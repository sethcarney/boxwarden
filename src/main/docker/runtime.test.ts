import { describe, expect, it } from 'vitest';
import { detectRuntime } from './runtime.js';

/**
 * The payloads below are trimmed copies of real /version responses. The Podman
 * one was captured from `\\.\pipe\docker_engine` on a Windows machine with no
 * Docker installed at all — which is the entire reason this module exists.
 */
const PODMAN = {
  Version: '5.7.0',
  ApiVersion: '1.41',
  Components: [{ Name: 'Podman Engine' }, { Name: 'Conmon' }, { Name: 'OCI Runtime (crun)' }],
  Platform: { Name: 'linux/amd64/ubuntu-26.04' },
};

const DOCKER_DESKTOP = {
  Version: '28.1.1',
  ApiVersion: '1.49',
  Components: [{ Name: 'Engine' }, { Name: 'containerd' }, { Name: 'runc' }],
  Platform: { Name: 'Docker Desktop 4.41.2 (191736)' },
};

const DOCKER_CE = {
  Version: '27.5.1',
  ApiVersion: '1.47',
  Components: [{ Name: 'Engine' }],
  Platform: { Name: 'Docker Engine - Community' },
};

describe('detectRuntime', () => {
  /**
   * The bug this whole module was written for. Podman's docker-compatible
   * service on Windows listens on the pipe named `docker_engine`, so inferring
   * the runtime from the socket produced a status chip reading
   * "Docker Desktop 5.7.0" — a version Docker has never shipped.
   */
  it('reports Podman on the pipe named docker_engine, whatever the socket suggested', () => {
    expect(detectRuntime(PODMAN, 'docker-desktop')).toBe('podman');
  });

  it('identifies Docker Desktop and OrbStack from their branded Platform name', () => {
    expect(detectRuntime(DOCKER_DESKTOP, 'docker-engine')).toBe('docker-desktop');
    expect(detectRuntime({ Platform: { Name: 'OrbStack' } }, 'docker-engine')).toBe('orbstack');
  });

  /**
   * Colima and Rancher Desktop run stock moby and report exactly what a plain
   * Linux install reports, so the socket path genuinely is the better evidence
   * and must not be overwritten by a guess derived from an ambiguous payload.
   */
  it('keeps the socket-derived guess when the payload identifies nothing', () => {
    expect(detectRuntime(DOCKER_CE, 'colima')).toBe('colima');
    expect(detectRuntime(DOCKER_CE, 'rancher-desktop')).toBe('rancher-desktop');
    expect(detectRuntime(DOCKER_CE, 'docker-engine')).toBe('docker-engine');
  });

  it('falls back rather than throwing on an empty or malformed response', () => {
    expect(detectRuntime({}, 'docker-engine')).toBe('docker-engine');
    expect(detectRuntime({ Components: [{}], Platform: {} }, 'podman')).toBe('podman');
  });
});
