import { aggregateProjectUsage, readProjectUsage } from '@orcaops/storage/history/database';
import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { artifactUsageFromRetainedEvents } from './artifact-usage.js';
import type { ArtifactUsageData } from './hash.js';

export function readDatabaseArtifactUsageSource(
  handle: ProjectDatabase,
  artifactId: string
): ArtifactUsageData | null {
  return readDatabaseArtifactUsageSnapshot(handle, artifactId).source;
}

export function readDatabaseArtifactUsageSnapshot(handle: ProjectDatabase, artifactId: string) {
  const usage = readProjectUsage(handle);
  if (usage === null) return { source: null, revision: null };
  const accounting = aggregateProjectUsage([handle], {
    artifactIds: [artifactId],
    expectedWriteSequence: usage.counters.writeSequence,
  });
  return {
    source: artifactUsageFromRetainedEvents(usage.events, accounting, artifactId),
    revision: usage.revision,
  };
}
