import { describe, expect, it } from 'vitest';

import { isCitationId } from '@orcaops/review-core';
import type { CoverageItem } from '@orcaops/review-core';

import { buildCitations } from './citations.js';
import { buildLandmarks } from './landmarks.js';
import type { ReviewArtifact, ReviewCheckpoint } from './model.js';
import { buildThreads } from './outline.js';
import { buildPlanCoverage } from './planCoverage.js';

const iso = (min: number): string => `2026-07-06T0${min}:00:00.000Z`;

function cp(n: number, at: string, over: Partial<ReviewCheckpoint> = {}): ReviewCheckpoint {
  return {
    artifact: 'art-a',
    n,
    closedAt: at,
    status: 'closed',
    openTreeSha: `open${n}`,
    closeTreeSha: `close${n}`,
    headSha: null,
    summary: `did thing ${n}`,
    filesChanged: [],
    completedStepIds: [],
    declaredStepIds: [],
    decisions: [],
    uncertainty: [],
    doneCriteria: [],
    verification: [],
    manifestHash: `mh${n}`,
    manifestTruncated: false,
    capturedFingerprint: {
      loadState: 'not-captured',
      openTreeSha: null,
      closeTreeSha: null,
      maxDiffBytes: null,
      diffOptions: null,
    },
    derivedManifestHash: null,
    overlapAmbiguousFiles: [],
    windowOverlap: undefined,
    attributionDegraded: undefined,
    ...over,
  };
}

function artifactA(): ReviewArtifact {
  return {
    id: 'art-a',
    branch: 'demo',
    label: 'Thread A work',
    task: 'do A',
    baseSha: 'base',
    startedAt: iso(1),
    firstActivityAt: iso(1),
    planSteps: [
      {
        stepId: 's1',
        text: 'step one',
        label: 'one',
        acceptanceCriteria: [{ criterionId: 'c1', text: 'crit one' }],
      },
      { stepId: 's2', text: 'step two', label: 'two', acceptanceCriteria: [] },
    ],
    nonGoals: [{ text: 'not this', rationale: 'reasons' }],
    planDecisions: [],
    summaryText: 'shipped it',
    evaluatorRuns: [
      {
        id: 'plan-mentions-tests',
        verdict: 'pass',
        severity: 'warn',
        runStatus: 'completed',
        disposition: null,
        body: 'PASS\ndetails',
      },
    ],
    planRevisions: 2,
    checkpoints: [
      cp(1, iso(2), {
        completedStepIds: ['s1'],
        declaredStepIds: ['s1'],
        decisions: [
          {
            decision: 'chose X',
            reason: 'because',
            alternativesConsidered: [{ option: 'Y instead', rejectedBecause: 'slower' }],
          },
        ],
        uncertainty: ['unsure Y'],
      }),
      cp(2, iso(3), { completedStepIds: [], declaredStepIds: ['s2'] }),
    ],
  };
}

describe('buildCitations', () => {
  it('emits a cite for every kind with valid ids and groups checkpoint cites', () => {
    const { citations, byCheckpoint } = buildCitations([artifactA()]);
    const ids = new Map(citations.map((c) => [c.id, c]));
    expect(ids.has('cite:art-a:plan_step:0')).toBe(true);
    expect(ids.has('cite:art-a:plan_step:1')).toBe(true);
    expect(ids.has('cite:art-a:acceptance:0')).toBe(true);
    expect(ids.get('cite:art-a:acceptance:0')?.parent).toBe('cite:art-a:plan_step:0');
    expect(ids.has('cite:art-a:plan_non_goal:0')).toBe(true);
    expect(ids.has('cite:art-a:summary:0')).toBe(true);
    expect(ids.has('cite:art-a:evaluator_run:0')).toBe(true);
    expect(ids.get('cite:art-a:evaluator_run:0')?.evaluator).toEqual({
      evaluator_ref: 'plan-mentions-tests',
      severity: 'warn',
      run_status: 'completed',
      verdict: 'pass',
      disposition: null,
      summary: 'PASS',
    });
    expect(ids.has('cite:art-a:cp1:decision:0')).toBe(true);
    expect(ids.has('cite:art-a:cp1:uncertainty:0')).toBe(true);
    // Rejected alternatives ride as RULED-OUT citations (floor transport).
    expect(ids.get('cite:art-a:cp1:alternative:0')?.text).toBe('Y instead\n↳ slower');
    expect(ids.get('cite:art-a:plan_step:0')?.text).toBe('step one');
    expect(citations.every((c) => isCitationId(c.id))).toBe(true);
    expect(byCheckpoint.get('art-a:cp1')).toEqual([
      'cite:art-a:cp1:decision:0',
      'cite:art-a:cp1:alternative:0',
      'cite:art-a:cp1:uncertainty:0',
    ]);
  });

  /**
   * The alternative index runs per CHECKPOINT while the nesting is per
   * DECISION, so the id alone cannot say which decision an alternative was
   * rejected against. `parent` is that link, and it must survive the flatten.
   */
  it('points each alternative at the decision it was nested under, not at the checkpoint', () => {
    const artifact = artifactA();
    artifact.checkpoints[0]!.decisions = [
      {
        decision: 'chose X',
        reason: 'because',
        alternativesConsidered: [
          { option: 'Y instead', rejectedBecause: 'slower' },
          { option: 'Z instead', rejectedBecause: 'riskier' },
        ],
      },
      {
        decision: 'chose P',
        reason: 'also because',
        alternativesConsidered: [{ option: 'Q instead', rejectedBecause: 'unproven' }],
      },
    ];
    const { citations } = buildCitations([artifact]);
    const alternatives = citations.filter((c) => c.kind === 'CHECKPOINT_ALTERNATIVE');
    // The third alternative belongs to the SECOND decision — the assertion the
    // per-checkpoint running index cannot make on its own.
    expect(alternatives.map((c) => [c.id, c.parent])).toEqual([
      ['cite:art-a:cp1:alternative:0', 'cite:art-a:cp1:decision:0'],
      ['cite:art-a:cp1:alternative:1', 'cite:art-a:cp1:decision:0'],
      ['cite:art-a:cp1:alternative:2', 'cite:art-a:cp1:decision:1'],
    ]);
    // Every parent resolves to a decision citation that was actually emitted.
    const decisionIds = new Set(
      citations.filter((c) => c.kind === 'CHECKPOINT_DECISION').map((c) => c.id)
    );
    for (const alt of alternatives) expect(decisionIds.has(alt.parent ?? '')).toBe(true);
  });
});

describe('buildCitations — plan-level decisions (chain 1)', () => {
  const planned = (): ReviewArtifact => {
    const artifact = artifactA();
    artifact.planDecisions = [
      {
        decision: 'store the projection on disk',
        reason: 'the TUI re-reads it',
        revisionN: 0,
        alternativesConsidered: [
          { option: 'recompute per render', rejectedBecause: 'O(n) per keystroke' },
          { option: 'cache in memory only', rejectedBecause: 'lost across processes' },
        ],
      },
      {
        decision: 'key by artifact uuid',
        reason: 'ordinals move under revision',
        revisionN: 2,
        alternativesConsidered: [{ option: 'key by ordinal', rejectedBecause: 'renumbers' }],
      },
    ];
    return artifact;
  };

  it('emits plan decisions and their alternatives as ARTIFACT-scoped citations', () => {
    const { citations, byCheckpoint } = buildCitations([planned()]);
    const decisions = citations.filter((c) => c.kind === 'PLAN_DECISION');
    expect(decisions.map((c) => c.id)).toEqual([
      'cite:art-a:plan_decision:0',
      'cite:art-a:plan_decision:1',
    ]);
    // The reason rides on the same `↳` marker every decision record uses.
    expect(decisions[0]!.text).toBe('store the projection on disk\n↳ the TUI re-reads it');
    expect(citations.every((c) => isCitationId(c.id))).toBe(true);
    // Artifact-scoped: no cp locus in the id, no cp on the record, and NOT
    // grouped under any checkpoint (a plan decision belongs to a revision).
    for (const d of decisions) {
      expect(d.id).not.toContain(':cp');
      expect(d.cp).toBeUndefined();
    }
    for (const ids of byCheckpoint.values())
      expect(
        ids.some((id) => id.includes('plan_decision') || id.includes('plan_alternative'))
      ).toBe(false);
  });

  it('runs the alternative index per ARTIFACT and points each at its own decision', () => {
    const { citations } = buildCitations([planned()]);
    const alternatives = citations.filter((c) => c.kind === 'PLAN_ALTERNATIVE');
    // The third alternative belongs to the SECOND decision — the assertion the
    // flat running index cannot make on its own.
    expect(alternatives.map((c) => [c.id, c.parent])).toEqual([
      ['cite:art-a:plan_alternative:0', 'cite:art-a:plan_decision:0'],
      ['cite:art-a:plan_alternative:1', 'cite:art-a:plan_decision:0'],
      ['cite:art-a:plan_alternative:2', 'cite:art-a:plan_decision:1'],
    ]);
    expect(alternatives[0]!.text).toBe('recompute per render\n↳ O(n) per keystroke');
    const decisionIds = new Set(
      citations.filter((c) => c.kind === 'PLAN_DECISION').map((c) => c.id)
    );
    for (const alt of alternatives) expect(decisionIds.has(alt.parent ?? '')).toBe(true);
  });
});

describe('buildCitations — done-criteria evidence (chain 2)', () => {
  const withEvidence = (criterionId: string): ReviewArtifact => {
    const artifact = artifactA();
    artifact.checkpoints[0]!.doneCriteria = [
      { criterionId, evidence: 'ran the suite; 638 tests green' },
    ];
    return artifact;
  };

  it('parents each evidence record on the acceptance criterion its criterion_id names', () => {
    const { citations, byCheckpoint } = buildCitations([withEvidence('c1')]);
    const evidence = citations.filter((c) => c.kind === 'CRITERION_EVIDENCE');
    expect(evidence.map((c) => [c.id, c.parent])).toEqual([
      ['cite:art-a:cp1:criterion_evidence:0', 'cite:art-a:acceptance:0'],
    ]);
    // The parent is a citation that was actually emitted, of the right kind.
    const acceptance = citations.find((c) => c.id === evidence[0]!.parent);
    expect(acceptance?.kind).toBe('ACCEPTANCE_CRITERION');
    // criterion_id stays in the text so the record says what it evidences even
    // when read without its parent.
    expect(evidence[0]!.text).toBe('c1 — ran the suite; 638 tests green');
    expect(evidence[0]!.cp).toBe(1);
    expect(byCheckpoint.get('art-a:cp1')).toContain('cite:art-a:cp1:criterion_evidence:0');
  });

  /**
   * THE ORPHAN PATH. A criterion_id that names no criterion in scope — a plan
   * revision dropped it, or the id was never in this artifact's plan — must
   * NOT cost the evidence its place in the record. It rides with `parent`
   * absent, exactly as an unattributable alternative does.
   */
  it('carries evidence whose criterion_id resolves to nothing, with no parent', () => {
    const { citations } = buildCitations([withEvidence('c-vanished')]);
    const evidence = citations.filter((c) => c.kind === 'CRITERION_EVIDENCE');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.parent).toBeUndefined();
    expect(evidence[0]!.text).toBe('c-vanished — ran the suite; 638 tests green');
    expect(isCitationId(evidence[0]!.id)).toBe(true);
  });

  it('resolves criterion ids per artifact, never across threads', () => {
    const a = artifactA();
    const b: ReviewArtifact = {
      ...artifactA(),
      id: 'art-b',
      planSteps: [],
      checkpoints: [cp(1, iso(2), { doneCriteria: [{ criterionId: 'c1', evidence: 'ev' }] })].map(
        (c) => ({ ...c, artifact: 'art-b' })
      ),
    };
    const { citations } = buildCitations([a, b]);
    // `c1` exists in art-a's plan, not art-b's: art-b's evidence stays orphaned
    // rather than borrowing another thread's criterion.
    const orphan = citations.find((c) => c.kind === 'CRITERION_EVIDENCE' && c.artifact === 'art-b');
    expect(orphan?.parent).toBeUndefined();
  });
});

describe('buildCitations — verified-close records (chain 3)', () => {
  const verified = (): ReviewArtifact => {
    const artifact = artifactA();
    artifact.checkpoints[0]!.verification = [
      {
        command: 'pnpm test',
        exitCode: 0,
        outputDigest: '638 passed',
        note: 'full engine suite',
      },
      { command: 'pnpm typecheck', exitCode: 1, outputDigest: null, note: null },
    ];
    return artifact;
  };

  it('emits one checkpoint-scoped citation per verification entry', () => {
    const { citations, byCheckpoint } = buildCitations([verified()]);
    const runs = citations.filter((c) => c.kind === 'CHECKPOINT_VERIFICATION');
    expect(runs.map((c) => c.id)).toEqual([
      'cite:art-a:cp1:verification:0',
      'cite:art-a:cp1:verification:1',
    ]);
    expect(runs.every((c) => c.cp === 1)).toBe(true);
    expect(citations.every((c) => isCitationId(c.id))).toBe(true);
    expect(byCheckpoint.get('art-a:cp1')).toContain('cite:art-a:cp1:verification:0');
  });

  it('does not synthesize verification citations for checkpoints with no entries', () => {
    const runs = buildCitations([artifactA()]).citations.filter(
      (c) => c.kind === 'CHECKPOINT_VERIFICATION'
    );
    expect(runs).toEqual([]);
  });

  it('carries the digest and note verbatim, and keeps a FAILING exit code', () => {
    const runs = buildCitations([verified()]).citations.filter(
      (c) => c.kind === 'CHECKPOINT_VERIFICATION'
    );
    expect(runs[0]!.text).toBe('pnpm test → exit 0 · 638 passed\n↳ full engine suite');
    // A non-zero exit is honest evidence; the floor must not filter proof by
    // whether it passed.
    expect(runs[1]!.text).toBe('pnpm typecheck → exit 1');
  });

  it('is distinct from the artifact-scoped evaluator-run log', () => {
    const { citations } = buildCitations([verified()]);
    const evaluator = citations.filter((c) => c.kind === 'EVALUATOR_RUN');
    const verification = citations.filter((c) => c.kind === 'CHECKPOINT_VERIFICATION');
    expect(evaluator).toHaveLength(1);
    expect(verification).toHaveLength(2);
    // Different loci, so the two can never be read as one another again.
    expect(evaluator[0]!.id).toBe('cite:art-a:evaluator_run:0');
    expect(evaluator[0]!.cp).toBeUndefined();
  });
});

describe('buildPlanCoverage', () => {
  it('marks claimed vs declared-only vs unclaimed steps', () => {
    const entries = buildPlanCoverage([artifactA()]);
    const s1 = entries.find((e) => e.step_id === 's1');
    const s2 = entries.find((e) => e.step_id === 's2');
    expect(s1).toMatchObject({ unclaimed: false, claimed_by: [{ artifact: 'art-a', cp: 1 }] });
    expect(s2).toMatchObject({
      unclaimed: true,
      claimed_by: [],
      declared_by: [{ artifact: 'art-a', cp: 2 }],
    });
  });
});

describe('buildThreads', () => {
  const links = {
    sliceRefsByCp: new Map(),
    citationIdsByCp: new Map(),
  };

  it('single thread → one thread carrying its checkpoints', async () => {
    const sections = await buildThreads([artifactA()], links);
    expect(sections).toHaveLength(1);
    expect(sections[0].artifact).toBe('art-a');
    expect(sections[0].checkpoints.map((s) => s.order)).toEqual([1, 2]);
    expect(sections[0].checkpoints[0].checkpointKey).toMatch(/^chap_/);
    expect(sections[0].threadKey).toMatch(/^sec_/);
    expect(sections[0].checkpoints[0].checkpoint).toMatchObject({
      artifact: 'art-a',
      cp: 1,
      label: 'did thing 1',
    });
  });

  it('keys are regeneration-stable across a rebuild', async () => {
    // NB: rebuilding the SAME artifact is the weak half of stability, and on its
    // own it is what let the thread key hash a checkpoint set for so long. The
    // property that matters — the key surviving a checkpoint being ADDED — is in
    // outline.test.ts.
    const a = await buildThreads([artifactA()], links);
    const b = await buildThreads([artifactA()], links);
    expect(a[0].threadKey).toBe(b[0].threadKey);
    expect(a[0].checkpoints[0].checkpointKey).toBe(b[0].checkpoints[0].checkpointKey);
  });

  it('multi thread → one thread per artifact, first-activity order', async () => {
    const b: ReviewArtifact = {
      ...artifactA(),
      id: 'art-b',
      label: 'Thread B',
      firstActivityAt: iso(0),
      checkpoints: [cp(1, iso(0), { artifact: 'art-b' })],
    };
    for (const c of b.checkpoints) c.artifact = 'art-b';
    const sections = await buildThreads([artifactA(), b], links);
    expect(sections).toHaveLength(2);
    expect(sections[0].artifact).toBe('art-b'); // earlier first-activity leads
    expect(sections[1].artifact).toBe('art-a');
  });
});

describe('buildLandmarks', () => {
  const item = (over: Partial<CoverageItem>): CoverageItem => ({
    hunkKey: 'hunk_x',
    file: 'src/a.ts',
    verdict: 'MATCHED',
    old_start: null,
    new_start: null,
    added_lines: 1,
    removed_lines: 0,
    units: [],
    ...over,
  });
  const ownedSlice = (cp: number, slice: number): CoverageItem['units'][number] => ({
    kind: 'owned_slice',
    slice,
    patch_row_start: slice,
    patch_row_end: slice,
    del_range: null,
    add_range: { start: slice + 1, end: slice + 1 },
    lines: 1,
    owner: { kind: 'checkpoint', artifact: 'art-a', cp },
  });

  it('derives PLAN_REVISION, OFF_PLAN, LATER_TOUCH, and CROSS_THREAD', () => {
    const single = buildLandmarks(
      [artifactA()],
      [
        // OFF_PLAN counts parents with ZERO owned slices — the new rollup.
        item({ verdict: 'UNEXPLAINED', units: [] }),
        // LATER_TOUCH is identity-based: two distinct checkpoint owners in one
        // hunk's unit set (a same-owner delete/add pair would count once).
        item({ units: [ownedSlice(1, 0), ownedSlice(2, 1)] }),
      ]
    );
    const kinds = single.map((l) => l.kind);
    expect(kinds).toContain('PLAN_REVISION');
    expect(kinds).toContain('OFF_PLAN');
    expect(kinds).toContain('LATER_TOUCH');
    expect(kinds).not.toContain('CROSS_THREAD');

    const b: ReviewArtifact = { ...artifactA(), id: 'art-b', planRevisions: 0 };
    const multi = buildLandmarks([artifactA(), b], []);
    expect(multi.map((l) => l.kind)).toContain('CROSS_THREAD');
  });
});
