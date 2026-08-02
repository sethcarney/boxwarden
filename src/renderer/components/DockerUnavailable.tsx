import type { DockerEnvironment } from '../../models/index.js';
import { describeTarget, explainFailure, runtimeLabel } from '../format.js';

/**
 * The evidence, shown when no container engine could be reached.
 *
 * It lists EVERY candidate that was tried, which is the whole reason
 * `DockerEnvironment.attempts` exists. Probing five sockets and reporting only
 * "couldn't connect to Docker" is what makes this class of tool infuriating:
 * the user cannot tell whether Docker is missing, stopped, or listening on a
 * socket the app never looked at. Showing the list turns a support thread into
 * a glance.
 *
 * This panel is the DIAGNOSIS; the fix lives above it in <Advisories>, built
 * from the same environment by src/domain/advice.ts. The split is worth
 * keeping: a user who needs to be told to run `wsl --install` should not have
 * to read six socket paths first, and a user debugging something unusual needs
 * the socket paths and will not be helped by advice.
 */
export function DockerUnavailable({ environment }: { readonly environment: DockerEnvironment }) {
  if (environment.api.ok) return null;

  const headline = explainFailure(
    environment.api.failure,
    describeEndpoint(environment.api.endpoint),
  );

  return (
    <section className="panel panel-error">
      <h2>Can’t reach a container engine</h2>
      <p className="lede">{headline}</p>

      <details open={environment.attempts.length > 1}>
        <summary>Everything boxwarden tried ({environment.attempts.length})</summary>
        <ul className="attempts">
          {environment.attempts.map((attempt, index) => (
            <li key={`${describeEndpoint(attempt.endpoint)}-${index}`}>
              <code>{describeEndpoint(attempt.endpoint)}</code>
              <span className="origin">{describeOrigin(attempt.endpoint.origin)}</span>
              <span className={attempt.ok ? 'ok' : 'fail'}>
                {attempt.ok
                  ? `ok — ${runtimeLabel(attempt.runtime)} ${attempt.serverVersion}`
                  : attempt.failure.code}
              </span>
            </li>
          ))}
        </ul>
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

function describeEndpoint(endpoint: DockerEnvironment['api']['endpoint']): string {
  return describeTarget(endpoint.transport);
}

function describeOrigin(origin: DockerEnvironment['api']['endpoint']['origin']): string {
  switch (origin.kind) {
    case 'env':
      return `from ${origin.variable}`;
    case 'well-known':
      return origin.runtime;
    case 'wsl':
      return `WSL: ${origin.distro}`;
    case 'manual':
      return origin.label ?? 'manual';
  }
}
