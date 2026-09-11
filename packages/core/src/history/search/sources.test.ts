import { describe, expect, it } from 'vitest';

import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  computeMemberShasHash,
  type EventType,
  type EventWithPayload,
  PlanInputSchema,
  reconstructArtifactThread,
  uuidv7,
} from '@orcaops/storage';
import { encodeArtifactEvent } from '@orcaops/storage/history/primitives';
import {
  type ArtifactSourceTimeMember,
  prepareArtifactSourceTimeMember,
  prepareSourceTimeEvidence,
} from '@orcaops/storage/history/source-time';

import { classifySearchMatch, normalizeSearchQuery } from './matching.js';
import { projectArtifactSearchSources } from './sources.js';

const recorded = '2026-09-05T10:00:00.000Z';
const member = 'a'.repeat(40);

function fixture(imported = false) {
  const artifactId = uuidv7();
  const events: EventWithPayload[] = [];
  const add = (type: EventType, payload: unknown, ts = recorded) => {
    const encoded = encodeArtifactEvent({ type, payload, ts, idempotency_key: uuidv7() });
    const event = { record: encoded.record, payload };
    events.push(event);
    return event;
  };
  const plan = PlanInputSchema.parse({
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'feature',
    base_sha: member,
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain source history',
    label: 'Source history',
    plan_steps: [
      {
        step_id: 'step',
        text: 'Preserve original bytes',
        label: 'Retained bytes',
        acceptance_criteria: [],
      },
    ],
    touched_scope: ['auth', 'refactor', 'src/not-a-file-tag.ts'],
    non_goals: [],
    decisions: [{ decision: 'Keep original evidence', reason: 'Retain reasoning', revision_n: 0 }],
    started_at: '2020-01-01T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
    ...(imported
      ? {
          origin: {
            kind: 'git-import',
            imported_at: recorded,
            enriched_at: null,
            tool_version: 'test',
            source_range: member,
            authors: ['author'],
            member_shas: [member],
            member_shas_hash: computeMemberShasHash([member]),
            cluster_key: 'b'.repeat(64),
          },
        }
      : {}),
  });
  const planEvent = add('plan_captured', plan);
  add('checkpoint_opened', {
    artifact_id: artifactId,
    n: 1,
    declared_step_ids: ['step'],
    agent: 'codex',
    policy_exceptions: [],
    plan_revision_id: null,
    open_plan_revision_event_id: planEvent.record.event_id,
    opened_at: recorded,
    head_sha: member,
    open_snapshot: buildDefaultSkippedSnapshotBoundary(),
  });
  const close = add('checkpoint_closed', {
    artifact_id: artifactId,
    n: 1,
    summary: 'Original checkpoint proof',
    files_changed: ['src/proof.ts'],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    completed_step_ids: ['step'],
    closed_by_agent: 'codex',
    head_sha: member,
    ts: recorded,
    close_snapshot: buildDefaultSkippedSnapshotBoundary(),
    diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
  });
  const summary = add('summary_captured', {
    schema_version: 1,
    artifact_id: artifactId,
    outcome: 'Original outcome',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: member,
    ts: recorded,
  });
  const project = (
    sourceTimeEvidence?: ReadonlyMap<string, unknown>,
    sourceTimeMember?: ArtifactSourceTimeMember | null
  ) =>
    projectArtifactSearchSources({
      projectId: 'project',
      artifactGeneration: 1,
      thread: reconstructArtifactThread(artifactId, events),
      sourceTimeEvidence,
      sourceTimeMember,
    });
  return { artifactId, events, add, plan, planEvent, close, summary, project };
}

describe('search source chronology and identity', () => {
  it('uses complete witness-qualified SHA-256 membership ahead of legacy origin and refuses missing or partial membership', () => {
    const f = fixture(true);
    const oid = 'c'.repeat(64);
    const fact = {
      commit_oid: oid,
      committer_time: '2018-01-01T00:00:00.000Z',
      verification_basis: 'git_commit_object' as const,
    };
    const sources = [f.planEvent.record.event_id, 'digest'].map(
      (sourceId) =>
        prepareSourceTimeEvidence({
          artifactId: f.artifactId,
          sourceId,
          attributedCommits: [oid],
          facts: [fact],
        }).evidence
    );
    const { member: qualifiedMember } = prepareArtifactSourceTimeMember({
      artifactId: f.artifactId,
      memberCommits: [oid],
      sources,
    });
    expect(f.project(undefined, qualifiedMember).at(-1)).toMatchObject({
      evidence_time: fact.committer_time,
      evidence_time_basis: 'commit_set_latest',
    });
    const incomplete = prepareArtifactSourceTimeMember({
      artifactId: f.artifactId,
      memberCommits: [oid, 'd'.repeat(64)],
      sources,
    }).member;
    expect(f.project(undefined, incomplete).at(-1)).toMatchObject({
      evidence_time: null,
      evidence_time_unknown_reason: 'identity_mismatch',
    });
    expect(
      f.project(undefined, { ...qualifiedMember, artifact_id: uuidv7() }).at(-1)
    ).toMatchObject({ evidence_time: null, evidence_time_unknown_reason: 'invalid_member_set' });
    delete f.plan.origin!.member_shas;
    delete f.plan.origin!.member_shas_hash;
    const evidence = new Map(sources.map((source) => [source.source_id, source]));
    expect(f.project(evidence).at(-1)).toMatchObject({
      evidence_time: null,
      evidence_time_unknown_reason: 'missing_member_set',
    });
    expect(f.project(undefined, qualifiedMember).at(-1)).toMatchObject({
      evidence_time: fact.committer_time,
      evidence_time_basis: 'commit_set_latest',
    });
  });
  it('uses the recording event time, preserves plan revisions, and leaves generated digest time unknown', () => {
    const f = fixture();
    const revised = f.add(
      'plan_revised',
      {
        ...f.plan,
        label: 'Revised intent',
        task: 'New retained intent',
        revision_n: 1,
        revised_at: '2021-01-01T00:00:00.000Z',
        rationale: 'New requirement',
        prior_plan_event_id: f.planEvent.record.event_id,
      },
      '2026-09-05T11:00:00.000Z'
    );
    const before = JSON.stringify(f.events);
    const rows = f.project();
    const plans = rows.filter((row) => row.source_kind === 'plan');
    expect(plans.map((row) => row.source_id)).toEqual([
      f.planEvent.record.event_id,
      revised.record.event_id,
    ]);
    expect(plans.map((row) => row.evidence_time)).toEqual([recorded, '2026-09-05T11:00:00.000Z']);
    expect(plans[0]!.evidence_time_basis).toBe('captured_event');
    expect(plans[1]!.decision_provenance).toEqual([
      {
        field_path: 'decisions.0',
        revision_n: 0,
        source_event_id: f.planEvent.record.event_id,
        evidence_commit_oid: null,
      },
    ]);
    const checkpoint = rows.find((row) => row.source_id === f.close.record.event_id)!;
    expect(checkpoint.intent).toEqual([]);
    expect(classifySearchMatch(checkpoint, normalizeSearchQuery('source history'))).toBeNull();
    expect(checkpoint.touched_files).toEqual(['src/proof.ts']);
    expect(
      rows.every((row) => row.touched_files.every((file) => !f.plan.touched_scope.includes(file)))
    ).toBe(true);
    expect(rows.at(-1)).toMatchObject({
      source_id: 'digest',
      source_event_id: null,
      content_event_id: null,
      source_ownership: 'derived_retained_content',
      evidence_time: null,
      evidence_time_basis: 'unknown',
      recorded_at: null,
    });
    expect(rows.at(-1)!.body.some((field) => field.text === 'Retain source history')).toBe(false);
    expect(JSON.stringify(f.events)).toBe(before);
  });

  it('keeps enrichment attached to each original source identity without promoting checkpoint intent or import time', () => {
    const f = fixture(true);
    const enrichedAt = '2026-09-05T12:00:00.000Z';
    const enrichment = f.add(
      'git_import_enriched',
      {
        provenance_version: 1,
        artifact_id: f.artifactId,
        cluster_key: 'b'.repeat(64),
        member_shas_hash: computeMemberShasHash([member]),
        enriched_at: enrichedAt,
        prior_enrichment_event_id: null,
        label: 'Enriched source',
        task: 'Descriptive imported intent',
        steps: [{ label: 'Retained bytes', text: 'Preserve imported bytes' }],
        checkpoint_summaries: [{ n: 1, summary: 'Enriched checkpoint evidence' }],
        outcome: 'Enriched outcome',
        decisions: { mode: 'preserve' },
      },
      enrichedAt
    );
    const rows = f.project();
    for (const original of [f.planEvent, f.close, f.summary]) {
      const row = rows.find((value) => value.source_id === original.record.event_id)!;
      expect(row).toMatchObject({
        source_event_id: original.record.event_id,
        content_event_id: enrichment.record.event_id,
        recorded_at: enrichedAt,
        imported_at: recorded,
        enriched_at: enrichedAt,
        evidence_time: null,
        evidence_time_basis: 'unknown',
      });
    }
    const checkpoint = rows.find((row) => row.source_id === f.close.record.event_id)!;
    expect(classifySearchMatch(checkpoint, normalizeSearchQuery('enriched checkpoint'))).toBe(
      'text_phrase'
    );
    expect(
      classifySearchMatch(checkpoint, normalizeSearchQuery('descriptive imported intent'))
    ).toBeNull();
    expect(rows.some((row) => row.source_id === enrichment.record.event_id)).toBe(false);
  });

  it('ranks imported specific source facts and derived complete member sets while refusing mismatched or partial evidence', () => {
    const f = fixture(true);
    const facts = [
      {
        commit_oid: member,
        committer_time: '2019-01-01T00:00:00.000Z',
        verification_basis: 'git_commit_object' as const,
      },
    ];
    const evidence = new Map(
      [f.planEvent.record.event_id, f.close.record.event_id, 'digest'].map((sourceId) => [
        sourceId,
        prepareSourceTimeEvidence({
          artifactId: f.artifactId,
          sourceId,
          attributedCommits: [member],
          facts,
        }).evidence,
      ])
    );
    const rows = f.project(evidence);
    expect(rows.find((row) => row.source_id === f.close.record.event_id)).toMatchObject({
      evidence_time: facts[0]!.committer_time,
      evidence_time_basis: 'commit',
    });
    expect(rows.at(-1)).toMatchObject({
      evidence_time: facts[0]!.committer_time,
      evidence_time_basis: 'commit_set_latest',
      recorded_at: null,
      imported_at: recorded,
    });
    const incomplete = new Map(evidence);
    incomplete.set('digest', { ...evidence.get('digest')!, facts: [] });
    expect(f.project(incomplete).at(-1)).toMatchObject({
      evidence_time: null,
      evidence_time_basis: 'unknown',
      evidence_time_unknown_reason: 'incomplete',
    });
    const mismatched = new Map(evidence);
    mismatched.set('digest', { ...evidence.get('digest')!, source_id: 'foreign' });
    expect(f.project(mismatched).at(-1)).toMatchObject({
      evidence_time: null,
      evidence_time_unknown_reason: 'identity_mismatch',
    });
  });
});
