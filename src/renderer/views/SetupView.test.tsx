// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  Advice,
  AdviceSeverity,
  DockerEndpoint,
  DockerEnvironment,
  EndpointProbe,
} from '../../models/index.js';
import { partitionAdvice, setupBadge, setupSummary } from '../advisories.js';
import type { AdvisoriesViewModel } from '../viewmodels/index.js';
import { SetupView } from './SetupView.js';

/**
 * A View test: a hand-built `AdvisoriesViewModel`, asserting only on what is
 * rendered. The partition itself is tested in `advisories.test.ts` and the
 * hiding state machine in `viewmodels/useAdvisories.test.ts`; the real pure
 * functions are used to build the stub so the two cannot drift apart.
 */

function advice(id: string, severity: AdviceSeverity = 'info'): Advice {
  return {
    id,
    severity,
    title: `${id} title`,
    body: `${id} body`,
    commands: [],
    links: [],
  };
}

function endpoint(socketPath: string): DockerEndpoint {
  return {
    transport: { transport: 'unix', socketPath },
    origin: { kind: 'well-known', runtime: 'docker-engine' },
  };
}

function environment(attempts: readonly EndpointProbe[]): DockerEnvironment {
  const first = attempts[0];
  if (first === undefined) throw new Error('need at least one attempt');
  return {
    api: first,
    cli: { ok: true, binaryPath: 'docker', version: '29.3.1' },
    attempts,
    wsl: { kind: 'not-applicable' },
  };
}

const CONNECTED: EndpointProbe = {
  ok: true,
  endpoint: endpoint('/var/run/docker.sock'),
  serverVersion: '29.3.1',
  apiVersion: '1.51',
  runtime: 'docker-engine',
};

const MISSING: EndpointProbe = {
  ok: false,
  endpoint: endpoint('/run/user/1000/podman/podman.sock'),
  failure: { code: 'not-present', detail: 'ENOENT' },
};

interface VmOptions {
  readonly all?: readonly Advice[];
  readonly hiddenIds?: readonly string[];
  readonly restore?: (id: string) => void;
  readonly restoreAll?: () => void;
  readonly hide?: (id: string) => void;
}

function advisoriesVm(options: VmOptions = {}): AdvisoriesViewModel {
  const all = options.all ?? [];
  const partition = partitionAdvice(all, options.hiddenIds ?? []);
  return {
    page: 'setup',
    navigate: vi.fn(),
    all,
    active: partition.active,
    hidden: partition.hidden,
    badge: setupBadge(partition),
    summary: setupSummary(partition),
    hide: options.hide ?? vi.fn(),
    restore: options.restore ?? vi.fn(),
    restoreAll: options.restoreAll ?? vi.fn(),
  };
}

function renderPage(options: VmOptions = {}, env?: DockerEnvironment) {
  return render(
    <SetupView
      advisories={advisoriesVm(options)}
      environment={env}
      scannedLabel="scanned 2 minutes ago"
    />,
  );
}

describe('SetupView', () => {
  /**
   * The whole reason this page exists. Hiding an advisory is only defensible
   * if the advisory survives being hidden, and this is where it survives.
   */
  it('lists a hidden advisory in full, body and all', () => {
    renderPage({ all: [advice('docker-cli-missing')], hiddenIds: ['docker-cli-missing'] });
    expect(screen.getByText('docker-cli-missing title')).toBeDefined();
    // Collapsed by default for a note; opening it must reach the real text.
    fireEvent.click(screen.getByRole('button', { name: 'docker-cli-missing title' }));
    expect(screen.getByText('docker-cli-missing body')).toBeDefined();
  });

  it('offers to put one back', () => {
    const restore = vi.fn();
    renderPage({ all: [advice('a')], hiddenIds: ['a'], restore });
    fireEvent.click(screen.getByText('Show again'));
    expect(restore).toHaveBeenCalledWith('a');
  });

  it('offers to put all of them back at once', () => {
    const restoreAll = vi.fn();
    renderPage({ all: [advice('a'), advice('b')], hiddenIds: ['a', 'b'], restoreAll });
    expect(screen.getByText('Hidden (2)')).toBeDefined();
    fireEvent.click(screen.getByText('Show all again'));
    expect(restoreAll).toHaveBeenCalled();
  });

  /**
   * A Hide button on an already-hidden card would be the one control in this
   * app that does nothing.
   */
  it('does not offer to hide an advisory that is already hidden', () => {
    renderPage({ all: [advice('a')], hiddenIds: ['a'] });
    expect(screen.queryByText('Hide')).toBeNull();
  });

  /** Hiding from here is still safe — the card lands in the list below. */
  it('still offers to hide an active advisory', () => {
    const hide = vi.fn();
    renderPage({ all: [advice('a')], hide });
    fireEvent.click(screen.getByText('Hide'));
    expect(hide).toHaveBeenCalledWith('a');
  });

  it('says nothing about hidden advice when none is hidden', () => {
    renderPage({ all: [advice('a')] });
    expect(screen.queryByLabelText('Advice hidden from the main screen')).toBeNull();
  });

  /**
   * The difference between this page and <DockerUnavailable>: that panel is
   * evidence for a failure, this list is a standing inventory. A user whose
   * second engine is missing from a working app has no other way to see which
   * socket boxwarden did not find.
   */
  it('shows every socket that was tried even when an engine answered', () => {
    renderPage({}, environment([CONNECTED, MISSING]));
    expect(screen.getByText('ok — Docker 29.3.1')).toBeDefined();
    expect(screen.getByText('/run/user/1000/podman/podman.sock')).toBeDefined();
    expect(screen.getByText('not-present')).toBeDefined();
  });

  it('says it is still looking rather than showing an empty socket list', () => {
    renderPage({});
    expect(screen.getByText('Looking for a container engine…')).toBeDefined();
  });

  it('mentions the missing docker CLI only when it is actually missing', () => {
    const { unmount } = renderPage({}, environment([CONNECTED]));
    expect(screen.queryByText(/was not found on your PATH/)).toBeNull();
    unmount();

    renderPage({}, { ...environment([CONNECTED]), cli: { ok: false, code: 'not-on-path' } });
    expect(screen.getByText(/was not found on your PATH/)).toBeDefined();
  });

  /**
   * A page reachable when nothing is wrong has to say something when nothing
   * is wrong, or it reads as a screen that failed to load.
   */
  it('reports a clean machine as a finding rather than as an empty page', () => {
    renderPage({}, environment([CONNECTED]));
    expect(screen.getByText(/found nothing to advise/)).toBeDefined();
  });
});
