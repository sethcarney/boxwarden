import type { DockerEnvironment } from '../../domain/index.js';
import { explainFailure } from '../format.js';

/**
 * The screen shown when Docker could not be reached.
 *
 * It lists EVERY candidate that was tried, which is the whole reason
 * `DockerEnvironment.attempts` exists. Probing five sockets and reporting only
 * "couldn't connect to Docker" is what makes this class of tool infuriating:
 * the user cannot tell whether Docker is missing, stopped, or listening on a
 * socket the app never looked at. Showing the list turns a support thread into
 * a glance.
 */
export function DockerUnavailable({ environment }: { readonly environment: DockerEnvironment }) {
  if (environment.api.ok) return null;

  const headline = explainFailure(
    environment.api.failure,
    describeEndpoint(environment.api.endpoint),
  );

  return (
    <section className="panel panel-error">
      <h2>Can’t reach Docker</h2>
      <p className="lede">{headline}</p>

      <details open={environment.attempts.length > 1}>
        <summary>Everything boxwarden tried ({environment.attempts.length})</summary>
        <ul className="attempts">
          {environment.attempts.map((attempt, index) => (
            <li key={`${describeEndpoint(attempt.endpoint)}-${index}`}>
              <code>{describeEndpoint(attempt.endpoint)}</code>
              <span className="origin">{describeOrigin(attempt.endpoint.origin)}</span>
              <span className={attempt.ok ? 'ok' : 'fail'}>
                {attempt.ok ? `ok — Docker ${attempt.serverVersion}` : attempt.failure.code}
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
  const { transport } = endpoint;
  switch (transport.transport) {
    case 'unix':
      return transport.socketPath;
    case 'npipe':
      return transport.pipeName;
    case 'tcp':
      return `tcp://${transport.host}:${transport.port}`;
    case 'ssh':
      return `ssh://${transport.host}`;
  }
}

function describeOrigin(origin: DockerEnvironment['api']['endpoint']['origin']): string {
  switch (origin.kind) {
    case 'env':
      return `from ${origin.variable}`;
    case 'well-known':
      return origin.runtime;
    case 'manual':
      return origin.label ?? 'manual';
  }
}
