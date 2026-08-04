import { chmod, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, net, shell } from 'electron';
import type { DownloadPlan, InstallKind, UpdateDownload } from '../../models/index.js';
import { MAX_DOWNLOAD_BYTES, applyKindFor, staleDownloads } from '../../models/index.js';
import { sha256File, verifyChecksum, verifySignature } from './verify.js';
import { trustMaterial } from './trust.js';

/**
 * Fetching the artefact, checking it, and handing it over.
 *
 * The state machine the UI renders lives here because all three steps share
 * one piece of state — the file on disk — and splitting them would allow the
 * one sequence this feature must never produce: a path advertised as ready
 * before the signature over it was checked. `#state` moves
 * `fetching → verifying → ready` and nothing else can write it.
 *
 * What is NOT here: any decision about what is acceptable. Which assets a
 * download needs, what a safe filename is, which digest belongs to which file,
 * what identity a signature must carry — all of that is in
 * `src/models/download.ts`, which imports nothing and has tests. This module
 * is a socket, a file handle and a spawn.
 */

/** The response headers can lie about length; this is the cap that cannot. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Small text assets: the bundle and the checksum manifest. */
const METADATA_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 1024 * 1024;

/**
 * Whether the running app has to exit before the download can be installed.
 *
 * True where the installer replaces something the running process is holding
 * open — the .app bundle, the per-user install directory. False for the deb,
 * where apt is replacing files a package manager owns and the running process
 * is irrelevant to it, and where quitting would be boxwarden closing itself
 * for somebody else's convenience.
 */
function quitsToInstall(kind: InstallKind): boolean {
  return kind === 'dmg' || kind === 'nsis' || kind === 'appimage';
}

export interface DownloaderOptions {
  /** Where verified downloads are kept. Under `app.getPath('userData')`. */
  readonly directory: string;
  /** TUF's metadata cache. Separate, because it is not a download. */
  readonly trustCachePath: string;
  readonly installKind: InstallKind;
  now(): Date;
  /** Called whenever `state` changes, so the renderer's poll has something new. */
  onChange(): void;
  /** Seam for tests and for `fake.ts`; `app.relaunch()` in production. */
  relaunch(): void;
}

export class UpdateDownloader {
  readonly #options: DownloaderOptions;
  #state: UpdateDownload = { kind: 'idle' };
  #controller: AbortController | undefined;
  /** The verified file's absolute path. Set only alongside a `ready` state. */
  #readyPath: string | undefined;

  constructor(options: DownloaderOptions) {
    this.#options = options;
  }

  get state(): UpdateDownload {
    return this.#state;
  }

  /**
   * Begin, unless something is already in flight.
   *
   * Returns immediately: the renderer polls the status rather than awaiting a
   * download that takes a minute, so an IPC call that blocked for its duration
   * would be a call that times out on a slow link and reports failure over a
   * download that is going fine.
   */
  start(plan: DownloadPlan): void {
    if (this.#state.kind === 'fetching' || this.#state.kind === 'verifying') return;
    void this.#run(plan);
  }

  /**
   * Record a refusal decided before any bytes were asked for.
   *
   * The model refuses a release with no signature, no checksum manifest or an
   * ambiguous artefact — see `planDownload`. Those land in the same `failed`
   * arm a mid-download failure does, deliberately: from the user's side both
   * mean "boxwarden will not do this for you, here is the release page", and
   * splitting them into two states would be splitting one sentence into two
   * screens.
   */
  refuse(version: string, message: string): void {
    if (this.#state.kind === 'fetching' || this.#state.kind === 'verifying') return;
    this.#set({ kind: 'failed', version, message });
  }

  /**
   * Stop, and delete the partial file.
   *
   * A cancelled download leaves nothing behind on purpose. A half-written
   * installer that survived would fail its checksum on the next attempt and
   * report itself as a corrupted release, which is a confusing way to say
   * "you pressed cancel".
   */
  cancel(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#state.kind === 'fetching' || this.#state.kind === 'verifying') {
      this.#set({ kind: 'idle' });
    }
  }

  /**
   * Hand the verified file over. Never reachable from any other state.
   *
   * The guard is the last line of the verification: `#readyPath` is written in
   * exactly one place, after both checks have passed, and read in exactly this
   * one. An `install` that fell back to "whatever is in the download
   * directory" would undo the whole module.
   */
  async install(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.#state.kind !== 'ready' || this.#readyPath === undefined) {
      return { ok: false, message: 'There is no verified download to install.' };
    }

    const path = this.#readyPath;
    const ready = this.#state;
    const { version, apply } = ready;
    this.#set({ kind: 'installing', version });

    try {
      if (apply === 'replace') {
        await this.#replaceAppImage(path);
      } else {
        // `openPath` resolves with a NON-EMPTY string on failure, which is the
        // opposite of every other API here and silently succeeds if unchecked.
        const failure = await shell.openPath(path);
        if (failure !== '') throw new Error(failure);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#set({ kind: 'failed', version, message });
      return { ok: false, message };
    }

    if (quitsToInstall(this.#options.installKind)) {
      // After the reply has been sent. Quitting inside the handler would drop
      // the IPC response, and the renderer would report the install as failed
      // on its way out.
      setImmediate(() => {
        if (apply === 'replace') this.#options.relaunch();
        app.quit();
      });
      return { ok: true };
    }

    // The deb is the one kind that does not quit — apt is replacing files a
    // package manager owns, and the running process is irrelevant to it. So
    // this process is still here afterwards, and leaving it on `installing`
    // would park "Installing…" on screen for the rest of the session. Back to
    // `ready`: the file is still there and still verified, and if the user
    // dismissed the software centre by accident the button should work again.
    this.#set(ready);
    return { ok: true };
  }

  /**
   * Delete downloads nothing is going to install.
   *
   * Run at launch rather than at exit: an exit-time sweep is the one that does
   * not happen when the app is killed, and this is the mechanism whose whole
   * job is to not leave installers lying around.
   */
  async sweep(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.#options.directory, { withFileTypes: true });
    } catch {
      // No directory yet is the normal state on a machine that has never
      // downloaded anything.
      return;
    }

    const described = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = join(this.#options.directory, entry.name);
          try {
            return { name: entry.name, modifiedAt: (await stat(path)).mtime };
          } catch {
            return undefined;
          }
        }),
    );

    const keep = this.#state.kind === 'ready' ? this.#state.fileName : undefined;
    const doomed = staleDownloads(
      described.filter((entry) => entry !== undefined),
      keep,
      this.#options.now(),
    );

    await Promise.all(
      doomed.map(async (name) => {
        // Rebuilt from the directory and a name the model has re-validated,
        // never from a path that came out of the release.
        await rm(join(this.#options.directory, name), { force: true });
      }),
    );
  }

  #set(next: UpdateDownload): void {
    this.#state = next;
    this.#options.onChange();
  }

  async #run(plan: DownloadPlan): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#readyPath = undefined;
    this.#set({ kind: 'fetching', version: plan.version, progress: { receivedBytes: 0 } });

    const path = join(this.#options.directory, plan.fileName);

    try {
      await mkdir(this.#options.directory, { recursive: true });
      // Anything left from a previous attempt at the same version. Appending
      // to it would produce a file that fails its checksum for a reason no
      // message could explain.
      await rm(path, { force: true });

      await this.#fetchArtefact(plan, path, controller.signal);
      if (aborted(controller)) return;

      this.#set({ kind: 'verifying', version: plan.version });

      const [manifest, bundle] = await Promise.all([
        fetchText(plan.checksums.url, controller.signal),
        fetchText(plan.signature.url, controller.signal),
      ]);

      verifyChecksum({ manifest, fileName: plan.fileName, actual: await sha256File(path) });
      await verifySignature({
        filePath: path,
        bundle,
        identity: plan.identity,
        trust: await trustMaterial({ cachePath: this.#options.trustCachePath }),
      });

      if (aborted(controller)) return;

      this.#readyPath = path;
      this.#set({
        kind: 'ready',
        version: plan.version,
        fileName: plan.fileName,
        apply: applyKindFor(this.#options.installKind),
      });
    } catch (error) {
      // The file is removed on EVERY failure path, verification included. A
      // download that failed its signature check is the one file on the
      // machine that must not be left somewhere a person might double-click.
      await rm(path, { force: true }).catch(() => undefined);
      this.#readyPath = undefined;

      if (aborted(controller)) {
        this.#set({ kind: 'idle' });
        return;
      }
      this.#set({
        kind: 'failed',
        version: plan.version,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  async #fetchArtefact(plan: DownloadPlan, path: string, signal: AbortSignal): Promise<void> {
    const response = await net.fetch(plan.artefact.url, {
      signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`The download failed (HTTP ${String(response.status)}).`);
    if (response.body === null) throw new Error('The download returned no content.');

    // The header is a hint for the progress bar, never a budget: the cap below
    // counts bytes actually written, so a response that under-declares its
    // length still cannot overrun the disk.
    const declared = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined;

    const sink = createWriteStream(path);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let received = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new Error('The download is larger than boxwarden is willing to fetch.');
        }

        await write(sink, value);
        this.#set({
          kind: 'fetching',
          version: plan.version,
          progress: {
            receivedBytes: received,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          },
        });
      }
    } finally {
      // Both ends, on every path out — including the throws above, which are
      // the ones that matter. Leaving the loop early without cancelling holds
      // the reader's lock on a body nobody is draining, and the socket behind
      // it stays open until the whole response is garbage collected. Abort
      // closes it; a size cap or a full disk does not, and those are exactly
      // the cases that leave a download half-read.
      await reader.cancel().catch(() => undefined);
      await new Promise<void>((resolve) => {
        sink.end(resolve);
      });
    }

    // A truncated response is a successful stream that stopped early — no
    // error, fewer bytes. Only the checksum would otherwise notice, and it
    // would call it corruption rather than a short read.
    if (totalBytes !== undefined && received !== totalBytes) {
      throw new Error('The download ended early.');
    }
  }

  /**
   * Overwrite the running AppImage with the verified one.
   *
   * Through a temporary file in the SAME directory and then a rename, because
   * a rename within a filesystem is atomic: a copy that is interrupted halfway
   * leaves the user with a truncated AppImage and no working boxwarden, and
   * that is the one failure mode an update mechanism must not have. Renaming
   * over the file the kernel is executing is fine — the running process holds
   * the inode, not the name, which is how every AppImage updater works.
   */
  async #replaceAppImage(source: string): Promise<void> {
    const target = process.env['APPIMAGE'];
    if (target === undefined || target === '') {
      throw new Error('boxwarden is not running from an AppImage, so it cannot replace one.');
    }

    const staging = join(dirname(target), `.boxwarden-update-${String(process.pid)}`);
    try {
      // Copy rather than rename from the download directory: userData is very
      // often on a different filesystem, and `rename` across one fails with
      // EXDEV.
      await copyFile(source, staging);
      await chmod(staging, 0o755);
      await rename(staging, target);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new Error(
          `boxwarden cannot write to ${target}. Move the new AppImage there yourself, or run from a location you own.`,
          { cause: error },
        );
      }
      throw error;
    }
    await rm(source, { force: true }).catch(() => undefined);
  }
}

/**
 * `signal.aborted`, read in a way TypeScript will not narrow.
 *
 * It is a readonly boolean, so a guard early in `#run` narrows it to `false`
 * for the rest of the function — and every later check then reads as dead
 * code, which is exactly what the linter said. A call cannot be narrowed.
 */
function aborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

/** `fs.copyFile`, imported lazily to keep the top of this file about Electron. */
async function copyFile(from: string, to: string): Promise<void> {
  const { copyFile: copy } = await import('node:fs/promises');
  await copy(from, to);
}

/** Backpressure. Without it a fast link buffers the whole artefact in memory. */
function write(sink: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * The signature bundle and the checksum manifest.
 *
 * Capped, because both are small and neither is worth a surprise: a
 * `sha256sums.txt` that streams forever would hang the verify step behind a
 * spinner that says "verifying" while nothing is being verified.
 */
async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await net.fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]),
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Could not fetch what this release says about itself (HTTP ${String(response.status)}).`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) {
    throw new Error('This release describes itself in more detail than boxwarden will read.');
  }
  return text;
}

/** The timeout that applies to the artefact request itself, not to the body. */
export const ARTEFACT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
