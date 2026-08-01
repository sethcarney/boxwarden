/**
 * Shown when `window.boxwarden` is undefined.
 *
 * A build problem, not a Docker problem, and worth its own screen: the
 * alternative symptom is an empty container list, which a user reasonably reads
 * as "this machine has no dev containers".
 */
export function BridgeMissing() {
  return (
    <main className="app">
      <section className="panel panel-error">
        <h2>The preload bridge did not load</h2>
        <p className="lede">
          <code>window.boxwarden</code> is undefined, so the UI has no way to reach Docker. This is
          a build problem, not a Docker problem — the preload script failed to load.
        </p>
        <p className="note">
          The usual cause is a preload built as ESM while the window has <code>sandbox: true</code>,
          which requires CommonJS. See the notes in <code>electron.vite.config.ts</code>.
        </p>
      </section>
    </main>
  );
}
