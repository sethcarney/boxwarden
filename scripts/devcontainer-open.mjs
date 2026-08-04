#!/usr/bin/env node
/**
 * Bring this repo's dev container up and attach an editor to it, from a
 * terminal — no command palette, no mouse.
 *
 *     bun run devcontainer:open
 *     bun run devcontainer:open -- --editor cursor
 *     bun run devcontainer:open -- --print
 *
 * Two CLIs, doing two different jobs:
 *
 *   devcontainer up   builds/starts the container from .devcontainer/ and
 *                     reports where the workspace landed inside it.
 *                     (@devcontainers/cli — the open-source one.)
 *   code --folder-uri attaches a window to a container that already exists.
 *                     (The VS Code CLI. Its forks take the same flag.)
 *
 * `code` alone cannot do the first job and `devcontainer` alone cannot do the
 * second, which is why the interesting part of this script is the URI that
 * joins them — the same `vscode-remote://dev-container+<hex>/<path>` that
 * boxwarden itself builds. This script is the manual version of the app's
 * Open button, and a good way to sanity-check that path without the GUI.
 *
 * MUST RUN ON THE HOST. Inside the dev container `code` resolves to the
 * container's PATH and the Docker socket paths are the host's, so both halves
 * point at the wrong machine. See docs/running.md.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Editors that take `--folder-uri` and understand `vscode-remote://`. */
const KNOWN_EDITORS = ['code', 'code-insiders', 'cursor', 'windsurf'];

// ---------------------------------------------------------------------------
// Pure bits. Exported for scripts/devcontainer-open.test.mjs, which pins them
// against src/main/editor/uri.ts — this file cannot import that module (it is
// TypeScript, and this script runs unbuilt), so the duplication is checked
// rather than avoided.
// ---------------------------------------------------------------------------

/**
 * Hex-encode a host folder path into a dev container authority.
 *
 * Byte for byte, from whatever string is passed in. The Dev Containers
 * extension recognises a container only if the authority decodes to the exact
 * string it wrote into `devcontainer.local_folder`, so normalising here — a
 * trailing slash, a drive-letter case, a separator flip — produces a
 * valid-looking URI for a container that does not exist, and VS Code responds
 * by offering to build a new one. Same rule, same reason, as
 * `authorityFor` in src/main/editor/uri.ts.
 */
export function authorityFor(localFolderRaw) {
  const hex = Array.from(new TextEncoder().encode(localFolderRaw))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `dev-container+${hex}`;
}

/** `vscode-remote://dev-container+<hex of host folder>/<path in container>` */
export function devContainerUri(localFolderRaw, workspaceFolder) {
  const path = workspaceFolder
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const absolute = path.startsWith('/') ? path : `/${path}`;
  return `vscode-remote://${authorityFor(localFolderRaw)}${absolute}`;
}

/**
 * `devcontainer up` streams human-readable progress and finishes with a single
 * JSON object. Scanning from the end rather than parsing the whole stream keeps
 * this working whether the log format is text or json, and whether or not the
 * CLI gains new lines after the result.
 */
export function parseUpResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && 'outcome' in parsed) return parsed;
    } catch {
      // Progress line, not the result. Keep walking backwards.
    }
  }
  return undefined;
}

/** `--editor cursor --print` -> { editor: 'cursor', print: true } */
export function parseArgs(argv) {
  const options = { editor: 'code', workspaceFolder: REPO_ROOT, print: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--editor':
      case '--workspace-folder': {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} needs a value`);
        if (arg === '--editor') options.editor = value;
        else options.workspaceFolder = resolve(value);
        break;
      }
      case '--print':
        options.print = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const USAGE = `Usage: bun run devcontainer:open [-- <options>]

  --editor <cmd>            ${KNOWN_EDITORS.join(', ')} (default: code)
  --workspace-folder <dir>  repo to open (default: this one)
  --print                   print the URI instead of launching an editor
  -h, --help

Environment:
  DEVCONTAINER_CLI   path to the devcontainer CLI; otherwise PATH, then npx
  BOXWARDEN_DOCKER   container runtime CLI (default: docker; e.g. podman)
`;

// ---------------------------------------------------------------------------
// Impure bits.
// ---------------------------------------------------------------------------

/** Run to completion, capturing stdout while still showing progress. */
function run(command, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      // Progress goes to stderr so that `--print`'s one line of stdout stays
      // pipeable into something else.
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
      shell: false,
    });

    let stdout = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        process.stderr.write(chunk);
      });
    }

    child.once('error', rejectRun);
    child.once('close', (code) => {
      resolveRun({ code: code ?? 1, stdout });
    });
  });
}

/**
 * Same capture, but "it did not work" is an expected answer rather than a
 * failure: both callers are asking a question (is this on PATH? what does this
 * label say?) whose negative answer has a fallback.
 *
 * The `error` listener is not optional. `spawn` reports a missing binary
 * asynchronously, so a try/catch around this — which is what it looked like it
 * needed — catches nothing, and the process dies on an unhandled 'error' event
 * instead of taking the fallback. ENOENT here is the *common* path: it is what
 * `docker` not being installed looks like.
 */
function tryCapture(command, args) {
  return new Promise((resolveCapture) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let stdout = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('error', () => resolveCapture(undefined));
    child.once('close', (code) => resolveCapture(code === 0 ? stdout.trim() : undefined));
  });
}

/**
 * The devcontainer CLI, in order: an explicit override, then PATH, then npx.
 *
 * The npx fallback exists so the documented command works on a machine that has
 * never installed it — but it downloads a package, so it says so rather than
 * pausing mysteriously for thirty seconds.
 */
async function devcontainerCommand() {
  const override = process.env['DEVCONTAINER_CLI'];
  if (override) return { command: override, args: [] };

  const onPath = await tryCapture(process.platform === 'win32' ? 'where' : 'which', [
    'devcontainer',
  ]);
  if (onPath) return { command: 'devcontainer', args: [] };

  console.error(
    '[boxwarden] devcontainer CLI not on PATH — falling back to npx (this downloads it).\n' +
      '[boxwarden] To install it permanently: npm i -g @devcontainers/cli\n',
  );
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', '@devcontainers/cli'],
  };
}

/**
 * The host folder as the label records it, read back from the container.
 *
 * This is the whole reason the script asks Docker rather than using the path it
 * passed in: the label is what the URI has to round-trip, and the tooling is
 * free to have normalised the path on its way in (the Windows drive-letter case
 * is the suspected one — see docs/roadmap.md). When the runtime CLI is missing
 * or the label is empty, the resolved workspace path is the best guess left.
 */
async function localFolderLabel(containerId, fallback) {
  const docker = process.env['BOXWARDEN_DOCKER'] ?? 'docker';
  const label = await tryCapture(docker, [
    'inspect',
    '--format',
    '{{index .Config.Labels "devcontainer.local_folder"}}',
    containerId,
  ]);

  // `docker inspect` renders a missing label as the literal "<no value>".
  if (!label || label === '<no value>') {
    console.error(
      `[boxwarden] could not read devcontainer.local_folder via ${docker}; using ${fallback}`,
    );
    return fallback;
  }
  if (label !== fallback) {
    console.error(`[boxwarden] label differs from the path passed in — using the label: ${label}`);
  }
  return label;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[boxwarden] ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (!existsSync(resolve(options.workspaceFolder, '.devcontainer/devcontainer.json'))) {
    console.error(
      `[boxwarden] no .devcontainer/devcontainer.json under ${options.workspaceFolder}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!KNOWN_EDITORS.includes(options.editor)) {
    // A warning, not an error: any VS Code fork with a CLI should work, and
    // hardcoding the list as a gate would make this script the thing that has
    // to be edited when a new one appears.
    console.error(`[boxwarden] ${options.editor} is not a known editor — trying it anyway.`);
  }

  const { command, args } = await devcontainerCommand();
  console.error(`[boxwarden] devcontainer up --workspace-folder ${options.workspaceFolder}`);

  let up;
  try {
    up = await run(command, [...args, 'up', '--workspace-folder', options.workspaceFolder], {
      capture: true,
    });
  } catch (error) {
    // Reached when neither the devcontainer CLI nor npx exists — a Bun-only
    // machine, typically. Naming the install command beats an ENOENT stack.
    console.error(
      `[boxwarden] could not run ${command}: ${error.message}\n` +
        `[boxwarden] Install the CLI: npm i -g @devcontainers/cli`,
    );
    process.exitCode = 1;
    return;
  }

  const result = parseUpResult(up.stdout);
  if (up.code !== 0 || result?.outcome !== 'success') {
    console.error(
      `\n[boxwarden] devcontainer up failed${result?.message ? `: ${result.message}` : ''}` +
        `${result?.description ? `\n[boxwarden] ${result.description}` : ''}`,
    );
    process.exitCode = up.code === 0 ? 1 : up.code;
    return;
  }

  // Asked for rather than assumed: the workspace folder inside the container is
  // whatever devcontainer.json says, and only defaults to /workspaces/<name>.
  const workspaceFolder = result.remoteWorkspaceFolder ?? '/workspaces';
  const localFolder = await localFolderLabel(result.containerId, options.workspaceFolder);
  const uri = devContainerUri(localFolder, workspaceFolder);

  if (options.print) {
    console.log(uri);
    return;
  }

  console.error(`[boxwarden] ${options.editor} --folder-uri ${uri}`);
  try {
    // detached + unref so the editor outlives this script, and an argv array
    // with no shell so the hex-encoded path stays inert data.
    const child = spawn(options.editor, ['--folder-uri', uri], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    child.unref();
  } catch (error) {
    console.error(
      `\n[boxwarden] could not launch ${options.editor}: ${error.message}\n` +
        `[boxwarden] Open it by hand instead:\n\n    ${uri}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
