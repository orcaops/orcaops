import path from 'node:path';

import type { Repo } from '@orcaops/core';
import { ArtifactLock, isUuidV7, uuidv7 } from '@orcaops/storage';

/**
 * Project identity. A UUIDv7 minted once per repo and stored as
 * `git config --local orcaops.projectid`, so it survives directory renames and
 * moves (the config travels with the repo) and is shared by every worktree.
 * Registry paths/remotes are re-association hints only.
 */
export const PROJECT_ID_CONFIG_KEY = 'orcaops.projectid';

export class ProjectIdentityError extends Error {
  constructor(message: string, name = 'ProjectIdentityError') {
    super(message);
    this.name = name;
  }
}

export class InvalidProjectIdentityError extends ProjectIdentityError {
  constructor() {
    super(
      `git config ${PROJECT_ID_CONFIG_KEY} is not a canonical UUIDv7 project id. ` +
        `Fix it or remove it with \`git config --local --unset ${PROJECT_ID_CONFIG_KEY}\` ` +
        `before archive operations continue.`,
      'InvalidProjectIdentityError'
    );
  }
}

export class ProjectIdentityReadError extends ProjectIdentityError {
  constructor() {
    super(
      `could not read git config ${PROJECT_ID_CONFIG_KEY}. Run ` +
        `\`git config --local --get ${PROJECT_ID_CONFIG_KEY}\` to diagnose the repository's ` +
        'local Git config; refusing to treat the read failure as a missing identity.',
      'ProjectIdentityReadError'
    );
  }
}

export class ProjectIdentityConfigLockTimeoutError extends ProjectIdentityError {
  constructor(waitedMs: number, cause: unknown) {
    super(
      `Could not write git config ${PROJECT_ID_CONFIG_KEY} within ${waitedMs}ms because ` +
        'Git config is locked by another process. Retry after that Git operation finishes.',
      'ProjectIdentityConfigLockTimeoutError'
    );
    this.cause = cause;
  }
}

export interface ProjectIdentityTiming {
  configAcquireMs?: number;
  configRetryMs?: number;
}

const DEFAULT_TIMING = {
  configAcquireMs: 2_000,
  configRetryMs: 50,
};

/**
 * Read the minted project id, or null when the repo has none yet. The stored
 * value becomes an archive path segment, so a malformed value or an operational
 * read failure is REFUSED with a clear typed error — never silently reminted
 * (which would orphan the real archive) and never passed onward to path
 * construction.
 */
export async function readProjectId(repo: Repo): Promise<string | null> {
  let stored: string | null;
  try {
    stored = await repo.getLocalConfig(PROJECT_ID_CONFIG_KEY);
  } catch {
    throw new ProjectIdentityReadError();
  }
  if (stored === null) return null;
  if (!isUuidV7(stored)) {
    throw new InvalidProjectIdentityError();
  }
  return stored;
}

export interface EnsuredProjectId {
  projectId: string;
  /** True when this call minted the id (first capture with archive enabled). */
  minted: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isGitConfigLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:could not|unable to).*lock.*config|config(?:\.lock| file).*exists/i.test(message);
}

/**
 * `git config --local` takes git's own `config.lock` — a race with arbitrary
 * NON-orcaops git processes that the orcaops artifact lock cannot serialize
 * against, so contention is retried here instead.
 */
async function setProjectIdWithRetry(
  repo: Repo,
  projectId: string,
  timing: ProjectIdentityTiming
): Promise<void> {
  const acquireMs = timing.configAcquireMs ?? DEFAULT_TIMING.configAcquireMs;
  const retryMs = timing.configRetryMs ?? DEFAULT_TIMING.configRetryMs;
  const started = Date.now();
  while (true) {
    try {
      await repo.setLocalConfig(PROJECT_ID_CONFIG_KEY, projectId);
      return;
    } catch (err) {
      if (!isGitConfigLockError(err)) throw err;
      if (Date.now() - started >= acquireMs) {
        throw new ProjectIdentityConfigLockTimeoutError(acquireMs, err);
      }
      await delay(retryMs);
    }
  }
}

/**
 * Read the project id, minting one on first use. Mint-on-first-use is a
 * superset of "mint on first capture": any archive-enabled invocation that
 * needs the identity may create it.
 */
export async function ensureProjectId(
  repo: Repo,
  timing: ProjectIdentityTiming = {}
): Promise<EnsuredProjectId> {
  const existing = await readProjectId(repo);
  if (existing) return { projectId: existing, minted: false };

  const commonDir = await repo.getCommonDirAbsolute();
  // Identity is shared by every worktree, so its initialization lock must be too.
  const lock = new ArtifactLock({
    locksDir: path.join(commonDir, 'orcaops', 'locks'),
    containmentRoot: commonDir,
  });
  return lock.withLock('project-identity', async () => {
    const raced = await readProjectId(repo);
    if (raced) return { projectId: raced, minted: false };
    const projectId = uuidv7();
    await setProjectIdWithRetry(repo, projectId, timing);
    const persisted = await readProjectId(repo);
    if (persisted !== projectId) {
      throw new ProjectIdentityError(
        `Git config ${PROJECT_ID_CONFIG_KEY} changed during initialization; retry the command.`
      );
    }
    return { projectId, minted: true };
  });
}
