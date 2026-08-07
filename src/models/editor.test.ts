import { describe, expect, it } from 'vitest';
import { editorOverride, editorOverrideVariable } from './editor.js';

describe('editorOverride', () => {
  it('names the variable from the id', () => {
    expect(editorOverrideVariable('cursor')).toBe('BOXWARDEN_EDITOR_CURSOR');
    expect(editorOverrideVariable('vscode-insiders')).toBe('BOXWARDEN_EDITOR_VSCODE_INSIDERS');
  });

  it('turns a set variable into an explicit-path strategy', () => {
    expect(editorOverride('cursor', { BOXWARDEN_EDITOR_CURSOR: 'C:\\x\\cursor.cmd' })).toEqual({
      kind: 'explicit-path',
      binaryPath: 'C:\\x\\cursor.cmd',
    });
  });

  it('ignores an unset or blank variable', () => {
    expect(editorOverride('cursor', {})).toBeUndefined();
    expect(editorOverride('cursor', { BOXWARDEN_EDITOR_CURSOR: '   ' })).toBeUndefined();
  });

  it('does not let one editor’s override reach another', () => {
    expect(editorOverride('windsurf', { BOXWARDEN_EDITOR_CURSOR: '/x' })).toBeUndefined();
  });
});
