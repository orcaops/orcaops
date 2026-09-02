import path from 'node:path';

import { ArtifactLock } from '@orcaops/storage';

export const REVIEW_LOCK_HEARTBEAT_MS = 30_000;

export function reviewLock(root: string, locksDir?: string): ArtifactLock {
  return new ArtifactLock({
    locksDir: locksDir ?? path.join(root, '.orcaops', 'tmp', 'locks'),
    containmentRoot: root,
    heartbeatIntervalMs: REVIEW_LOCK_HEARTBEAT_MS,
  });
}
