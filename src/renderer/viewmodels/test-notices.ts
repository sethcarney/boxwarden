import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type { NoticesViewModel } from './useNotices.js';

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
  readonly showOpenFailure: Mock<(message: string, uri: string | undefined) => void>;
  readonly rememberFailedUri: Mock<(uri: string | undefined) => void>;
  readonly copyFailedUri: Mock<() => void>;
  readonly dismiss: Mock<() => void>;
}

export function stubNotices(): StubNotices {
  return {
    notice: undefined,
    lastFailedUri: undefined,
    showInfo: vi.fn<(message: string) => void>(),
    showError: vi.fn<(message: string) => void>(),
    showThrown: vi.fn<(error: unknown) => void>(),
    showOpenFailure: vi.fn<(message: string, uri: string | undefined) => void>(),
    rememberFailedUri: vi.fn<(uri: string | undefined) => void>(),
    copyFailedUri: vi.fn<() => void>(),
    dismiss: vi.fn<() => void>(),
  };
}
