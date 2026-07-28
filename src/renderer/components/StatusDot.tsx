import type { DevContainerRuntime } from '../../domain/index.js';
import { displayStatus } from '../../domain/index.js';

/**
 * The coloured dot. Colour comes from the domain's three-way `displayStatus`
 * rather than from the seven Docker states, so there is exactly one place
 * deciding that `paused` reads as live and `created` reads as stopped.
 */
export function StatusDot({ runtime }: { readonly runtime: DevContainerRuntime }) {
  const status = displayStatus(runtime);
  return <span className={`dot dot-${status}`} aria-hidden="true" />;
}
