import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanForProjects } from './scan.js';

/**
 * The one impure module here with tests, and the exception is deliberate: the
 * suite's rule is "no Docker daemon and no display", not "no filesystem". A
 * directory walk is exactly the kind of code whose bugs — a symlink loop, a
 * depth limit off by one, a `.devcontainer` variant that is silently dropped —
 * do not show up anywhere except against a real filesystem.
 *
 * Everything is built under a temp directory that is torn down afterwards.
 */

let root: string;

async function config(path: string, body: string): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, 'devcontainer.json'), body, 'utf8');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'boxwarden-scan-'));

  // A plain project, with a name and the generated comment VS Code writes.
  await config('code/api/.devcontainer', '{\n  // generated\n  "name": "Payments API",\n}');

  // No name field — falls back to the folder.
  await config('code/web/.devcontainer', '{"image": "node:22"}');

  // Two variants in one repo.
  await config('code/ml/.devcontainer/cpu', '{"name": "ml (cpu)"}');
  await config('code/ml/.devcontainer/gpu', '{"name": "ml (gpu)"}');

  // The root-level spelling the spec also allows.
  await mkdir(join(root, 'code/tiny'), { recursive: true });
  await writeFile(join(root, 'code/tiny/.devcontainer.json'), '{"name": "tiny"}', 'utf8');

  // Must never be reported: a dependency's own fixture.
  await config('code/api/node_modules/pkg/.devcontainer', '{"name": "do not list me"}');

  // Deeper than the default depth allows.
  await config('a/b/c/d/deep/.devcontainer', '{"name": "too deep"}');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function scan(overrides: Partial<Parameters<typeof scanForProjects>[0]> = {}) {
  return scanForProjects({
    roots: [{ path: root, source: 'user' }],
    platform: 'linux',
    ...overrides,
  });
}

describe('scanForProjects', () => {
  it('finds every config shape the spec allows', async () => {
    const result = await scan();
    expect(result.projects.map((project) => project.configLabel).sort()).toEqual([
      '.devcontainer.json',
      '.devcontainer/cpu/devcontainer.json',
      '.devcontainer/devcontainer.json',
      '.devcontainer/devcontainer.json',
      '.devcontainer/gpu/devcontainer.json',
    ]);
  });

  it('reads the name out of a commented config and falls back to the folder without one', async () => {
    const byFolder = new Map(
      (await scan()).projects.map((project) => [
        project.folder.kind === 'posix' ? project.folder.path : '',
        project.name,
      ]),
    );
    expect(byFolder.get(join(root, 'code/api'))).toBe('Payments API');
    expect(byFolder.get(join(root, 'code/web'))).toBe('web');
  });

  it('tags variants and gives each its own id', async () => {
    const ml = (await scan()).projects.filter((project) => project.variant !== undefined);
    expect(ml.map((project) => project.variant).sort()).toEqual(['cpu', 'gpu']);
    expect(new Set(ml.map((project) => project.id)).size).toBe(2);
  });

  /** A devcontainer.json in node_modules belongs to a dependency, not the user. */
  it('never descends into ignored directories', async () => {
    const result = await scan();
    expect(result.projects.some((project) => project.configPath.includes('node_modules'))).toBe(
      false,
    );
  });

  /**
   * `a/b/c/d/deep` sits five levels down, past the default of three. The fix
   * for a user in that position is to add `a/b` as a root, which is why the
   * roots UI exists at all — so the limit has to actually bite.
   */
  it('stops at the depth limit, and reaches past it when told to', async () => {
    const shallow = await scan();
    expect(shallow.projects.some((project) => project.name === 'too deep')).toBe(false);

    const deep = await scan({ maxDepth: 5 });
    expect(deep.projects.some((project) => project.name === 'too deep')).toBe(true);
  });

  it('points the folder at the project, not at .devcontainer', async () => {
    const api = (await scan()).projects.find((project) => project.name === 'Payments API');
    expect(api?.folder).toEqual({ kind: 'posix', path: join(root, 'code/api') });
  });

  it('reports a missing root instead of failing the whole scan', async () => {
    const result = await scan({
      roots: [
        { path: join(root, 'code'), source: 'default' },
        { path: join(root, 'nope'), source: 'user' },
      ],
    });
    expect(result.roots.map((entry) => entry.failure)).toEqual([undefined, 'missing']);
    expect(result.projects.length).toBeGreaterThan(0);
  });

  /** Two roots that nest are ordinary — $HOME and $HOME/work. */
  it('does not list a project twice when roots overlap', async () => {
    const result = await scan({
      roots: [
        { path: root, source: 'default' },
        { path: join(root, 'code'), source: 'user' },
      ],
    });
    expect(new Set(result.projects.map((project) => project.id)).size).toBe(result.projects.length);
  });

  it('says so when it gave up early rather than reporting a short list as complete', async () => {
    const result = await scan({ maxProjects: 1 });
    expect(result.truncated).toBe(true);
  });
});
