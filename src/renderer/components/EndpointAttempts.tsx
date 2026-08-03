import type { DockerEnvironment, EndpointProbe } from '../../models/index.js';
import { describeTarget, runtimeLabel } from '../format.js';

/**
 * Every socket boxwarden tried, and what each one said.
 *
 * This is the whole reason `DockerEnvironment.attempts` keeps the losers as
 * well as the winner. Probing six candidates and reporting only "couldn't
 * connect to Docker" is what makes this class of tool infuriating: the user
 * cannot tell whether the engine is missing, stopped, or listening on a socket
 * the app never looked at.
 *
 * Extracted from `DockerUnavailable` because it is wanted in two places that
 * mean different things. There it is EVIDENCE FOR A FAILURE and only renders
 * when nothing answered; on the setup page it is a standing inventory, shown
 * while everything is working — which is when it answers the other question
 * this list is good for: "boxwarden can see one of my two engines, which one
 * did it miss?"
 */
export function EndpointAttempts({
  attempts,
}: {
  readonly attempts: DockerEnvironment['attempts'];
}) {
  return (
    <ul className="attempts">
      {attempts.map((attempt, index) => (
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
  );
}

function describeEndpoint(endpoint: EndpointProbe['endpoint']): string {
  return describeTarget(endpoint.transport);
}

function describeOrigin(origin: EndpointProbe['endpoint']['origin']): string {
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
