import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveSidecar, sidecarMissingError } from './sidecarPath';
import type { WatchSnapshot } from './types';

const execFileAsync = promisify(execFile);

/** Pure: parse and shape-check one JSON snapshot emitted by the Node sidecar. */
export function parseSnapshot(stdout: string): WatchSnapshot {
  const data = JSON.parse(stdout) as WatchSnapshot;
  if (
    data === null ||
    typeof data !== 'object' ||
    typeof data.totals !== 'object' ||
    !Array.isArray(data.projects)
  ) {
    throw new Error('unexpected watch snapshot shape');
  }
  return data;
}

export interface PollOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Node binary to run the sidecar under (default: `node` on PATH). */
  nodeBin?: string;
}

/**
 * Spawn the app's own Node sidecar once in --once mode and return a parsed
 * snapshot. Node — not Bun — so better-sqlite3 loads; this is the process
 * boundary that keeps the native addon off the Bun UI. Requires a built
 * dist/sidecar.js (throws otherwise, e.g. when running raw from source).
 */
export async function pollSnapshot(opts: PollOptions = {}): Promise<WatchSnapshot> {
  const sidecar = resolveSidecar();
  if (sidecar === null) {
    throw sidecarMissingError();
  }
  const env = { ...(opts.env ?? process.env) };
  if (opts.root !== undefined && opts.root.length > 0) env.ORCAOPS_ROOT = opts.root;
  const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
  const { stdout } = await execFileAsync(node, [sidecar, '--once'], {
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseSnapshot(stdout);
}

export interface SourceHandlers {
  onSnapshot: (snapshot: WatchSnapshot) => void;
  onError: (error: Error) => void;
}

/**
 * A swappable snapshot producer: the poll source and the warm streaming
 * sidecar implement the same shape, so the UI hook never changes.
 */
export interface SnapshotSource {
  start(handlers: SourceHandlers): () => void;
}

export interface PollSourceOptions extends PollOptions {
  intervalMs?: number;
}

/** Poll source: re-runs the Node sidecar in one-shot mode without overlap. */
export function createPollSource(opts: PollSourceOptions = {}): SnapshotSource {
  const intervalMs = opts.intervalMs ?? 2000;
  return {
    start({ onSnapshot, onError }) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async (): Promise<void> => {
        try {
          const snapshot = await pollSnapshot(opts);
          if (!stopped) onSnapshot(snapshot);
        } catch (error) {
          if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
        }
      };
      void tick();
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}
