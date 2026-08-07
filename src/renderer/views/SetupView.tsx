import type { DockerEnvironment } from '../../models/index.js';
import type { EditorOption } from '../../shared/ipc.js';
import { Advisories } from '../components/Advisories.js';
import { EditorInventory } from '../components/EditorInventory.js';
import { EndpointAttempts } from '../components/EndpointAttempts.js';
import type { AdvisoriesViewModel } from '../viewmodels/useAdvisories.js';

interface Props {
  readonly advisories: AdvisoriesViewModel;
  /** Every editor boxwarden probed, with the binary it resolved to. */
  readonly editors: readonly EditorOption[];
  /** Undefined until the first scan lands; the diagnostics say so rather than showing an empty list. */
  readonly environment: DockerEnvironment | undefined;
  /** "scanned 2 minutes ago", already formatted by the ViewModel. */
  readonly scannedLabel: string | undefined;
}

/**
 * The second screen: everything boxwarden knows about this machine's setup.
 *
 * WHY IT EXISTS
 *
 * Hiding an advisory is only a defensible thing to offer if the advisory
 * survives being hidden. This page is where it survives. It lists what is
 * active and what has been put away, both in full, and it is reachable from the
 * header whether or not anything is wrong — a page you can only get to when
 * something is broken is no use to the user trying to work out why boxwarden
 * cannot see the engine they know is running.
 *
 * The diagnostics below the advice are shown here EVEN WHEN EVERYTHING WORKS,
 * which is the difference between this and `<DockerUnavailable>`. That panel is
 * evidence for a failure. This one answers the question a working app can still
 * provoke: boxwarden found one of my two engines — which one did it miss, and
 * what did that socket say?
 */
export function SetupView({ advisories, editors, environment, scannedLabel }: Props) {
  return (
    <div className="setup">
      <section className="panel" aria-label="Setup advice">
        <h2>Setup</h2>
        <p className="lede">{advisories.summary}</p>
      </section>

      {/*
       * `onHide` and not `onRestore`: hiding from here is still safe, because
       * the card lands in the list below rather than leaving the page.
       */}
      <Advisories advice={advisories.active} label="Active advice" onHide={advisories.hide} />

      {advisories.hidden.length > 0 && (
        <section className="panel setup-hidden" aria-label="Hidden advice">
          <header className="projects-head">
            <h2>Hidden ({advisories.hidden.length})</h2>
            <button type="button" className="link" onClick={advisories.restoreAll}>
              Show all again
            </button>
          </header>
          <p className="note">
            These are off the main screen and still true. boxwarden keeps computing them, and this
            page keeps showing them.
          </p>
          {/*
           * No `onHide` here — the card is already hidden, and a Hide button on
           * it would be the one control in this app that does nothing.
           */}
          <Advisories
            advice={advisories.hidden}
            label="Advice hidden from the main screen"
            onRestore={advisories.restore}
          />
        </section>
      )}

      <section className="panel" aria-label="Editors found">
        <h2>Which editor boxwarden would launch</h2>
        <p className="lede">
          The exact binary each editor resolved to, and how it was found. An editor ships a
          command-line launcher beside its application executable and the two do not always accept
          the same arguments, so when “Open in …” produces a window with no folder in it, this is
          the first thing to check.
        </p>
        <EditorInventory editors={editors} />
      </section>

      <section className="panel" aria-label="Container engine diagnostics">
        <h2>How boxwarden looked for a container engine</h2>
        {environment === undefined ? (
          <p className="lede">Looking for a container engine…</p>
        ) : (
          <>
            <p className="lede">
              Every socket that was tried on the last scan, and what each one answered
              {scannedLabel === undefined ? '' : ` — ${scannedLabel}`}.
            </p>
            <EndpointAttempts attempts={environment.attempts} />
            <p className="note">
              A socket that answered is connected to and its containers unioned in, whatever the
              engine picker is set to — the picker narrows what is LISTED, not what is probed.
            </p>
            {!environment.cli.ok && (
              <p className="note">
                The <code>docker</code> command was not found on your PATH ({environment.cli.code}).
                Nothing boxwarden does today needs it; rebuilding and creating containers will.
              </p>
            )}
            <p className="note">
              If you are running boxwarden inside a dev container, it talks to whichever daemon the
              mounted socket belongs to — see <code>docs/architecture.md</code>.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
