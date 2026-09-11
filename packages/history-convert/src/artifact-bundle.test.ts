import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildDiffFingerprintManifest } from '@orcaops/diff-fingerprint';

import {
  assertDecodedLegacyArtifactBundle,
  decodeLegacyArtifactBundle,
} from './artifact-bundle.js';
import { decodeLegacyArtifact } from './artifact.js';
import { checkpointMarkdown, planMarkdown } from './legacy/storage/artifacts/store.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { buildDefaultSkippedFingerprintSummary } from './legacy/storage/schema/diff-fingerprint.js';
import { computeChecksum } from './legacy-operations/cli/fingerprint-cache.js';

const artifactId = '01999999-9999-7000-8000-000000000001';
const eventId = '01999999-9999-7000-8000-000000000002';
const plan = JSON.parse(
  readFileSync(new URL('../fixtures/artifact-plan.json', import.meta.url), 'utf8')
);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function event(payload: unknown, id = artifactId, type = 'plan_captured') {
  const unsigned = {
    event_id: id,
    type,
    ts: '2026-04-26T12:00:00.000Z',
    schema_version: 1,
    idempotency_key: id,
    payload,
  };
  return encode({
    ...unsigned,
    checksum: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  });
}
function fixture() {
  const events = event(plan);
  const artifact = decodeLegacyArtifact({ artifactId, bytes: events });
  const members = [
    { relativePath: 'events.ndjson', bytes: events },
    { relativePath: 'artifact.json', bytes: encode(artifact.artifact) },
    { relativePath: 'plan.json', bytes: encode(artifact.plan) },
    { relativePath: 'plan.md', bytes: Buffer.from(planMarkdown(artifact.plan)) },
    { relativePath: 'digest.md', bytes: Buffer.from('Original digest bytes\n') },
    {
      relativePath: 'digest.meta.json',
      bytes: encode({ source_event_id: artifactId, usage_fingerprint: 'retained-usage-hash' }),
    },
    { relativePath: 'resume.md', bytes: Buffer.from('Original handoff bytes\n') },
  ];
  return { artifact, members };
}
describe('retained artifact attachments', () => {
  it('binds a derived manifest and checkpoint renders to the retained closed checkpoint', async () => {
    const openTree = 'a'.repeat(40);
    const closeTree = 'b'.repeat(40);
    const built = await buildDiffFingerprintManifest({
      artifactId,
      checkpointN: 1,
      openTreeSha: openTree,
      closeTreeSha: closeTree,
      diffBytes: Buffer.from(
        'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
      ),
      truncated: false,
      maxDiffBytes: 1024,
    });
    const snapshot = (tree: string) => ({
      snapshot_ref: `refs/orcaops/snapshot/${tree}`,
      tree_sha: tree,
      snapshot_commit_sha: 'c'.repeat(40),
      snapshot_error_reason: null,
    });
    const opened = {
      artifact_id: artifactId,
      n: 1,
      declared_step_ids: ['step-1'],
      agent_session_id: 'source-session',
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: artifactId,
      open_plan_revision_event_id: artifactId,
      opened_at: plan.started_at,
      head_sha: openTree,
      open_snapshot: snapshot(openTree),
    };
    const closed = {
      artifact_id: artifactId,
      n: 1,
      closed_by_agent: 'codex',
      summary: 'Original close',
      files_changed: ['a.txt'],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: closeTree,
      ts: plan.started_at,
      close_snapshot: snapshot(closeTree),
      diff_fingerprint_summary: built.summary,
      diff_fingerprint_manifest: built.manifest,
    };
    const bytes = Buffer.concat([
      event(plan),
      event(opened, eventId, 'checkpoint_opened'),
      event(closed, '01999999-9999-7000-8000-000000000003', 'checkpoint_closed'),
    ]);
    const decoded = decodeLegacyArtifact({ artifactId, bytes });
    const cp = decoded.checkpoints[0]!;
    const entry = {
      schema_version: 1 as const,
      artifact_id: artifactId,
      checkpoint_n: 1,
      source: 'stored_manifest_trees' as const,
      open_tree_sha: openTree,
      close_tree_sha: closeTree,
      max_diff_bytes: 1024,
      manifest_hash_stored: built.summary.manifest_hash,
      verified: true,
      note: null,
      manifest: built.manifest,
      derived_summary: {
        status: built.summary.status,
        manifest_hash: built.summary.manifest_hash,
        hunk_count: built.summary.hunk_count,
        captured_hunk_count: built.summary.captured_hunk_count,
        truncated: built.summary.truncated,
      },
    };
    const members = [
      { relativePath: 'events.ndjson', bytes },
      { relativePath: 'checkpoint-1.json', bytes: encode(cp) },
      { relativePath: 'checkpoint-1.md', bytes: Buffer.from(checkpointMarkdown(cp)) },
      {
        relativePath: 'derived/fingerprint-cp1.json',
        bytes: encode({ ...entry, checksum: computeChecksum(entry) }),
      },
    ];
    const graph = await decodeLegacyArtifactBundle({ artifactId, members });
    expect(graph.auxiliaries.every((value) => value.fidelity === 'matches-current')).toBe(true);
    expect(
      graph.auxiliaries.find((value) => value.kind === 'derived-fingerprint')?.sourceEventId
    ).toBe(cp.source_event_id);
    const missing = Buffer.concat([
      event(plan),
      event(opened, eventId, 'checkpoint_opened'),
      event(
        { ...closed, diff_fingerprint_manifest: undefined },
        '01999999-9999-7000-8000-000000000003',
        'checkpoint_closed'
      ),
    ]);
    await expect(
      decodeLegacyArtifactBundle({
        artifactId,
        members: [{ relativePath: 'events.ndjson', bytes: missing }],
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    for (const manifest of [
      { ...built.manifest, hunks: 'invalid' },
      { ...built.manifest, hunks: [] },
    ]) {
      const malformed = Buffer.concat([
        event(plan),
        event(opened, eventId, 'checkpoint_opened'),
        event(
          { ...closed, diff_fingerprint_manifest: manifest },
          '01999999-9999-7000-8000-000000000003',
          'checkpoint_closed'
        ),
      ]);
      await expect(
        decodeLegacyArtifactBundle({
          artifactId,
          members: [{ relativePath: 'events.ndjson', bytes: malformed }],
        })
      ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
    }
    for (const change of [
      { diff_fingerprint_manifest: { ...built.manifest, checkpoint_n: 2 } },
      { diff_fingerprint_summary: { ...built.summary, manifest_hash: 'different-summary-hash' } },
    ]) {
      const changed = Buffer.concat([
        event(plan),
        event(opened, eventId, 'checkpoint_opened'),
        event(
          { ...closed, ...change },
          '01999999-9999-7000-8000-000000000003',
          'checkpoint_closed'
        ),
      ]);
      const retained = await decodeLegacyArtifactBundle({
        artifactId,
        members: [{ relativePath: 'events.ndjson', bytes: changed }],
      });
      expect(retained.auxiliaries).toContainEqual({
        relativePath: 'events.ndjson',
        kind: 'derived-fingerprint',
        authority: 'original-attachment',
        fidelity: 'differs-from-current',
        sourceEventId: '01999999-9999-7000-8000-000000000003',
      });
      expect(Buffer.from(retained.members[0]!.bytesBase64, 'base64')).toEqual(changed);
    }
    const skipped = Buffer.concat([
      event(plan),
      event(opened, eventId, 'checkpoint_opened'),
      event(
        {
          ...closed,
          diff_fingerprint_manifest: undefined,
          diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
        },
        '01999999-9999-7000-8000-000000000003',
        'checkpoint_closed'
      ),
    ]);
    expect(
      (
        await decodeLegacyArtifactBundle({
          artifactId,
          members: [{ relativePath: 'events.ndjson', bytes: skipped }],
        })
      ).artifact.checkpoints[0]!.status
    ).toBe('closed');
    members[3]!.relativePath = 'derived/fingerprint-cp2.json';
    await expect(decodeLegacyArtifactBundle({ artifactId, members })).rejects.toMatchObject({
      code: 'SOURCE_INTEGRITY',
    });
  });
  it('preserves exact generated files with bounded renderer comparisons and no authority promotion', async () => {
    const f = fixture();
    const bundle = await decodeLegacyArtifactBundle({ artifactId, members: f.members });
    expect(bundle.members).toHaveLength(7);
    expect(bundle.auxiliaries).toHaveLength(6);
    expect(bundle.auxiliaries.every((entry) => entry.authority === 'original-attachment')).toBe(
      true
    );
    expect(bundle.auxiliaries.find((entry) => entry.relativePath === 'plan.md')).toMatchObject({
      fidelity: 'matches-current',
      sourceEventId: null,
    });
    expect(bundle.auxiliaries.find((entry) => entry.relativePath === 'resume.md')).toMatchObject({
      fidelity: 'not-compared',
      sourceEventId: null,
    });
    expect(() => assertDecodedLegacyArtifactBundle(bundle)).not.toThrow();
    expect(() => assertDecodedLegacyArtifactBundle({ ...bundle })).toThrow();
    f.members[3]!.bytes.fill(0);
    expect(
      Buffer.from(
        bundle.members.find((entry) => entry.relativePath === 'plan.md')!.bytesBase64,
        'base64'
      ).toString()
    ).toContain('do the thing');
  });
  it('reports divergent generated narrative while retaining the authoritative event representation', async () => {
    const f = fixture();
    const replacement = { ...f.artifact.plan, task: 'Different retained projection narrative' };
    f.members[2]!.bytes = encode(replacement);
    f.members[3]!.bytes = Buffer.from('Different retained generated Markdown\n');
    const bundle = await decodeLegacyArtifactBundle({ artifactId, members: f.members });
    expect(bundle.artifact.plan.task).toBe('do the thing');
    expect(
      bundle.auxiliaries
        .filter((entry) => entry.fidelity === 'differs-from-current')
        .map((entry) => entry.relativePath)
    ).toEqual(['plan.json', 'plan.md']);
    expect(
      Buffer.from(
        bundle.members.find((entry) => entry.relativePath === 'plan.json')!.bytesBase64,
        'base64'
      )
    ).toEqual(encode(replacement));
  });
  it('requires structured projections to reference an existing event that produces their kind', async () => {
    const f = fixture();
    f.members[2]!.bytes = encode({ ...f.artifact.plan, source_event_id: eventId });
    await expect(
      decodeLegacyArtifactBundle({ artifactId, members: f.members })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    f.members[0]!.bytes = Buffer.concat([
      f.members[0]!.bytes,
      event({ reason: 'explicit-checkout' }, eventId, 'pin_displaced'),
    ]);
    await expect(
      decodeLegacyArtifactBundle({ artifactId, members: f.members })
    ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
  });
  it('refuses absent named dependencies and unknown schema fields without printing original prose', async () => {
    const f = fixture();
    await expect(
      decodeLegacyArtifactBundle({
        artifactId,
        members: f.members.filter((entry) => entry.relativePath !== 'digest.md'),
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    f.members[2]!.bytes = encode({ ...f.artifact.plan, unique: 'private source bytes' });
    await expect(
      decodeLegacyArtifactBundle({ artifactId, members: f.members })
    ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
    await expect(
      decodeLegacyArtifactBundle({
        artifactId,
        members: [
          ...fixture().members,
          { relativePath: 'checkpoint-9.md', bytes: Buffer.from('missing checkpoint bytes') },
        ],
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('blocks unknown files even when their directory is named derived', async () => {
    await expect(
      decodeLegacyArtifactBundle({
        artifactId,
        members: [
          ...fixture().members,
          { relativePath: 'derived/future.json', bytes: encode({ version: 9 }) },
        ],
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RESOURCE_SCHEMA' });
  });
});
