import { resolveSidecar } from './sidecarPath';
import { createPollSource, type PollSourceOptions, type SnapshotSource } from './snapshot';
import { createStreamSource } from './streamSource';

/**
 * Prefer the warm streaming sidecar (sub-second fs.watch push) when it's
 * built; fall back to polling the same sidecar one-shot (`node dist/sidecar.js
 * --once`). Both run the app's own engine under Node without invoking the
 * interactive `orcaops-watch` bin. This is a transport fallback only: the poll
 * source needs the same built sidecar, so when it's absent the poll path
 * throws `sidecarMissingError()` and the TUI degrades to a per-panel error
 * line rather than crashing.
 */
export function createSnapshotSource(opts: PollSourceOptions = {}): SnapshotSource {
  const sidecarPath = resolveSidecar();
  if (sidecarPath !== null) {
    return createStreamSource({ ...opts, sidecarPath });
  }
  return createPollSource(opts);
}
