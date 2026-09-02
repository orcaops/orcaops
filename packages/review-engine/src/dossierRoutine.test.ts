import { describe, expect, it } from 'vitest';

import {
  buildReviewFloorFixture,
  CITATION_KIND,
  type Floor,
  formatCitationId,
} from '@orcaops/review-core';

import {
  ATTRIBUTION_MISMATCH_SHARED_EXPLANATION,
  buildClaimLedger,
  CLAIM_LEDGER_ENTRY_KIND,
} from './claimLedger.js';
import {
  type AccountProjection,
  buildDossier,
  type BuildDossierInput,
  DOSSIER_BUDGET_V1,
  type DossierAccountCore,
  type DossierEvaluatorRun,
  estimatorV1,
  ForensicTransportCeilingError,
  PROTECTED_ACCOUNT_FIELDS,
  ROUTINE_BUDGET_V1,
} from './dossier.js';
import { renderAccountRoutineMd } from './twolaneRunCli.js';
import { accountCitableIds, buildAccountPromptAliases } from './twolaneSlice.js';
import { accountPromptAliasMaps, unaliasAccountValue } from '../tests/support/accountAlias.js';

const AT = '2026-07-18T00:00:00.000Z';

const section = (path: string, bodyLines: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${bodyLines.length + 1} @@`,
    ' context',
    ...bodyLines.map((l) => `+${l}`),
  ].join('\n');

function makeInput(
  retainedDiff: string,
  overrides: Partial<BuildDossierInput> = {}
): BuildDossierInput {
  const floor: Floor = buildReviewFloorFixture('clean').floor;
  return {
    floor,
    retainedDiff,
    ledgerEntries: buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries,
    branch: 'routine-selector-test',
    baseSha: 'basesha1234',
    generatedAt: AT,
    ...overrides,
  };
}

describe('routine budgets — the forensic lane is un-budgeted', () => {
  it('ROUTINE_BUDGET_V1 bounds the REDUCIBLE sections only; the forensic lane is verbatim-complete', () => {
    const diff = [
      section('src/impl-a.ts', ['const IMPL_MARKER_A = 1;']),
      section('src/impl-b.ts', ['const IMPL_MARKER_B = 2;']),
      '',
    ].join('\n');
    const { forensicInput, accountProjection } = buildDossier(
      makeInput(diff, { budget: ROUTINE_BUDGET_V1 })
    );
    // Only the sections budget reduction can act on are capped. The protected
    // corpus is not a budget input at all — over its own ceiling the run
    // refuses, and under it the corpus is served whole.
    expect(
      estimatorV1(
        JSON.stringify({
          implicatedHunks: accountProjection.implicatedHunks,
          riskRemainder: accountProjection.riskRemainder,
          fileInventory: accountProjection.fileInventory,
          ledger: accountProjection.accountCore.ledger,
        })
      )
    ).toBeLessThanOrEqual(ROUTINE_BUDGET_V1.accountProjectionTotal);
    // Forensic lane is the complete eligible diff — no budget, no omission.
    expect(forensicInput.diff).toContain('IMPL_MARKER_A');
    expect(forensicInput.diff).toContain('IMPL_MARKER_B');
    expect(forensicInput.metrics.eligibleDiffBytes).toBe(
      Buffer.byteLength(forensicInput.diff, 'utf8')
    );
  });
});

describe('plan retention is unconditional (protected corpus)', () => {
  const diff = [
    section('src/impl-a.ts', ['const IMPL_MARKER_A = 1;']),
    section('src/impl-b.ts', ['const IMPL_MARKER_B = 2;']),
    '',
  ].join('\n');

  /** The golden floor captures no plan; inject a realistic one. */
  const plannedFloor = (): Floor => {
    const floor = buildReviewFloorFixture('clean').floor;
    const artifact = floor.citations[0]?.artifact ?? 'a1';
    for (let i = 0; i < 4; i += 1)
      floor.citations.push({
        id: `${artifact}:plan:${i}`,
        kind: 'PLAN_STEP',
        artifact,
        cp: null,
        text: `Plan step ${i}: build the deterministic widget stage with a long descriptive sentence about scope`,
      } as (typeof floor.citations)[number]);
    for (let i = 0; i < 3; i += 1)
      floor.citations.push({
        id: `${artifact}:non-goal:${i}`,
        kind: 'PLAN_NON_GOAL',
        artifact,
        cp: null,
        text: `Non-goal ${i}: never expand into the adjacent subsystem this slice`,
      } as (typeof floor.citations)[number]);
    return floor;
  };

  it('the plan-step and non-goal index survives the tightest budget VERBATIM, not clipped', () => {
    const floor = plannedFloor();
    const full = buildDossier(makeInput(diff, { floor })).accountProjection.accountCore;
    expect(full.planSteps.length).toBe(4);
    expect(full.nonGoals.length).toBe(3);
    // The index is protected, so the tightest reducible budget serves the same
    // bytes as the healthy build.
    const tiny = buildDossier(
      makeInput(diff, {
        floor,
        budget: { ...DOSSIER_BUDGET_V1, ledgerReduction: 1, accountProjectionTotal: 1 },
      })
    ).accountProjection;
    expect('degradation' in tiny).toBe(false);
    expect(tiny.accountCore.planSteps).toEqual(full.planSteps);
    expect(tiny.accountCore.nonGoals).toEqual(full.nonGoals);
    for (const step of tiny.accountCore.planSteps) expect(step.text).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------
// The protected corpus travels two hops, and each one is asserted on its own:
//   dossier.account_core  ->  accountProjection.accountCore   (projection)
//   accountProjection     ->  renderAccountRoutineMd(...)     (payload)
// The MODEL reads the second one. A green projection assertion says nothing
// about what survived the render, so both hops are checked below.
// ---------------------------------------------------------------------------

/** A uuid artifact, so the projection's citation-id ALIAS STRIP actually fires here. */
const ARTIFACT_UUID = '019f791c-1111-7000-8000-000000000001';

const cite = (kind: string, index: number, checkpointN: number | null = null): string =>
  formatCitationId({ artifact: ARTIFACT_UUID, checkpointN, kind: kind as never, index });

/**
 * Every captured text is longer than every clip the retired ladder applied (41
 * characters for decision bodies, 160 for cited text). A corpus of short
 * strings cannot OBSERVE a clip, so shortness here would silently blunt every
 * assertion below.
 */
const long = (lead: string): string =>
  `${lead} — ${'the recorded rationale runs well past any clip length the old ladder applied, '.repeat(3)}and ends here.`;

type EvaluatorMetadata = DossierEvaluatorRun['evaluator'];

/**
 * Run metadata for the fixture's evaluator citations, mirroring what the floor
 * producer records. Both rows are anomalous on purpose (a violation and an
 * error): a routine pass with no disposition collapses into the payload's
 * count line, and a row that is never rendered cannot exercise the render
 * round-trip below.
 */
const EVALUATOR_METADATA: EvaluatorMetadata[] = [
  {
    evaluator_ref: 'core/api-stability',
    severity: 'block',
    run_status: 'completed',
    verdict: 'violation',
    disposition: 'unresolved',
    summary: long('Evaluator run 0 flagged the exported surface'),
  },
  {
    evaluator_ref: 'core/test-discipline',
    severity: 'warn',
    run_status: 'error',
    verdict: null,
    disposition: null,
    summary: long('Evaluator run 1 could not execute'),
  },
];

/**
 * The golden floor stocked with EVERY protected kind, at least two entries deep
 * in every list. Depth is the point: `.slice(0, 1)` on a one-element list is
 * invisible, and `decisions.length >= 1` — the assertion this fixture exists to
 * replace — is satisfied by exactly that slice.
 *
 * `bulkPlanSteps` pads the corpus past the account total cap. The fidelity
 * assertions do not need it (they compare content, at any size), but the
 * total-cap guard does: at the fixture's natural size the whole projection
 * measures ~200 tokens against a 12,000-token cap, so the eviction loop never
 * runs and the guard cannot tell a correctly scoped cap from the trap.
 */
const capturedFloor = (bulkPlanSteps = 0): Floor => {
  const floor = JSON.parse(
    JSON.stringify(buildReviewFloorFixture('clean').floor).replaceAll(
      'artifact-fixture',
      ARTIFACT_UUID
    )
  ) as Floor;
  const thread = floor.outline.threads[0]!;
  thread.checkpoints[0]!.summary = long(
    'cp1 close: reworked the widget stage\n   over   two passes'
  );
  thread.checkpoints.push({
    checkpointKey: 'chap_fixture_2',
    order: 2,
    checkpoint: { artifact: ARTIFACT_UUID, cp: 2, label: 'Second checkpoint' },
    summary: long('cp2 close: re-based the eviction order on the reducible sections'),
    members: [{ artifact: ARTIFACT_UUID, cp: 2 }],
    sliceRefs: [],
    citationIds: [],
  });
  // The golden floor's one decision is short; the corpus must not contain a
  // text a 160-character clip would leave untouched.
  floor.citations[0]!.text = long('cp1 decision 0 (the golden fixture row)');

  const add = (
    kind: string,
    index: number,
    text: string,
    at: { cp?: number; parent?: string; evaluator?: EvaluatorMetadata } = {}
  ): void => {
    floor.citations.push({
      id: cite(kind, index, at.cp ?? null),
      kind,
      artifact: ARTIFACT_UUID,
      ...(at.cp !== undefined ? { cp: at.cp } : {}),
      ...(at.parent !== undefined ? { parent: at.parent } : {}),
      ...(at.evaluator !== undefined ? { evaluator: at.evaluator } : {}),
      text,
    } as (typeof floor.citations)[number]);
  };

  // Plan-scoped provenance.
  for (const i of [0, 1, 2]) add(CITATION_KIND.PLAN_STEP, i, long(`Plan step ${i}`));
  for (let i = 0; i < bulkPlanSteps; i += 1)
    add(CITATION_KIND.PLAN_STEP, 3 + i, long(`Bulk plan step ${i}`));
  for (const i of [0, 1]) add(CITATION_KIND.PLAN_NON_GOAL, i, long(`Non-goal ${i}`));
  for (const i of [0, 1]) add(CITATION_KIND.PLAN_DECISION, i, long(`Plan decision ${i}`));
  // Asymmetric fan-out (2 then 1): an alternative re-served under the wrong
  // plan decision changes a parent AND a per-decision count.
  for (const i of [0, 1])
    add(CITATION_KIND.PLAN_ALTERNATIVE, i, long(`Plan option ${i} ruled out against decision 0`), {
      parent: cite(CITATION_KIND.PLAN_DECISION, 0),
    });
  add(CITATION_KIND.PLAN_ALTERNATIVE, 2, long('Plan option ruled out against decision 1'), {
    parent: cite(CITATION_KIND.PLAN_DECISION, 1),
  });
  for (const i of [0, 1])
    add(CITATION_KIND.ACCEPTANCE_CRITERION, i, long(`Acceptance criterion ${i}`), {
      parent: cite(CITATION_KIND.PLAN_STEP, i),
    });
  for (const i of [0, 1])
    add(CITATION_KIND.EVALUATOR_RUN, i, long(`Evaluator run ${i}`), {
      evaluator: EVALUATOR_METADATA[i]!,
    });

  // Checkpoint 1: two decisions (2 + 1 alternatives), two uncertainties, two
  // verified-close records, and evidence for both criteria plus one orphan
  // whose criterion_id resolves to nothing.
  add(CITATION_KIND.CHECKPOINT_DECISION, 1, long('cp1 decision 1'), { cp: 1 });
  for (const i of [0, 1])
    add(
      CITATION_KIND.CHECKPOINT_ALTERNATIVE,
      i,
      long(`cp1 option ${i} ruled out against decision 0`),
      {
        cp: 1,
        parent: cite(CITATION_KIND.CHECKPOINT_DECISION, 0, 1),
      }
    );
  add(CITATION_KIND.CHECKPOINT_ALTERNATIVE, 2, long('cp1 option ruled out against decision 1'), {
    cp: 1,
    parent: cite(CITATION_KIND.CHECKPOINT_DECISION, 1, 1),
  });
  for (const i of [0, 1])
    add(CITATION_KIND.CHECKPOINT_UNCERTAINTY, i, long(`cp1 uncertainty ${i}`), { cp: 1 });
  for (const i of [0, 1])
    add(
      CITATION_KIND.CHECKPOINT_VERIFICATION,
      i,
      long(`cp1 verification ${i}: pnpm test → exit 0`),
      {
        cp: 1,
      }
    );
  for (const i of [0, 1])
    add(CITATION_KIND.CRITERION_EVIDENCE, i, long(`cp1 evidence for criterion ${i}`), {
      cp: 1,
      parent: cite(CITATION_KIND.ACCEPTANCE_CRITERION, i),
    });
  add(
    CITATION_KIND.CRITERION_EVIDENCE,
    2,
    long('cp1 evidence for a criterion no longer in scope'),
    {
      cp: 1,
    }
  );

  // Checkpoint 2: one alternative under each decision, so a swap between them
  // is visible only as a change of parent.
  for (const i of [0, 1])
    add(CITATION_KIND.CHECKPOINT_DECISION, i, long(`cp2 decision ${i}`), { cp: 2 });
  for (const i of [0, 1])
    add(
      CITATION_KIND.CHECKPOINT_ALTERNATIVE,
      i,
      long(`cp2 option ruled out against decision ${i}`),
      {
        cp: 2,
        parent: cite(CITATION_KIND.CHECKPOINT_DECISION, i, 2),
      }
    );
  add(CITATION_KIND.CHECKPOINT_UNCERTAINTY, 0, long('cp2 uncertainty 0'), { cp: 2 });
  return floor;
};

/** The protected corpus as a value — projected from the exported const, never a second field list. */
type ProtectedCorpus = Pick<DossierAccountCore, (typeof PROTECTED_ACCOUNT_FIELDS)[number]>;

const protectedCorpusOf = (core: ProtectedCorpus): ProtectedCorpus =>
  Object.fromEntries(PROTECTED_ACCOUNT_FIELDS.map((f) => [f, core[f]])) as ProtectedCorpus;

/** The served corpus with the projection's alias strip undone — comparable to the captured one. */
const servedCorpus = (built: ReturnType<typeof buildDossier>): ProtectedCorpus =>
  unaliasAccountValue(
    protectedCorpusOf(built.accountProjection.accountCore),
    built.accountProjection.artifactAliases
  );

/**
 * THE fidelity assertion: the protected corpus the projection SERVES is the
 * corpus the dossier CAPTURED — same records, same order, same bytes — once the
 * alias strip is undone.
 *
 * A structural deep-equal rather than a non-emptiness check. Asserting
 * `decisions.length >= 1` and `decisions[0].text.trim().length > 0` would not
 * do: the first is satisfied by `.slice(0, 1)` and the second by a single
 * character, so such a check stays green even if production clips every
 * decision body to 41 characters and drops more than half of them, and it never
 * looks at alternatives, criteria, or verification at all. This fails on a clip
 * (text differs), a slice (length differs), and a drop (entry missing), in every
 * protected field at once.
 */
const assertCorpusFidelity = (built: ReturnType<typeof buildDossier>, at: string): void => {
  // The strip must have fired, or undoing it is a no-op and this assertion
  // quietly stops covering the alias hop it exists to cover.
  expect(Object.values(built.accountProjection.artifactAliases), at).toContain(ARTIFACT_UUID);
  expect(JSON.stringify(protectedCorpusOf(built.accountProjection.accountCore)), at).not.toContain(
    ARTIFACT_UUID
  );
  expect(servedCorpus(built), at).toEqual(protectedCorpusOf(built.dossier.account_core));
};

/**
 * What the deep-equal is measured against. Two empty corpora are also equal, so
 * these counts are what make the fidelity assertion evidence rather than
 * ceremony: they pin the captured side to a corpus with depth in every list.
 */
const assertCapturedShape = (core: DossierAccountCore): void => {
  expect(core.checkpoints.map((cp) => `${cp.artifact}:cp${cp.cp}`)).toEqual([
    `${ARTIFACT_UUID}:cp1`,
    `${ARTIFACT_UUID}:cp2`,
  ]);
  expect(core.checkpoints.map((cp) => cp.status)).toEqual(['closed', 'closed']);
  expect(core.checkpoints.map((cp) => cp.decisions.map((d) => d.alternatives.length))).toEqual([
    [2, 1],
    [1, 1],
  ]);
  expect(core.checkpoints.map((cp) => cp.uncertainty.length)).toEqual([2, 1]);
  for (const cp of core.checkpoints) expect(cp.label).not.toBeNull();
  expect(core.planSteps.length).toBe(3);
  expect(core.nonGoals.length).toBe(2);
  expect(core.planDecisions.map((d) => d.alternatives.length)).toEqual([2, 1]);
  expect(core.acceptanceCriteria.length).toBe(2);
  expect(core.criterionEvidence.map((e) => e.parent !== undefined)).toEqual([true, true, false]);
  expect(core.verification.length).toBe(2);
  expect(core.evaluatorRuns.length).toBe(2);
  // Every captured text outlives both historical clip lengths, checkpoint
  // summaries included — otherwise a clip could pass through unobserved.
  for (const text of [
    ...core.checkpoints.flatMap((cp) => [
      cp.summary ?? '',
      ...cp.decisions.flatMap((d) => [d.text, ...d.alternatives.map((a) => a.text)]),
      ...cp.uncertainty.map((u) => u.text),
    ]),
    ...core.planDecisions.flatMap((d) => [d.text, ...d.alternatives.map((a) => a.text)]),
    ...[
      ...core.planSteps,
      ...core.nonGoals,
      ...core.acceptanceCriteria,
      ...core.criterionEvidence,
      ...core.verification,
      ...core.evaluatorRuns,
    ].map((r) => r.text),
  ])
    expect(text.length).toBeGreaterThan(160);
};

describe('account projection: the protected corpus is served complete at every budget', () => {
  const diff = [
    section('src/impl-a.ts', ['const IMPL_MARKER_A = 1;']),
    section('src/impl-b.ts', ['const IMPL_MARKER_B = 2;']),
    '',
  ].join('\n');

  it('no budget clips, drops, or summarizes the corpus — the served bytes are the captured bytes', () => {
    // Three budgets: the default, the routine profile, and one absurd enough to
    // pressure every reduction path at once. The old ladder's tightest rungs
    // clipped decision bodies, emptied every rejected alternative, and zeroed
    // acceptance criteria and evaluator runs; reduction is typed against the
    // ledger alone now, so all three must serve identical protected bytes.
    const budgets: [string, Partial<BuildDossierInput>][] = [
      ['the default budget', {}],
      ['ROUTINE_BUDGET_V1', { budget: ROUTINE_BUDGET_V1 }],
      [
        'an absurd budget (ledgerReduction 1, accountProjectionTotal 1)',
        { budget: { ...DOSSIER_BUDGET_V1, ledgerReduction: 1, accountProjectionTotal: 1 } },
      ],
    ];
    const served: ProtectedCorpus[] = [];
    for (const [at, overrides] of budgets) {
      const built = buildDossier(makeInput(diff, { floor: capturedFloor(), ...overrides }));
      assertCapturedShape(built.dossier.account_core);
      expect('degradation' in built.accountProjection, at).toBe(false);
      assertCorpusFidelity(built, at);
      served.push(servedCorpus(built));
    }
    // ...and identical to each other, so no budget serves a different corpus.
    expect(served[1], 'ROUTINE_BUDGET_V1 vs the default budget').toEqual(served[0]);
    expect(served[2], 'the absurd budget vs the default budget').toEqual(served[0]);
  });

  it('the account lane still ships code hunks on a multi-hunk build with a real corpus', () => {
    // THE TRAP a total cap springs: measured on the COMPLETE projection, a
    // corpus of any real size holds `measure(projection) > cap` true forever, so
    // the loop evicts the risk remainder and then every implicated hunk — green
    // tests, zero code. The cap measures only the sections its evictions can act
    // on.
    // Big enough that measuring the WHOLE projection would hold
    // `measure > cap` true forever — the condition that springs the trap. The
    // REDUCIBLE sections stay far under the same cap, so a correctly scoped
    // loop evicts nothing and the hunks below survive.
    const floor = capturedFloor(400);
    const anchored = ['src/impl-a.ts', 'src/impl-b.ts', 'src/impl-c.ts'];
    const diffMulti = [
      ...anchored.map((f, i) => section(f, [`const MARKER_${i} = guard(${i});`])),
      section('src/other.ts', ['const OTHER = 9;']),
      '',
    ].join('\n');
    const ledgerEntries = anchored.map((file, i) => ({
      id: `ldg:ATTRIBUTION_MISMATCH_CANDIDATE:anchor${i}00000000000`,
      kind: CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
      status: 'CANDIDATE' as const,
      message: `claim anchored at ${file}`,
      citations: [],
      anchors: [file],
      evidence: {},
    }));
    const { accountProjection, dossier } = buildDossier(
      makeInput(diffMulti, { floor, ledgerEntries, budget: ROUTINE_BUDGET_V1 })
    );
    expect(accountProjection.implicatedHunks.length).toBeGreaterThan(0);
    expect(accountProjection.implicatedHunks.map((h) => h.file).sort()).toEqual(anchored);
    expect(dossier.truncation_manifest.some((r) => r.id === 'account-total-cap-exceeded')).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Payload fidelity — the surface the MODEL actually reads
// ---------------------------------------------------------------------------

/**
 * One protected record as the RENDERED payload presents it: what it is, its id,
 * what it is served UNDER, and its text. The four-tuple is the whole point —
 * checking that a record's characters appear SOMEWHERE in the payload still
 * passes with an alternative rendered under the wrong decision, which is
 * precisely the defect an earlier step in this round existed to fix.
 */
interface PayloadRecord {
  kind: string;
  /** The bracketed citation id; null for the label and summary rows, which carry none. */
  citationId: string | null;
  /** What this record is nested under: a decision id, a criterion id, or `a1:cp2`. */
  parent: string | null;
  text: string;
}

/**
 * `renderAccountRoutineMd` collapses whitespace through its own `oneLine`.
 * Re-implemented here rather than imported ON PURPOSE: sharing production's
 * normalizer would make this comparison a tautology, since a clip introduced
 * inside `oneLine` would then be applied to both sides and vanish.
 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Every protected record of a projected core, independent of presentation order. */
const capturedRecords = (core: ProtectedCorpus): PayloadRecord[] => {
  const rows: PayloadRecord[] = [];
  const push = (
    kind: string,
    list: readonly { citationId: string; text: string }[],
    parent: string | null = null
  ): void => {
    for (const r of list)
      rows.push({ kind, citationId: r.citationId, parent, text: collapse(r.text) });
  };
  push('plan-step', core.planSteps);
  push('non-goal', core.nonGoals);
  for (const d of core.planDecisions) {
    rows.push({
      kind: 'plan-decision',
      citationId: d.citationId,
      parent: null,
      text: collapse(d.text),
    });
    push('plan-alternative', d.alternatives, d.citationId);
  }
  for (const criterion of core.acceptanceCriteria)
    rows.push({
      kind: 'acceptance-criterion',
      citationId: criterion.citationId,
      parent: criterion.parent ?? null,
      text: collapse(criterion.text),
    });
  const criterionIds = new Set(core.acceptanceCriteria.map((criterion) => criterion.citationId));
  for (const e of core.criterionEvidence)
    rows.push({
      kind: 'criterion-evidence',
      citationId: e.citationId,
      parent: e.parent ?? null,
      text:
        e.parent !== undefined && criterionIds.has(e.parent) && e.text.includes(' — ')
          ? collapse(e.text.slice(e.text.indexOf(' — ') + 3))
          : collapse(e.text),
    });
  for (const cp of core.checkpoints) {
    const ref = `${cp.artifact}:cp${cp.cp}`;
    rows.push({ kind: 'checkpoint', citationId: null, parent: null, text: ref });
    if (cp.label !== null)
      rows.push({
        kind: 'checkpoint-label',
        citationId: null,
        parent: ref,
        text: collapse(cp.label),
      });
    if (cp.summary !== null)
      rows.push({
        kind: 'checkpoint-summary',
        citationId: null,
        parent: ref,
        text: collapse(cp.summary),
      });
    for (const d of cp.decisions) {
      rows.push({
        kind: 'checkpoint-decision',
        citationId: d.citationId,
        parent: ref,
        text: collapse(d.text),
      });
      push('checkpoint-alternative', d.alternatives, d.citationId);
    }
    push('uncertainty', cp.uncertainty, ref);
  }
  for (const verification of core.verification) {
    const parsed = /^cite:([^:]+):cp(\d+):/.exec(verification.citationId);
    rows.push({
      kind: 'verification',
      citationId: verification.citationId,
      parent: parsed === null ? null : `${parsed[1]}:cp${parsed[2]}`,
      text: collapse(verification.text),
    });
  }
  // An evaluator row is printed as its structured run metadata rather than the
  // citation prose, so the metadata composition is what has to round-trip.
  for (const run of core.evaluatorRuns) {
    const e = run.evaluator;
    rows.push({
      kind: 'evaluator-run',
      citationId: run.citationId,
      parent: null,
      text: collapse(
        `${e.evaluator_ref} — run ${e.run_status.toUpperCase()} · verdict ` +
          `${(e.verdict ?? 'none').toUpperCase()} · severity ${e.severity.toUpperCase()} · ` +
          `disposition ${e.disposition ?? 'unrecorded'} — ${e.summary}`
      ),
    });
  }
  return rows;
};

/**
 * Parse the rendered account lane BACK into records — structure, not substring
 * search. `parent` is read off the render's own nesting (the decision a line is
 * indented beneath, the `evidences [...]` suffix, the `###` heading above it),
 * so a record served under the wrong parent parses to a different tuple and
 * fails, and a record the renderer never emits is simply missing.
 */
const parseAccountPayload = (md: string, projection: AccountProjection): PayloadRecord[] => {
  const rows: PayloadRecord[] = [];
  const lines = md.split('\n');
  const aliases = accountPromptAliasMaps(projection);
  const citation = (alias: string): string => aliases.citations.get(alias) ?? alias;
  const checkpoint = (alias: string): string => aliases.checkpoints.get(alias) ?? alias;
  let checkpointRef: string | null = null;
  let decisionId: string | null = null;
  let stepId: string | null = null;
  let criterionId: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const section = /^## (.+)$/.exec(line);
    if (section !== null) {
      checkpointRef = null;
      decisionId = null;
      stepId = null;
      criterionId = null;
      continue;
    }
    if (/^### /.test(line)) {
      checkpointRef = null;
      decisionId = null;
      stepId = null;
      criterionId = null;
      continue;
    }
    const cpHead = /^#### (k\d+) · (\S+)(?: — (.*))?$/.exec(line);
    if (cpHead !== null) {
      checkpointRef = cpHead[2]!;
      expect(checkpoint(cpHead[1]!)).toBe(checkpointRef);
      decisionId = null;
      stepId = null;
      criterionId = null;
      rows.push({ kind: 'checkpoint', citationId: null, parent: null, text: checkpointRef });
      if (cpHead[3] !== undefined)
        rows.push({
          kind: 'checkpoint-label',
          citationId: null,
          parent: checkpointRef,
          text: cpHead[3],
        });
      // The summary is the one unprefixed line, emitted directly under the heading.
      const next = lines[i + 1] ?? '';
      if (next !== '' && !next.startsWith('-') && !next.startsWith('#')) {
        rows.push({
          kind: 'checkpoint-summary',
          citationId: null,
          parent: checkpointRef,
          text: next,
        });
        i += 1;
      }
      continue;
    }
    const step = /^- step \[([^\]]+)\] (.*)$/.exec(line);
    if (step !== null) {
      stepId = citation(step[1]!);
      criterionId = null;
      rows.push({
        kind: 'plan-step',
        citationId: stepId,
        parent: null,
        text: step[2]!,
      });
      continue;
    }
    if (line === '- unassigned criteria (unresolved plan-step link):') {
      stepId = null;
      criterionId = null;
      continue;
    }
    const criterion = /^ {2}- criterion \[([^\]]+)\] (.*)$/.exec(line);
    if (criterion !== null) {
      criterionId = citation(criterion[1]!);
      rows.push({
        kind: 'acceptance-criterion',
        citationId: criterionId,
        parent: stepId,
        text: criterion[2]!,
      });
      continue;
    }
    const evidence = /^ {4}- evidence \[([^\]]+)\](?: @ \S+)? (.*)$/.exec(line);
    if (evidence !== null) {
      rows.push({
        kind: 'criterion-evidence',
        citationId: citation(evidence[1]!),
        parent: criterionId,
        text: evidence[2]!,
      });
      continue;
    }
    const nonGoal = /^ {2}- non-goal \[([^\]]+)\] (.*)$/.exec(line);
    if (nonGoal !== null) {
      rows.push({
        kind: 'non-goal',
        citationId: citation(nonGoal[1]!),
        parent: null,
        text: nonGoal[2]!,
      });
      continue;
    }
    const decision = /^( {0}| {2})- decision \[([^\]]+)\] (.*)$/.exec(line);
    if (decision !== null) {
      decisionId = citation(decision[2]!);
      rows.push({
        kind: decision[1] === '  ' ? 'plan-decision' : 'checkpoint-decision',
        citationId: decisionId,
        parent: decision[1] === '  ' ? null : checkpointRef,
        text: decision[3]!,
      });
      continue;
    }
    const alternative = /^( {2}| {4})- alternative \[([^\]]+)\] (.*)$/.exec(line);
    if (alternative !== null) {
      rows.push({
        kind: alternative[1] === '    ' ? 'plan-alternative' : 'checkpoint-alternative',
        citationId: citation(alternative[2]!),
        // Nesting, not provenance: the decision this line is actually printed
        // under is the relationship the model will read off the payload.
        parent: decisionId,
        text: alternative[3]!,
      });
      continue;
    }
    const uncertainty = /^- uncertainty \[([^\]]+)\] (.*)$/.exec(line);
    if (uncertainty !== null) {
      rows.push({
        kind: 'uncertainty',
        citationId: citation(uncertainty[1]!),
        parent: checkpointRef,
        text: uncertainty[2]!,
      });
      continue;
    }
    const orphanEvidence =
      /^- evidence \[([^\]]+)\](?: @ \S+)? (.*) — no acceptance criterion in scope$/.exec(line);
    if (orphanEvidence !== null) {
      rows.push({
        kind: 'criterion-evidence',
        citationId: citation(orphanEvidence[1]!),
        parent: null,
        text: orphanEvidence[2]!,
      });
      continue;
    }
    const verification =
      /^- verification \[([^\]]+)\](?: @ \S+)? (.*?)(?: — no checkpoint in scope)?$/.exec(line);
    if (verification !== null) {
      rows.push({
        kind: 'verification',
        citationId: citation(verification[1]!),
        parent: checkpointRef,
        text: verification[2]!,
      });
      continue;
    }
    const evaluator = /^- evaluator \[([^\]]+)\] (.*)$/.exec(line);
    if (evaluator !== null)
      rows.push({
        kind: 'evaluator-run',
        citationId: citation(evaluator[1]!),
        parent: null,
        text: evaluator[2]!,
      });
  }
  return rows;
};

const orderedPayloadRecords = (records: readonly PayloadRecord[]): PayloadRecord[] =>
  [...records].sort((a, b) => {
    const left = JSON.stringify([a.kind, a.citationId, a.parent, a.text]);
    const right = JSON.stringify([b.kind, b.citationId, b.parent, b.text]);
    return left < right ? -1 : left > right ? 1 : 0;
  });

describe('account payload: the rendered lane preserves every protected record', () => {
  const diff = [
    section('src/impl-a.ts', ['const IMPL_MARKER_A = 1;']),
    section('src/impl-b.ts', ['const IMPL_MARKER_B = 2;']),
    '',
  ].join('\n');

  const rendered = () => {
    const built = buildDossier(
      makeInput(diff, { floor: capturedFloor(), budget: ROUTINE_BUDGET_V1 })
    );
    assertCapturedShape(built.dossier.account_core);
    return {
      projection: built.accountProjection,
      md: renderAccountRoutineMd(built.accountProjection),
    };
  };

  /**
   * The projection deep-equal proves dossier -> projection, and the model never
   * reads the projection. Content can survive that assertion and still be
   * mangled on the way to the payload — the render is where whitespace
   * collapses, where nesting is expressed as indentation, and where a record
   * can be printed under the wrong parent or not printed at all.
   */
  it('every protected record round-trips out of the rendered markdown with its kind, id, parent, and text', () => {
    const { projection, md } = rendered();
    const expected = capturedRecords(projection.accountCore);
    expect(expected.length).toBe(37);
    const ids = expected.map((r) => r.citationId).filter((id): id is string => id !== null);
    expect(new Set(ids).size).toBe(ids.length);
    expect(orderedPayloadRecords(parseAccountPayload(md, projection))).toEqual(
      orderedPayloadRecords(expected)
    );
  });

  it('bracketed-iff-citable holds on the rendered payload in both directions', () => {
    const { projection, md } = rendered();
    const citable = accountCitableIds(projection);
    const aliases = accountPromptAliasMaps(projection);
    // Forward: nothing the payload brackets is an id the model may not cite.
    const bracketed = [...md.matchAll(/\[(c\d+)\]/g)].map(
      (m) => aliases.citations.get(m[1]!) ?? m[1]!
    );
    expect(bracketed.length).toBeGreaterThan(0);
    for (const id of bracketed)
      expect(citable.has(id), `payload brackets non-citable ${id}`).toBe(true);
    // Reverse: every protected record the payload shows is citable AND is shown
    // bracketed — a record displayed without a legal id is evidence the model
    // can read but cannot ground a finding on.
    const shown = parseAccountPayload(md, projection)
      .map((r) => r.citationId)
      .filter((id): id is string => id !== null);
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) {
      expect(citable.has(id), `${id} is shown but not citable`).toBe(true);
      expect(bracketed, `${id} parsed as a record but is not bracketed`).toContain(id);
    }
    // Every bracketed id is ACCOUNTED FOR: a protected record's own id, the
    // criterion an evidence row evidences, or a ledger row's cited text. An
    // id-shaped string outside that set is one the parse cannot explain.
    const accounted = new Set([
      ...shown,
      ...projection.accountCore.criterionEvidence
        .map((e) => e.parent)
        .filter((p): p is string => p !== undefined),
      ...projection.accountCore.ledger.flatMap((row) => Object.keys(row.citedFallback)),
    ]);
    for (const id of bracketed)
      expect(accounted.has(id), `payload brackets ${id}, which no parsed record accounts for`).toBe(
        true
      );
    // ...and every citable protected id reaches the payload: the corpus is not
    // allowed to hold a record the render never emits.
    for (const r of capturedRecords(projection.accountCore))
      if (r.citationId !== null)
        expect(shown, `${r.citationId} is citable but not displayed`).toContain(r.citationId);
  });

  it('does not render heuristic implicated or risk-selected code into the account payload', () => {
    const anchored = ['src/impl-a.ts', 'src/impl-b.ts'];
    const diffWithMarkers = [
      section(anchored[0]!, ['const IMPLICATED_MARKER = guard(1);']),
      section(anchored[1]!, ['const RISK_MARKER = guard(2);']),
      '',
    ].join('\n');
    const built = buildDossier(
      makeInput(diffWithMarkers, {
        floor: capturedFloor(),
        ledgerEntries: [
          {
            id: 'ldg:ATTRIBUTION_MISMATCH_CANDIDATE:accountprompt0001',
            kind: CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
            status: 'CANDIDATE',
            message: `claim anchored at ${anchored[0]}`,
            citations: [],
            anchors: [anchored[0]!],
            evidence: {},
          },
        ],
      })
    );
    expect(built.accountProjection.implicatedHunks.length).toBeGreaterThan(0);
    expect(built.accountProjection.riskRemainder.length).toBeGreaterThan(0);

    const inventoryBefore = structuredClone(built.accountProjection.fileInventory);
    const inventoryModeBefore = built.accountProjection.inventoryMode;
    const md = renderAccountRoutineMd(built.accountProjection);
    expect(md).not.toContain('## Implicated code (raw hunks)');
    expect(md).not.toContain('## Risk remainder (raw hunks)');
    expect(md).not.toContain('IMPLICATED_MARKER');
    expect(md).not.toContain('RISK_MARKER');
    expect(md).not.toContain('## Changed-file inventory');
    expect(md).not.toContain('inventory mode');
    expect(built.accountProjection.fileInventory).toEqual(inventoryBefore);
    expect(built.accountProjection.inventoryMode).toBe(inventoryModeBefore);
    expect(md).toContain('## Checkpoints');
  });

  it('groups ledger rows without weakening exact anchors, aliases, or omission disclosure', () => {
    const built = buildDossier(
      makeInput(section('src/impl-a.ts', ['const MARKER = 1;']), { floor: capturedFloor() })
    );
    const projection = structuredClone(built.accountProjection);
    const cp1 = projection.accountCore.checkpoints.find((checkpoint) => checkpoint.cp === 1)!;
    projection.accountCore.checkpoints.push({
      ...structuredClone(cp1),
      cp: 10,
      label: 'tenth checkpoint',
      summary: null,
      decisions: [],
      uncertainty: [],
    });
    const fullArtifact = projection.artifactAliases[cp1.artifact]!;
    const fallbackId = projection.accountCore.planSteps[0]!.citationId;
    projection.accountCore.ledger = [
      {
        id: 'ldg:ATTRIBUTION_MISMATCH_CANDIDATE:one',
        kind: CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
        status: 'CANDIDATE',
        message: `Checkpoint ${fullArtifact}:cp1 claims files the floor attributes to none of its changes: src/a.ts. ${ATTRIBUTION_MISMATCH_SHARED_EXPLANATION}`,
        citations: [],
        anchors: [`${fullArtifact}:cp1`, 'src/a.ts', 'src/a.tsx'],
        anchorsOmitted: 2,
        citedFallback: { [fallbackId]: 'fallback proof text' },
      },
      {
        id: 'ldg:ATTRIBUTION_MISMATCH_CANDIDATE:ten',
        kind: CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
        status: 'CANDIDATE',
        message: `Checkpoint ${fullArtifact}:cp10 claims files the floor attributes to none of its changes: src/ten.ts. ${ATTRIBUTION_MISMATCH_SHARED_EXPLANATION}`,
        citations: [],
        anchors: [`${fullArtifact}:cp10`, 'src/ten.ts'],
        citedFallback: {},
      },
      {
        id: 'ldg:UNTRACKED_EVIDENCE:near-match',
        kind: CLAIM_LEDGER_ENTRY_KIND.UNTRACKED_EVIDENCE,
        status: 'CANDIDATE',
        message: 'The capture names src/a.tsx only.',
        citations: [],
        anchors: ['src/a.ts'],
        citedFallback: {},
      },
    ];

    const aliases = buildAccountPromptAliases(projection);
    const checkpointAliases = new Map(
      aliases.checkpoints.map((entry) => [entry.canonical, entry.alias])
    );
    const citationAliases = new Map(
      aliases.citations.map((entry) => [entry.canonical, entry.alias])
    );
    const md = renderAccountRoutineMd(projection);

    expect(renderAccountRoutineMd(projection)).toBe(md);
    expect(md).toContain('### ATTRIBUTION_MISMATCH_CANDIDATE · CANDIDATE (2)');
    expect(md).toContain('### UNTRACKED_EVIDENCE · CANDIDATE (1)');
    expect(md.split(ATTRIBUTION_MISMATCH_SHARED_EXPLANATION)).toHaveLength(2);
    expect(md).toContain(`Checkpoint ${checkpointAliases.get(`${cp1.artifact}:cp1`)}`);
    expect(md).toContain(`Checkpoint ${checkpointAliases.get(`${cp1.artifact}:cp10`)}`);
    expect(md).not.toContain(fullArtifact);
    for (const row of projection.accountCore.ledger)
      expect(md).toContain(`[${citationAliases.get(row.id)}]`);
    expect(md).toContain('anchors: src/a.tsx · 2 additional anchors projection-omitted');
    expect(md).toContain('anchors: src/a.ts');
    expect(md).toContain(`cited [${citationAliases.get(fallbackId)}] "fallback proof text"`);
    expect(md).not.toContain('## Changed-file inventory');
    expect(projection.fileInventory).toEqual(built.accountProjection.fileInventory);
    expect(projection.inventoryMode).toBe(built.accountProjection.inventoryMode);
  });
});

describe('forensic verbatim: importance-omission is banned', () => {
  it('a giant committed fixture is rendered verbatim ALONGSIDE implementation code — never dropped to make room', () => {
    const fixtureLines = Array.from({ length: 300 }, (_, i) => `FIXTURE_LINE_${i} padding text`);
    const diff = [
      section('packages/x/fixtures/giant/prompt.txt', fixtureLines),
      section('notes/notes.md', ['notes line']),
      section('src/impl-a.ts', ['const IMPL_MARKER_A = guard(1);']),
      section('src/impl-b.ts', ['const IMPL_MARKER_B = guard(2);']),
      section('src/impl-c.ts', ['const IMPL_MARKER_C = guard(3);']),
      '',
    ].join('\n');
    const { forensicInput } = buildDossier(makeInput(diff));
    // Every file is present verbatim — the packer's fixture-starvation and the
    // dropped-pivotal-file regressions are both structurally impossible now.
    expect(forensicInput.diff).toContain('IMPL_MARKER_A');
    expect(forensicInput.diff).toContain('IMPL_MARKER_B');
    expect(forensicInput.diff).toContain('IMPL_MARKER_C');
    expect(forensicInput.diff).toContain('FIXTURE_LINE_0');
    expect(forensicInput.diff).toContain('notes line');
    expect(forensicInput.metrics.eligibleFiles).toBe(5);
  });

  it('over an absolute transport ceiling the run REFUSES (no partial payload)', () => {
    const giantLines = Array.from({ length: 400 }, (_, i) => `GIANT_SRC_LINE_${i} padding text`);
    const diff = [
      section('src/giant.ts', giantLines),
      section('src/small-a.ts', ['const SMALL_A = 1;']),
      '',
    ].join('\n');
    expect(() => buildDossier(makeInput(diff, { forensicTransportCeilingBytes: 800 }))).toThrow(
      ForensicTransportCeilingError
    );
  });
});
