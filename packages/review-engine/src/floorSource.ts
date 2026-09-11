import { type Floor } from '@orcaops/review-core';

import { readDatabaseReviewContext } from './database/read-context.js';

export interface HealthyFloorSource {
  floor: Floor;
  diffText: string;
  floorFingerprint: string;
}

/**
 * The selected floor from the canonical store. Replaces the `floor.json` /
 * `diff.patch` / cache-marker read for every consumer that only needs the
 * current floor and its diff: the retained publication IS the cache, so a
 * healthy read is one that resolves to a selected floor publication.
 *
 * The floor's own `input_hash` stands in for the file cache's marker
 * fingerprint. Both answer the one question the callers ask — did the floor
 * change underneath this build — and the input hash is the floor's retained
 * identity rather than a separate marker that can disagree with it.
 */
export async function loadCanonicalFloorSource(
  branch: string,
  options: { cwd: string; projectId?: string; dataRoot?: string }
): Promise<HealthyFloorSource> {
  const context = await readDatabaseReviewContext({
    branch,
    cwd: options.cwd,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
  });
  if (context.floor === null)
    throw new Error(`no selected floor for '${branch}'; run review data first`);
  return {
    floor: context.floor.floor as Floor,
    diffText: Buffer.from(context.floor.diffBytes).toString('utf8'),
    floorFingerprint: context.floor.floor.input_hash,
  };
}
