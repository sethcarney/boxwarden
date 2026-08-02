import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  DevContainerProject,
  HostPath,
  ProjectRoot,
  ProjectScan,
  ScannedRoot,
  RootFailure,
} from '../../models/index.js';
import {
  CONFIG_DIRECTORY,
  CONFIG_FILENAME,
  ROOT_CONFIG_FILENAME,
  asProjectId,
  devcontainerName,
  shouldDescend,
  sortProjects,
} from '../../models/index.js';
import { parseLocalFolder } from '../docker/host-path.js';

/**
 * The impure half of unbuilt-project discovery: walk the disk, find every
 * `devcontainer.json`, hand the results to the pure layer.
 *
 * WHY THIS IS BOUNDED THE WAY IT IS
 *
 * A recursive walk of a developer's home directory is, left unbounded, an
 * unbounded operation. It can be minutes on a machine with a few large
 * checkouts and a network drive mounted under `$HOME`, and the app would sit
 * there looking hung. Three limits keep it honest, and all three are reported
 * rather than hidden:
 *
 *   - DEPTH. Three levels below a root. `~/code/proj`, `~/Documents/GitHub/proj`
 *     and `~/source/repos/proj` all fit; `~/a/b/c/d/proj` does not, and the
 *     answer for that user is to add `~/a/b` as a root.
 *   - TIME. A wall-clock deadline shared across roots, spent round-robin so a
 *     single enormous root cannot starve the others.
 *   - COUNT. A cap on results, because a UI listing 2,000 projects is not a
 *     feature.
 *
 * Hitting any of them sets `truncated`, which the UI says out loud. A truncated
 * scan that looked complete would send a user hunting for why their project is
 * "missing" when the answer is that boxwarden stopped early.
 */

export interface ScanOptions {
  readonly roots: readonly ProjectRoot[];
  /** `process.platform`, passed in so the Windows path flavour is testable elsewhere. */
  readonly platform: string;
  readonly maxDepth?: number;
  readonly maxProjects?: number;
  readonly budgetMs?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PROJECTS = 250;
const DEFAULT_BUDGET_MS = 10_000;

/** Configs are small. Anything past this is not one, and is not worth reading. */
const MAX_CONFIG_BYTES = 512_000;

/**
 * A real path on this machine, typed.
 *
 * On Windows this defers to `parseLocalFolder` — the same parser the Docker
 * label goes through — so a user-added `\\wsl.localhost\Ubuntu\home\me` root
 * yields a `wsl` path with its distro attached, and its projects open over
 * `vscode-remote://wsl+…` rather than as a 9P share. Anything it cannot
 * classify is still a Windows path here, because we just read it off a Windows
 * filesystem; unlike a label, its provenance is not in doubt.
 */
function hostPathFor(platform: string, absolutePath: string): HostPath {
  if (platform !== 'win32') return { kind: 'posix', path: absolutePath };
  const parsed = parseLocalFolder(absolutePath);
  return parsed.kind === 'unresolved' ? { kind: 'windows', path: absolutePath } : parsed;
}

/** The config's `name`, or the folder's basename when it has none we can read. */
async function projectNameFrom(configPath: string, folderPath: string): Promise<string> {
  const fallback = basename(folderPath.replace(/[/\\]+$/, ''));
  try {
    const info = await stat(configPath);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return fallback;
    const source = await readFile(configPath, 'utf8');
    return devcontainerName(source) ?? fallback;
  } catch {
    // Unreadable config, but the folder is there and so is the file. The user
    // very likely wants to open it precisely to fix that.
    return fallback;
  }
}

async function buildProject(
  options: {
    readonly configPath: string;
    readonly folderPath: string;
    readonly configLabel: string;
    readonly root: string;
    readonly variant?: string;
  },
  platform: string,
): Promise<DevContainerProject> {
  const name = await projectNameFrom(options.configPath, options.folderPath);
  return {
    id: asProjectId(options.configPath),
    name,
    folder: hostPathFor(platform, options.folderPath),
    configPath: options.configPath,
    configLabel: options.configLabel,
    root: options.root,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
}

/**
 * Every config inside a `.devcontainer/` directory.
 *
 * Two shapes, both from the spec: the plain `.devcontainer/devcontainer.json`,
 * and `.devcontainer/<variant>/devcontainer.json`, which is how a repo says it
 * ships more than one dev container. The second is why a project's identity is
 * its config path and not its folder.
 */
async function configsInConfigDirectory(configDir: string): Promise<
  readonly {
    readonly configPath: string;
    readonly configLabel: string;
    readonly variant?: string;
  }[]
> {
  let entries;
  try {
    entries = await readdir(configDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: { configPath: string; configLabel: string; variant?: string }[] = [];
  const variantDirs: string[] = [];

  for (const entry of entries) {
    if (entry.name === CONFIG_FILENAME && !entry.isDirectory()) {
      found.push({
        configPath: join(configDir, CONFIG_FILENAME),
        configLabel: `${CONFIG_DIRECTORY}/${CONFIG_FILENAME}`,
      });
      continue;
    }
    // Dot-directories are skipped here too: `.devcontainer/.cache` is not a
    // variant, and `shouldDescend` already encodes that judgement.
    if (entry.isDirectory() && shouldDescend(entry.name)) variantDirs.push(entry.name);
  }

  for (const variant of variantDirs) {
    const configPath = join(configDir, variant, CONFIG_FILENAME);
    try {
      const info = await stat(configPath);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    found.push({
      configPath,
      configLabel: `${CONFIG_DIRECTORY}/${variant}/${CONFIG_FILENAME}`,
      variant,
    });
  }

  return found;
}

interface Pending {
  readonly path: string;
  readonly depth: number;
}

interface RootState {
  readonly root: ProjectRoot;
  readonly queue: Pending[];
  found: number;
  failure?: RootFailure;
  detail?: string;
}

/** Classify a root that could not be walked, before any work is queued for it. */
async function openRoot(root: ProjectRoot): Promise<RootState> {
  const state: RootState = { root, queue: [], found: 0 };
  try {
    const info = await stat(root.path);
    if (!info.isDirectory()) {
      state.failure = 'unreadable';
      state.detail = 'Not a directory.';
      return state;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    state.failure = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
    state.detail = error instanceof Error ? error.message : String(error);
    return state;
  }
  state.queue.push({ path: root.path, depth: 0 });
  return state;
}

export async function scanForProjects(options: ScanOptions): Promise<ProjectScan> {
  const startedAt = Date.now();
  const scannedAt = new Date(startedAt);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS);

  const states = await Promise.all(options.roots.map((root) => openRoot(root)));
  const projects: DevContainerProject[] = [];
  const seen = new Set<string>();
  let truncated = false;

  /**
   * Round-robin, one directory per root per pass, rather than draining each
   * root in turn. With sequential draining a first root that is a 200,000-file
   * monorepo spends the entire budget and every later root reports zero — and
   * the user sees a scan that silently ignored the folder they just added.
   */
  while (states.some((state) => state.queue.length > 0)) {
    if (Date.now() > deadline || projects.length >= maxProjects) {
      truncated = true;
      break;
    }

    for (const state of states) {
      const next = state.queue.shift();
      if (next === undefined) continue;

      let entries;
      try {
        entries = await readdir(next.path, { withFileTypes: true });
      } catch {
        // A folder we cannot read is not a failure of the scan — permission
        // denied on one subdirectory of $HOME is ordinary. Skip it silently;
        // reporting every one would bury the roots that genuinely failed.
        continue;
      }

      const configs: {
        configPath: string;
        folderPath: string;
        configLabel: string;
        variant?: string;
      }[] = [];

      for (const entry of entries) {
        if (entry.name === CONFIG_DIRECTORY && entry.isDirectory()) {
          for (const config of await configsInConfigDirectory(join(next.path, CONFIG_DIRECTORY))) {
            configs.push({ ...config, folderPath: next.path });
          }
          continue;
        }

        if (entry.name === ROOT_CONFIG_FILENAME && !entry.isDirectory()) {
          configs.push({
            configPath: join(next.path, ROOT_CONFIG_FILENAME),
            folderPath: next.path,
            configLabel: ROOT_CONFIG_FILENAME,
          });
          continue;
        }

        // Symlinked directories are never followed. `isDirectory()` is false
        // for a symlink here (readdir reports link type, not target type), so
        // this is not an extra check so much as a property worth naming: it is
        // what makes the walk acyclic without tracking visited inodes.
        if (entry.isDirectory() && next.depth < maxDepth && shouldDescend(entry.name)) {
          state.queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
        }
      }

      for (const config of configs) {
        // Two roots can nest (`$HOME` and `$HOME/work`), and without this the
        // overlap is listed twice.
        if (seen.has(config.configPath)) continue;
        seen.add(config.configPath);

        projects.push(
          await buildProject(
            {
              configPath: config.configPath,
              folderPath: config.folderPath,
              configLabel: config.configLabel,
              root: state.root.path,
              ...(config.variant === undefined ? {} : { variant: config.variant }),
            },
            options.platform,
          ),
        );
        state.found += 1;
      }
    }
  }

  const roots: readonly ScannedRoot[] = states.map((state) => ({
    path: state.root.path,
    source: state.root.source,
    found: state.found,
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    ...(state.detail === undefined ? {} : { detail: state.detail }),
  }));

  return {
    scannedAt,
    roots,
    projects: sortProjects(projects),
    truncated,
    elapsedMs: Date.now() - startedAt,
  };
}
