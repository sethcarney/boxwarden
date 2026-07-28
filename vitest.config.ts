import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Two kinds of test, one runner.
 *
 * The bulk of the suite covers the pure layer — label parsing, Docker-inspect
 * mapping, URI construction, endpoint ordering — and needs neither a daemon
 * nor a browser, so `node` stays the default environment. The impure edges
 * (dockerode calls, spawning an editor) are deliberately thin wrappers around
 * those pure functions so the split stays cheap.
 *
 * Component tests opt into jsdom per file with a docblock:
 *
 *     // @vitest-environment jsdom
 *
 * Per-file rather than a glob because jsdom costs a second or so of setup, and
 * paying it for every mapping test would triple the suite's runtime for no
 * benefit.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // React Testing Library's auto-cleanup hook needs this.
    globals: true,
  },
});
