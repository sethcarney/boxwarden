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
# Dependencies. Bun is the package manager; see devcontainer.json for why it
# is not the runtime.
# ---------------------------------------------------------------------------
if [ -f package.json ]; then
  bun install
else
  echo "post-create: no package.json, skipping install"
fi
