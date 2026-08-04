import { describe, expect, it } from 'vitest';
import { parseServiceState } from './ssh-agent.js';

/**
 * The only part of the probe that makes a decision, and therefore the only
 * part worth a test. Everything else in that module spawns PowerShell or stats
 * a path — the judgements built on this live in src/models/advice.ts.
 */
describe('parseServiceState', () => {
  it('reads the two states that need different fixes', () => {
    expect(parseServiceState('Stopped|Disabled\r\n')).toBe('disabled');
    expect(parseServiceState('Stopped|Manual\r\n')).toBe('stopped');
    expect(parseServiceState('Stopped|Automatic\r\n')).toBe('stopped');
  });

  it('reads a healthy service', () => {
    expect(parseServiceState('Running|Automatic\r\n')).toBe('running');
  });

  /**
   * Both can be true at once — a service someone started by hand without
   * changing how it boots. The reboot problem is real, but it is not what the
   * user is looking at, and reporting `disabled` would advertise a broken
   * agent while the agent is running.
   */
  it('lets Running win over a Disabled start type', () => {
    expect(parseServiceState('Running|Disabled')).toBe('running');
  });

  it('treats a service that is not installed as unknown, not as stopped', () => {
    expect(parseServiceState('missing\n')).toBe('unknown');
  });

  /** Anything unrecognised must produce no advisory rather than a guess. */
  it('is unknown for empty or unexpected output', () => {
    expect(parseServiceState('')).toBe('unknown');
    expect(parseServiceState('\n\n')).toBe('unknown');
    expect(parseServiceState('Get-Service : Cannot find any service')).toBe('unknown');
  });

  it('does not care about casing or trailing whitespace', () => {
    expect(parseServiceState('  RUNNING|automatic  ')).toBe('running');
  });
});
