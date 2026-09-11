import { describe, expect, it } from 'vitest';

import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  lineHash,
  summarizeManifest,
} from '@orcaops/diff-fingerprint';

import { encodeArtifactEvent } from './event-encoding.js';
import {
  HISTORY_PROVENANCE_HASH_LIMIT,
  HISTORY_PROVENANCE_PATH_LIMIT,
  historyProvenanceMayMatch,
  historyProvenanceMetadata,
} from './metadata-provenance.js';
import { reconstructArtifactThread } from '../events/artifact-thread.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { buildDefaultSkippedSnapshotBoundary } from '../schema/diff-fingerprint.js';
import { PlanInputSchema } from '../schema/plan.js';

const ts = '2026-09-05T10:00:00.000Z';
async function fixture(count = 1) {
  const artifactId = uuidv7();
  const planId = uuidv7();
  const plan = PlanInputSchema.parse({
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
    task: 'Keep evidence',
    label: 'Evidence',
    plan_steps: [
      { step_id: uuidv7(), text: 'Keep evidence', label: 'Evidence', acceptance_criteria: [] },
    ],
    touched_scope: ['auth', 'filename-looking.ts'],
    non_goals: [],
    decisions: [],
    started_at: ts,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  });
  const manifest = await buildDiffFingerprintManifest({
    artifactId,
    checkpointN: 1,
    openTreeSha: 'a'.repeat(40),
    closeTreeSha: 'b'.repeat(40),
    diffBytes: Buffer.from(
      `diff --git a/retained.ts b/retained.ts\n--- a/retained.ts\n+++ b/retained.ts\n@@ -0,0 +1,${count} @@\n` +
        Array.from({ length: count }, (_, n) => `+const retained${n} = true;\n`).join('')
    ),
    truncated: false,
    maxDiffBytes: 1_000_000,
  });
  const close: Record<string, unknown> = {
    artifact_id: artifactId,
    n: 1,
    summary: 'Keep original bytes',
    files_changed: ['declared.ts'],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    completed_step_ids: [plan.plan_steps[0].step_id],
    closed_by_agent: 'codex',
    head_sha: 'b'.repeat(40),
    ts,
    close_snapshot: buildDefaultSkippedSnapshotBoundary(),
    diff_fingerprint_summary: manifest.summary,
    diff_fingerprint_manifest: manifest.manifest,
  };
  const event = (
    type: Parameters<typeof encodeArtifactEvent>[0]['type'],
    payload: unknown,
    eventId = uuidv7()
  ) => {
    const { record } = encodeArtifactEvent({
      type,
      payload,
      event_id: eventId,
      ts,
      idempotency_key: uuidv7(),
    });
    return { record, payload };
  };
  const planEvent = event('plan_captured', plan, planId);
  const thread = (planOnly = false) =>
    reconstructArtifactThread(artifactId, [
      planEvent,
      ...(planOnly
        ? []
        : [
            event('checkpoint_opened', {
              artifact_id: artifactId,
              n: 1,
              declared_step_ids: [plan.plan_steps[0].step_id],
              agent: 'codex',
              policy_exceptions: [],
              plan_revision_id: null,
              open_plan_revision_event_id: planId,
              opened_at: ts,
              head_sha: 'a'.repeat(40),
              open_snapshot: buildDefaultSkippedSnapshotBoundary(),
            }),
            event('checkpoint_closed', close),
          ]),
    ]);
  return { artifactId, close, manifest, thread };
}

describe('provenance candidate metadata', () => {
  it('indexes genuine claims and cross-file hashes without treating evaluator categories as paths', async () => {
    const f = await fixture();
    const index = await historyProvenanceMetadata(f.thread());
    expect(index).toMatchObject({
      declaredPaths: ['declared.ts'],
      fingerprintPaths: ['retained.ts'],
      unavailable: false,
      omitted: false,
      planOnly: false,
    });
    expect(historyProvenanceMayMatch(index, { file: 'declared.ts' })).toBe(true);
    expect(historyProvenanceMayMatch(index, { file: 'filename-looking.ts' })).toBe(false);
    expect(
      historyProvenanceMayMatch(index, {
        file: 'copy.ts',
        lineHash: await lineHash('add', Buffer.from('const retained0 = true;')),
      })
    ).toBe(true);
    expect(historyProvenanceMayMatch(index, { file: 'unrelated.ts' })).toBe(false);
  });

  it('retains plan-only context without claiming a typed file declaration', async () => {
    const f = await fixture();
    const index = await historyProvenanceMetadata(f.thread(true));
    expect(index).toMatchObject({
      declaredPaths: [],
      fingerprintPaths: [],
      addedLineHashes: [],
      planOnly: true,
    });
    expect(historyProvenanceMayMatch(index, { file: 'unproven.ts' })).toBe(true);
  });

  it.each(['missing', 'malformed', 'mismatched', 'foreign'] as const)(
    'conservatively includes %s fingerprint evidence with a disclosure',
    async (condition) => {
      const f = await fixture();
      if (condition === 'missing') delete f.close.diff_fingerprint_manifest;
      else if (condition === 'malformed') f.close.diff_fingerprint_manifest = { broken: true };
      else {
        const manifest = { ...f.manifest.manifest!, artifact_id: uuidv7() };
        f.close.diff_fingerprint_manifest = manifest;
        if (condition === 'foreign')
          f.close.diff_fingerprint_summary = summarizeManifest(
            manifest,
            await computeDiffFingerprintManifestHash(manifest)
          );
      }
      const index = await historyProvenanceMetadata(f.thread());
      expect(index).toMatchObject({
        unavailable: true,
        issues: ['PROVENANCE_FINGERPRINT_UNAVAILABLE'],
      });
      expect(historyProvenanceMayMatch(index, { file: 'otherwise-absent.ts' })).toBe(true);
    }
  );

  it('bounds indexed paths and hashes while forcing inclusion for omitted observations', async () => {
    const f = await fixture(HISTORY_PROVENANCE_HASH_LIMIT + 1);
    f.close.files_changed = Array.from(
      { length: HISTORY_PROVENANCE_PATH_LIMIT + 1 },
      (_, n) => `path-${n}.ts`
    );
    const index = await historyProvenanceMetadata(f.thread());
    expect(index.declaredPaths).toHaveLength(HISTORY_PROVENANCE_PATH_LIMIT);
    expect(index.addedLineHashes).toHaveLength(HISTORY_PROVENANCE_HASH_LIMIT);
    expect(index).toMatchObject({ omitted: true, issues: ['PROVENANCE_INDEX_OMITTED'] });
    expect(historyProvenanceMayMatch(index, { file: 'unindexed.ts' })).toBe(true);
  });

  it('does not use a truncated original fingerprint to prove candidate absence', async () => {
    const f = await fixture();
    const manifest = {
      ...f.manifest.manifest!,
      status: 'truncated' as const,
      truncated: true,
      error_reason: 'cap_exceeded' as const,
    };
    f.close.diff_fingerprint_manifest = manifest;
    f.close.diff_fingerprint_summary = summarizeManifest(
      manifest,
      await computeDiffFingerprintManifestHash(manifest)
    );
    const index = await historyProvenanceMetadata(f.thread());
    expect(index.omitted).toBe(true);
    expect(index.issues).toContain('PROVENANCE_FINGERPRINT_TRUNCATED');
    expect(historyProvenanceMayMatch(index, { file: 'possibly-omitted.ts' })).toBe(true);
  });
});
