// The warm Node data-sidecar. Runs the SnapshotEngine — and therefore
// better-sqlite3 — under Node, driving ticks off fs.watch pushes plus a slow
// heartbeat, and streams each WatchSnapshot to stdout as one NDJSON line. The
// Bun UI spawns this and parses the stream; this file never touches OpenTUI.
import { reviewRuntimeDescriptorFromModule, runReview } from '@orcaops/review-engine';

import { SnapshotEngine } from './engine.js';
import { FsWatch } from './fs-watch.js';
import { DEFAULT_THRESHOLDS } from './liveness.js';
import { serializeSidecarSchemaError } from './sidecarError.js';
import { collectSnapshot } from './snapshot.js';
import type { WatchSnapshot } from './types.js';

const HEARTBEAT_MS = 10_000;
const FAST_MS = 2_000;

async function main(): Promise<void> {
  const rootOverride = process.env.ORCAOPS_ROOT;
  const root = rootOverride !== undefined && rootOverride.length > 0 ? rootOverride : undefined;

  // One-shot review verbs: `sidecar.js review data --branch <b> [--json]`.
  // Assembles the review floor and exits before the streaming engine spins up.
  // Set exitCode and RETURN (never process.exit) — exit() truncates a still-
  // draining stdout at the pipe buffer, silently cutting payloads over ~64KB.
  const argv = process.argv.slice(2);
  if (argv[0] === 'review') {
    const runtime = await reviewRuntimeDescriptorFromModule(import.meta.url);
    process.exitCode = await runReview(argv, process.env, undefined, runtime);
    return;
  }

  // One-shot mode: the poll / --probe fallback spawns THIS sidecar with --once
  // (it resolves the app's own dist/sidecar.js rather than the interactive
  // orcaops-watch bin). Collect a single snapshot, print it as one NDJSON line, and exit —
  // by RETURNING, never process.exit(): a snapshot over the ~64KB pipe buffer
  // would be silently truncated mid-drain, and this is the degraded-mode path
  // where that corruption would surface as an empty cockpit.
  if (process.argv.includes('--once')) {
    const snapshot = await collectSnapshot({ rootOverride: root, thresholds: DEFAULT_THRESHOLDS });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }

  const engine = new SnapshotEngine({
    rootOverride: root,
    env: process.env,
    thresholds: DEFAULT_THRESHOLDS,
  });

  engine.on('snapshot', (snapshot: WatchSnapshot) => {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  });

  await engine.start();

  let stopped = false;
  let timer: ReturnType<typeof setInterval>;
  const stop = (exitCode: number): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    fsw.close();
    engine.close();
    process.stdin.pause();
    process.exitCode = exitCode;
  };
  const fail = (error: unknown): void => {
    if (stopped) return;
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    stop(1);
  };
  const requestTick = (): void => {
    void engine.tick().catch(fail);
  };

  timer = setInterval(requestTick, FAST_MS);
  timer.unref?.();
  const setPoll = (ms: number): void => {
    clearInterval(timer);
    timer = setInterval(requestTick, ms);
    timer.unref?.();
  };

  const fsw = new FsWatch({
    roots: engine.getWatchRoots(),
    onTick: requestTick,
    onDegrade: () => setPoll(FAST_MS),
  });
  setPoll(fsw.start() ? HEARTBEAT_MS : FAST_MS);

  // Release every keep-alive handle and let the process drain out naturally
  // — process.exit() here could cut an in-flight NDJSON snapshot mid-line.
  const shutdown = (): void => stop(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // If the Bun parent dies, our stdout pipe breaks — exit rather than orphan.
  process.stdout.on('error', () => {
    if (!stopped) process.exit(0);
  });
  process.stdin.on('end', shutdown);
  process.stdin.resume();
}

main().catch((error: unknown) => {
  const structured = serializeSidecarSchemaError(error);
  process.stderr.write(
    `${structured ?? (error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`
  );
  process.exitCode = 1;
});
