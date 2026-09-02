// Unit coverage for the whole-floor cache fingerprint. A fingerprint DIFFERENCE
// is exactly a cache miss, so "every assembly input forces a rebuild when it
// changes" is proven here by mutating one field at a time. The two deliberate
// EXCLUSIONS (worktreeHead, derivedManifestHash) must NOT change the fingerprint,
// and array ORDER must change it (differently-ordered inputs = different floors).

import { describe, expect, it } from 'vitest';

import {
  buildReviewFloorFixture,
  CITATION_KIND,
  FLOOR_SCHEMA_VERSION,
  floorSchema,
  formatCitationId,
  stableHash64,
} from '@orcaops/review-core';

import {
  computeFloorFingerprint,
  computeInputHash,
  FLOOR_PRODUCER_VERSION,
  type FloorCacheHealth,
  isFloorCacheHealthClean,
} from './floor.js';
import type { AssemblyInput, ReviewArtifact, ReviewCheckpoint } from './model.js';
import { REVIEW_STATE_VERSION } from './reviewState.js';
import type { ScopeInputs } from './scope.js';

function cp(overrides: Partial<ReviewCheckpoint> = {}): ReviewCheckpoint {
  return {
    artifact: 'a1',
    n: 1,
    closedAt: '2020-01-01T00:00:00Z',
    status: 'closed',
    openTreeSha: 'open-tree',
    closeTreeSha: 'close-tree',
    headSha: 'head',
    summary: 'did a thing',
    filesChanged: ['src/x.ts'],
    completedStepIds: ['step-1'],
    declaredStepIds: ['step-1'],
    decisions: [{ decision: 'use X', reason: 'because', alternativesConsidered: [] }],
    uncertainty: ['is Y correct?'],
    doneCriteria: [],
    verification: [],
    manifestHash: 'mh',
    manifestTruncated: false,
    capturedFingerprint: {
      loadState: 'loaded',
      openTreeSha: 'open-tree',
      closeTreeSha: 'close-tree',
      maxDiffBytes: 2_000_000,
      diffOptions: { find_renames: true, no_ext_diff: true, unified: 3 },
    },
    derivedManifestHash: null,
    overlapAmbiguousFiles: [],
    windowOverlap: undefined,
    attributionDegraded: undefined,
    ...overrides,
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    id: 'a1',
    branch: 'feat',
    label: null,
    task: null,
    baseSha: null,
    startedAt: '2020-01-01T00:00:00Z',
    firstActivityAt: '2020-01-01T00:00:00Z',
    planSteps: [
      { stepId: 'step-1', text: 'do the thing', label: 'the thing', acceptanceCriteria: [] },
    ],
    nonGoals: [],
    planDecisions: [],
    summaryText: null,
    evaluatorRuns: [],
    planRevisions: 0,
    checkpoints: [cp()],
    ...overrides,
  };
}

function scopeInputs(overrides: Partial<ScopeInputs> = {}): ScopeInputs {
  const input: AssemblyInput = {
    branch: 'feat',
    branchSlug: 'feat',
    baseSha: 'base-sha',
    baseTreeSha: 'base-tree',
    pinnedTreeSha: 'pinned-tree',
    defaultBranch: 'main',
    worktreeHead: 'worktree-head',
    artifacts: [artifact()],
  };
  return {
    input,
    fingerprintMaxDiffBytes: 1000,
    reviewMaxDiffBytes: 1000,
    reviewIncludedUntracked: [],
    disclosures: [],
    ...overrides,
  };
}

/** Deep clone so a mutation helper never aliases the baseline. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('computeFloorFingerprint — determinism + exclusions', () => {
  it('is identical for identical inputs', async () => {
    expect(await computeFloorFingerprint(scopeInputs())).toBe(
      await computeFloorFingerprint(scopeInputs())
    );
  });

  it('is UNCHANGED by worktreeHead (the live staleness anchor is excluded)', async () => {
    const a = scopeInputs();
    const b = clone(a);
    b.input.worktreeHead = 'a-completely-different-head';
    expect(await computeFloorFingerprint(b)).toBe(await computeFloorFingerprint(a));
  });

  it('is UNCHANGED by a checkpoint derivedManifestHash (deep-stripped)', async () => {
    const a = scopeInputs();
    const b = clone(a);
    b.input.artifacts[0].checkpoints[0].derivedManifestHash = 'freshly-derived';
    expect(await computeFloorFingerprint(b)).toBe(await computeFloorFingerprint(a));
  });
});

// The fingerprint serializes the COMPLETE projected AssemblyInput, so every field
// participates by construction; these cases are a broad representative sweep (not
// a literal per-field enumeration) proving a metadata-only change forces a miss.
describe('computeFloorFingerprint — assembly inputs force a miss', () => {
  const mutations: Array<[string, (s: ScopeInputs) => void]> = [
    ['branch', (s) => (s.input.branch = 'other')],
    ['baseTreeSha', (s) => (s.input.baseTreeSha = 'moved')],
    ['pinnedTreeSha', (s) => (s.input.pinnedTreeSha = 'moved')],
    ['baseSha (same tree)', (s) => (s.input.baseSha = 'different-commit')],
    ['defaultBranch', (s) => (s.input.defaultBranch = 'master')],
    ['fingerprintMaxDiffBytes', (s) => (s.fingerprintMaxDiffBytes = 2000)],
    ['reviewMaxDiffBytes', (s) => (s.reviewMaxDiffBytes = 2000)],
    ['reviewIncludedUntracked', (s) => (s.reviewIncludedUntracked = ['src/new.ts'])],
    ['a scope disclosure', (s) => (s.disclosures = [{ code: 'degenerate_scope', message: 'x' }])],
    ['plan step text', (s) => (s.input.artifacts[0].planSteps[0].text = 'rewritten')],
    [
      'a new decision',
      (s) =>
        s.input.artifacts[0].checkpoints[0].decisions.push({
          decision: 'new',
          reason: 'r',
          alternativesConsidered: [],
        }),
    ],
    ['checkpoint uncertainty', (s) => (s.input.artifacts[0].checkpoints[0].uncertainty = ['new'])],
    ['filesChanged', (s) => (s.input.artifacts[0].checkpoints[0].filesChanged = ['src/y.ts'])],
    ['completedStepIds', (s) => (s.input.artifacts[0].checkpoints[0].completedStepIds = [])],
    [
      'checkpoint status (closed→open)',
      (s) => (s.input.artifacts[0].checkpoints[0].status = 'open'),
    ],
    [
      'closedAt ordering',
      (s) => (s.input.artifacts[0].checkpoints[0].closedAt = '2021-06-06T00:00:00Z'),
    ],
    ['openTreeSha', (s) => (s.input.artifacts[0].checkpoints[0].openTreeSha = 'moved')],
    ['manifestHash', (s) => (s.input.artifacts[0].checkpoints[0].manifestHash = 'tampered')],
    ['a summary', (s) => (s.input.artifacts[0].summaryText = 'shipped it')],
    [
      'an evaluator run',
      (s) =>
        (s.input.artifacts[0].evaluatorRuns = [
          {
            id: 'e',
            verdict: 'pass',
            severity: 'warn',
            runStatus: 'completed',
            disposition: null,
            body: 'ok',
          },
        ]),
    ],
    // The fingerprint serializes the COMPLETE projected AssemblyInput, so these
    // participate too.
    ['branchSlug', (s) => (s.input.branchSlug = 'other-slug')],
    ['artifact label', (s) => (s.input.artifacts[0].label = 'renamed')],
    ['artifact task', (s) => (s.input.artifacts[0].task = 'a new task')],
    ['artifact baseSha', (s) => (s.input.artifacts[0].baseSha = 'abc1234')],
    ['artifact startedAt', (s) => (s.input.artifacts[0].startedAt = '2099-01-01T00:00:00Z')],
    [
      'artifact firstActivityAt',
      (s) => (s.input.artifacts[0].firstActivityAt = '2099-01-01T00:00:00Z'),
    ],
    ['planRevisions', (s) => (s.input.artifacts[0].planRevisions = 3)],
    ['a non-goal', (s) => (s.input.artifacts[0].nonGoals = [{ text: 'do not', rationale: 'why' }])],
    [
      'an acceptance criterion',
      (s) =>
        (s.input.artifacts[0].planSteps[0].acceptanceCriteria = [
          { criterionId: 'c1', text: 'the rubric' },
        ]),
    ],
    [
      'a rejected alternative',
      (s) =>
        s.input.artifacts[0].checkpoints[0].decisions[0].alternativesConsidered.push({
          option: 'the other way',
          rejectedBecause: 'slower',
        }),
    ],
    [
      'a decision reason',
      (s) => (s.input.artifacts[0].checkpoints[0].decisions[0].reason = 'new why'),
    ],
    ['checkpoint headSha', (s) => (s.input.artifacts[0].checkpoints[0].headSha = 'newhead')],
    [
      'declaredStepIds',
      (s) => (s.input.artifacts[0].checkpoints[0].declaredStepIds = ['step-1', 'step-2']),
    ],
    ['manifestTruncated', (s) => (s.input.artifacts[0].checkpoints[0].manifestTruncated = true)],
    [
      'overlapAmbiguousFiles',
      (s) => (s.input.artifacts[0].checkpoints[0].overlapAmbiguousFiles = ['z.ts']),
    ],
    ['checkpoint summary', (s) => (s.input.artifacts[0].checkpoints[0].summary = 'reworded')],
  ];

  for (const [name, mutate] of mutations) {
    it(`changes when ${name} changes`, async () => {
      const base = scopeInputs();
      const mutated = clone(base);
      mutate(mutated);
      expect(await computeFloorFingerprint(mutated)).not.toBe(await computeFloorFingerprint(base));
    });
  }
});

// The manifest's recorded capture inputs ride on the checkpoint, and
// projectFingerprintInput spreads EVERY checkpoint field into the fingerprint. That
// is a loaded gun: park the full DiffFingerprintManifest there and its hunk +
// line-hash payload lands in canonicalJson on the CHEAP cache-preamble path, whose
// entire reason to exist is that a hit-check pays none of the derive cost.
describe('computeFloorFingerprint — the manifest projection is cache-safe', () => {
  it('a corrupt manifest sidecar forces a MISS on a previously-healthy floor', async () => {
    // Nothing else moves when a sidecar goes corrupt — the stored summary hash is
    // untouched — so without loadState in the fingerprint the stale healthy floor
    // would be served and the corruption would never surface.
    const healthy = scopeInputs();
    const corrupt = clone(healthy);
    corrupt.input.artifacts[0].checkpoints[0].capturedFingerprint = {
      loadState: 'corrupt',
      openTreeSha: null,
      closeTreeSha: null,
      maxDiffBytes: null,
      diffOptions: null,
    };
    expect(await computeFloorFingerprint(corrupt)).not.toBe(await computeFloorFingerprint(healthy));
  });

  it("moves when the manifest's RECORDED cap changes (a re-capture under a new cap)", async () => {
    const base = scopeInputs();
    const recaptured = clone(base);
    recaptured.input.artifacts[0].checkpoints[0].capturedFingerprint.maxDiffBytes = 4_000_000;
    expect(await computeFloorFingerprint(recaptured)).not.toBe(await computeFloorFingerprint(base));
  });

  it('stays SMALL — no manifest hunk/line-hash payload may leak into the canonical JSON', async () => {
    // A behavioural guard against the regression, not a vibe: if someone later
    // attaches the manifest itself, the projected input balloons and this fails.
    const s = scopeInputs();
    const captured = s.input.artifacts[0].checkpoints[0].capturedFingerprint;
    expect(Object.keys(captured).sort()).toEqual([
      'closeTreeSha',
      'diffOptions',
      'loadState',
      'maxDiffBytes',
      'openTreeSha',
    ]);
    // No array-shaped payload (hunks, line hashes) anywhere in the projection.
    for (const v of Object.values(captured)) expect(Array.isArray(v)).toBe(false);
  });
});

// input_hash is the NARRATIVE-content identity, not the cache key. The cap split
// makes `review.max_diff_bytes` user-tunable, which opens a hazard: change the cap,
// the floor rebuilds (the cache fingerprint carries it), but a narrative composed
// against the TRUNCATED floor would still read "fresh" against a fuller one. The fix
// is a component gated on truncation — and the gate is what protects every repo whose
// diff fits the cap from a pointless recompose.
describe('computeInputHash — truncation gate', () => {
  /**
   * The EXACT pre-change algorithm, replicated. If the untruncated path ever stops
   * matching this, every narrative in every repo silently goes stale on upgrade —
   * so this is pinned rather than trusted.
   */
  async function legacyInputHash(input: AssemblyInput): Promise<string> {
    const parts = [input.branch, input.baseTreeSha, input.pinnedTreeSha];
    const cpParts: string[] = [];
    for (const a of input.artifacts) {
      cpParts.push(`artifact:${a.id}`);
      for (const c of a.checkpoints) {
        if (c.status === 'closed') {
          cpParts.push(`${a.id}:cp${c.n}:${c.closeTreeSha}:${c.manifestHash}`);
        }
      }
    }
    return stableHash64('orcaops.review.floor_input.v2', [...parts, ...cpParts.sort()]);
  }

  it('is BYTE-IDENTICAL to the pre-split hash when the diff was not truncated', async () => {
    const { input } = scopeInputs();
    expect(await computeInputHash(input, null)).toBe(await legacyInputHash(input));
  });

  it('moves once the diff IS truncated — the retained hunk set is now an input', async () => {
    const { input } = scopeInputs();
    expect(await computeInputHash(input, ['hk1', 'hk2'])).not.toBe(
      await computeInputHash(input, null)
    );
  });

  it('moves when truncation retains a DIFFERENT hunk set (e.g. the cap was raised)', async () => {
    const { input } = scopeInputs();
    expect(await computeInputHash(input, ['hk1', 'hk2', 'hk3'])).not.toBe(
      await computeInputHash(input, ['hk1', 'hk2'])
    );
  });

  it('does NOT move when the same hunks are retained — a cap change that changed nothing', async () => {
    const { input } = scopeInputs();
    // Raising the cap from 2MB to 10MB on a diff that still truncates to the same
    // hunks must not stale the narrative. Equally: complete-hunk normalization drops
    // only bytes the floor already ignored, so it must not stale it either.
    expect(await computeInputHash(input, ['hk1', 'hk2'])).toBe(
      await computeInputHash(input, ['hk1', 'hk2'])
    );
  });

  it('is sensitive to hunk ORDER (identity is the ordered retained set)', async () => {
    const { input } = scopeInputs();
    expect(await computeInputHash(input, ['hk1', 'hk2'])).not.toBe(
      await computeInputHash(input, ['hk2', 'hk1'])
    );
  });

  /**
   * A GOLDEN VALUE, not a self-consistency check. `computeInputHash` reads
   * branch + trees + per-checkpoint close-tree/manifest hashes and nothing
   * else, which is what lets new capture fields land without staling a single
   * composed narrative. That property is invisible to a same-input-same-output
   * assertion, so the literal is pinned: if a future field is threaded into
   * this hash, every narrative in every repo silently goes stale on upgrade
   * and this line is the only thing that says so.
   */
  it('is pinned to a literal for a fixed input — new model fields must not reach it', async () => {
    const { input } = scopeInputs();
    expect(await computeInputHash(input, null)).toBe('RWWegSJKZ7c');
  });

  /**
   * The concrete version of the claim above for the three categories of
   * captured provenance the citation table now reads: populating them changes
   * the FLOOR (new citations) but must not change the narrative-content
   * identity, because the floor's decisions/uncertainty/plan text never
   * entered this hash either.
   */
  it('does not move when plan decisions, done-criteria, or verification are captured', async () => {
    const base = scopeInputs().input;
    const enriched: AssemblyInput = {
      ...base,
      artifacts: [
        artifact({
          planDecisions: [
            {
              decision: 'plumb the citation table',
              reason: 'nothing read the corpus',
              revisionN: 1,
              alternativesConsidered: [{ option: 'render ad hoc', rejectedBecause: 'uncitable' }],
            },
          ],
          checkpoints: [
            cp({
              doneCriteria: [{ criterionId: 'c1', evidence: 'suite green' }],
              verification: [{ command: 'pnpm test', exitCode: 0, outputDigest: null, note: null }],
            }),
          ],
        }),
      ],
    };
    expect(await computeInputHash(enriched, null)).toBe(await computeInputHash(base, null));
  });
});

describe('floor versioning — shape vs producer', () => {
  it('pins the floor contract and durable reviewer-state versions', () => {
    expect(FLOOR_SCHEMA_VERSION).toBe(4);
    expect(FLOOR_PRODUCER_VERSION).toBe('11');
    expect(REVIEW_STATE_VERSION).toBe(4);
  });

  it('a floor carrying every current citation relationship parses at schema 4', () => {
    const floor = buildReviewFloorFixture('clean').floor;
    const artifactId = floor.citations[0]?.artifact ?? 'a1';
    floor.citations.push(
      {
        id: formatCitationId({
          artifact: artifactId,
          checkpointN: null,
          kind: CITATION_KIND.PLAN_DECISION,
          index: 0,
        }),
        kind: CITATION_KIND.PLAN_DECISION,
        artifact: artifactId,
        text: 'plan-time choice',
      },
      {
        id: formatCitationId({
          artifact: artifactId,
          checkpointN: null,
          kind: CITATION_KIND.PLAN_ALTERNATIVE,
          index: 0,
        }),
        kind: CITATION_KIND.PLAN_ALTERNATIVE,
        artifact: artifactId,
        parent: formatCitationId({
          artifact: artifactId,
          checkpointN: null,
          kind: CITATION_KIND.PLAN_DECISION,
          index: 0,
        }),
        text: 'ruled out',
      },
      {
        id: formatCitationId({
          artifact: artifactId,
          checkpointN: 1,
          kind: CITATION_KIND.CRITERION_EVIDENCE,
          index: 0,
        }),
        kind: CITATION_KIND.CRITERION_EVIDENCE,
        artifact: artifactId,
        cp: 1,
        text: 'c1 — evidence',
      },
      {
        id: formatCitationId({
          artifact: artifactId,
          checkpointN: 1,
          kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
          index: 0,
        }),
        kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
        artifact: artifactId,
        cp: 1,
        text: 'pnpm test → exit 0',
      }
    );
    expect(floor.schema_version).toBe(FLOOR_SCHEMA_VERSION);
    expect(() => floorSchema.parse(floor)).not.toThrow();
  });
});

// The caps are two settings governing two different jobs. The table above proves
// each forces a miss; these prove they are not secretly the SAME field wearing two
// names — which is the whole content of the split. If they collided, raising the
// review cap would silently perturb checkpoint-manifest identity.
describe('computeFloorFingerprint — the two caps are independent axes', () => {
  it('an unchanged pair produces a HIT', async () => {
    expect(await computeFloorFingerprint(scopeInputs())).toBe(
      await computeFloorFingerprint(scopeInputs())
    );
  });

  it('moving the review cap and moving the fingerprint cap are DIFFERENT fingerprints', async () => {
    const review = scopeInputs({ reviewMaxDiffBytes: 2000 });
    const fingerprint = scopeInputs({ fingerprintMaxDiffBytes: 2000 });
    // Same numeric value, different field ⇒ different hash. A single shared field
    // (or two fields hashed under one name) would collide here.
    expect(await computeFloorFingerprint(review)).not.toBe(
      await computeFloorFingerprint(fingerprint)
    );
  });

  it('swapping the two caps changes the fingerprint (they are not commutative)', async () => {
    const a = scopeInputs({ fingerprintMaxDiffBytes: 1000, reviewMaxDiffBytes: 2000 });
    const b = scopeInputs({ fingerprintMaxDiffBytes: 2000, reviewMaxDiffBytes: 1000 });
    expect(await computeFloorFingerprint(a)).not.toBe(await computeFloorFingerprint(b));
  });
});

describe('computeFloorFingerprint — array order is significant', () => {
  it('differs when plan steps are reordered (citation IDs are positional)', async () => {
    const a = scopeInputs();
    a.input.artifacts[0].planSteps = [
      { stepId: 's1', text: 'first', label: 'first', acceptanceCriteria: [] },
      { stepId: 's2', text: 'second', label: 'second', acceptanceCriteria: [] },
    ];
    const b = clone(a);
    b.input.artifacts[0].planSteps.reverse();
    expect(await computeFloorFingerprint(b)).not.toBe(await computeFloorFingerprint(a));
  });

  it('differs when checkpoint decisions are reordered', async () => {
    const a = scopeInputs();
    a.input.artifacts[0].checkpoints[0].decisions = [
      { decision: 'one', reason: 'r1', alternativesConsidered: [] },
      { decision: 'two', reason: 'r2', alternativesConsidered: [] },
    ];
    const b = clone(a);
    b.input.artifacts[0].checkpoints[0].decisions.reverse();
    expect(await computeFloorFingerprint(b)).not.toBe(await computeFloorFingerprint(a));
  });
});

describe('isFloorCacheHealthClean — the marker gate', () => {
  const clean: FloorCacheHealth = {
    reviewDiffOk: true,
    truncationStatsFailed: false,
    manifestDeriveFailed: false,
    lineageFailed: false,
    blameFailed: false,
  };

  it('a fully clean build is cacheable', () => {
    expect(isFloorCacheHealthClean(clean)).toBe(true);
  });

  it('ANY degradation signal blocks the marker', () => {
    expect(isFloorCacheHealthClean({ ...clean, reviewDiffOk: false })).toBe(false);
    expect(isFloorCacheHealthClean({ ...clean, truncationStatsFailed: true })).toBe(false);
    expect(isFloorCacheHealthClean({ ...clean, manifestDeriveFailed: true })).toBe(false);
    expect(isFloorCacheHealthClean({ ...clean, lineageFailed: true })).toBe(false);
    expect(isFloorCacheHealthClean({ ...clean, blameFailed: true })).toBe(false);
  });
});
