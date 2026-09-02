import type { ContextSection } from './schemas/common.js';
import type { EvaluatorContext } from './schemas/context.js';

/**
 * Build the auto-prepended `## Context` block.
 *
 * `additionalSections` names the opt-in sections beyond the baseline —
 * the evaluator spec's `engine.additional_context_sections`. The baseline
 * always renders; sections with empty data are omitted (no "Changed
 * files: (none)" lines).
 *
 * Section order is fixed by this function, not by the caller's array, so
 * two specs declaring the same sections in different orders produce the
 * same block. The renderer is deterministic — same inputs produce the
 * same string byte-for-byte — so prompt-cache hits in the LLM client are
 * stable.
 */
export function buildContextBlock(
  context: EvaluatorContext,
  additionalSections: readonly ContextSection[]
): string {
  const wants = (section: ContextSection): boolean => additionalSections.includes(section);
  const lines: string[] = ['## Context', ''];

  lines.push(`Plan task: ${context.plan.task}`);
  lines.push(`Branch: ${context.repo.branch}`);
  // Phase is always rendered so a single shared prompt — e.g.
  // the three plan-conformance specs — can be phase-aware without forking
  // into per-phase prompt files.
  lines.push(`Phase: ${context.phase}`);
  if (context.plan.touched_scope.length > 0) {
    lines.push(`Touched scope: ${context.plan.touched_scope.join(', ')}`);
  }

  if (context.plan.non_goals.length > 0) {
    lines.push('');
    lines.push('Non-goals (intentionally out of scope):');
    // Render the full structured non-goal (text + rationale +
    // source_refs), NOT just `ng` — a NonGoal object in a template literal
    // would silently emit `[object Object]`. The conformance judge reads
    // source_refs/rationale to separate a declared exclusion from a gap.
    for (const ng of context.plan.non_goals) {
      lines.push(`  - ${ng.text}`);
      if (ng.rationale.length > 0) lines.push(`    rationale: ${ng.rationale}`);
      if (ng.source_refs.length > 0) {
        lines.push(`    source_refs: ${ng.source_refs.join(', ')}`);
      }
    }
  }

  if (context.plan.plan_steps.length > 0) {
    lines.push('');
    lines.push('Plan steps:');
    context.plan.plan_steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.text} (step_id ${s.step_id})`);
    });
  }

  // The rubric a delivery-coverage evaluator grades each step against.
  if (wants('acceptance-criteria')) {
    lines.push('');
    lines.push('## Acceptance criteria (the rubric to verify per step)');
    let anyCriteria = false;
    for (const s of context.plan.plan_steps) {
      if (s.acceptance_criteria.length === 0) {
        lines.push(`  - step ${s.step_id} (${s.label}): no acceptance criteria — NOT graded`);
        continue;
      }
      anyCriteria = true;
      lines.push(`  - step ${s.step_id} (${s.label}):`);
      for (const c of s.acceptance_criteria) {
        lines.push(`      • [${c.criterion_id}] ${c.text}`);
      }
    }
    if (!anyCriteria) {
      lines.push('  (no step declares acceptance criteria — there is nothing to grade)');
    }
  }

  // What each closed checkpoint claimed it completed. Claims, not proof —
  // an evaluator that grades delivery pairs this with the diff boundary.
  if (wants('delivered-checkpoints')) {
    lines.push('');
    lines.push('## Delivered checkpoints (claimed evidence — hints, NOT proof)');
    for (const cp of context.closed_checkpoints) {
      if (cp.status !== 'closed') continue;
      lines.push(
        `  - cp #${cp.n}: completed steps [${cp.completed_step_ids.join(', ') || 'none'}]`
      );
      for (const dc of cp.done_criteria) {
        lines.push(`      • [${dc.criterion_id}] evidence: ${dc.evidence}`);
      }
    }
  }

  // Base/head SHA + changed files, so a worktree-reading evaluator knows
  // which delta is actually attributable to this artifact.
  if (wants('diff-boundary')) {
    lines.push('');
    lines.push("## Diff boundary (THIS artifact's delta)");
    lines.push(`base_sha: ${context.repo.base_sha}`);
    lines.push(`head_sha: ${context.repo.head_sha}`);
    if (context.changed_files.length > 0) {
      lines.push('Changed files (the authoritative attribution boundary):');
      for (const f of context.changed_files) lines.push(`  - ${f}`);
    }
    lines.push(
      'Inspect the delivered work with the available commands (Read/Grep/Glob and ' +
        'selected git inspection commands, e.g. `git diff <base_sha>`, `git status --porcelain`, ' +
        '`git ls-files --others --exclude-standard`). The work is typically ' +
        'UNCOMMITTED, so diff against base_sha in the working tree — a commit-range ' +
        'diff base..head is often empty. In a shared worktree base_sha..HEAD may ' +
        'include sibling commits; treat the changed-files list as the attribution ' +
        'boundary. Steps with no criteria are not coverage-graded.'
    );
  }

  // The pinned source plan is large, so it renders only for evaluators that
  // declare it and only when a pin exists. Never truncate — a conformance
  // judge comparing against a truncated plan would report false gaps.
  if (context.source_plan !== null && wants('source-plan')) {
    lines.push('');
    lines.push('Source plan (pinned, immutable):');
    lines.push(`  ref: ${context.source_plan.source_ref.locator}`);
    lines.push('');
    lines.push(context.source_plan.content);
  }

  if (context.closed_checkpoints.length > 0) {
    lines.push('');
    lines.push(`Closed checkpoints (${context.closed_checkpoints.length}):`);
    for (const cp of context.closed_checkpoints) {
      if (cp.status !== 'closed') continue;
      lines.push(`  #${cp.n}: ${cp.summary}`);
      if (cp.uncertainty.length > 0) {
        lines.push(`     uncertainty: ${cp.uncertainty.join('; ')}`);
      }
    }
  }

  if (context.open_checkpoints.length > 0) {
    lines.push('');
    lines.push(`Open checkpoints (${context.open_checkpoints.length}):`);
    for (const cp of context.open_checkpoints) {
      if (cp.status !== 'open') continue;
      lines.push(`  #${cp.n}: declared step_ids [${cp.declared_step_ids.join(', ')}]`);
    }
  }

  if (context.changed_files.length > 0) {
    lines.push('');
    lines.push(`Changed files (since plan.base_sha):`);
    for (const f of context.changed_files) lines.push(`  - ${f}`);
  }

  if (context.summary !== null) {
    lines.push('');
    lines.push(`Summary outcome: ${context.summary.outcome}`);
    if (context.summary.open_items.length > 0) {
      lines.push(`Open items: ${context.summary.open_items.join('; ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Assemble the full prompt an LLM evaluator receives: the auto-prepended
 * context block, then the pack's prompt body under `## Task`.
 *
 * Both the runner and the SDK's fixture harness go through here. A harness
 * that composed its own copy would be testing a prompt no evaluator ever
 * sees, which is precisely the kind of gap that let the ref-gating defect
 * survive.
 */
export function composeEvaluatorPrompt(opts: {
  context: EvaluatorContext;
  additionalSections: readonly ContextSection[];
  promptBody: string;
}): string {
  const contextBlock = buildContextBlock(opts.context, opts.additionalSections);
  return `${contextBlock}\n\n## Task\n\n${opts.promptBody}`;
}
