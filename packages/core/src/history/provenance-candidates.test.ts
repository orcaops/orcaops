import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDefaultSkippedSnapshotBoundary,
  canonicalJson,
  computeMemberShasHash,
  type EventType,
  type EventWithPayload,
  PlanInputSchema,
  reconstructArtifactThread,
  uuidv7,
} from '@orcaops/storage';
import {
  bindingFromGitContext,
  initializeCapturedExecution,
  initializeUnboundExecution,
  recordExecutionCheckpointOpen,
} from '@orcaops/storage/history/execution';
import { digest, encodeArtifactEvent } from '@orcaops/storage/history/primitives';

import { resolveDatabaseGitContext } from './context/git-context.js';
import { runHistoryGit } from './git-context.js';
import {
  collectRetainedProvenanceCandidates,
  type ProvenanceIssue,
  type RetainedProvenanceArtifact,
  type RetainedProvenanceSource,
} from './provenance-candidates.js';
import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  summarizeManifest,
} from '../diff-fingerprint/adapter.js';

const roots: string[] = [];
const ts = '2026-09-05T10:00:00.000Z';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provenance-candidates-')));
  roots.push(root);
  const main = path.join(root, 'main');
  await mkdir(main);
  await runHistoryGit(main, ['init', '-qb', 'main']);
  await runHistoryGit(main, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Initial',
  ]);
  const context = {
    ...(await resolveDatabaseGitContext({ cwd: main })),
    repositoryInstanceId: uuidv7(),
    worktreeId: uuidv7(),
    headOid: (await runHistoryGit(main, ['rev-parse', '--verify', 'HEAD'])).stdout.trim(),
    branch: 'main',
  };
  const authority = {
    root_key: digest(root),
    project_id: uuidv7(),
    store_instance_id: uuidv7(),
  };
  const published = new Map<
    string,
    { events: EventWithPayload[]; executionState: unknown; generation: number; damaged: boolean }
  >();
  async function artifact(
    options: { planOnly?: boolean; imported?: boolean; context?: typeof context } = {}
  ) {
    const originContext = options.context ?? context;
    const artifactId = uuidv7();
    const planId = uuidv7();
    const openId = uuidv7();
    const closeId = uuidv7();
    const operationId = uuidv7();
    const plan = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'feature',
      base_sha: originContext.headOid,
      agent: 'codex',
      agent_session_id: null,
      task: 'Preserve original rationale',
      label: 'Original rationale',
      plan_steps: [
        {
          step_id: uuidv7(),
          text: 'Keep selected evidence',
          label: 'Selected evidence',
          acceptance_criteria: [],
        },
      ],
      touched_scope: ['selected.ts'],
      non_goals: [],
      decisions: [
        { decision: 'Keep exact evidence', reason: 'Permit later review', revision_n: 0 },
      ],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
      ...(options.imported
        ? {
            origin: {
              kind: 'git-import',
              imported_at: ts,
              enriched_at: null,
              tool_version: 'test',
              source_range: originContext.headOid,
              authors: ['Test'],
              member_shas: [originContext.headOid!],
              member_shas_hash: computeMemberShasHash([originContext.headOid!]),
              cluster_key: 'b'.repeat(64),
            },
          }
        : {}),
    });
    const pin = {
      source_ref: { kind: 'local' as const, locator: '/removed/source.md' },
      content: 'Keep original source requirements.',
      hash: digest('Keep original source requirements.'),
      baseline: null,
    };
    const built = await buildDiffFingerprintManifest({
      artifactId,
      checkpointN: 1,
      openTreeSha: 'a'.repeat(40),
      closeTreeSha: 'b'.repeat(40),
      diffBytes: Buffer.from(
        'diff --git a/selected.ts b/selected.ts\n--- a/selected.ts\n+++ b/selected.ts\n@@ -1 +1 @@\n-const selected = "old";\n+const selected = "retained";\n'
      ),
      truncated: false,
      maxDiffBytes: 100_000,
    });
    const add = (type: EventType, payload: unknown, eventId = uuidv7()): EventWithPayload => {
      const encoded = encodeArtifactEvent({
        type,
        payload,
        event_id: eventId,
        ts,
        idempotency_key: uuidv7(),
      });
      return { record: encoded.record, payload };
    };
    const open = {
      artifact_id: artifactId,
      n: 1,
      declared_step_ids: [plan.plan_steps[0].step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: planId,
      opened_at: ts,
      head_sha: originContext.headOid,
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
    };
    const close = {
      artifact_id: artifactId,
      n: 1,
      summary: 'Original close evidence',
      files_changed: ['selected.ts'],
      decisions: [{ decision: 'Retain the original boundary', reason: 'Avoid revision drift' }],
      uncertainty: ['Independent branch relevance still needs Git evidence'],
      done_criteria: [],
      completed_step_ids: [plan.plan_steps[0].step_id],
      closed_by_agent: 'codex',
      head_sha: originContext.headOid,
      ts,
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: built.summary,
      diff_fingerprint_manifest: built.manifest,
    };
    const events = [
      add('plan_captured', { ...plan, source_plan: pin }, planId),
      ...(!options.planOnly
        ? [add('checkpoint_opened', open, openId), add('checkpoint_closed', close, closeId)]
        : []),
    ];
    let executionState = options.imported
      ? initializeUnboundExecution({ artifactId, operationId, reason: 'imported', ts })
      : initializeCapturedExecution({
          artifactId,
          operationId,
          context: bindingFromGitContext(originContext),
          ts,
        });
    if (!options.planOnly && !options.imported)
      executionState = recordExecutionCheckpointOpen({
        state: executionState,
        checkpointEventId: openId,
        expectedGeneration: 1,
        context: bindingFromGitContext(originContext),
      });
    async function publish() {
      expect(published.has(artifactId)).toBe(false);
      published.set(artifactId, {
        events: structuredClone(events),
        executionState: structuredClone(executionState),
        generation: 1,
        damaged: false,
      });
    }
    function append(entries: EventWithPayload[]) {
      const current = published.get(artifactId);
      if (!current) throw new Error('Publish the artifact before appending');
      current.events.push(...structuredClone(entries));
      current.generation += 1;
    }
    return {
      artifactId,
      planId,
      openId,
      closeId,
      plan,
      pin,
      built,
      events,
      open,
      close,
      add,
      publish,
      append,
    };
  }
  function openView(options: { artifactIds?: readonly string[] } = {}) {
    const ids = options.artifactIds ?? [...published.keys()];
    const issues: ProvenanceIssue[] = [];
    const artifacts: RetainedProvenanceArtifact[] = [];
    for (const artifactId of ids) {
      const value = published.get(artifactId);
      if (!value) continue;
      if (value.damaged) {
        issues.push({
          artifact_id: artifactId,
          source_event_id: null,
          code: 'HISTORY_INTEGRITY_REQUIRED',
          message: 'Retained artifact evidence is unavailable',
        });
        continue;
      }
      const events = structuredClone(value.events);
      artifacts.push({
        artifact_id: artifactId,
        version_token: digest(canonicalJson({ generation: value.generation, events })),
        artifact_generation: value.generation,
        pending: false,
        thread: reconstructArtifactThread(artifactId, events),
        execution_state: structuredClone(value.executionState),
      });
    }
    return {
      root_key: authority.root_key,
      project_id: authority.project_id,
      store_instance_id: authority.store_instance_id,
      artifacts,
      issues,
    } satisfies RetainedProvenanceSource;
  }
  function damage(artifactId: string) {
    const value = published.get(artifactId);
    if (!value) throw new Error('Publish the artifact before damaging it');
    value.damaged = true;
  }
  return { root, main, authority, context, artifact, openView, damage };
}

async function collectProvenanceCandidates(input: {
  source: RetainedProvenanceSource;
  artifactIds: readonly string[];
}) {
  return collectRetainedProvenanceCandidates(input);
}

describe('committed provenance candidates', { timeout: 30_000 }, () => {
  it('collects detached evidence from explicit immutable artifact snapshots', async () => {
    const f = await fixture();
    const a = await f.artifact();
    await a.publish();
    const source = f.openView();
    const retained = await collectRetainedProvenanceCandidates({
      source,
      artifactIds: [a.artifactId],
    });
    expect(retained.source_versions).toEqual([
      { artifact_id: a.artifactId, version_token: source.artifacts[0].version_token },
    ]);
    expect(retained.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact_id: a.artifactId,
          project_id: f.authority.project_id,
          store_instance_id: f.authority.store_instance_id,
        }),
      ])
    );
    retained.candidates[0].plan_support.plan!.decisions.length = 0;
    expect(
      (await collectProvenanceCandidates({ source, artifactIds: [a.artifactId] })).candidates[0]
        .plan_support.plan?.decisions
    ).toHaveLength(1);
  });

  it('keeps the original plan, source pin and fingerprints at one immutable version after a revision', async () => {
    const f = await fixture();
    const a = await f.artifact();
    await a.publish();
    const reader = f.openView();
    const first = await collectProvenanceCandidates({
      source: reader,
      artifactIds: [a.artifactId],
    });
    const next = {
      ...a.plan,
      revision_n: 1,
      revised_at: ts,
      prior_plan_event_id: a.planId,
      rationale: 'Different later approach',
      task: 'Later task',
      decisions: [
        ...a.plan.decisions,
        { decision: 'Use a later strategy', reason: 'New information', revision_n: 1 },
      ],
    };
    const revisedId = uuidv7();
    a.append([a.add('plan_revised', next, revisedId)]);
    expect(
      await collectProvenanceCandidates({ source: reader, artifactIds: [a.artifactId] })
    ).toEqual(first);
    const current = f.openView();
    const result = await collectProvenanceCandidates({
      source: current,
      artifactIds: [a.artifactId],
    });
    const checkpoint = result.candidates.find((candidate) => candidate.kind === 'checkpoint')!;
    expect(checkpoint).toMatchObject({
      source_event_id: a.closeId,
      source_plan: a.pin,
      plan_support: {
        anchor_event_id: a.planId,
        source_event_id: a.planId,
        plan: { task: a.plan.task, revision_n: 0, decisions: a.plan.decisions },
      },
      checkpoint: { decisions: a.close.decisions, uncertainty: a.close.uncertainty },
      fingerprint: { state: 'available', manifest: a.built.manifest },
      association: { unknown: false, checkpoint_worktree_id: f.context.worktreeId },
    });
    expect(checkpoint.version_token).not.toBe(first.candidates[0].version_token);
    expect(
      result.candidates.find((candidate) => candidate.source_event_id === revisedId)?.plan_support
        .plan?.task
    ).toBe('Later task');
    checkpoint.plan_support.plan!.decisions.length = 0;
    expect(
      (await collectProvenanceCandidates({ source: current, artifactIds: [a.artifactId] }))
        .candidates[0].plan_support.plan?.decisions
    ).toHaveLength(1);
  });

  it('retains plan-only rationale without inventing a checkpoint or file attribution', async () => {
    const f = await fixture();
    const a = await f.artifact({ planOnly: true });
    await a.publish();
    const reader = f.openView();
    const result = await collectProvenanceCandidates({
      source: reader,
      artifactIds: [a.artifactId],
    });
    expect(result.completeness.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: 'plan',
      checkpoint: null,
      source_event_id: a.planId,
      plan_support: { plan: { decisions: a.plan.decisions } },
      fingerprint: { state: 'skipped', manifest: null },
    });
  });

  it.each(['missing', 'future'] as const)(
    'preserves %s original plan support as unavailable',
    async (condition) => {
      const f = await fixture();
      const a = await f.artifact();
      a.open.open_plan_revision_event_id = uuidv7();
      if (condition === 'future')
        a.events.push(
          a.add(
            'plan_revised',
            {
              ...a.plan,
              revision_n: 1,
              revised_at: ts,
              prior_plan_event_id: a.planId,
              rationale: 'Later information',
            },
            a.open.open_plan_revision_event_id
          )
        );
      await a.publish();
      const reader = f.openView();
      const result = await collectProvenanceCandidates({
        source: reader,
        artifactIds: [a.artifactId],
      });
      expect(result.candidates.find((candidate) => candidate.kind === 'checkpoint')).toMatchObject({
        plan_support: { state: 'unavailable', plan: null },
        checkpoint: { decisions: a.close.decisions },
      });
      expect(result.completeness.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PROVENANCE_OPEN_PLAN_UNAVAILABLE' }),
        ])
      );
    }
  );

  it.each(['missing', 'mismatched', 'foreign'] as const)(
    'discloses %s committed fingerprint evidence',
    async (damage) => {
      const f = await fixture();
      const a = await f.artifact();
      const close = a.close as Record<string, unknown>;
      if (damage === 'missing') delete close.diff_fingerprint_manifest;
      else {
        const manifest = { ...a.built.manifest!, artifact_id: uuidv7() };
        close.diff_fingerprint_manifest = manifest;
        if (damage === 'foreign')
          close.diff_fingerprint_summary = summarizeManifest(
            manifest,
            await computeDiffFingerprintManifestHash(manifest)
          );
      }
      await a.publish();
      const reader = f.openView();
      const result = await collectProvenanceCandidates({
        source: reader,
        artifactIds: [a.artifactId],
      });
      expect(
        result.candidates.find((candidate) => candidate.kind === 'checkpoint')?.fingerprint
      ).toMatchObject({ state: 'unavailable', manifest: null });
      expect(result.completeness.complete).toBe(false);
    }
  );

  it('keeps unreadable overlap siblings provisional and includes verified sibling versions', async () => {
    const f = await fixture();
    const a = await f.artifact();
    const b = await f.artifact();
    Object.assign(a.close, {
      attribution_degraded: { unmerged_paths: ['selected.ts'] },
      window_overlap: {
        siblings: [],
        cross_artifact_siblings: [{ artifact_id: b.artifactId, n: 1 }],
        pending: true,
        dropped_files: [],
        rejected_claims: [],
        ambiguous_files: [],
        mixed_segment: [],
        own_claim_pending: [{ file_before: 'selected.ts', file_after: 'selected.ts' }],
        segment_attributed: [],
        unattributed_in_window: [],
        degradations: ['cross_artifact_claims_only'],
      },
    });
    await a.publish();
    await b.publish();
    const selected = f.openView({ artifactIds: [a.artifactId] });
    const narrow = await collectProvenanceCandidates({
      source: selected,
      artifactIds: [a.artifactId],
    });
    expect(narrow.candidates.find((candidate) => candidate.kind === 'checkpoint')).toMatchObject({
      overlap: { finalized: false, unreadableSiblingArtifacts: [b.artifactId] },
      checkpoint: { attribution_degraded: { unmerged_paths: ['selected.ts'] } },
    });
    const complete = f.openView();
    const all = await collectProvenanceCandidates({
      source: complete,
      artifactIds: [a.artifactId],
    });
    expect(all.source_versions.map((source) => source.artifact_id).sort()).toEqual(
      [a.artifactId, b.artifactId].sort()
    );
    expect(all.candidates.every((candidate) => candidate.artifact_id === a.artifactId)).toBe(true);
    expect(
      all.candidates.find((candidate) => candidate.kind === 'checkpoint')?.overlap
    ).toMatchObject({
      finalized: true,
      ambiguous: [{ file_before: 'selected.ts', file_after: 'selected.ts' }],
    });
  });

  it('labels later import enrichment separately from original checkpoint and open-plan support', async () => {
    const f = await fixture();
    const a = await f.artifact({ imported: true });
    a.events.push(
      a.add('summary_captured', {
        schema_version: 1,
        artifact_id: a.artifactId,
        outcome: 'Original outcome',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: f.context.headOid,
        ts,
      })
    );
    const enrichedId = uuidv7();
    a.events.push(
      a.add(
        'git_import_enriched',
        {
          provenance_version: 1,
          artifact_id: a.artifactId,
          cluster_key: 'b'.repeat(64),
          member_shas_hash: computeMemberShasHash([f.context.headOid!]),
          enriched_at: ts,
          prior_enrichment_event_id: null,
          label: 'Enriched source',
          task: 'Enriched rationale',
          steps: [{ label: 'Selected evidence', text: 'Retain described evidence' }],
          checkpoint_summaries: [{ n: 1, summary: 'Enriched checkpoint explanation' }],
          outcome: 'Enriched outcome',
          decisions: { mode: 'preserve' },
        },
        enrichedId
      )
    );
    await a.publish();
    const reader = f.openView();
    const result = await collectProvenanceCandidates({
      source: reader,
      artifactIds: [a.artifactId],
    });
    expect(result.candidates.find((candidate) => candidate.kind === 'checkpoint')).toMatchObject({
      source_event_id: a.closeId,
      origin: 'imported',
      checkpoint: { summary: 'Original close evidence', source_event_id: a.closeId },
      plan_support: { anchor_event_id: a.planId, plan: { task: a.plan.task } },
      enrichment: {
        content_event_id: enrichedId,
        checkpoint_summary: 'Enriched checkpoint explanation',
        plan: { task: 'Enriched rationale' },
      },
    });
  });

  it('reads retained qualified candidates after the originating linked checkout is removed and discloses corrupted siblings', async () => {
    const f = await fixture();
    const linked = path.join(f.root, 'linked');
    await runHistoryGit(f.main, ['worktree', 'add', '-qb', 'feature', linked]);
    const linkedContext = {
      ...(await resolveDatabaseGitContext({ cwd: linked })),
      repositoryInstanceId: f.context.repositoryInstanceId,
      worktreeId: uuidv7(),
      headOid: (await runHistoryGit(linked, ['rev-parse', '--verify', 'HEAD'])).stdout.trim(),
      branch: 'feature',
    };
    const a = await f.artifact({ context: linkedContext });
    const b = await f.artifact();
    await a.publish();
    await b.publish();
    await runHistoryGit(f.main, ['worktree', 'remove', linked]);
    f.damage(b.artifactId);
    const reader = f.openView();
    const result = await collectProvenanceCandidates({
      source: reader,
      artifactIds: [a.artifactId, b.artifactId],
    });
    expect(
      result.candidates.every(
        (candidate) =>
          candidate.project_id === f.authority.project_id &&
          candidate.store_instance_id === f.authority.store_instance_id &&
          candidate.artifact_id === a.artifactId
      )
    ).toBe(true);
    expect(
      result.candidates.find((candidate) => candidate.kind === 'checkpoint')?.plan_support.plan
        ?.decisions
    ).toEqual(a.plan.decisions);
    expect(
      result.candidates.find((candidate) => candidate.kind === 'checkpoint')?.association
        .checkpoint_worktree_id
    ).toBe(linkedContext.worktreeId);
    expect(result.completeness.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact_id: b.artifactId, code: 'HISTORY_INTEGRITY_REQUIRED' }),
      ])
    );
  });
});
