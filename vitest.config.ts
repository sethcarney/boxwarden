import { defineConfig } from 'vitest/config';

/**
 * Tests cover the pure layer only: label parsing, Docker-inspect mapping, URI
 * construction, endpoint candidate ordering. None of it touches a daemon, so
 * the suite runs in CI and inside a dev container with no Docker socket.
 *
 * The impure edges (dockerode calls, spawning an editor) are deliberately thin
 * wrappers around those pure functions so that this split stays cheap.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
