import { useCallback, useEffect, useState } from 'react';
import type { EditorId } from '../../models/index.js';
import type { BoxwardenApi, EditorOption } from '../../shared/ipc.js';
import { useMounted } from './useMounted.js';

export interface EditorsViewModel {
  readonly editors: readonly EditorOption[];
  readonly editorId: EditorId;
  readonly selectedEditor: EditorOption | undefined;
  /** The name to put on a button. Falls back to VS Code before the list arrives. */
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly chooseEditor: (id: EditorId) => void;
}

/**
 * Which editors are installed, and which one the user is opening with.
 *
 * Read once — the set of editors on a machine does not change while the app is
 * open, so this is not part of the five-second poll.
 */
export function useEditors(api: BoxwardenApi | undefined): EditorsViewModel {
  const [editors, setEditors] = useState<readonly EditorOption[]>([]);
  const [editorId, setEditorId] = useState<EditorId>('vscode');
  const mounted = useMounted();

  useEffect(() => {
    if (api === undefined) return;
    void api.listEditors().then(
      (found) => {
        if (!mounted.current) return;
        setEditors(found);
        // Default to the first editor actually installed rather than to VS Code
        // unconditionally — on a machine with only Cursor, defaulting to VS Code
        // means every card opens with its primary action disabled.
        const firstAvailable = found.find((editor) => editor.available);
        if (firstAvailable !== undefined) setEditorId(firstAvailable.id);
      },
      () => {
        // A bridge that cannot list editors leaves the default in place; the
        // per-card "not found" hint already explains a disabled Open button,
        // and a notice here would fire before the user has done anything.
      },
    );
  }, [api, mounted]);

  const chooseEditor = useCallback((id: EditorId) => {
    setEditorId(id);
  }, []);

  const selectedEditor = editors.find((editor) => editor.id === editorId);

  return {
    editors,
    editorId,
    selectedEditor,
    editorName: selectedEditor?.displayName ?? 'VS Code',
    editorAvailable: selectedEditor?.available ?? false,
    chooseEditor,
  };
}
