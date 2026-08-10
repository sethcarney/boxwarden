import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DesktopWindow, EditorWindowCriteria } from './index.js';
import { matchEditorWindows } from './index.js';

/**
 * The property this feature's safety rests on.
 *
 * Closing a window is the one irreversible thing boxwarden does to something it
 * does not own — the container it stops can be started again, the branch it
 * switches can be switched back, but a window it closes takes whatever was on
 * screen with it. So the example tests in `editor-window.test.ts` name the
 * confusions somebody thought of (`warden` inside `boxwarden`, `not-boxwarden`
 * behind a hyphen, Cursor's window on a VS Code container), and this file looks
 * for the one nobody did.
 *
 * The claim is deliberately one-sided. It says nothing about what SHOULD match
 * — a false negative here costs a stranded window, which is where this feature
 * started — and everything about what must not.
 */

const unspaced = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((value) => !/\s/.test(value) && value.trim() !== '');

function criteriaFor(names: readonly string[]): EditorWindowCriteria {
  return { names, editors: ['vscode'] };
}

function vscodeWindow(title: string): DesktopWindow {
  return { handle: '1', process: 'Code', title };
}

describe('matchEditorWindows never matches a container it was not asked about', () => {
  it('will not match a workspace whose name simply is not ours', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), unspaced, unspaced, (prefix, workspace, name) => {
        fc.pre(workspace.toLowerCase() !== name.toLowerCase());

        // Both the window's workspace name and ours are whitespace-free, so the
        // trailing token of the title IS the workspace name — and the only way
        // the boundary rule can accept it is if the two are the same string.
        const title = `${prefix} ${workspace} [Dev Container: whatever] - Visual Studio Code`;
        expect(matchEditorWindows([vscodeWindow(title)], criteriaFor([name]))).toEqual([]);
      }),
    );
  });

  it('will not match any title without the remote marker, whatever else is in it', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), unspaced, (title, name) => {
        fc.pre(!title.includes('[Dev Container'));
        expect(matchEditorWindows([vscodeWindow(title)], criteriaFor([name]))).toEqual([]);
      }),
    );
  });

  it('will not match a process that is not an editor, however right the title is', () => {
    fc.assert(
      fc.property(unspaced, fc.string({ minLength: 1, maxLength: 20 }), (name, process) => {
        fc.pre(!['code', 'cursor', 'windsurf'].includes(process.trim().toLowerCase()));
        fc.pre(!process.toLowerCase().startsWith('code -'));
        fc.pre(!process.toLowerCase().startsWith('code-'));
        fc.pre(!process.toLowerCase().startsWith('visual studio code'));

        const title = `${name} [Dev Container: x] - Visual Studio Code`;
        expect(matchEditorWindows([{ handle: '1', process, title }], criteriaFor([name]))).toEqual(
          [],
        );
      }),
    );
  });

  it('will not match anything at all when the container named no folder', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (title) => {
        expect(matchEditorWindows([vscodeWindow(title)], criteriaFor([]))).toEqual([]);
      }),
    );
  });
});
