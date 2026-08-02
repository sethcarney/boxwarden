import { describe, expect, it } from 'vitest';
import type { SshAgentState } from './ssh-agent.js';
import { containersMissingAgentSocket, sshAgentState } from './ssh-agent.js';

/**
 * The fixtures below are the four ways an agent socket actually reaches a dev
 * container in the wild, plus the two ways it fails to. They are written as
 * env/mount pairs rather than whole inspect payloads because that is exactly
 * what the function reads — and because a container with a real environment
 * block in a fixture is a fixture nobody can safely paste a bug report into.
 */

describe('sshAgentState', () => {
  describe('forwarded', () => {
    it('recognises Docker Desktop’s magic socket', () => {
      const state = sshAgentState(
        ['PATH=/usr/bin', 'SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock'],
        ['/run/host-services/ssh-auth.sock', '/workspaces/webapp'],
      );
      expect(state).toEqual<SshAgentState>({
        kind: 'forwarded',
        socket: '/run/host-services/ssh-auth.sock',
      });
    });

    it('recognises a plain Linux bind of the host agent', () => {
      const state = sshAgentState(
        ['SSH_AUTH_SOCK=/tmp/ssh-agent.sock'],
        ['/tmp/ssh-agent.sock', '/var/run/docker.sock'],
      );
      expect(state.kind).toBe('forwarded');
    });

    it('recognises the compose convention of mounting at /ssh-agent', () => {
      const state = sshAgentState(['SSH_AUTH_SOCK=/ssh-agent'], ['/ssh-agent']);
      expect(state).toEqual<SshAgentState>({ kind: 'forwarded', socket: '/ssh-agent' });
    });

    /**
     * The bias that keeps this from crying wolf. A setup that shares the whole
     * agent directory is forwarding just as effectively as one that binds the
     * socket, and calling it broken would spend the warning's credibility on a
     * machine where nothing is wrong.
     */
    it('accepts a mount of the directory the socket lives in', () => {
      const state = sshAgentState(['SSH_AUTH_SOCK=/tmp/ssh-4Fj2/agent.1234'], ['/tmp/ssh-4Fj2']);
      expect(state.kind).toBe('forwarded');
    });

    it('ignores a trailing slash on either side', () => {
      expect(sshAgentState(['SSH_AUTH_SOCK=/ssh-agent/'], ['/ssh-agent']).kind).toBe('forwarded');
      expect(sshAgentState(['SSH_AUTH_SOCK=/ssh-agent'], ['/ssh-agent/']).kind).toBe('forwarded');
    });

    /** Docker appends the container's own environment after the image's. */
    it('takes the last value when the variable is set twice', () => {
      const state = sshAgentState(
        ['SSH_AUTH_SOCK=/from/the/image', 'SSH_AUTH_SOCK=/ssh-agent'],
        ['/ssh-agent'],
      );
      expect(state).toEqual<SshAgentState>({ kind: 'forwarded', socket: '/ssh-agent' });
    });
  });

  describe('declared-unmounted — the case a user cannot diagnose alone', () => {
    it('reports the socket when the variable is set and nothing is mounted there', () => {
      const state = sshAgentState(
        ['SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock'],
        ['/workspaces/webapp', '/var/run/docker.sock'],
      );
      expect(state).toEqual<SshAgentState>({
        kind: 'declared-unmounted',
        socket: '/run/host-services/ssh-auth.sock',
      });
    });

    it('reports it when there are no mounts at all', () => {
      expect(sshAgentState(['SSH_AUTH_SOCK=/ssh-agent'], []).kind).toBe('declared-unmounted');
    });

    /** A sibling path is not the socket, however similar it reads. */
    it('does not accept a mount that merely shares a prefix', () => {
      const state = sshAgentState(['SSH_AUTH_SOCK=/tmp/ssh-agent-other'], ['/tmp/ssh-agent']);
      expect(state.kind).toBe('declared-unmounted');
    });

    /** Otherwise a root mount would vouch for every socket path there is. */
    it('does not accept a mount at /', () => {
      expect(sshAgentState(['SSH_AUTH_SOCK=/ssh-agent'], ['/']).kind).toBe('declared-unmounted');
    });
  });

  describe('absent — an ordinary container, not a fault', () => {
    it('reports absent when SSH_AUTH_SOCK is not set', () => {
      const state = sshAgentState(['PATH=/usr/bin', 'HOME=/root'], ['/ssh-agent']);
      expect(state).toEqual<SshAgentState>({ kind: 'absent' });
    });

    it('reports absent when there is no environment block at all', () => {
      expect(sshAgentState(undefined, [])).toEqual<SshAgentState>({ kind: 'absent' });
    });

    /** How a shell profile clears the variable. It names no socket to be wrong about. */
    it('reports absent when the variable is set to an empty value', () => {
      expect(sshAgentState(['SSH_AUTH_SOCK='], []).kind).toBe('absent');
      expect(sshAgentState(['SSH_AUTH_SOCK=   '], []).kind).toBe('absent');
    });

    it('does not match a variable that merely ends in SSH_AUTH_SOCK', () => {
      expect(sshAgentState(['MY_SSH_AUTH_SOCK=/ssh-agent'], []).kind).toBe('absent');
    });
  });
});

describe('containersMissingAgentSocket', () => {
  const container = (name: string, sshAgent: SshAgentState) => ({ name, sshAgent });

  it('keeps only the declared-unmounted ones, in list order', () => {
    const found = containersMissingAgentSocket([
      container('webapp', { kind: 'forwarded', socket: '/ssh-agent' }),
      container('api', { kind: 'declared-unmounted', socket: '/ssh-agent' }),
      container('db', { kind: 'absent' }),
      container('worker', { kind: 'declared-unmounted', socket: '/ssh-agent' }),
    ]);
    expect(found.map((entry) => entry.name)).toEqual(['api', 'worker']);
  });

  it('is empty when nothing is broken', () => {
    expect(containersMissingAgentSocket([container('db', { kind: 'absent' })])).toEqual([]);
  });
});
