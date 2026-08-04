import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type { CopyableFallback, NoticesViewModel } from './useNotices.js';

/**
 * A recording stand-in for the notices ViewModel.
 *
 * `useDiscovery` and `useProjects` report through it rather than owning their
 * own message state, so the tests for those two assert on these spies instead
 * of standing up the real hook — which is the point of passing it in.
 */
export interface StubNotices extends NoticesViewModel {
  readonly showInfo: Mock<(message: string) => void>;
  readonly showError: Mock<(message: string) => void>;
  readonly showThrown: Mock<(error: unknown) => void>;
  readonly showLaunchFailure: Mock<
    (message: string, fallback: CopyableFallback | undefined) => void
  >;
  readonly rememberFallback: Mock<(fallback: CopyableFallback | undefined) => void>;
  readonly copyFallback: Mock<() => void>;
  readonly dismiss: Mock<() => void>;
}

export function stubNotices(): StubNotices {
  return {
    notice: undefined,
    fallback: undefined,
    showInfo: vi.fn<(message: string) => void>(),
    showError: vi.fn<(message: string) => void>(),
    showThrown: vi.fn<(error: unknown) => void>(),
    showLaunchFailure: vi.fn<(message: string, fallback: CopyableFallback | undefined) => void>(),
    rememberFallback: vi.fn<(fallback: CopyableFallback | undefined) => void>(),
    copyFallback: vi.fn<() => void>(),
    dismiss: vi.fn<() => void>(),
  };
}
