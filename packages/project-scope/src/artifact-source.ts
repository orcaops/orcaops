import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

import { artifactPathsFor, type ArtifactStore, type ProjectIndexMeta } from '@orcaops/storage';

export type ArtifactProjectionSource = 'hot' | 'archive';

export interface ArtifactSourceCandidate {
  hotPresent: boolean;
  archivePresent: boolean;
  hotLastWriteMs: number | null;
  archiveLastWriteMs: number | null;
}

export interface ArtifactSourceResolution {
  source: ArtifactProjectionSource;
  lastWriteMs: number | null;
}

/**
 * Archive wins only when strictly newer. Hot is written before its mirror
 * under the same lock, so equal high-waters are ordinary mirror completion.
 */
export function resolveArtifactSource(
  candidate: ArtifactSourceCandidate
): ArtifactSourceResolution | null {
  if (candidate.hotPresent && candidate.archivePresent) {
    if (
      candidate.archiveLastWriteMs !== null &&
      (candidate.hotLastWriteMs === null || candidate.archiveLastWriteMs > candidate.hotLastWriteMs)
    ) {
      return { source: 'archive', lastWriteMs: candidate.archiveLastWriteMs };
    }
    return { source: 'hot', lastWriteMs: candidate.hotLastWriteMs };
  }
  if (candidate.hotPresent) {
    return { source: 'hot', lastWriteMs: candidate.hotLastWriteMs };
  }
  if (candidate.archivePresent) {
    return { source: 'archive', lastWriteMs: candidate.archiveLastWriteMs };
  }
  return null;
}

/** Read failures propagate so an archive twin cannot hide poisoned hot data. */
export async function hotLastWriteMs(hot: ArtifactStore, artifactId: string): Promise<number> {
  const { eventsNdjson } = artifactPathsFor(hot.repoRoot, hot.config, artifactId);
  const handle = await open(eventsNdjson, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const value = await handle.stat();
    if (!value.isFile()) {
      throw new Error(`Hot event log is not a regular file: ${eventsNdjson}`);
    }
    return value.mtimeMs;
  } finally {
    await handle.close();
  }
}

export function archiveLastWriteMs(meta: ProjectIndexMeta, artifactId: string): number | null {
  return meta.artifacts[artifactId]?.mtime_ms ?? null;
}
