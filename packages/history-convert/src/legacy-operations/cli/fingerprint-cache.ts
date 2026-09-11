import { createHash } from 'node:crypto';
export interface DerivedFingerprintCacheEntry {
  schema_version: 1;
  artifact_id: string;
  checkpoint_n: number;
  source: 'stored_manifest_trees' | 'snapshot_boundaries';
  open_tree_sha: string;
  close_tree_sha: string;
  max_diff_bytes: number;
  manifest_hash_stored: string | null;
  verified: boolean | null;
  note: string | null;
  manifest: unknown;
  derived_summary: {
    status: string;
    manifest_hash: string | null;
    hunk_count: number;
    captured_hunk_count: number;
    truncated: boolean;
  };
  checksum: string;
}
export function computeChecksum(entry: Omit<DerivedFingerprintCacheEntry, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(entry), 'utf8').digest('hex');
}
