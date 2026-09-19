// PlanInputSchema also parses retained history, so the authored-step rubric
// requirement must remain at the mutation boundary rather than in that schema.

interface CriterionText {
  readonly text: string;
}

interface StepRubric {
  readonly label: string;
  readonly acceptance_criteria: ReadonlyArray<CriterionText>;
}

/**
 * Quoted in every missing-rubric error. An agent running a generated skill
 * from before this contract still has instructions calling criteria optional,
 * so the error has to teach the nested shape on its own rather than assume
 * the installed instructions are current.
 */
export const ACCEPTANCE_CRITERIA_YAML_SHAPE = [
  'plan_steps:',
  '  - text: |-',
  '      <what this step does>',
  '    label: |-',
  '      <short headline>',
  '    acceptance_criteria:',
  '      - text: |-',
  '          <observable condition that proves this step is done>',
].join('\n');

/**
 * Stated conditionally on purpose. Malformed input does not prove the installed
 * instructions are stale, so this offers the remedy without diagnosing it — the
 * existing drift detector is what establishes staleness.
 */
export const STALE_SKILL_REMEDY =
  'If your installed capture instructions still describe acceptance_criteria as ' +
  'optional, they predate this contract — run `orcaops update` to regenerate them.';

function isRecordedCriterion(criterion: CriterionText): boolean {
  return criterion.text.trim().length > 0;
}

export function hasRecordedCriteria(step: StepRubric): boolean {
  return step.acceptance_criteria.some(isRecordedCriterion);
}

function quoteSteps(steps: ReadonlyArray<{ readonly position: number; readonly label: string }>) {
  return steps.map((s) => `#${s.position} "${s.label}"`).join(', ');
}

function agree(count: number): readonly [string, string] {
  return count === 1 ? (['step', 'declares'] as const) : (['steps', 'declare'] as const);
}

export function missingCriteriaOnCaptureMessage(
  steps: ReadonlyArray<{ readonly position: number; readonly label: string }>
): string {
  const [subject, verb] = agree(steps.length);
  return (
    `Cannot capture plan: ${subject} ${quoteSteps(steps)} ${verb} no acceptance criteria. ` +
    `Every newly authored step needs at least one criterion describing an observable ` +
    `condition that proves the step is done — a close keys its evidence to them. ` +
    `Supply them as a nested list under each step:\n\n${ACCEPTANCE_CRITERIA_YAML_SHAPE}` +
    `\n\n${STALE_SKILL_REMEDY}`
  );
}

export function missingCriteriaOnNewStepMessage(
  steps: ReadonlyArray<{ readonly position: number; readonly label: string }>
): string {
  const [subject, verb] = agree(steps.length);
  return (
    `Cannot revise plan: newly added ${subject} ${quoteSteps(steps)} ${verb} no acceptance ` +
    `criteria. A step added by a revision carries the same obligation as one authored at ` +
    `capture. Supply them as a nested list under each step:\n\n${ACCEPTANCE_CRITERIA_YAML_SHAPE}` +
    `\n\n${STALE_SKILL_REMEDY}`
  );
}

/**
 * Revision, existing covered step: rejected even when acknowledged, because a
 * retained covered step must not become rubric-free. Replacement is the legal
 * move on an unprotected step; a protected one goes through the existing
 * close-or-abandon / new-follow-up-step recovery paths instead.
 */
export function rubricRemovedMessage(
  steps: ReadonlyArray<{ readonly position: number; readonly label: string }>
): string {
  const [subject] = agree(steps.length);
  return (
    `Cannot revise plan: ${subject} ${quoteSteps(steps)} would be left with no acceptance ` +
    `criteria. Removing the last criterion from a covered step is rejected, and ` +
    `\`acknowledge_criteria_changes\` does not permit it. On a step with no open checkpoint ` +
    `and no completed claim, replace the old criteria with valid new ones in this same ` +
    `full-supersede revision instead. On a step an open checkpoint declares, close it ` +
    `without naming the step in completed_step_ids (or abandon it) and revise before ` +
    `reopening; for completed work, leave the historical rubric intact and add a new step ` +
    `for the new obligation.\n\n${STALE_SKILL_REMEDY}`
  );
}

export function rewrittenHistoricalStepMessage(
  steps: ReadonlyArray<{ readonly position: number; readonly label: string }>
): string {
  const subject = steps.length === 1 ? 'step' : 'steps';
  const verb = steps.length === 1 ? 'has' : 'have';
  const declares = steps.length === 1 ? 'declares' : 'declare';
  return (
    `Cannot revise plan: historical rubric-free ${subject} ${quoteSteps(steps)} ${verb} ` +
    `rewritten text but still ${declares} no acceptance criteria. Restore the retained step text ` +
    `byte-for-byte (label-only edits remain allowed), or supply at least one criterion for ` +
    `the rewritten obligation:\n\n${ACCEPTANCE_CRITERIA_YAML_SHAPE}` +
    `\n\n${STALE_SKILL_REMEDY}`
  );
}

interface StepCoverageInput extends StepRubric {
  readonly step_id: string;
}

/**
 * Rubric presence for one plan revision. `revision_n` travels with the counts
 * because a revision replay returns a historical plan: reporting a count
 * without the revision it measures would let one revision's steps be read
 * alongside another's totals.
 */
export interface RubricCoverage {
  readonly revision_n: number;
  readonly total: number;
  readonly covered: number;
  readonly missing: number;
  readonly missing_step_ids: string[];
}

/**
 * Counts rubric presence — never evidence, delivery, or source-plan fidelity.
 * `stepIds` narrows to a claimed subset (checkpoint close); omit it for the
 * whole plan. Ids that are not in the revision are ignored, so a close whose
 * claims predate a later revision still measures its own opening revision.
 */
export function rubricCoverage(
  plan: { readonly revision_n: number; readonly plan_steps: ReadonlyArray<StepCoverageInput> },
  stepIds?: readonly string[]
): RubricCoverage {
  const selected =
    stepIds === undefined
      ? plan.plan_steps
      : plan.plan_steps.filter((step) => stepIds.includes(step.step_id));
  const missing = selected.filter((step) => !hasRecordedCriteria(step));
  return {
    revision_n: plan.revision_n,
    total: selected.length,
    covered: selected.length - missing.length,
    missing: missing.length,
    missing_step_ids: missing.map((step) => step.step_id),
  };
}

export const NO_CRITERIA_RECORDED =
  'No acceptance criteria were recorded; criterion-level completion is unverified.';

export function rubricCoverageSentence(coverage: RubricCoverage): string {
  if (coverage.total === 0) return 'Recorded acceptance criteria: no steps in scope.';
  const head = `Recorded acceptance criteria: ${coverage.covered} of ${coverage.total} steps (revision ${coverage.revision_n})`;
  if (coverage.missing === 0) return `${head}.`;
  const subject = coverage.missing === 1 ? 'step has' : 'steps have';
  return `${head}; ${coverage.missing} ${subject} no recorded criteria.`;
}
