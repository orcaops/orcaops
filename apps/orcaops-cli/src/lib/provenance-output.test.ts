import { describe, expect, it } from 'vitest';

import type { ProvenanceMatch } from '@orcaops/core/history';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  ClosedCheckpointSchema,
  PlanSchema,
  redactSecretsInObject,
} from '@orcaops/storage';

import {
  compactProvenanceCandidate,
  compactProvenanceIssues,
  compactSourceVersions,
  detailedProvenanceCandidate,
  provenanceTargetFacts,
} from './provenance-output.js';

function match(): ProvenanceMatch {
  const ts = '2026-01-01T00:00:00.000Z';
  const plan = PlanSchema.parse({
    schema_version: 4,
    artifact_id: 'artifact',
    source_event_id: 'plan-content',
    branch: 'feature',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain original reasoning',
    label: 'Original reasoning',
    plan_steps: [
      { step_id: 'step', text: 'Retain evidence', label: 'Evidence', acceptance_criteria: [] },
    ],
    touched_scope: ['selected.ts'],
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
  return {
    candidate: {
      root_key: 'root',
      project_id: 'project',
      store_instance_id: 'store',
      artifact_id: 'artifact',
      locator: 'project/artifact/close',
      version_token: 'v'.repeat(64),
      artifact_generation: 1,
      pending: false,
      origin: 'captured',
      kind: 'checkpoint',
      source_event_id: 'close',
      recorded_at: ts,
      plan_support: {
        anchor_event_id: 'plan-anchor',
        source_event_id: 'plan-source',
        content_event_id: 'plan-content',
        state: 'available',
        plan,
      },
      source_plan: {
        source_ref: { kind: 'local', locator: '/source.md' },
        content: 'Approved design',
        hash: 'h'.repeat(64),
        baseline: null,
      },
      checkpoint: ClosedCheckpointSchema.parse({
        schema_version: 4,
        artifact_id: 'artifact',
        n: 1,
        status: 'closed',
        declared_step_ids: ['step'],
        agent: 'codex',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: 'plan-anchor',
        opened_at: ts,
        head_sha: 'b'.repeat(40),
        open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        close_snapshot: buildDefaultSkippedSnapshotBoundary(),
        closed_at: ts,
        closed_by_agent: 'codex',
        summary: 'Recorded checkpoint',
        files_changed: ['selected.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: ['step'],
        diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
        source_event_ids: { opened: 'open', closed: 'close' },
        source_event_id: 'close',
      }),
      fingerprint: { state: 'skipped', manifest: null, truncated: false },
      overlap: null,
      association: { worktree_ids: [], unknown: true, checkpoint_worktree_id: null },
      enrichment: {
        content_event_id: 'enrichment',
        enriched_at: ts,
        plan: structuredClone(plan),
        checkpoint_summary: 'Later narrative',
      },
      issues: [],
    },
    reachability: 'reachable',
    reachability_basis: 'checkpoint_head',
    relationship: 'reachable_history',
    confidence: 'likely',
    content_match: 'none',
    manifest_files: [],
    provisional: false,
    reasons: ['Verified line blame lies inside the recorded checkpoint work interval'],
  };
}

describe('provenance output projections', () => {
  it.each(['plan', 'source plan', 'checkpoint', 'enrichment plan', 'enrichment summary'])(
    'keeps compact byte size constant when the omitted %s body grows',
    (body) => {
      const input = match();
      const set = (text: string) => {
        if (body === 'plan') input.candidate.plan_support.plan!.task = text;
        if (body === 'source plan') input.candidate.source_plan!.content = text;
        if (body === 'checkpoint') input.candidate.checkpoint!.summary = text;
        if (body === 'enrichment plan') input.candidate.enrichment!.plan!.task = text;
        if (body === 'enrichment summary') input.candidate.enrichment!.checkpoint_summary = text;
      };
      set('x'.repeat(1024));
      const small = JSON.stringify(
        compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts')
      );
      const largeBody = 'y'.repeat(1024 * 1024);
      set(largeBody);
      const detailed = detailedProvenanceCandidate(input);
      const large = JSON.stringify(compactProvenanceCandidate(detailed, 'selected.ts'));
      expect(Buffer.byteLength(large)).toBe(Buffer.byteLength(small));
      expect(JSON.stringify(detailed)).toContain(largeBody);
    }
  );

  it('identifies distinct work by historical labels without embedding rationale', () => {
    const rows = ['Session expiration', 'Retry policy', 'Audit trail'].map((label, i) => {
      const input = match();
      input.candidate.artifact_id = `artifact-${i}`;
      input.candidate.plan_support.plan!.label = label;
      input.candidate.checkpoint!.n = i + 1;
      input.candidate.enrichment!.plan!.label = 'Later supplemental label';
      return compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts');
    });
    expect(
      rows.map(({ label, artifact_id, checkpoint }) => [label, artifact_id, checkpoint?.n])
    ).toEqual([
      ['Session expiration', 'artifact-0', 1],
      ['Retry policy', 'artifact-1', 2],
      ['Audit trail', 'artifact-2', 3],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Later supplemental label');
    expect(JSON.stringify(rows)).not.toContain('Recorded checkpoint');
  });

  it('counts entries in each historical body and distinguishes unavailable from empty', () => {
    const input = match();
    const decision = { decision: 'Retain behavior', reason: 'Compatibility', revision_n: 0 };
    input.candidate.plan_support.plan!.decisions = [decision, decision];
    input.candidate.checkpoint!.decisions = [decision];
    input.candidate.checkpoint!.uncertainty = ['Investigate overlap', 'Investigate overlap'];
    input.candidate.enrichment!.plan!.decisions = [decision, decision, decision];
    const project = () =>
      compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts');
    expect(project().evidence_counts).toEqual({
      plan_decisions: 2,
      checkpoint_decisions: 1,
      checkpoint_uncertainty: 2,
    });
    input.candidate.plan_support = {
      ...input.candidate.plan_support,
      state: 'unavailable',
      plan: null,
    };
    input.candidate.checkpoint!.decisions = [];
    expect(project()).toMatchObject({
      label: null,
      evidence_counts: { plan_decisions: null, checkpoint_decisions: 0, checkpoint_uncertainty: 2 },
    });
    expect(detailedProvenanceCandidate(input).label).toBeNull();
    input.candidate.checkpoint = null;
    expect(project().evidence_counts).toEqual({
      plan_decisions: null,
      checkpoint_decisions: null,
      checkpoint_uncertainty: null,
    });
  });

  it('hashes the complete source collection canonically without depending on input order', () => {
    const versions = [
      { artifact_id: 'support', version_token: 'z' },
      { artifact_id: 'candidate', version_token: 'a' },
    ];
    const summary = compactSourceVersions(versions);
    expect(summary).toEqual(compactSourceVersions([...versions].reverse()));
    expect(summary).toEqual({
      count: 2,
      digest: 'sha256:2d326d8a07b2d5cf9e2dbc314af5839a4e3e6e1494b575364280a256b167fbb5',
    });
    expect(
      compactSourceVersions([versions[1], { ...versions[0], version_token: 'changed' }]).digest
    ).not.toBe(summary.digest);
    expect(compactSourceVersions([...versions, versions[0]]).count).toBe(3);
    expect(compactSourceVersions([])).toEqual({
      count: 0,
      digest: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    });
  });

  it('serializes every whole-file candidate without repeating its narrative bodies', () => {
    const input = match();
    input.candidate.plan_support.plan!.task = 'Plan narrative '.repeat(2048);
    const rows = Array.from({ length: 168 }, (_, i) => {
      const row = detailedProvenanceCandidate(input);
      return { ...row, source_event_id: `event-${i}`, locator: `project/artifact/event-${i}` };
    });
    const detailed = JSON.stringify(rows);
    const compact = JSON.stringify(
      rows.map((row) => compactProvenanceCandidate(row, 'selected.ts'))
    );
    expect(JSON.parse(compact).map((row: { locator: string }) => row.locator)).toEqual(
      rows.map((row) => row.locator)
    );
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(detailed) / 10);
    expect(JSON.parse(compact)).toHaveLength(168);
  });

  it('uses original target facts when redaction collapses distinct paths', () => {
    const input = match();
    const selected = 'ghp_' + 'A'.repeat(36);
    const other = 'ghp_' + 'B'.repeat(36);
    input.candidate.checkpoint!.attribution_degraded = { unmerged_paths: [other] };
    const original = detailedProvenanceCandidate(input);
    const facts = provenanceTargetFacts(original, selected);
    const redacted = redactSecretsInObject({ row: original, selected });
    expect(redacted.row.checkpoint!.attribution_degraded!.unmerged_paths[0]).toBe(
      redacted.selected
    );
    expect(
      compactProvenanceCandidate(redacted.row, redacted.selected, facts).checkpoint
        ?.attribution_degraded?.target_unmerged
    ).toBe(false);
  });

  it('bounds long display paths without shortening historical lookup identities', () => {
    const input = match();
    input.manifest_files = ['🦈'.repeat(1000)];
    input.candidate.association.worktree_ids = ['worktree-'.repeat(100)];
    input.candidate.pending = true;
    input.candidate.origin = 'imported';
    input.candidate.fingerprint = { state: 'unavailable', manifest: null, truncated: true };
    const result = compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts');
    expect(result.manifest_files.items[0]).toEqual({
      text: '🦈'.repeat(240),
      length: 1000,
      truncated: true,
    });
    expect(result.association.worktree_ids.items).toEqual(input.candidate.association.worktree_ids);
    expect(result).toMatchObject({
      pending: true,
      origin: 'imported',
      fingerprint: { state: 'unavailable', truncated: true },
    });
  });

  it('retains the existing detailed candidate fields with the historical label', () => {
    const input = match();
    const { candidate, ...evidence } = input;
    const { fingerprint, ...source } = candidate;
    expect(detailedProvenanceCandidate(input)).toEqual({
      ...evidence,
      ...source,
      label: source.plan_support.plan!.label,
      fingerprint: {
        state: fingerprint.state,
        truncated: fingerprint.truncated,
        manifest_hash: null,
      },
    });
  });

  it('preserves historical identities and the fallback Git anchor without bodies', () => {
    const input = match();
    const compact = compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts');
    expect(compact).toMatchObject({
      artifact_id: 'artifact',
      store_instance_id: 'store',
      version_token: 'v'.repeat(64),
      confidence: 'likely',
      reasons: input.reasons,
      plan_support: {
        anchor_event_id: 'plan-anchor',
        source_event_id: 'plan-source',
        content_event_id: 'plan-content',
        base_sha: 'a'.repeat(40),
        state: 'available',
      },
      checkpoint: {
        n: 1,
        open_head_sha: null,
        head_sha: 'b'.repeat(40),
        source_event_ids: { opened: 'open', closed: 'close' },
      },
      enrichment: {
        content_event_id: 'enrichment',
        plan_available: true,
        checkpoint_summary_available: true,
      },
    });
    expect(compact.plan_support).not.toHaveProperty('plan');
    expect(compact.source_plan).not.toHaveProperty('content');
    expect(compact.checkpoint).not.toHaveProperty('summary');
    expect(compact.enrichment).not.toHaveProperty('plan');
    input.candidate.kind = 'plan';
    input.candidate.checkpoint = null;
    input.reachability_basis = 'plan_base';
    expect(
      compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts')
    ).toMatchObject({
      checkpoint: null,
      reachability_basis: 'plan_base',
      plan_support: { base_sha: 'a'.repeat(40) },
    });
    input.candidate.plan_support = {
      anchor_event_id: 'missing',
      source_event_id: null,
      content_event_id: null,
      state: 'unavailable',
      plan: null,
    };
    expect(
      compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts').plan_support
    ).toMatchObject({
      state: 'unavailable',
      base_sha: null,
    });
  });

  it('retains target ambiguity and degradation beyond the evidence previews', () => {
    const input = match();
    const paths = [...Array.from({ length: 12 }, (_, i) => `other-${i}.ts`), 'selected.ts'];
    input.candidate.overlap = {
      n: 1,
      finalized: false,
      ambiguous: paths.map((file) => ({ file_before: null, file_after: file })),
      mixedSegment: [],
      ownClaimPending: [{ file_before: 'selected.ts', file_after: null }],
      dropped: [],
      segmentAttributed: [],
      unattributedInWindow: [],
      unreadableSiblingArtifacts: ['missing-artifact'],
    };
    input.candidate.checkpoint!.attribution_degraded = {
      unmerged_paths: paths,
      probe_failed: true,
    };
    input.candidate.association.worktree_ids = paths;
    input.manifest_files = paths;
    const output = compactProvenanceCandidate(detailedProvenanceCandidate(input), 'selected.ts');
    expect(output.overlap).toMatchObject({
      finalized: false,
      target: { ambiguous: true, own_claim_pending: true },
      ambiguous: { total: 13, omitted: 3 },
    });
    expect(output.overlap?.ambiguous.items).toHaveLength(10);
    expect(output.checkpoint?.attribution_degraded).toMatchObject({
      target_unmerged: true,
      probe_failed: true,
      unmerged_paths: { omitted: 3 },
    });
    expect(output.association.worktree_ids.items).toHaveLength(10);
    expect(output.manifest_files.items).toHaveLength(10);
  });

  it('counts original diagnostic records separately from affected-artifact counts', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({
      code: i % 2 ? 'MISSING' : 'OMITTED',
      project_id: 'project',
      artifact_id: `artifact-${i}`,
      count: 500,
      message: '🦈'.repeat(300),
      resource: 'x'.repeat(300),
    }));
    const output = compactProvenanceIssues(issues);
    expect(output).toMatchObject({
      total: 12,
      omitted: 2,
      distinct_codes: 2,
      code_counts: [
        { code: 'MISSING', count: 6 },
        { code: 'OMITTED', count: 6 },
      ],
    });
    expect(output.items[0]).toMatchObject({
      count: 500,
      message: { text: '🦈'.repeat(240), length: 300, truncated: true },
      resource: { length: 300, truncated: true },
    });
    expect(output.items[0].artifact_id).toBe('artifact-0');
  });

  it('previews redacted diagnostic text without exposing a partial credential', () => {
    const credential = 'ghp_' + 'A'.repeat(36);
    const issues = [{ code: 'FAILURE', message: 'x'.repeat(230) + ' ' + credential }];
    const redacted = redactSecretsInObject(issues);
    expect(redacted[0].message).not.toContain(credential);
    const output = compactProvenanceIssues(redacted);
    expect(JSON.stringify(output)).not.toContain('ghp_');
  });
});
