import type { DockerEnvironment } from '../../models/index.js';
import { describeTarget, explainFailure } from '../format.js';
import { EndpointAttempts } from './EndpointAttempts.js';

/**
 * The evidence, shown when no container engine could be reached.
 *
 * It lists EVERY candidate that was tried, which is the whole reason
 * `DockerEnvironment.attempts` exists — see `<EndpointAttempts>`, which draws
 * that list here and again on the setup page.
 *
 * This panel is the DIAGNOSIS; the fix lives above it in <Advisories>, built
 * from the same environment by src/models/advice.ts. The split is worth
 * keeping: a user who needs to be told to run `wsl --install` should not have
 * to read six socket paths first, and a user debugging something unusual needs
 * the socket paths and will not be helped by advice.
 */
export function DockerUnavailable({ environment }: { readonly environment: DockerEnvironment }) {
  if (environment.api.ok) return null;

  const headline = explainFailure(
    environment.api.failure,
    describeTarget(environment.api.endpoint.transport),
  );

  return (
    <section className="panel panel-error">
      <h2>Can’t reach a container engine</h2>
      <p className="lede">{headline}</p>

      <details open={environment.attempts.length > 1}>
        <summary>Everything boxwarden tried ({environment.attempts.length})</summary>
        <EndpointAttempts attempts={environment.attempts} />
      </details>

      {!environment.cli.ok && (
        <p className="note">
          The <code>docker</code> command was also not found on your PATH ({environment.cli.code}).
          Nothing in boxwarden needs it yet, but rebuilding and creating containers will.
        </p>
      )}

      <p className="note">
        If you are running boxwarden inside a dev container, it talks to whichever daemon the
        mounted socket belongs to — see <code>docs/architecture.md</code>.
      </p>
    </section>
  );
}
