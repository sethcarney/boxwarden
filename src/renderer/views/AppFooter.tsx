import type { EditorId, TerminalId } from '../../models/index.js';
import type { EditorOption, TerminalOption } from '../../shared/ipc.js';
import { ViewPicker } from '../components/ViewPicker.js';
import type { UpdateSummary } from '../presenters.js';
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
  readonly terminals: readonly TerminalOption[];
  readonly terminalId: TerminalId | undefined;
  /**
   * False when nothing was found. Hidden rather than shown empty: on a machine
   * with no emulator this app knows about, an empty picker is a puzzle, and the
   * card's Terminal button already carries the explanation in its tooltip.
   */
  readonly showTerminalPicker: boolean;
  readonly onChooseTerminal: (id: TerminalId) => void;
  /**
   * The version this is, and what the last release check found — one line,
   * already worded by `updateSummary` for all six arms of the status.
   *
   * Always rendered, including when everything is current. It is the only
   * place boxwarden says which version it is, and it is the way back from
   * "Stop checking for updates": a setting with no visible off state is a
   * setting nobody can reverse.
   */
  readonly update: UpdateSummary;
  readonly updateBusy: boolean;
  /** Check now — and turn the daily check back on, if it was off. */
  readonly onUpdateAction: () => void;
}

export function AppFooter({
  countLabel,
  scannedLabel,
  view,
  onChangeView,
  editors,
  editorId,
  onChooseEditor,
  terminals,
  terminalId,
  showTerminalPicker,
  onChooseTerminal,
  update,
  updateBusy,
  onUpdateAction,
}: Props) {
  return (
    <footer className="app-foot">
      <span>
        {countLabel}
        {scannedLabel === undefined ? '' : ` · ${scannedLabel}`}
      </span>

      <button
        type="button"
        className="link foot-update"
        title={update.title}
        onClick={onUpdateAction}
        disabled={updateBusy}
      >
        {update.label}
      </button>

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

        {showTerminalPicker && (
          <label className="editor-picker">
            Terminal
            <select
              value={terminalId ?? ''}
              onChange={(event) => {
                onChooseTerminal(event.target.value);
              }}
            >
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.displayName}
                  {terminal.available ? '' : ' (not found)'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </footer>
  );
}
