import type { DevContainer } from './devcontainer.js';
import type { HostPath, MaybeHostPath } from './paths.js';

/**
 * Dev container projects that exist on disk but have never been built.
 *
 * THE GAP THIS FILLS
 *
 * Everything else in boxwarden starts from Docker: a dev container is only
 * visible once it carries `devcontainer.local_folder`, and a container only
 * carries that label once someone has built it. So the app is blind to the
 * exact case a newcomer to a machine is in — a dozen checked-out repos, each
 * with a `.devcontainer/`, and not one container to show for it. "No dev
 * containers found" is technically true and completely unhelpful.
 *
 * A project here is a `devcontainer.json` on the filesystem. That is the whole
 * definition, and it is deliberately shallow: this module does NOT understand
 * `extends`, feature resolution, variable substitution, or compose files. It
 * answers one question — "is there a dev container configured in this folder,
 * and what is it called" — because that is all the UI needs to offer the user
 * a way to open it.
 *
 * Everything below is pure. The directory walk that feeds it lives in
 * src/main/projects/scan.ts.
 */

/**
 * A project's identity is its config file path, verbatim.
 *
 * Not the folder: one folder can hold several configs
 * (`.devcontainer/<name>/devcontainer.json` is how the spec spells "this repo
 * has more than one dev container"), and collapsing them would silently drop
 * all but the first. Not a hash either — an id that can be read in a log is
 * worth more here than one that is short.
 */
export type ProjectId = string & { readonly __brand: 'ProjectId' };

export function asProjectId(configPath: string): ProjectId {
  return configPath as ProjectId;
}

export interface DevContainerProject {
  readonly id: ProjectId;
  /** `name` from devcontainer.json when it has one, else the folder's basename. */
  readonly name: string;
  /**
   * The folder that would be opened — the one CONTAINING `.devcontainer`, not
   * `.devcontainer` itself. This is what becomes `devcontainer.local_folder`
   * once the container is built, which is what makes matching against a live
   * container possible at all.
   */
  readonly folder: HostPath;
  /** Absolute path of the config file, in the host's own separator style. */
  readonly configPath: string;
  /** How the config is spelled relative to the folder, e.g. `.devcontainer/devcontainer.json`. */
  readonly configLabel: string;
  /** Which scan root this was found under — shown so a surprising hit is explainable. */
  readonly root: string;
  /** Set only for `.devcontainer/<variant>/devcontainer.json`. */
  readonly variant?: string;
}

/** Why a configured scan root produced nothing. */
export type RootFailure = 'missing' | 'unreadable';

export interface ProjectRoot {
  readonly path: string;
  /**
   * `default` roots are computed from the platform and can change between
   * releases; `user` roots were chosen in a folder picker and must not. The UI
   * distinguishes them because removing a default is a different promise from
   * removing one the user added — see `resolveProjectRoots`.
   */
  readonly source: 'default' | 'user';
}

export interface ScannedRoot extends ProjectRoot {
  readonly found: number;
  readonly failure?: RootFailure;
  readonly detail?: string;
}

export interface ProjectScan {
  readonly scannedAt: Date;
  readonly roots: readonly ScannedRoot[];
  readonly projects: readonly DevContainerProject[];
  /**
   * True when the walk hit its time or result budget and stopped early.
   *
   * Surfaced rather than swallowed: a truncated scan and a complete one look
   * identical in the list, and a user whose project is missing needs to know
   * which of "boxwarden did not look there" and "boxwarden gave up" happened.
   */
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

/**
 * Directory names never descended into.
 *
 * Two jobs. The obvious one is speed — `node_modules` alone can be more
 * directory entries than the rest of a home folder combined. The less obvious
 * one is correctness: a `devcontainer.json` inside `node_modules` belongs to a
 * dependency's own test fixtures, not to the user, and offering to open it is
 * worse than missing it.
 *
 * Dot-directories are skipped wholesale by the walker (see `shouldDescend`),
 * so they are not repeated here — this list is the ordinary-looking folders
 * that are nonetheless never worth entering.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'tmp',
  'temp',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
  // macOS and Windows put enormous, uninteresting trees directly in $HOME.
  'Library',
  'Applications',
  'AppData',
  'OneDrive',
  'Music',
  'Movies',
  'Pictures',
  'Videos',
  'Downloads',
]);

/** The one dot-directory the walker looks INSIDE, rather than past. */
export const CONFIG_DIRECTORY = '.devcontainer';

/** Config file names, in the two places the spec allows them. */
export const CONFIG_FILENAME = 'devcontainer.json';
export const ROOT_CONFIG_FILENAME = '.devcontainer.json';

/**
 * Whether the walker should step into a directory.
 *
 * Dot-directories are refused as a class, with `.devcontainer` handled
 * separately by the caller. It is a blunt rule and it is the right one: `.git`,
 * `.venv`, `.gradle`, `.cache`, `.m2`, `.terraform` and `.pnpm-store` are all
 * expensive, all uninteresting, and enumerating them by name is a list that
 * would never stop growing.
 */
export function shouldDescend(name: string): boolean {
  if (name.startsWith('.')) return false;
  return !IGNORED_DIRECTORIES.has(name);
}

/**
 * Strip comments and trailing commas so `JSON.parse` can read a devcontainer.json.
 *
 * `devcontainer.json` is JSONC — the spec says so, the schema says so, and the
 * generated file VS Code writes for a new project opens with a comment. A plain
 * `JSON.parse` therefore fails on a large share of real files, and failing means
 * falling back to the folder name for every project whose author left the
 * generated comments in. That is most of them.
 *
 * Written as a character scan rather than a regex because the strings inside the
 * file can contain `//` (every `"image"` with a registry host does) and a regex
 * that does not track string state deletes half the document. Escapes are
 * tracked for the same reason: `"C:\\path\\"` must not read as an unterminated
 * string.
 *
 * Replaces comments with spaces rather than removing them, so byte offsets in a
 * `JSON.parse` error still point at the right place in the original.
 *
 * Two passes, and the order is the whole reason there are two. Comments go
 * first, because a trailing comma can be followed by one:
 *
 *     { "name": "api", // renamed
 *     }
 *
 * Then the commas, over a document where every comment has already become
 * whitespace. Both passes track string state, which is what the second one is
 * for: `replace(/,(\s*[}\]])/g, ' $1')` also rewrites a `,}` that is two
 * characters of somebody's `"name"`, and `project.property.test.ts` found that
 * by generating one.
 */
export function stripJsonc(source: string): string {
  return elideTrailingCommas(elideComments(source));
}

/**
 * Copy a string literal, opening quote onward, honouring escapes.
 *
 * Shared by both passes, since "where does this string end" is the one question
 * they both have to get right — `"C:\\path\\"` must not read as unterminated.
 * Returns the text copied and the index just past the closing quote.
 */
function copyStringLiteral(source: string, start: number): { text: string; next: number } {
  let text = source.charAt(start);
  let index = start + 1;

  while (index < source.length) {
    const inner = source.charAt(index);
    text += inner;
    index += 1;
    if (inner === '\\' && index < source.length) {
      text += source.charAt(index);
      index += 1;
      continue;
    }
    if (inner === '"') break;
  }

  return { text, next: index };
}

/** Pass one: line and block comments become spaces, newlines preserved. */
function elideComments(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '"') {
      const { text, next } = copyStringLiteral(source, index);
      out += text;
      index = next;
      continue;
    }

    if (char === '/' && source.charAt(index + 1) === '/') {
      while (index < source.length && source.charAt(index) !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && source.charAt(index + 1) === '*') {
      while (index < source.length) {
        const inner = source.charAt(index);
        // Newlines are preserved so line numbers survive.
        out += inner === '\n' ? '\n' : ' ';
        index += 1;
        if (inner === '*' && source.charAt(index) === '/') {
          out += ' ';
          index += 1;
          break;
        }
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Pass two: a comma whose next non-whitespace character closes the object or
 * array becomes a space. Runs on the output of `elideComments`, so a comment
 * between the comma and the brace has already become whitespace and cannot
 * hide it.
 */
function elideTrailingCommas(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '"') {
      const { text, next } = copyStringLiteral(source, index);
      out += text;
      index = next;
      continue;
    }

    if (char === ',') {
      let ahead = index + 1;
      while (ahead < source.length && /\s/.test(source.charAt(ahead))) ahead += 1;
      const next = source.charAt(ahead);
      out += next === '}' || next === ']' ? ' ' : char;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * The `name` field of a devcontainer.json, when it has a usable one.
 *
 * Never throws. A config that cannot be parsed is still a real project — the
 * folder is there, the file is there, and the user very likely wants to open it
 * and fix exactly that. Returning undefined lets the caller fall back to the
 * folder name instead of dropping the project over a syntax error.
 */
export function devcontainerName(source: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(source));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const name = (parsed as Record<string, unknown>)['name'];
  if (typeof name !== 'string') return undefined;

  const trimmed = name.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Where to look when the user has not said.
 *
 * The home directory, and that is nearly all. Listing `~/code`, `~/src`,
 * `~/Projects`, `~/dev`, `~/Developer`, `~/repos`, `~/git`,
 * `~/Documents/GitHub` and `~/source/repos` was the first draft, and every one
 * of them is reachable from `$HOME` within the walker's depth limit — so the
 * list bought nothing except nine "this folder does not exist" rows to explain
 * on most machines.
 *
 * `/workspaces` on Linux is the exception, because it is outside `$HOME`: it is
 * where the Dev Containers spec mounts the workspace, so boxwarden running
 * inside a dev container finds the repo it is running from.
 *
 * Takes `platform` and `homedir` as parameters rather than reading them, the
 * same way `candidateEndpoints` does, so the Windows answer is testable from
 * Linux.
 */
export function defaultProjectRoots(platform: string, homedir: string): readonly string[] {
  const roots = [homedir];
  if (platform === 'linux') roots.push('/workspaces');
  return roots;
}

/** Preferences hold either an explicit list or nothing at all — see `parseProjectRoots`. */
export const PROJECT_ROOTS_UNSET = undefined;

/**
 * Read the persisted root list.
 *
 * `undefined` and an empty array mean different things and must keep meaning
 * different things. `undefined` is "never configured" and yields the defaults;
 * `[]` is "the user removed every root" and yields no scanning at all. Folding
 * them together would make the last removal silently undo itself, which reads
 * as the app ignoring the click.
 */
export function parseProjectRoots(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return PROJECT_ROOTS_UNSET;
  const roots = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  // Duplicates would scan the same tree twice and list every project twice.
  return [...new Set(roots)];
}

/**
 * The roots to actually walk.
 *
 * A path that happens to equal a default is still labelled `default` after the
 * list has been materialised, so the UI can keep saying "this is where
 * boxwarden looks unless you tell it otherwise" about `$HOME` rather than
 * presenting it as something the user once chose.
 */
export function resolveProjectRoots(
  configured: readonly string[] | undefined,
  defaults: readonly string[],
): readonly ProjectRoot[] {
  const paths = configured ?? defaults;
  return paths.map((path) => ({
    path,
    source: defaults.includes(path) ? ('default' as const) : ('user' as const),
  }));
}

/**
 * A host path reduced to a string two sources can be compared on.
 *
 * The two sources are a live container's `devcontainer.local_folder` and a
 * folder this app just walked, and they are written by different programs on
 * different days. Case and separators drift between them on Windows — the
 * extension writes whatever the user's shell handed it, which may be
 * `c:\Users\...` where the walk produced `C:\Users\...`.
 *
 * Normalising here is safe in a way that normalising for the editor URI is
 * emphatically NOT (see src/main/editor/uri.ts): the worst outcome of a wrong
 * answer here is a project listed as unbuilt when it is built, or hidden when
 * it is not. Nothing is launched from this value.
 *
 * POSIX paths keep their case, because POSIX filesystems keep their case.
 */
export function comparableFolder(host: MaybeHostPath): string | undefined {
  switch (host.kind) {
    case 'unresolved':
      return undefined;
    case 'windows':
      return host.path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    case 'posix':
      return host.path.replace(/\/+$/, '');
    case 'wsl':
      // The distro is part of the identity: /home/me/proj in Ubuntu and the
      // same path in Debian are different folders.
      return `wsl:${host.distro.toLowerCase()}:${host.path.replace(/\/+$/, '')}`;
  }
}

export interface PartitionedProjects {
  /** Configured on disk with no container to show for it — the whole point of this module. */
  readonly unbuilt: readonly DevContainerProject[];
  /** Already represented in the container list, so the list is where they belong. */
  readonly built: readonly DevContainerProject[];
}

/**
 * Split scanned projects by whether a container already exists for them.
 *
 * Matching is on the folder, not the config file, because the label records the
 * folder. A repo with two configs in it therefore counts as built once either
 * has been built — which is the honest answer available from the label alone,
 * and errs towards not nagging the user about a project they are already
 * running.
 */
export function partitionProjects(
  projects: readonly DevContainerProject[],
  containers: readonly DevContainer[],
): PartitionedProjects {
  const occupied = new Set<string>();
  for (const container of containers) {
    const key = comparableFolder(container.localFolder);
    if (key !== undefined) occupied.add(key);
  }

  const unbuilt: DevContainerProject[] = [];
  const built: DevContainerProject[] = [];
  for (const project of projects) {
    const key = comparableFolder(project.folder);
    (key !== undefined && occupied.has(key) ? built : unbuilt).push(project);
  }

  return { unbuilt, built };
}

/**
 * Alphabetical by display name, then by config path.
 *
 * The tiebreaker matters more than it looks: a repo with `frontend` and
 * `backend` variants shows two rows with the same name if neither config sets
 * one, and without a stable second key their order flips between scans.
 */
export function sortProjects(
  projects: readonly DevContainerProject[],
): readonly DevContainerProject[] {
  return [...projects].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.configPath.localeCompare(b.configPath),
  );
}
