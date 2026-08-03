import type { EngineSelection, EngineSummary } from '../../models/index.js';
import type { SetupBadge } from '../advisories.js';
import { EnginePicker } from '../components/EnginePicker.js';
import type { EngineChip } from '../presenters.js';
import type { AppPage } from '../viewmodels/useAdvisories.js';

interface Props {
  /** Undefined until the first reading arrives; the picker and chip wait for it. */
  readonly engines: readonly EngineSummary[] | undefined;
  readonly selection: EngineSelection | undefined;
  readonly engine: EngineChip | undefined;
  readonly pickerDisabled: boolean;
  readonly page: AppPage;
  readonly setup: SetupBadge;
  readonly onNavigate: (page: AppPage) => void;
  readonly onSelectEngine: (selection: EngineSelection) => void;
  readonly onRefresh: () => void;
}

export function AppHeader({
  engines,
  selection,
  engine,
  pickerDisabled,
  page,
  setup,
  onNavigate,
  onSelectEngine,
  onRefresh,
}: Props) {
  return (
    <header className="app-head">
      <h1>boxwarden</h1>

      {/*
       * Two pages, so a segmented control rather than a router — the same
       * spelling the layout picker uses. It sits next to the title and not in
       * the footer because it changes WHICH SCREEN this is, which is the one
       * thing in this header that is not about the container list.
       *
       * The Setup tab is always here, including on a machine where nothing is
       * wrong. A page reachable only when something is broken is no use to the
       * user working out why an engine they know is running is missing — and it
       * is where every hidden advisory lives, so it can never be a dead end.
       */}
      <nav className="segmented app-nav" aria-label="Screen">
        <button
          type="button"
          className={page === 'containers' ? 'segment segment-on' : 'segment'}
          aria-current={page === 'containers' ? 'page' : undefined}
          onClick={() => {
            onNavigate('containers');
          }}
        >
          Containers
        </button>
        <button
          type="button"
          className={page === 'setup' ? 'segment segment-on' : 'segment'}
          aria-current={page === 'setup' ? 'page' : undefined}
          title={setup.title}
          onClick={() => {
            onNavigate('setup');
          }}
        >
          Setup
          {setup.count > 0 && (
            <span className={`nav-count nav-count-${setup.tone}`}>{setup.count}</span>
          )}
        </button>
      </nav>

      <div className="head-right">
        {engines !== undefined && selection !== undefined && (
          <EnginePicker
            engines={engines}
            selection={selection}
            disabled={pickerDisabled}
            onChange={onSelectEngine}
          />
        )}
        {engine !== undefined && (
          <span className={`chip ${engine.ok ? 'chip-ok' : 'chip-fail'}`} title={engine.title}>
            {engine.label}
          </span>
        )}
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </header>
  );
}
