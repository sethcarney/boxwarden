import type { EditorId } from '../../models/index.js';
import type { EditorOption } from '../../shared/ipc.js';
import { ViewPicker } from '../components/ViewPicker.js';
import type { ViewPreferences } from '../view.js';

interface Props {
  /** "4 dev containers", already pluralised by the ViewModel. */
  readonly countLabel: string;
  /** "scanned 2 minutes ago", or undefined before the first reading. */
  readonly scannedLabel: string | undefined;
  readonly view: ViewPreferences;
  readonly onChangeView: (next: ViewPreferences) => void;
  readonly editors: readonly EditorOption[];
  readonly editorId: EditorId;
  readonly onChooseEditor: (id: EditorId) => void;
}

export function AppFooter({
  countLabel,
  scannedLabel,
  view,
  onChangeView,
  editors,
  editorId,
  onChooseEditor,
}: Props) {
  return (
    <footer className="app-foot">
      <span>
        {countLabel}
        {scannedLabel === undefined ? '' : ` · ${scannedLabel}`}
      </span>

      <div className="foot-right">
        <ViewPicker view={view} onChange={onChangeView} />

        <label className="editor-picker">
          Open in
          <select
            value={editorId}
            onChange={(event) => {
              onChooseEditor(event.target.value);
            }}
          >
            {editors.map((editor) => (
              <option key={editor.id} value={editor.id}>
                {editor.displayName}
                {editor.available ? '' : ' (not found)'}
              </option>
            ))}
          </select>
        </label>
      </div>
    </footer>
  );
}
