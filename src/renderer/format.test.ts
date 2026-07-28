import { describe, expect, it } from 'vitest';
import { canStart, canStop, explainFailure, relativeTime, statusLabel } from './format.js';

const NOW = new Date('2026-07-27T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms);

describe('relativeTime', () => {
  it('describes each bucket, singular and plural', () => {
    expect(relativeTime(ago(5_000), NOW)).toBe('just now');
    expect(relativeTime(ago(60_000), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5 minutes ago');
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(3 * 60 * 60_000), NOW)).toBe('3 hours ago');
    expect(relativeTime(ago(48 * 60 * 60_000), NOW)).toBe('2 days ago');
  });

  it('does not say "in -3 seconds" when the clock skews', () => {
    expect(relativeTime(new Date(NOW + 10_000), NOW)).toBe('just now');
  });
});

describe('statusLabel', () => {
  it('shows uptime without the trailing "ago"', () => {
    expect(statusLabel({ state: 'running', startedAt: ago(3 * 3_600_000), ports: [] }, NOW)).toBe(
      'Up 3 hours',
    );
  });

  it('appends health when Docker reports it', () => {
    expect(
      statusLabel(
        { state: 'running', startedAt: ago(3_600_000), ports: [], health: 'unhealthy' },
        NOW,
      ),
    ).toBe('Up 1 hour · unhealthy');
  });

  it('omits health when it is "none", which means no healthcheck rather than bad health', () => {
    expect(
      statusLabel({ state: 'running', startedAt: ago(3_600_000), ports: [], health: 'none' }, NOW),
    ).toBe('Up 1 hour');
  });

  /** A non-zero exit code is the whole diagnosis; a bare "Stopped" throws it away. */
  it('surfaces a non-zero exit code and hides a zero one', () => {
    expect(statusLabel({ state: 'exited', exitCode: 137, finishedAt: ago(3_600_000) }, NOW)).toBe(
      'Exited (137) 1 hour ago',
    );
    expect(statusLabel({ state: 'exited', exitCode: 0, finishedAt: ago(3_600_000) }, NOW)).toBe(
      'Exited 1 hour ago',
    );
  });

  it('distinguishes never-started from stopped', () => {
    expect(statusLabel({ state: 'created' }, NOW)).toBe('Created, never started');
  });
});

describe('canStart / canStop', () => {
  it('offers start only for states a start would actually change', () => {
    expect(canStart({ state: 'exited', exitCode: 0, finishedAt: ago(0) })).toBe(true);
    expect(canStart({ state: 'created' })).toBe(true);
    expect(canStart({ state: 'running', startedAt: ago(0), ports: [] })).toBe(false);
  });

  it('treats paused as stoppable, since it still holds its ports', () => {
    expect(canStop({ state: 'paused', startedAt: ago(0), ports: [] })).toBe(true);
    expect(canStop({ state: 'exited', exitCode: 0, finishedAt: ago(0) })).toBe(false);
  });

  it('offers neither action mid-transition', () => {
    expect(canStart({ state: 'restarting' })).toBe(false);
    expect(canStop({ state: 'restarting' })).toBe(false);
    expect(canStart({ state: 'removing' })).toBe(false);
    expect(canStop({ state: 'removing' })).toBe(false);
  });
});

describe('explainFailure', () => {
  /**
   * These strings are the product, not decoration: this is the screen a user
   * lands on when the app looks broken. Each must name the thing that failed
   * and say what to do about it.
   */
  it('names the socket and suggests a fix for each failure', () => {
    const target = '/var/run/docker.sock';

    expect(explainFailure({ code: 'not-present', detail: '' }, target)).toContain(target);
    expect(explainFailure({ code: 'not-present', detail: '' }, target)).toContain('DOCKER_HOST');

    expect(explainFailure({ code: 'permission-denied', detail: '' }, target)).toContain(
      'docker" group',
    );
    expect(explainFailure({ code: 'connection-refused' }, target)).toContain('not running');
    expect(explainFailure({ code: 'timeout', ms: 3000 }, target)).toContain('3000ms');
    expect(
      explainFailure({ code: 'api-too-old', server: '1.24', minimum: '1.41' }, target),
    ).toContain('1.41');
  });
});
