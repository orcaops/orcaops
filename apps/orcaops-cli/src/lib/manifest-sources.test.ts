import { describe, expect, it } from 'vitest';

import {
  type ArtifactRow,
  buildDefaultSkippedSnapshotBoundary,
  RecoveryRefusedError,
} from '@orcaops/storage';

import type { CliContext } from './context.js';
import { loadManifestSources } from './manifest-sources.js';

const row = (id: string): ArtifactRow => ({ id }) as ArtifactRow;

function ctxWith(read: (id: string) => Promise<unknown>): CliContext {
  return {
    store: { readCheckpointsRecovered: read },
    archive: null,
  } as unknown as CliContext;
}

describe('loadManifestSources containment', () => {
  it('skips a recovery refusal and names the artifact in skippedUnreadableArtifacts', async () => {
    const ctx = ctxWith((id) =>
      id === 'rotted'
        ? Promise.reject(new RecoveryRefusedError('projection unrecoverable', 'rotted'))
        : Promise.resolve([])
    );
    const result = await loadManifestSources(ctx, [row('rotted'), row('healthy')]);
    expect(result.skippedUnreadableArtifacts).toEqual(['rotted']);
  });

  it('rethrows a non-recovery error instead of downgrading it to a skip', async () => {
    const ctx = ctxWith(() => Promise.reject(new TypeError('boom')));
    await expect(loadManifestSources(ctx, [row('any')])).rejects.toThrow(TypeError);
  });

  it('marks a missing manifest incompatible when its closed summary retains a stored hash', async () => {
    const checkpoint = {
      n: 1,
      status: 'closed',
      closed_at: '2026-08-08T00:00:00.000Z',
      files_changed: ['src/example.ts'],
      window_overlap: undefined,
      diff_fingerprint_summary: {
        status: 'captured',
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        manifest_hash: 'a'.repeat(43),
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        hunk_count: 1,
        captured_hunk_count: 1,
        truncated: false,
        error_reason: null,
      },
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
    };
    const ctx = {
      store: {
        readCheckpointsRecovered: async () => [checkpoint],
        readCheckpointDiffFingerprint: async () => null,
      },
      archive: null,
    } as unknown as CliContext;

    const result = await loadManifestSources(ctx, [row('artifact-a')]);

    expect(result.incompatibleCount).toBe(1);
    expect(result.checkpointGranularity['artifact-a:1']).toBe('incompatible');
    expect(result.manifestless).toEqual([]);
  });
});
