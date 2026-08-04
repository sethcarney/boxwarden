#!/usr/bin/env bash
#
# Runs once after the container is created. Invoked as `bash post-create.sh`,
# so it does not depend on the executable bit surviving a git checkout.
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"

# ---------------------------------------------------------------------------
# Named-volume ownership.
#
# Docker seeds a named volume from the image when the target path already
# exists there, ownership included. When it does NOT exist at build time,
# Docker creates the mountpoint owned by root — and this container runs as
# `node`. Claude Code would then fail to write its token, silently undoing the
# persistence the volume was added for.
#
# Cheap and idempotent, so just assert it every time rather than reasoning
# about which case applies on a given rebuild.
# ---------------------------------------------------------------------------
# Guarded on writability rather than ownership: it is the condition that
# actually matters, and it stays a no-op when a root-owned directory is
# already group-writable. Once correct this never fires again, so accumulated
# session history is not recursively chowned on every rebuild.
if [ -d "${CLAUDE_DIR}" ]; then
  if [ ! -w "${CLAUDE_DIR}" ]; then
    echo "post-create: ${CLAUDE_DIR} not writable by $(id -un), reclaiming"
    sudo chown -R "$(id -u):$(id -g)" "${CLAUDE_DIR}"
  fi
else
  mkdir -p "${CLAUDE_DIR}"
fi

# ---------------------------------------------------------------------------
# Skills, from the lock file.
#
# The mdm feature (see devcontainer.json) installs the binary during the image
# build, before the workspace is mounted, so a feature cannot restore skills —
# this script is the first point at which the repo exists to read.
#
# Guarded on the lock file rather than run unconditionally, because this repo
# does not commit one yet: with nothing to restore the command's behaviour is
# undocumented, and this script runs under `set -e`, where a non-zero exit takes
# the whole postCreate down after an otherwise successful build. So the step is
# a no-op today and starts working on its own the moment someone adds skills and
# commits skills-lock.json — no edit here required.
# ---------------------------------------------------------------------------
if [ -f skills-lock.json ]; then
  mdm skills install
else
  echo "post-create: no skills-lock.json, skipping skills install"
fi

# ---------------------------------------------------------------------------
# Dependencies. Bun is the package manager; see devcontainer.json for why it
# is not the runtime.
# ---------------------------------------------------------------------------
if [ -f package.json ]; then
  bun install
else
  echo "post-create: no package.json, skipping install"
fi

# ---------------------------------------------------------------------------
# Electron's binary.
#
# Electron 43+ dropped its postinstall script; the ~100MB binary is now
# fetched lazily, only the first time something does `require('electron')`.
# `bun install` never does that (there's no lifecycle script left to run, so
# `trustedDependencies: ["electron"]` above no-ops for this purpose), and
# electron-vite's dev server doesn't either — it only checks for
# node_modules/electron/path.txt and throws "Electron uninstall" if it's
# missing. So `npm run dev` fails on first run after every fresh
# container/rebuild unless we force the download here.
# ---------------------------------------------------------------------------
if [ -f node_modules/electron/install.js ]; then
  node node_modules/electron/install.js
fi

# ---------------------------------------------------------------------------
# Chromium's runtime libraries.
#
# Electron embeds Chromium — a desktop browser — but this is a headless server
# image: it ships Node and a compiler toolchain and nothing that a GUI needs.
# So the binary downloads correctly and then fails to link. `ldd` on it reports
# ~17 missing shared objects, but the loader stops at the first, so the error
# only ever names libnspr4.so. That makes this look like an NSS problem when it
# is really a missing-desktop problem, and it is why the fix is a package list
# rather than anything to do with the electron install itself.
#
# These are spelled WITHOUT the t64 suffix and resolved to the real name at
# run time, because neither spelling is portable on its own. Debian's 64-bit
# time_t transition renamed six of these (libatk1.0-0 -> libatk1.0-0t64, and
# similarly libatk-bridge2.0-0, libatspi2.0-0, libcups2, libgtk-3-0,
# libasound2). Bookworm has only the old names; trixie has only the new ones —
# it does NOT carry transitional packages for them, so a hardcoded `libgtk-3-0`
# fails there with "has no installation candidate" exactly like eterm does. The
# other nine were untouched by the transition and exist under one name on both.
#
# So: probe for <pkg>t64 first and fall back to <pkg>. That keeps this working
# on trixie today and on bookworm, which devcontainer.json explicitly
# contemplates moving back to.
# ---------------------------------------------------------------------------
ELECTRON_RUNTIME_DEPS=(
  libnspr4 libnss3
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
  libcups2 libdbus-1-3 libgtk-3-0
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0
  libgbm1 libasound2
)

pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

# Fast path, and the reason name resolution happens in the second pass rather
# than this one: dpkg answers from local state, but picking between <pkg> and
# <pkg>t64 needs apt's package lists, and desktop-lite deletes /var/lib/apt/
# lists as its last step. Refreshing them is the slowest thing in this script,
# so a rebuild where everything is already present must not reach it.
unresolved_deps=()
for pkg in "${ELECTRON_RUNTIME_DEPS[@]}"; do
  if ! pkg_installed "${pkg}" && ! pkg_installed "${pkg}t64"; then
    unresolved_deps+=("${pkg}")
  fi
done

if [ ${#unresolved_deps[@]} -eq 0 ]; then
  echo "post-create: Chromium runtime libraries already present"
else
  echo "post-create: installing Chromium runtime libraries (${#unresolved_deps[@]} missing)"
  sudo apt-get update -qq

  missing_deps=()
  for pkg in "${unresolved_deps[@]}"; do
    # A real candidate version starts with a digit (possibly after an epoch);
    # apt prints "(none)" for a name it knows of but cannot install.
    if apt-cache policy "${pkg}t64" 2>/dev/null | grep -q 'Candidate: [0-9]'; then
      missing_deps+=("${pkg}t64")
    else
      missing_deps+=("${pkg}")
    fi
  done

  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing_deps[@]}"
fi
