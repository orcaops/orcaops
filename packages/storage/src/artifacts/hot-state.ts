import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  assertResolvedWithin,
  assertSafeRelativePath,
  PathContainmentError,
} from '../paths/containment.js';
import type { Config } from '../schema/config.js';

export interface HotStateProbe {
  artifacts: boolean;
  cache: boolean;
  usage: boolean;
  staged: boolean;
  empty: boolean;
}

export function probeHotState(
  repoRoot: string,
  config: Pick<Config, 'artifacts' | 'cache'>
): HotStateProbe {
  try {
    const artifacts = hasArtifactDirectories(repoRoot, config);
    const cache = existsSync(cacheDbPath(repoRoot, config));
    const usage = existsSync(usageLedgerPath(repoRoot));
    const staged = existsSync(artifactDeletionStagingRoot(repoRoot));
    return { artifacts, cache, usage, staged, empty: !artifacts && !cache && !usage && !staged };
  } catch (error) {
    if (error instanceof PathContainmentError)
      return { artifacts: true, cache: true, usage: false, staged: false, empty: false };
    throw error;
  }
}

function hasArtifactDirectories(repoRoot: string, config: Pick<Config, 'artifacts'>): boolean {
  const root = artifactsRoot(repoRoot, config);
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function artifactsRoot(repoRoot: string, config: Pick<Config, 'artifacts'>): string {
  assertSafeRelativePath(config.artifacts.path, 'config artifacts.path');
  return assertResolvedWithin(
    path.join(repoRoot, config.artifacts.path),
    repoRoot,
    'config artifacts.path',
    { allowRoot: true, rejectSymlinks: true }
  );
}

function cacheDbPath(repoRoot: string, config: Pick<Config, 'cache'>): string {
  assertSafeRelativePath(config.cache.path, 'config cache.path');
  return assertResolvedWithin(
    path.join(repoRoot, config.cache.path),
    repoRoot,
    'config cache.path',
    {
      rejectSymlinks: true,
    }
  );
}

function usageLedgerPath(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'usage', 'ledger.ndjson'),
    repoRoot,
    'usage ledger path',
    { rejectSymlinks: true }
  );
}

function artifactDeletionStagingRoot(repoRoot: string): string {
  return path.join(repoRoot, '.orcaops', 'tmp', 'artifact-deletions');
}
