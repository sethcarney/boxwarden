#!/usr/bin/env node
/**
 * Asserts the parts of .devcontainer/devcontainer.json whose failure modes are
 * misleading rather than obvious:
 *
 *   1. Claude Code's credential persistence, which fails SILENTLY. Nothing
 *      errors, the container builds fine, and the only symptom is being asked
 *      to sign in after every rebuild — easy to mistake for normal behaviour.
 *   2. The host Docker socket mount, which fails LOUDLY but points nowhere
 *      useful: on a rootless host the container exits 1 during startup, after
 *      a successful build, and the log shows the runtime command line rather
 *      than the missing socket.
 *
 * Deliberately a plain script with no test framework: the choice between
 * Vitest and `bun test` is still open, and a regression guard should not be
 * what decides it. Fold it into the suite later if that is tidier.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.devcontainer',
  'devcontainer.json',
);

/** Strip // and /* *\/ comments from JSONC without tripping over strings. */
function stripJsonComments(src) {
  const BACKSLASH = String.fromCharCode(92);
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === BACKSLASH) escaped = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** "source=x,target=y,type=volume" -> { source, target, type } */
function parseMount(mount) {
  if (typeof mount !== 'string') return mount;
  return Object.fromEntries(
    mount.split(',').map((part) => {
      const idx = part.indexOf('=');
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
    }),
  );
}

const config = JSON.parse(stripJsonComments(readFileSync(CONFIG, 'utf8')));
const failures = [];
const checks = [];

function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// The expected path is DERIVED from remoteUser rather than hardcoded, so that
// swapping the base image (node -> vscode) is caught instead of drifting.
const remoteUser = config.remoteUser;
check('remoteUser is set', typeof remoteUser === 'string' && remoteUser.length > 0);

const home = remoteUser === 'root' ? '/root' : `/home/${remoteUser}`;
const expected = `${home}/.claude`;

const featureIds = Object.keys(config.features ?? {});
check(
  'Claude Code feature present',
  featureIds.some((id) => id.includes('anthropics/devcontainer-features/claude-code')),
  `features: ${featureIds.join(', ') || '(none)'}`,
);

// The whole point of the fix: without this, ~/.claude.json — which holds the
// OAuth session — is written to $HOME, outside the volume, and the login is
// discarded on every rebuild.
const configDir = config.containerEnv?.CLAUDE_CONFIG_DIR;
check(
  `containerEnv.CLAUDE_CONFIG_DIR === ${expected}`,
  configDir === expected,
  configDir === undefined ? 'not set' : `got ${configDir}`,
);

const mounts = (config.mounts ?? []).map(parseMount);
const claudeMount = mounts.find((m) => m.target === expected);
check(
  `a mount targets ${expected}`,
  Boolean(claudeMount),
  `mounts: ${mounts.map((m) => m.target).join(', ') || '(none)'}`,
);

// A bind mount would expose host credential files to the container.
check(
  'that mount is type=volume, not a bind mount',
  claudeMount?.type === 'volume',
  claudeMount ? `got type=${claudeMount.type}` : 'no matching mount',
);

// ---------------------------------------------------------------------------
// The host Docker socket.
//
// docker-outside-of-docker hardcodes the HOST side of this mount to
// /var/run/docker.sock, which does not exist on a rootless host (Podman, or
// rootless Docker). Restating the mount in devcontainer.json is the only way
// to change it — the CLI de-duplicates mounts by target and keeps the
// config's — so the check is that the restatement is still there and still
// parameterized. Dropping it is an easy "cleanup" to make, and it breaks
// every Podman user with a startup crash that names no socket.
// ---------------------------------------------------------------------------
const SOCKET_TARGET = '/var/run/docker-host.sock';

check(
  'docker-outside-of-docker feature present',
  featureIds.some((id) => id.includes('features/docker-outside-of-docker')),
  `features: ${featureIds.join(', ') || '(none)'}`,
);

const socketMount = mounts.find((m) => m.target === SOCKET_TARGET);
check(
  `a mount overrides the feature's socket bind at ${SOCKET_TARGET}`,
  Boolean(socketMount),
  `mounts: ${mounts.map((m) => m.target).join(', ') || '(none)'}`,
);

// Parameterized so rootless hosts can redirect it, with a default so rootful
// Docker and Docker Desktop need nothing set. Hardcoding either path breaks
// the other camp.
const socketSource = socketMount?.source ?? '';
const localEnvDefault = /^\$\{localEnv:[A-Za-z_][A-Za-z0-9_]*:(?<fallback>[^}]+)\}$/.exec(
  socketSource,
);
check(
  'its source is ${localEnv:...} with a default',
  Boolean(localEnvDefault),
  socketMount ? `got source=${socketSource || '(empty)'}` : 'no matching mount',
);
check(
  'that default is /var/run/docker.sock',
  localEnvDefault?.groups?.fallback === '/var/run/docker.sock',
  localEnvDefault ? `got ${localEnvDefault.groups.fallback}` : 'no default to check',
);

for (const { label, ok, detail } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} check(s) failed. Claude Code credentials will not persist across` +
      ` rebuilds, and/or the container will not start on a rootless Docker or Podman host.`,
  );
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed.`);
