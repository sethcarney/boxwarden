import { net } from 'electron';
import type { Release } from '../../models/index.js';
import { LATEST_RELEASE_API_URL, parseRelease } from '../../models/index.js';

/**
 * The only outbound network request boxwarden makes.
 *
 * Worth saying plainly, because everything else this app does is local: it
 * talks to a container socket, walks the filesystem and spawns editors. This
 * one function asks api.github.com whether a newer release exists, at most
 * once a day, and only if the user has not turned it off. It sends nothing but
 * the request itself — no version beyond the User-Agent GitHub requires, no
 * machine identifier, no query string.
 *
 * Its own module, and the reason is testability rather than tidiness:
 * importing `electron` is what makes a module unrunnable under vitest, so
 * everything that decides anything lives in `check.ts` (which imports none)
 * and `update.ts` (which imports nothing at all). What is left here is a fetch
 * and a status code.
 */

/** Long enough for a slow link, short enough that a black hole is not a hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Undefined means the repository has published nothing (404) — which is "you
 * are current", not a failure: there is nothing newer than what you have.
 * Everything else throws, and the caller renders it as a check that could not
 * be completed.
 */
export async function fetchLatestRelease(currentVersion: string): Promise<Release | undefined> {
  const response = await net.fetch(LATEST_RELEASE_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects an API request with no User-Agent. Naming the app and
      // its version is the convention, and it is the only thing this request
      // discloses.
      'User-Agent': `boxwarden/${currentVersion}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // GitHub caches this response for a minute; a daily check has no use for
    // Chromium's copy of yesterday's.
    cache: 'no-cache',
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(describeHttpFailure(response.status));

  const payload: unknown = await response.json();
  const release = parseRelease(payload);
  if (release === undefined) {
    // Reached GitHub and got something unusable: a draft, an error object, a
    // release page URL pointing somewhere other than this repository. Not
    // "up to date" — the check did not complete.
    throw new Error('GitHub answered with something that is not a published release.');
  }
  return release;
}

function describeHttpFailure(status: number): string {
  if (status === 403 || status === 429) {
    return `GitHub refused the request (HTTP ${String(status)}). Unauthenticated API calls are rate limited per IP address; the next check will try again.`;
  }
  return `GitHub answered HTTP ${String(status)}.`;
}
