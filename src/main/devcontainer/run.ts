import { spawn } from 'node:child_process';

/**
 * The impure shell around `devcontainerUpInvocation` — one spawn, no shell.
 *
 * A build pulls images and runs `postCreateCommand`, so the honest timeout is
 * long: fifteen minutes is past any healthy build and short of "the daemon
 * hung and nobody will ever know". Output is kept as bounded TAILS — the
 * result JSON is the last stdout line and the useful error is the last few
 * stderr lines, and an unbounded buffer on a chatty image pull is a slow leak
 * held for the whole build.
 */

const UP_TIMEOUT_MS = 15 * 60_000;
const STDOUT_TAIL_LIMIT = 256 * 1024;
const STDERR_TAIL_LIMIT = 8 * 1024;

export interface UpRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
}

function keepTail(current: string, chunk: string, limit: number): string {
  const joined = current + chunk;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

export function runDevcontainerUp(
  command: string,
  args: readonly string[],
  timeoutMs: number = UP_TIMEOUT_MS,
): Promise<UpRun> {
  return new Promise((resolve, reject) => {
    // `shell: false` always — the args carry filesystem paths from container
    // labels and scan results, which through argv are inert data and through
    // a shell string would be an injection. Same rule as every launcher here.
    const child = spawn(command, args, { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk.toString('utf8'), STDOUT_TAIL_LIMIT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk.toString('utf8'), STDERR_TAIL_LIMIT);
    });

    // ENOENT/EACCES — the binary vanished between the probe and this spawn.
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? undefined, timedOut });
    });
  });
}
