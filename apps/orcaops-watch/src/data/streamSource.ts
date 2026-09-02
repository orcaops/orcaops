import { type ChildProcess, spawn } from 'node:child_process';

import { parseSnapshot, type PollOptions, type SnapshotSource } from './snapshot';

export interface StreamSourceOptions extends PollOptions {
  sidecarPath: string;
  restartDelayMs?: number;
}

/**
 * Retention cap for child stderr (UTF-16 code units). The exit diagnostic
 * only ever uses the first 200 chars of the trimmed text, so keeping the
 * whole stream for a long-lived noisy child buys nothing and grows without
 * bound; the head is what the pre-existing formatter consumed, so bounded
 * retention leaves the emitted message unchanged.
 */
export const STDERR_RETAIN_BYTES = 8 * 1024;

/** Append-only head window: keeps the first `cap` units, drops the rest. */
export class BoundedHeadBuffer {
  private retained = '';

  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (this.retained.length >= this.cap) return;
    const room = this.cap - this.retained.length;
    this.retained += chunk.length > room ? chunk.slice(0, room) : chunk;
  }

  head(): string {
    return this.retained;
  }
}

/**
 * Streaming source: spawns the warm Node sidecar under Node, parses its NDJSON
 * WatchSnapshot stream, and supervises it — reporting an error and respawning
 * (after a short delay) if it dies, and killing it on stop().
 */
export function createStreamSource(opts: StreamSourceOptions): SnapshotSource {
  return {
    start({ onSnapshot, onError }) {
      let stopped = false;
      let child: ChildProcess | null = null;
      let restartTimer: ReturnType<typeof setTimeout> | undefined;

      const spawnChild = (): void => {
        if (stopped) return;
        const env = { ...(opts.env ?? process.env) };
        if (opts.root !== undefined && opts.root.length > 0) env.ORCAOPS_ROOT = opts.root;
        const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';

        child = spawn(node, [opts.sidecarPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

        let buffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length > 0 && !stopped) {
              try {
                onSnapshot(parseSnapshot(line));
              } catch {
                // ignore a torn/partial line; the next full line supersedes it
              }
            }
            nl = buffer.indexOf('\n');
          }
        });

        const stderr = new BoundedHeadBuffer(STDERR_RETAIN_BYTES);
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr.append(chunk.toString('utf8'));
        });

        child.on('exit', (code) => {
          child = null;
          if (stopped) return;
          const head = stderr.head().trim();
          const detail = head.length > 0 ? `: ${head.slice(0, 200)}` : '';
          onError(new Error(`watch sidecar exited (code ${code ?? 'null'})${detail}`));
          if (!stopped) restartTimer = setTimeout(spawnChild, opts.restartDelayMs ?? 1000);
        });

        child.on('error', (error) => {
          if (!stopped) onError(error);
        });
      };

      spawnChild();

      return () => {
        stopped = true;
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        if (child !== null) {
          try {
            child.kill('SIGTERM');
          } catch {
            // already gone
          }
        }
      };
    },
  };
}
