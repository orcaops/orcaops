import { z } from 'zod';

import type { ArtifactThread } from '../events/artifact-thread.js';
import { validateCheckpointFingerprintManifest } from '../schema/diff-fingerprint.js';

export const HISTORY_PROVENANCE_PATH_LIMIT = 512;
export const HISTORY_PROVENANCE_HASH_LIMIT = 4096;
export const HistoryProvenanceMetadataSchema = z.strictObject({
  declaredPaths: z.array(z.string()).max(HISTORY_PROVENANCE_PATH_LIMIT),
  fingerprintPaths: z.array(z.string()).max(HISTORY_PROVENANCE_PATH_LIMIT),
  addedLineHashes: z.array(z.string()).max(HISTORY_PROVENANCE_HASH_LIMIT),
  planOnly: z.boolean(),
  omitted: z.boolean(),
  unavailable: z.boolean(),
  issues: z.array(z.string()),
});
export type HistoryProvenanceMetadata = z.infer<typeof HistoryProvenanceMetadataSchema>;

export async function historyProvenanceMetadata(
  thread: ArtifactThread
): Promise<HistoryProvenanceMetadata> {
  const declared = new Set<string>();
  const paths = new Set<string>();
  const hashes = new Set<string>();
  const issues = new Set<string>();
  let omitted = false;
  let unavailable = false;
  const add = (set: Set<string>, value: string, limit: number) => {
    if (set.has(value)) return;
    if (set.size === limit) omitted = true;
    else set.add(value);
  };
  const closed = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'closed');
  const events = new Map(thread.events.map((event) => [event.record.event_id, event]));
  for (const checkpoint of closed) {
    for (const file of checkpoint.files_changed) add(declared, file, HISTORY_PROVENANCE_PATH_LIMIT);
    const payload = events.get(checkpoint.source_event_ids.closed)?.payload as
      | Record<string, unknown>
      | undefined;
    const raw = payload?.diff_fingerprint_manifest;
    if (raw === undefined && checkpoint.diff_fingerprint_summary.status === 'skipped') continue;
    const validated = await validateCheckpointFingerprintManifest({
      artifactId: thread.artifactId,
      checkpointN: checkpoint.n,
      openTreeSha: checkpoint.open_snapshot.tree_sha,
      closeTreeSha: checkpoint.close_snapshot.tree_sha,
      summary: checkpoint.diff_fingerprint_summary,
      manifest: raw,
    });
    if (!validated.available) {
      unavailable = true;
      issues.add('PROVENANCE_FINGERPRINT_UNAVAILABLE');
      continue;
    }
    const manifest = validated.manifest;
    if (manifest.truncated) {
      omitted = true;
      issues.add('PROVENANCE_FINGERPRINT_TRUNCATED');
    }
    for (const hunk of manifest.hunks) {
      for (const file of [hunk.file_before, hunk.file_after])
        if (file !== null) add(paths, file, HISTORY_PROVENANCE_PATH_LIMIT);
      for (const hash of hunk.added_line_hashes) add(hashes, hash, HISTORY_PROVENANCE_HASH_LIMIT);
    }
  }
  if (omitted) issues.add('PROVENANCE_INDEX_OMITTED');
  return {
    declaredPaths: [...declared].sort(),
    fingerprintPaths: [...paths].sort(),
    addedLineHashes: [...hashes].sort(),
    planOnly: closed.length === 0,
    omitted,
    unavailable,
    issues: [...issues].sort(),
  };
}

export function historyProvenanceMayMatch(
  index: HistoryProvenanceMetadata,
  input: { file: string; lineHash?: string | null }
): boolean {
  return (
    index.omitted ||
    index.unavailable ||
    index.planOnly ||
    index.declaredPaths.includes(input.file) ||
    index.fingerprintPaths.includes(input.file) ||
    (input.lineHash != null && index.addedLineHashes.includes(input.lineHash))
  );
}
