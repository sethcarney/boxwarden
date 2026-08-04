import { describe, expect, it } from 'vitest';
import { attachedEditorsIn, editorDisplayName, parseAttachedEditors } from './editor-session.js';

/** Docker's default `ps -ef` layout, which is what most of these arrive in. */
const TITLES = ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'];

function row(pid: string, command: string): readonly string[] {
  return ['vscode', pid, '1', '0', '10:31', '?', '00:00:01', command];
}

const VSCODE_SERVER =
  '/home/vscode/.vscode-server/bin/9f2c1ab/node /home/vscode/.vscode-server/bin/9f2c1ab/out/server-main.js --host=127.0.0.1';

describe('parseAttachedEditors', () => {
  it('finds a VS Code server', () => {
    expect(parseAttachedEditors(TITLES, [row('412', VSCODE_SERVER)])).toEqual({
      kind: 'attached',
      editors: ['vscode'],
    });
  });

  /**
   * One window is many processes — the server, the extension host, a pty host
   * per terminal — all carrying the same path. The question is which editors
   * are attached, not how many processes they run.
   */
  it('reports one editor however many of its processes are running', () => {
    const attachment = parseAttachedEditors(TITLES, [
      row('412', VSCODE_SERVER),
      row(
        '418',
        '/home/vscode/.vscode-server/bin/9f2c1ab/node --ms-enable-electron-run-as-node /home/vscode/.vscode-server/extensions/x/out/main.js',
      ),
      row(
        '455',
        '/home/vscode/.vscode-server/bin/9f2c1ab/node /home/vscode/.vscode-server/bin/9f2c1ab/out/ptyHost.js',
      ),
    ]);

    expect(attachment).toEqual({ kind: 'attached', editors: ['vscode'] });
  });

  it('tells the forks apart, and finds more than one at once', () => {
    const attachment = parseAttachedEditors(TITLES, [
      row(
        '412',
        '/home/dev/.cursor-server/bin/aa/node /home/dev/.cursor-server/bin/aa/out/server-main.js',
      ),
      row(
        '500',
        '/home/dev/.windsurf-server/bin/bb/node /home/dev/.windsurf-server/bin/bb/out/server-main.js',
      ),
    ]);

    expect(attachment.kind).toBe('attached');
    expect(attachment.kind === 'attached' && [...attachment.editors].sort()).toEqual([
      'cursor',
      'windsurf',
    ]);
  });

  /**
   * `.vscode-server-insiders` contains `.vscode-server` as a prefix, so the
   * order of the table is what keeps Insiders from being reported as stable.
   */
  it('does not report Insiders as stable VS Code', () => {
    expect(
      parseAttachedEditors(TITLES, [
        row(
          '412',
          '/home/vscode/.vscode-server-insiders/bin/cc/node /home/vscode/.vscode-server-insiders/bin/cc/out/server-main.js',
        ),
      ]),
    ).toEqual({ kind: 'attached', editors: ['vscode-insiders'] });
  });

  /**
   * The lesson `looksLikeClaudeCode` learned: a checkout with "vscode" in its
   * name runs plenty of commands containing the word, and a warning that fires
   * on those is one nobody believes by the second week. Matching a path
   * SEGMENT is what makes the difference.
   */
  it('does not fire on a command that merely mentions the word', () => {
    expect(
      parseAttachedEditors(TITLES, [
        row('412', 'node /workspaces/vscode-extensions/build.js'),
        row('413', 'grep -r vscode-server /workspaces/app'),
        row('414', 'bun run dev'),
      ]),
    ).toEqual({ kind: 'none' });
  });

  it("reads Podman's column layout, which names its command column differently", () => {
    const podman = ['USER', 'PID', 'PPID', '%CPU', 'ELAPSED', 'TTY', 'TIME', 'COMMAND'];
    expect(parseAttachedEditors(podman, [row('412', VSCODE_SERVER)])).toEqual({
      kind: 'attached',
      editors: ['vscode'],
    });
  });

  /**
   * Never a confident `none` for a table we could not read: this decorates a
   * destructive button, and "we could not tell" must not arrive as "nothing is
   * attached".
   */
  it('answers unknown for a table it cannot read', () => {
    expect(parseAttachedEditors(undefined, [])).toMatchObject({ kind: 'unknown' });
    expect(parseAttachedEditors([], [])).toMatchObject({ kind: 'unknown' });
    expect(parseAttachedEditors(['UID', 'PID'], [])).toMatchObject({ kind: 'unknown' });
    expect(parseAttachedEditors(TITLES, undefined)).toMatchObject({ kind: 'unknown' });
  });

  it('answers none for a table with nothing in it', () => {
    expect(parseAttachedEditors(TITLES, [])).toEqual({ kind: 'none' });
  });
});

describe('attachedEditorsIn', () => {
  it('unions a group, so Stop all weighs every member', () => {
    expect(
      attachedEditorsIn([
        { kind: 'attached', editors: ['vscode'] },
        { kind: 'none' },
        { kind: 'attached', editors: ['vscode', 'cursor'] },
        undefined,
      ]),
    ).toEqual(['vscode', 'cursor']);
  });

  it('counts nothing for statuses that are not an attachment', () => {
    expect(
      attachedEditorsIn([
        { kind: 'none' },
        { kind: 'not-applicable' },
        { kind: 'unknown', reason: 'x' },
      ]),
    ).toEqual([]);
  });
});

describe('editorDisplayName', () => {
  it('spells each flavour the way its vendor does', () => {
    expect(editorDisplayName('vscode')).toBe('VS Code');
    expect(editorDisplayName('vscode-insiders')).toBe('VS Code Insiders');
    expect(editorDisplayName('cursor')).toBe('Cursor');
  });
});
