import path from 'node:path';

import { ArtifactLock, type ArtifactLockLease, ArtifactLockTimeoutError } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export async function withRepositoryInstallLock<T>(
  gitCommonDir: string,
  fn: (lease: ArtifactLockLease) => Promise<T>
): Promise<T> {
  const lock = new ArtifactLock({
    locksDir: path.join(gitCommonDir, 'orcaops', 'locks'),
    containmentRoot: gitCommonDir,
    heartbeatIntervalMs: 30_000,
  });
  let callbackStarted = false;
  try {
    return await lock.withLock('install-state', async (lease) => {
      callbackStarted = true;
      return fn(lease);
    });
  } catch (error) {
    if (!callbackStarted && error instanceof ArtifactLockTimeoutError) {
      throw new OrcaopsError(
        ErrorCodes.LOCK_TIMEOUT,
        'Could not acquire the repository installation lock within 10 seconds; another init, update, link, uninstall, or Doctor repair is still running. Retry after it finishes.'
      );
    }
    throw error;
  }
}
