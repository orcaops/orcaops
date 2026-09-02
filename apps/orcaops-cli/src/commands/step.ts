import type { ArtifactOriginKind, StepClaims } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';

/**
 * `orcaops step brief <step_id> [--artifact <id>] [--json]` — the
 * parallel-dispatch task-brief contract: everything a subagent needs to work ONE
 * plan step, without handing it the whole artifact:
 *
 *   - the step (text / label / acceptance_criteria), resolved against the
 *     LATEST revision first; a step absent there renders from the last
 *     revision that contained it, flagged `dropped_in_latest_revision` with
 *     `last_present_revision_n` — informational-only, since checkpoint
 *     opens validate `declared_step_ids` against the ACTIVE revision and a
 *     dropped step can never be claimed;
 *   - its claim state (claimed by a closed cp / declared by an open cp /
 *     unclaimed) via `getStepClaims`;
 *   - related closed-checkpoint context: cps that claimed the step, with
 *     `done_criteria` filtered to the step's criterion_ids;
 *   - guardrails: the plan's `non_goals` + `touched_scope`;
 *   - sibling steps' claim states (dispatch coordination at a glance).
 */

interface StepView {
  step_id: string;
  idx: number;
  text: string;
  label: string;
  acceptance_criteria: Array<{ criterion_id: string; text: string }>;
}

export type StepClaimState =
  | { state: 'claimed'; checkpoint_n: number }
  | { state: 'declared_by_open_checkpoint'; checkpoint_n: number }
  | { state: 'unclaimed' }
  | { state: 'not_claimable_dropped' };

export interface StepBriefInput {
  artifactId: string;
  stepId: string;
  /** `git-import` marks synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  /** Latest plan revision (steps carry PARSED acceptance criteria). */
  latest: {
    revision_n: number;
    steps: StepView[];
    non_goals: unknown[];
    touched_scope: string[];
  };
  /**
   * When the step is absent from the latest revision: the last revision
   * that contained it (already resolved by the caller), else null.
   */
  lastPresent: { revision_n: number; step: StepView } | null;
  claims: StepClaims;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    summary: string;
    completed_step_ids: readonly string[];
    done_criteria: ReadonlyArray<{ criterion_id: string; evidence: string }>;
  }>;
}

export interface StepBrief {
  artifact_id: string;
  /** `git-import` when the brief serves synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  step: {
    step_id: string;
    text: string;
    label: string;
    acceptance_criteria: Array<{ criterion_id: string; text: string }>;
    dropped_in_latest_revision: boolean;
    last_present_revision_n: number;
  };
  claim_state: StepClaimState;
  related_closed_checkpoints: Array<{
    n: number;
    closed_at: string;
    summary: string;
    done_criteria: Array<{ criterion_id: string; evidence: string }>;
  }>;
  guardrails: { non_goals: unknown[]; touched_scope: string[] };
  siblings: Array<{ step_id: string; label: string; claim_state: StepClaimState }>;
  /** Present only for dropped steps: the dispatchability warning. */
  note?: string;
}

function claimStateFor(stepId: string, claims: StepClaims, dropped: boolean): StepClaimState {
  if (dropped) return { state: 'not_claimable_dropped' };
  if (claims.closedClaimed.includes(stepId)) {
    // Attribution of WHICH cp claimed it happens in buildStepBrief where the
    // closed cps are in hand; this branch is refined there.
    return { state: 'claimed', checkpoint_n: -1 };
  }
  const open = claims.openDeclared.find((o) => o.declared.includes(stepId));
  if (open) return { state: 'declared_by_open_checkpoint', checkpoint_n: open.n };
  return { state: 'unclaimed' };
}

/** Assemble the brief. Pure — unit-tested directly. */
export function buildStepBrief(input: StepBriefInput): StepBrief {
  const inLatest = input.latest.steps.find((s) => s.step_id === input.stepId);
  const dropped = inLatest === undefined;
  const resolved = inLatest ?? input.lastPresent?.step;
  if (resolved === undefined) {
    throw new Error(`step ${input.stepId} resolved by neither latest nor historical revision`);
  }
  const lastPresentRevision = dropped ? input.lastPresent!.revision_n : input.latest.revision_n;

  const withClaimCp = (state: StepClaimState, stepId: string): StepClaimState => {
    if (state.state !== 'claimed') return state;
    const cp = input.closedCheckpoints.find((c) => c.completed_step_ids.includes(stepId));
    return { state: 'claimed', checkpoint_n: cp?.n ?? -1 };
  };

  const claim_state = withClaimCp(claimStateFor(input.stepId, input.claims, dropped), input.stepId);

  const criterionIds = new Set(resolved.acceptance_criteria.map((c) => c.criterion_id));
  const related_closed_checkpoints = input.closedCheckpoints
    .map((cp) => ({
      n: cp.n,
      closed_at: cp.closed_at,
      summary: cp.summary,
      done_criteria: cp.done_criteria.filter((d) => criterionIds.has(d.criterion_id)),
      claimed: cp.completed_step_ids.includes(input.stepId),
    }))
    .filter((cp) => cp.claimed || cp.done_criteria.length > 0)
    .map(({ claimed: _claimed, ...cp }) => cp);

  const siblings = input.latest.steps
    .filter((s) => s.step_id !== input.stepId)
    .map((s) => ({
      step_id: s.step_id,
      label: s.label,
      claim_state: withClaimCp(claimStateFor(s.step_id, input.claims, false), s.step_id),
    }));

  return {
    artifact_id: input.artifactId,
    origin: input.origin,
    step: {
      step_id: input.stepId,
      text: resolved.text,
      label: resolved.label,
      acceptance_criteria: resolved.acceptance_criteria,
      dropped_in_latest_revision: dropped,
      last_present_revision_n: lastPresentRevision,
    },
    claim_state,
    related_closed_checkpoints,
    guardrails: {
      non_goals: input.latest.non_goals,
      touched_scope: input.latest.touched_scope,
    },
    siblings,
    ...(dropped
      ? {
          note:
            `This step was dropped in a plan revision (last present in revision ` +
            `${lastPresentRevision}). It is informational-only: checkpoint opens validate ` +
            `declared_step_ids against the ACTIVE revision, so a dropped step can never be ` +
            `claimed or dispatched.`,
        }
      : {}),
  };
}

export interface StepBriefOptions {
  artifact?: string;
  json?: boolean;
}

function parseStepView(row: {
  step_id: string;
  idx: number;
  text: string;
  label: string;
  acceptance_criteria: string;
}): StepView {
  return {
    step_id: row.step_id,
    idx: row.idx,
    text: row.text,
    label: row.label,
    acceptance_criteria: JSON.parse(row.acceptance_criteria) as Array<{
      criterion_id: string;
      text: string;
    }>,
  };
}

export async function stepBriefAction(stepId: string, opts: StepBriefOptions = {}): Promise<void> {
  try {
    if (typeof stepId !== 'string' || stepId.trim().length === 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'step brief requires a <step_id>.',
        'step_id'
      );
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const hits = ctx.store.store.findArtifactIdsByStepId(stepId);
      if (hits.length === 0) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No plan step with step_id "${stepId}" in any captured artifact.`,
          'step_id'
        );
      }
      let artifactId: string;
      if (opts.artifact !== undefined) {
        if (!hits.includes(opts.artifact)) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Artifact "${opts.artifact}" has no plan step "${stepId}" (found in: ${hits.join(', ')}).`,
            'artifact'
          );
        }
        artifactId = opts.artifact;
      } else if (hits.length > 1) {
        throw new OrcaopsError(
          ErrorCodes.AMBIGUOUS_ARTIFACT,
          `step_id "${stepId}" appears in ${hits.length} artifacts (${hits.join(', ')}). ` +
            `Pass --artifact <id> to disambiguate.`
        );
      } else {
        artifactId = hits[0];
      }

      const latest = ctx.store.store.getLatestPlanRevision(artifactId);
      if (latest === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Artifact "${artifactId}" has no plan revisions.`,
          'artifact'
        );
      }

      // Dropped-step resolution: absent from the latest revision → walk the
      // revision history (ascending) and take the LAST revision containing it.
      let lastPresent: StepBriefInput['lastPresent'] = null;
      if (!latest.steps.some((s) => s.step_id === stepId)) {
        for (const rev of ctx.store.store.listPlanRevisions(artifactId)) {
          const hit = rev.steps.find((s) => s.step_id === stepId);
          if (hit) lastPresent = { revision_n: rev.plan.revision_n, step: parseStepView(hit) };
        }
        if (lastPresent === null) {
          // findArtifactIdsByStepId hit this artifact, so a revision must
          // contain the step — reaching here means projection drift.
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `step_id "${stepId}" is indexed for artifact "${artifactId}" but no plan revision ` +
              `contains it — run \`orcaops rebuild\`.`,
            'step_id'
          );
        }
      }

      const brief = buildStepBrief({
        artifactId,
        stepId,
        origin: ctx.store.store.getArtifact(artifactId)?.origin_kind ?? null,
        latest: {
          revision_n: latest.plan.revision_n,
          steps: latest.steps.map(parseStepView),
          non_goals: JSON.parse(latest.plan.non_goals) as unknown[],
          touched_scope: JSON.parse(latest.plan.touched_scope) as string[],
        },
        lastPresent,
        claims: ctx.store.store.getStepClaims(artifactId),
        closedCheckpoints: ctx.store.store.getClosedCheckpoints(artifactId).map((cp) => ({
          n: cp.n,
          closed_at: cp.closed_at,
          summary: cp.summary,
          completed_step_ids: cp.completed_step_ids,
          done_criteria: cp.done_criteria,
        })),
      });

      if (opts.json) {
        emitOk({ ...brief });
        return;
      }
      writeTerminalSafeStdout(formatHuman(brief));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function describeClaim(c: StepClaimState): string {
  switch (c.state) {
    case 'claimed':
      return `claimed by cp #${c.checkpoint_n}`;
    case 'declared_by_open_checkpoint':
      return `declared by OPEN cp #${c.checkpoint_n}`;
    case 'unclaimed':
      return 'unclaimed';
    case 'not_claimable_dropped':
      return 'dropped (not claimable)';
  }
}

function formatHuman(brief: StepBrief): string {
  const lines: string[] = [];
  lines.push(`Step brief — ${brief.step.label} (artifact ${brief.artifact_id})`);
  if (brief.origin === 'git-import') {
    lines.push('  origin:       imported from git history (synthesized)');
  }
  lines.push(`  step_id:      ${brief.step.step_id}`);
  lines.push(`  text:         ${brief.step.text}`);
  lines.push(`  claim state:  ${describeClaim(brief.claim_state)}`);
  if (brief.step.dropped_in_latest_revision) {
    lines.push(`  DROPPED:      last present in revision ${brief.step.last_present_revision_n}`);
  }
  if (brief.step.acceptance_criteria.length > 0) {
    lines.push('  acceptance criteria:');
    for (const c of brief.step.acceptance_criteria) lines.push(`    - ${c.text}`);
  }
  for (const cp of brief.related_closed_checkpoints) {
    lines.push(`  related cp #${cp.n} (${cp.closed_at}): ${cp.summary}`);
    for (const d of cp.done_criteria) lines.push(`    evidence: ${d.evidence}`);
  }
  lines.push(`  touched_scope: ${brief.guardrails.touched_scope.join(', ') || '(none)'}`);
  if (brief.siblings.length > 0) {
    lines.push('  siblings:');
    for (const s of brief.siblings) lines.push(`    - ${s.label}: ${describeClaim(s.claim_state)}`);
  }
  if (brief.note) lines.push(`  note: ${brief.note}`);
  lines.push('');
  return lines.join('\n');
}
