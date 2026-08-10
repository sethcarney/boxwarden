/**
 * Print every top-level window this machine will let boxwarden see, and say
 * which ones the Stop button would consider closing.
 *
 * Run it with bun, on the HOST — not inside the dev container, which has no
 * desktop at all:
 *
 *     bun run debug:windows
 *
 * This exists because "boxwarden could not find its window to close it" is a
 * dead end otherwise. The matcher is a pure function over three strings — the
 * process name, the window title, and the container's own folder name — and
 * when it answers no, the only useful next question is which of the three did
 * not look the way this app expects. So this prints all of them, unfiltered,
 * beside the verdict.
 *
 * It imports the SAME backends and the SAME matcher the app uses rather than
 * reimplementing them, which is the whole point: a debug tool that agrees with
 * the code only by coincidence is a debug tool that lies exactly when it
 * matters. Nothing in `src/main/window/` imports Electron, so bun can run it
 * directly.
 *
 * It only ever LISTS. Nothing here closes anything.
 */

import { parseDevContainerTitle, windowFlavour } from '../src/models/editor-window.js';
import { desktopBackend } from '../src/main/window/close.js';

const backend = await desktopBackend();

if (!backend.ok) {
  console.error(`This desktop cannot be asked: ${backend.unsupported.reason}`);
  process.exit(1);
}

const windows = await backend.backend.list();
console.log(`${String(windows.length)} window(s) enumerated on ${process.platform}.\n`);

const editors = windows.filter((window) => windowFlavour(window.process) !== undefined);

console.log('--- windows belonging to an editor boxwarden recognises ---');
if (editors.length === 0) {
  console.log('(none)');
  console.log('\nIf an editor IS open, its process name is not one boxwarden knows.');
  console.log('Every process name seen, so the table in editor-window.ts can be fixed:');
  console.log([...new Set(windows.map((window) => window.process))].sort().join('\n'));
} else {
  for (const window of editors) {
    const title = parseDevContainerTitle(window.title);
    console.log(`\nprocess     ${window.process}  (${String(windowFlavour(window.process))})`);
    console.log(`title       ${window.title}`);
    console.log(
      title === undefined
        ? 'marker      NOT FOUND — no "[Dev Container" in this title, so it is never a candidate'
        : `marker      found\nbeforeMarker "${title.beforeMarker}"  <- the workspace name must be the END of this\nlabel       ${title.label ?? '(none)'}`,
    );
  }
}

console.log('\n--- every other window, for completeness ---');
for (const window of windows) {
  if (windowFlavour(window.process) !== undefined) continue;
  console.log(`${window.process}\t${window.title}`);
}
