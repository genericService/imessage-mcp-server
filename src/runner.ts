import { execFile } from 'child_process';
import { config } from './config.js';

/**
 * Hardened wrapper around the Python iMessage CLI.
 *
 * The previous implementation called `promisify(execFile)` directly with no
 * timeout, no output cap and no concurrency control. Three concrete failure
 * modes came out of that:
 *
 *  1. HANG: `send` drives Messages.app through AppleScript/System Events. If
 *     macOS raises a TCC permission dialog, or the GUI session is locked, the
 *     child never exits. The HTTP request hangs forever and the MCP session
 *     behind it is pinned open, so the idle sweeper never reclaims it.
 *  2. CRASH: `execFile` buffers stdout in memory with a 1 MB default. A single
 *     `attachment` call on a photo or video overflows it, killing the child
 *     with ENOBUFS and surfacing as an opaque error.
 *  3. STAMPEDE: an agent looping over chats spawns unbounded concurrent
 *     python3 + sqlite processes, starving the host.
 *
 * Everything funnels through `runCli` so those guarantees hold uniformly.
 */

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(message: string, opts: { code: string; exitCode?: number | null; stderr?: string; timedOut?: boolean }) {
    super(message);
    this.name = 'CliError';
    this.code = opts.code;
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? '';
    this.timedOut = opts.timedOut ?? false;
  }
}

/** Bounded FIFO semaphore guarding concurrent child processes. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.active;
  }
}

const semaphore = new Semaphore(config.maxConcurrentCli);

export function getRunnerStats() {
  return { inFlight: semaphore.inFlight, queued: semaphore.pending };
}

/** Strip absolute paths / long noise out of child stderr before surfacing it. */
function summariseStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  // Python tracebacks are noisy; the final line carries the actual cause.
  const meaningful = lines[lines.length - 1].trim();
  return meaningful.length > 500 ? `${meaningful.slice(0, 500)}...` : meaningful;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
  /** Override the CLI script path. Used by tests to exercise failure modes. */
  cliPathOverride?: string;
}

/**
 * Execute the Python CLI with a hard timeout, an output cap and bounded
 * concurrency. Rejects with a {@link CliError} carrying a stable `code`.
 */
export async function runCli(args: string[], options: RunOptions = {}): Promise<string> {
  const timeout = options.timeoutMs ?? config.readTimeoutMs;
  const maxBuffer = options.maxBufferBytes ?? config.cliMaxBufferBytes;

  const release = await semaphore.acquire();
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        config.pythonBin,
        [options.cliPathOverride ?? config.cliPath, ...args],
        {
          timeout,
          maxBuffer,
          killSignal: 'SIGKILL',
          signal: options.signal,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: any; signal?: string };
            const detail = summariseStderr(String(stderr ?? ''));

            // execFile reports timeout kills via `killed` + the kill signal.
            if (err.killed || err.signal === 'SIGKILL' || err.signal === 'SIGTERM') {
              return reject(
                new CliError(
                  `Command timed out after ${timeout}ms. The macOS host may be showing a permission prompt, ` +
                    'the GUI session may be locked, or Messages.app may be unresponsive.',
                  { code: 'ETIMEDOUT', stderr: detail, timedOut: true }
                )
              );
            }
            if (err.code === 'ENOBUFS') {
              return reject(
                new CliError(`Command output exceeded the ${maxBuffer} byte buffer limit.`, {
                  code: 'ENOBUFS',
                  stderr: detail
                })
              );
            }
            if (err.code === 'ENOENT') {
              return reject(
                new CliError(
                  `Could not execute "${config.pythonBin}". Set PYTHON_BIN to a valid interpreter path.`,
                  { code: 'ENOENT', stderr: detail }
                )
              );
            }
            if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
              return reject(new CliError('Command aborted because the client disconnected.', { code: 'EABORTED' }));
            }
            return reject(
              new CliError(detail || `Command failed with exit code ${err.code ?? 'unknown'}.`, {
                code: 'EEXIT',
                exitCode: typeof err.code === 'number' ? err.code : null,
                stderr: detail
              })
            );
          }
          resolve(String(stdout ?? ''));
        }
      );

      child.on('error', () => {
        /* handled by the callback above; prevents an unhandled 'error' crash */
      });
    });
  } finally {
    release();
  }
}

/**
 * Run the CLI and parse its stdout as JSON.
 *
 * The CLI prints warnings to stdout in some paths, and a malformed payload
 * used to propagate as an unhelpful `Unexpected token` SyntaxError. We surface
 * a precise, truncated diagnostic instead.
 */
export async function runCliJson<T = unknown>(args: string[], options: RunOptions = {}): Promise<T> {
  const stdout = await runCli(args, options);
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new CliError('Command returned no output where JSON was expected.', { code: 'EEMPTY' });
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const preview = trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
    throw new CliError(`Command returned malformed JSON: ${preview}`, { code: 'EJSON' });
  }
}
