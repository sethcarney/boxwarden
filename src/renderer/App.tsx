import { useAppViewModel } from './viewmodels/index.js';
import { AppView } from './views/AppView.js';

/**
 * The composition root.
 *
 * One line of ViewModel, one line of View, and deliberately nothing else: the
 * state, the polling and the IPC orchestration that used to live here are in
 * `viewmodels/`, and the markup is in `views/`. Keeping this file empty is what
 * makes both halves testable on their own — the ViewModel with `renderHook` and
 * no DOM, the Views with fixed props and no bridge.
 */
export function App() {
  const vm = useAppViewModel();
  return <AppView vm={vm} />;
}
