import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { archiveArtifactPaths, atomicWriteFile } from '@orcaops/storage';

/**
 * Archive-side cache for `fingerprint derive` output. A checksummed FILE under the
 * project's archive dir (`artifacts/<id>/derived/fingerprint-cp<n>.json`),
 * deliberately NOT an event: archive event logs remain a pure mirror of
 * the hot log. The cache is optional and transparent — consumers re-derive
 * on demand when it's absent, and stored manifest tree fields stay
 * authoritative. A corrupt or input-mismatched entry is simply ignored
 * (re-derive + rewrite).
 */
export interface DerivedFingerprintCacheEntry {
  schema_version: 1;
  artifact_id: string;
  checkpoint_n: number;
  source: 'stored_manifest_trees' | 'snapshot_boundaries';
  open_tree_sha: string;
  close_tree_sha: string;
  max_diff_bytes: number;
  /** The stored manifest_hash the derivation compared against (null = none). */
  manifest_hash_stored: string | null;
  verified: boolean | null;
  note: string | null;
  /** The full derived manifest — read instead of re-deriving. */
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

function cachePath(projectDir: string, artifactId: string, n: number): string {
  return path.join(
    archiveArtifactPaths(projectDir, artifactId).derivedDir,
    `fingerprint-cp${n}.json`
  );
}

function computeChecksum(entry: Omit<DerivedFingerprintCacheEntry, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(entry), 'utf8').digest('hex');
}

/** Read + verify a cache entry; null on missing/corrupt/tampered. */
export async function readDerivedCache(
  projectDir: string,
  artifactId: string,
  n: number
): Promise<DerivedFingerprintCacheEntry | null> {
  try {
    const raw = await readFile(cachePath(projectDir, artifactId, n), 'utf8');
    const parsed = JSON.parse(raw) as DerivedFingerprintCacheEntry;
    if (parsed.schema_version !== 1) return null;
    const { checksum, ...rest } = parsed;
    if (computeChecksum(rest) !== checksum) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort write (fail-open — the cache must never fail a derive). */
export async function writeDerivedCache(
  projectDir: string,
  artifactId: string,
  n: number,
  entry: Omit<DerivedFingerprintCacheEntry, 'checksum'>
): Promise<void> {
  try {
    const file = cachePath(projectDir, artifactId, n);
    await mkdir(path.dirname(file), { recursive: true });
    const full: DerivedFingerprintCacheEntry = { ...entry, checksum: computeChecksum(entry) };
    await atomicWriteFile(file, JSON.stringify(full, null, 2) + '\n');
  } catch {
    // fail-open: derive output was already rendered from live computation
  }
}
