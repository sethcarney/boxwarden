import type { LayoutMode, Theme, ViewPreferences } from '../view.js';
import { LAYOUT_MODES, THEMES } from '../view.js';

interface Props {
  readonly view: ViewPreferences;
  readonly onChange: (view: ViewPreferences) => void;
}

/**
 * Layout and theme, in the footer.
 *
 * The header is for controls that change WHAT IS IN THE LIST — the engine
 * picker is there because it decides which containers exist at all. These two
 * change only how the same list is drawn, which puts them next to the editor
 * picker at the bottom, out of the way of the thing being looked at.
 */
const LAYOUTS: Record<LayoutMode, { readonly label: string; readonly hint: string }> = {
  grid: {
    label: 'Grid',
    hint: 'Cards in as many columns as the window fits.',
  },
  list: {
    label: 'List',
    hint: 'One full-width card per container, with every detail shown.',
  },
  rows: {
    label: 'Rows',
    hint: 'One line per container — the most that fits in a small window.',
  },
};

const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
  auto: 'Match system',
};

export function ViewPicker({ view, onChange }: Props) {
  return (
    <div className="view-picker">
      {/*
       * A segmented control rather than a fourth <select>: there are three
       * options, they are switched between while looking at the result, and a
       * dropdown would hide two thirds of the answer behind a click.
       */}
      <div className="segmented" role="group" aria-label="Layout">
        {LAYOUT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={mode === view.layout ? 'segment segment-on' : 'segment'}
            aria-pressed={mode === view.layout}
            title={LAYOUTS[mode].hint}
            onClick={() => {
              onChange({ ...view, layout: mode });
            }}
          >
            {LAYOUTS[mode].label}
          </button>
        ))}
      </div>

      <label className="theme-picker">
        Theme
        <select
          value={view.theme}
          onChange={(event) => {
            onChange({ ...view, theme: event.target.value as Theme });
          }}
        >
          {THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {THEME_LABELS[theme]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
