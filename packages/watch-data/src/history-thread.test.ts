import { describe, expect, it } from 'vitest';

import { buildDiffFingerprintManifest } from '@orcaops/core';
import type { ArtifactThread, ClosedCheckpoint } from '@orcaops/storage';

import { threadDetail } from './history-thread.js';

const artifactId = '019dd0f3-a2ca-7e65-8ef4-28e6ab262c5e';
const openTreeSha = 'a'.repeat(40);
const closeTreeSha = 'b'.repeat(40);

async function fixture(mismatch: 'none' | 'artifact' | 'tree' | 'hash' = 'none') {
  const built = await buildDiffFingerprintManifest({
    artifactId,
    checkpointN: 1,
    openTreeSha,
    closeTreeSha,
    diffBytes: Buffer.from(
      'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1,2 @@\n-old\n+new\n+again\n'
    ),
    truncated: false,
    maxDiffBytes: 100_000,
  });
  if (built.manifest === null) throw new Error('Expected a manifest fixture');
  const manifest = structuredClone(built.manifest);
  const summary = structuredClone(built.summary);
  if (mismatch === 'artifact') manifest.artifact_id = `${artifactId.slice(0, -1)}f`;
  if (mismatch === 'tree') manifest.close_tree_sha = 'c'.repeat(40);
  if (mismatch === 'hash') summary.manifest_hash = 'forged';
  const checkpoint = {
    artifact_id: artifactId,
    n: 1,
    status: 'closed',
    declared_step_ids: [],
    completed_step_ids: [],
    files_changed: ['value.ts'],
    decisions: [],
    uncertainty: [],
    summary: 'Changed value',
    closed_at: '2026-09-09T00:00:00.000Z',
    open_snapshot: { tree_sha: openTreeSha },
    close_snapshot: { tree_sha: closeTreeSha },
    diff_fingerprint_summary: summary,
    source_event_ids: { opened: 'open', closed: 'current-close' },
  } as unknown as ClosedCheckpoint;
  const thread = {
    artifactId,
    plan: null,
    checkpoints: [checkpoint],
    events: [
      {
        record: { event_id: 'older-close', type: 'checkpoint_closed' },
        payload: { n: 1, diff_fingerprint_manifest: built.manifest },
      },
      {
        record: { event_id: 'current-close', type: 'checkpoint_closed' },
        payload: { n: 1, diff_fingerprint_manifest: manifest },
      },
    ],
  } as unknown as ArtifactThread;
  return { manifest, thread };
}

describe('history thread fingerprint totals', () => {
  it('counts a consistent manifest from the retained close', async () => {
    const f = await fixture();
    const detail = await threadDetail(f.thread);
    expect(detail.checkpoints[0]).toMatchObject({ linesAdded: 2, linesRemoved: 1 });
  });

  it.each(['artifact', 'tree', 'hash'] as const)(
    'leaves totals unavailable for a mismatched %s while retaining the payload',
    async (mismatch) => {
      const f = await fixture(mismatch);
      const original = structuredClone(f.manifest);
      const detail = await threadDetail(f.thread);
      expect(detail.checkpoints[0]).toMatchObject({ linesAdded: null, linesRemoved: null });
      expect(f.manifest).toEqual(original);
    }
  );

  it('does not fall back to an older close when the retained close is inconsistent', async () => {
    const f = await fixture('hash');
    const detail = await threadDetail(f.thread);
    expect(detail.checkpoints[0]).toMatchObject({ linesAdded: null, linesRemoved: null });
  });
});
