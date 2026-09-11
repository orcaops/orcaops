import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ClassifiedDifference, FileManifest } from './manifest.js';
import { compareManifests, fileManifest } from './manifest.js';
import type { DisposableRoot } from './roots.js';

const execute = promisify(execFile);

/**
 * Every place a packaged process could persist something, not just the history
 * root: a "creates nothing" claim that only inventories `ORCAOPS_DATA_DIR` would
 * miss the registration marker under the repository's common directory, the
 * credential and config home, the cache and state homes, and the publication refs.
 */
export type EnvironmentManifest = {
  data: FileManifest;
  registration: FileManifest;
  config: FileManifest;
  cache: FileManifest;
  state: FileManifest;
  refs: string;
};

export async function environmentManifest(root: DisposableRoot): Promise<EnvironmentManifest> {
  const refs = await execute('git', ['-C', root.repo, 'for-each-ref', 'refs/orcaops'], {
    env: root.env,
  }).then(
    ({ stdout }) => stdout,
    () => ''
  );
  const [data, registration, config, cache, state] = await Promise.all([
    fileManifest(root.dataDir),
    fileManifest(path.join(root.repo, '.git', 'orcaops')),
    fileManifest(root.configHome),
    fileManifest(root.cacheHome),
    fileManifest(root.stateHome),
  ]);
  return { data, registration, config, cache, state, refs };
}

export type EnvironmentDifference = {
  data: ClassifiedDifference;
  registration: ClassifiedDifference;
  config: ClassifiedDifference;
  cache: ClassifiedDifference;
  state: ClassifiedDifference;
  refsChanged: boolean;
};

export function compareEnvironments(
  before: EnvironmentManifest,
  after: EnvironmentManifest
): EnvironmentDifference {
  return {
    data: compareManifests(before.data, after.data),
    registration: compareManifests(before.registration, after.registration),
    config: compareManifests(before.config, after.config),
    cache: compareManifests(before.cache, after.cache),
    state: compareManifests(before.state, after.state),
    refsChanged: before.refs !== after.refs,
  };
}

const still = { created: [], removed: [], changed: [] } as const;

/**
 * The buckets that must not move when a packaged process created nothing.
 *
 * SQLite's own WAL and SHM coordination is excluded — the approved passive-read
 * clarification permits it — and the caller asserts on those buckets when it
 * cares.
 */
export function authoritativelyUnchanged(difference: EnvironmentDifference) {
  return {
    dataDatabase: difference.data.database,
    dataOther: difference.data.other,
    registration: difference.registration.other,
    config: difference.config.other,
    cacheDatabase: difference.cache.database,
    cacheOther: difference.cache.other,
    state: difference.state.other,
    refsChanged: difference.refsChanged,
  };
}

export const nothingAuthoritativeMoved = {
  dataDatabase: still,
  dataOther: still,
  registration: still,
  config: still,
  cacheDatabase: still,
  cacheOther: still,
  state: still,
  refsChanged: false,
};
