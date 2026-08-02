import type { DevContainerRuntime } from '../../models/index.js';
import { statusDotClass } from '../format.js';

/**
 * The coloured dot. Colour comes from the domain's three-way `displayStatus`
 * rather than from the seven Docker states, so there is exactly one place
 * deciding that `paused` reads as live and `created` reads as stopped. It
 * arrives here already turned into a class by `format.ts` — the View renders
 * the answer and does not reach past the layer that computes it.
 */
export function StatusDot({ runtime }: { readonly runtime: DevContainerRuntime }) {
  return <span className={statusDotClass(runtime)} aria-hidden="true" />;
}
