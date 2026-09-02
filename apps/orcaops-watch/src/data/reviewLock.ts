import path from 'node:path';

import { assertResolvedWithin } from '@orcaops/evaluator-protocol';
import { ArtifactLock } from '@orcaops/storage/locks';

const HEARTBEAT_INTERVAL_MS = 30_000;

export function reviewLocksDir(root: string): string {
  return assertResolvedWithin(
    path.join(root, '.orcaops', 'tmp', 'locks'),
    root,
    'watch review locks directory',
    { rejectSymlinks: true }
  );
}

export function reviewFloorLockKey(slug: string): string {
  return `review-floor-${slug}`;
}

export async function withReviewLock<T>(
  locksDir: string,
  key: string,
  fn: () => Promise<T>,
  containmentRoot?: string
): Promise<T> {
  const lock = new ArtifactLock({
    locksDir,
    containmentRoot,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  return lock.withLock(key, async () => fn());
}
