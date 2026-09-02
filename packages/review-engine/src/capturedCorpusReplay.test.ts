// REPLAY: capture completeness, measured as a controlled experiment.
//
// The fixture pair is ONE captured corpus in two states. The starved state is
// what a counts-only degradation ladder serves: decisions clipped to 41
// characters, most dropped, every rejected alternative gone, acceptance criteria
// and evaluator-run summaries emptied. The core state is the same corpus
// complete and un-projected, so completeness is measured over identical input
// bytes rather than against a branch that keeps moving.
//
// SCOPE, stated so the measurement cannot overclaim. The pair can speak only to
// what the core carries:
//   · fully covered   — acceptance criteria and evaluator-run summaries (the
//                       starved state empties both outright).
//   · partially covered — alternatives: this proves their TEXT is not dropped,
//                       NOT that they attach to the right decision. The core
//                       carries no `parent` back-reference, so parent
//                       correctness is unprovable here by construction and is
//                       covered by the assembly/dossier tests instead.
//   · NOT covered     — plan decisions, criterion evidence, and checkpoint
//                       verification: the core carries none of them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  buildAccountProjection,
  type DossierAccountCore,
  type DossierEvaluatorRun,
  type DossierFileEntry,
  ROUTINE_BUDGET_V1,
} from './dossier.js';

const FIX = path.join(__dirname, '..', 'fixtures', 'story-acceptance');
const loadGz = <T>(name: string): T =>
  JSON.parse(gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8')) as T;

interface FrozenInput {
  branch: string;
  floor_input_hash: string;
  account_core: DossierAccountCore;
  file_index: DossierFileEntry[];
}

/**
 * The frozen core's shape, typed instead of cast so fixture drift fails
 * typecheck. It legitimately predates exactly five things: the
 * `verification` rename (its `verification` key holds evaluator runs), the
 * `planDecisions` / `criterionEvidence` fields (hydrated empty below),
 * acceptance criteria's `parent` back-reference, and evaluator rows'
 * structured `evaluator` metadata — the last two hydrated below from
 * hand-authored values. Every other field must match the current shape.
 */
type FrozenAccountCore = Omit<
  DossierAccountCore,
  'planDecisions' | 'criterionEvidence' | 'evaluatorRuns' | 'verification' | 'acceptanceCriteria'
> & {
  verification: { citationId: string; text: string }[];
  acceptanceCriteria: { citationId: string; text: string }[];
};

interface FrozenRaw extends Omit<FrozenInput, 'account_core'> {
  account_core: FrozenAccountCore;
}
interface FrozenStarved {
  degradation?: string;
  accountCore: {
    checkpoints: { decisions: { text: string }[]; uncertainty: { text: string }[] }[];
    acceptanceCriteria: unknown[];
    verification?: unknown[];
    evaluatorRuns?: unknown[];
  };
}

const raw = loadGz<FrozenRaw>('frozen-account-core.json.gz');
const starved = loadGz<FrozenStarved>('frozen-starved-projection.json.gz');

// Translating the frozen core into the current shape, faithfully:
//
//  · The frozen `verification` field is the MISNAMED one — it holds evaluator-run
//    summaries, never checkpoint verification. That conflation reads evaluator
//    verdicts as checkpoint verification, so the field maps by MEANING, not by
//    name.
//  · `planDecisions`, `criterionEvidence`, and the real `verification` hydrate
//    EMPTY, which is the faithful representation of this corpus: the core carries
//    no such records — precisely why the replay cannot speak to them.
//  · Acceptance criteria hydrate `parent` from the hand-authored mapping below,
//    NOT from the corpus: the frozen core carries no back-reference at all,
//    which is why parent correctness is out of scope (see the header). The
//    fixture bytes stay frozen so the measurement input never drifts.
//  · Evaluator rows hydrate `evaluator` from the hand-authored placeholder
//    below for the same reason — the frozen rows carry no run metadata. The
//    replay measures their TEXT and COUNT, never the metadata, so the
//    placeholder is shape, not evidence.
//
// Production never takes this path (the dossier is rebuilt from the floor on
// every routine-start), so this is a replay concern, not a compatibility shim.
const UNRECORDED_RUN_METADATA: DossierEvaluatorRun['evaluator'] = {
  evaluator_ref: 'unrecorded/frozen-corpus',
  severity: 'info',
  run_status: 'completed',
  verdict: null,
  disposition: null,
  summary: '',
};
const CRITERION_PARENT_STEP_INDEX = [0, 1, 0, 2, 3, 4] as const;
const parentStepCitationId = (criterionIndex: number): string => {
  const stepIndex = CRITERION_PARENT_STEP_INDEX[criterionIndex];
  const step = stepIndex === undefined ? undefined : raw.account_core.planSteps[stepIndex];
  if (step === undefined)
    throw new Error(
      `no hand-authored parent step for acceptance criterion ${criterionIndex}: the mapping ` +
        `covers ${CRITERION_PARENT_STEP_INDEX.length} criteria over ` +
        `${raw.account_core.planSteps.length} plan steps`
    );
  return step.citationId;
};
const frozen: FrozenInput = {
  ...raw,
  account_core: {
    ...raw.account_core,
    acceptanceCriteria: raw.account_core.acceptanceCriteria.map((criterion, index) => ({
      ...criterion,
      parent: parentStepCitationId(index),
    })),
    evaluatorRuns: raw.account_core.verification.map((run) => ({
      ...run,
      evaluator: UNRECORDED_RUN_METADATA,
    })),
    verification: [],
    planDecisions: [],
    criterionEvidence: [],
  },
};

/** Rebuild the projection over the frozen core. Hunks are irrelevant to the
 *  captured corpus, so the code-excerpt inputs are deliberately empty. */
const replay = () =>
  buildAccountProjection(
    frozen.branch,
    frozen.floor_input_hash,
    frozen.account_core,
    [],
    frozen.file_index,
    new Set<string>(),
    ROUTINE_BUDGET_V1
  );

const countDecisions = (cps: { decisions: unknown[] }[]): number =>
  cps.reduce((n, cp) => n + cp.decisions.length, 0);
const countAlternatives = (cps: { decisions: { alternatives?: unknown[] }[] }[]): number =>
  cps.reduce((n, cp) => n + cp.decisions.reduce((m, d) => m + (d.alternatives?.length ?? 0), 0), 0);

describe('capture-completeness replay — the starved corpus, re-projected', () => {
  it('the frozen baseline carries the starvation the replay measures against', () => {
    // Guards the experiment itself: if the baseline were not starved the replay
    // would prove nothing, so the "before" is asserted, not assumed.
    expect(starved.degradation).toBe('COUNTS_ONLY');
    expect(starved.accountCore.acceptanceCriteria).toHaveLength(0);
    const texts = starved.accountCore.checkpoints.flatMap((cp) => [
      ...cp.decisions.map((d) => d.text),
      ...cp.uncertainty.map((u) => u.text),
    ]);
    expect(texts.length).toBeGreaterThan(0);
    // Every surviving record was clipped to exactly 41 characters.
    expect([...new Set(texts.map((t) => t.length))]).toEqual([41]);
  });

  it('serves the captured corpus complete over the identical input', () => {
    const { projection } = replay();
    const core = projection.accountCore;

    // Budget reduction reaches the ledger and nothing else; the launch shape
    // carries no degradation marker at all.
    expect('degradation' in projection).toBe(false);

    // Checkpoints: every one, with every decision and uncertainty, verbatim.
    expect(core.checkpoints).toHaveLength(frozen.account_core.checkpoints.length);
    expect(countDecisions(core.checkpoints)).toBe(countDecisions(frozen.account_core.checkpoints));
    for (const [i, cp] of core.checkpoints.entries()) {
      const src = frozen.account_core.checkpoints[i]!;
      expect(cp.summary).toBe(src.summary);
      expect(cp.decisions.map((d) => d.text)).toEqual(src.decisions.map((d) => d.text));
      expect(cp.uncertainty.map((u) => u.text)).toEqual(src.uncertainty.map((u) => u.text));
    }

    // Categories a counts-only degradation empties outright.
    expect(core.acceptanceCriteria).toHaveLength(frozen.account_core.acceptanceCriteria.length);
    expect(core.evaluatorRuns).toHaveLength(frozen.account_core.evaluatorRuns.length);
  });

  it('retains alternative text that was dropped wholesale (text only — parent is out of scope here)', () => {
    const { projection } = replay();
    const before = countAlternatives(starved.accountCore.checkpoints as never);
    const after = countAlternatives(projection.accountCore.checkpoints);
    expect(before).toBe(0);
    expect(after).toBe(countAlternatives(frozen.account_core.checkpoints));
    expect(after).toBeGreaterThan(0);
  });

  it('records the measured deltas so the result is legible without re-running', () => {
    const { projection } = replay();
    const core = projection.accountCore;
    const delta = {
      decisions: {
        before: countDecisions(starved.accountCore.checkpoints as never),
        after: countDecisions(core.checkpoints),
        captured: countDecisions(frozen.account_core.checkpoints),
      },
      alternatives: {
        before: 0,
        after: countAlternatives(core.checkpoints),
      },
      acceptanceCriteria: {
        before: starved.accountCore.acceptanceCriteria.length,
        after: core.acceptanceCriteria.length,
      },
      longestDecisionChars: {
        before: 41,
        after: Math.max(
          ...core.checkpoints.flatMap((cp) => cp.decisions.map((d) => d.text.length))
        ),
      },
    };
    // Served counts equal captured counts — nothing is selected, nothing clipped.
    expect(delta.decisions.after).toBe(delta.decisions.captured);
    expect(delta.decisions.after).toBeGreaterThan(delta.decisions.before);
    expect(delta.acceptanceCriteria.after).toBeGreaterThan(delta.acceptanceCriteria.before);
    expect(delta.longestDecisionChars.after).toBeGreaterThan(41);
  });
});
