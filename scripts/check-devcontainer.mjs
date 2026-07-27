#!/usr/bin/env node
/**
 * Asserts that Claude Code's credential persistence is wired correctly in
 * .devcontainer/devcontainer.json.
 *
 * This exists because every failure mode here is SILENT. Nothing errors, the
 * container builds fine, and the only symptom is being asked to sign in after
 * every rebuild — which is easy to mistake for normal behaviour.
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
check(`a mount targets ${expected}`, Boolean(claudeMount), `mounts: ${mounts.map((m) => m.target).join(', ') || '(none)'}`);

// A bind mount would expose host credential files to the container.
check(
  'that mount is type=volume, not a bind mount',
  claudeMount?.type === 'volume',
  claudeMount ? `got type=${claudeMount.type}` : 'no matching mount',
);

for (const { label, ok, detail } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. Claude Code credentials will NOT persist across rebuilds.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed.`);
