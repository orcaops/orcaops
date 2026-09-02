import {
  artifactPathsFor,
  type ArtifactStore,
  atomicWriteFile,
  type NonGoal,
  redactSecretsInObject,
  redactSecretsInString,
} from '@orcaops/storage';

import { computeCoverage } from '../lifecycle/coverage.js';

export interface ResumeStep {
  /**
   * UUIDv7 stable identifier for the step (revision-stable). The CLI
   * passes this back as `declared_step_ids` / `completed_step_ids` on
   * checkpoint open/close.
   */
  step_id: string;
  /** Display ordinal — 1-based position in the latest plan. */
  idx: number;
  /** Short-form description (1-line TL;DR of `text`) used as the consumable headline. */
  label: string;
  /** Step text from the latest plan revision. */
  text: string;
  done: boolean;
  /** Which checkpoint (n) is the strongest evidence the step is done; null if not done. */
  evidence_checkpoint?: number;
  /**
   * Plan-time acceptance criteria — the criterion_ids a
   * resuming agent keys `done_criteria` to at checkpoint-close.
   */
  acceptance_criteria: Array<{ criterion_id: string; text: string }>;
}

/**
 * Closed-cp completion record for a step_id that no longer appears in
 * the latest plan revision. The completion is preserved as audit-only
 * (the `acknowledge_drops_completed_steps` field on the revision
 * payload records the explicit drop). Surfaced under "Completed in
 * earlier plan revisions" in resume markdown.
 */
export interface HistoricCompletion {
  step_id: string;
  text_at_completion: string | null;
  evidence_checkpoint: number;
}

export interface ResumeData {
  artifact_id: string;
  branch: string;
  task: string;
  /**
   * The authoring agent (`plan.agent`, runtime-resolved at capture).
   * Per-event attribution (open cps' `agent`) is rendered only when it
   * differs from this — single-agent threads stay noise-free.
   */
  authoring_agent: string;
  started_at: string;
  /** "Summary captured" — the completion gate; kept stable for callers. */
  is_complete: boolean;
  /**
   * "Every step_id in the latest plan is claimed by some closed cp's
   * completed_step_ids." Distinct from `is_complete`: an artifact can
   * be summarized with uncovered steps (e.g., revised away after
   * partial work).
   */
  plan_coverage_complete: boolean;
  checkpoint_count: number;
  /** Latest cp's head_sha; helps surface "branch HEAD is far ahead". */
  last_checkpoint_head_sha: string | null;
  /** Current plan revision (0 = initial capture, 1+ = revisions). */
  revision_n: number;
  /**
   * Latest plan event_id. Subagents pass this as `plan_revision_id`
   * on cp-open to opt into the optimistic-concurrency check.
   */
  plan_event_id: string;
  steps: ResumeStep[];
  /** Things this plan was intentionally NOT going to do (plan-captured). */
  non_goals: NonGoal[];
  /**
   * Decisions a resuming agent inherits — the WHY so it doesn't re-derive or
   * silently contradict prior choices. Plan-time decisions (source 'plan',
   * carrying revision_n) come first, then checkpoint-close decisions (source
   * 'checkpoint', carrying checkpoint) in cp order. Not deduped: each
   * {decision, reason} is distinct reasoning (mirrors the digest).
   */
  decisions: Array<{
    decision: string;
    reason: string;
    source: 'plan' | 'checkpoint';
    checkpoint?: number;
    revision_n?: number;
    alternatives_considered?: Array<{ option: string; rejected_because: string }>;
  }>;
  open_uncertainty: Array<{ item: string; checkpoint: number }>;
  open_items: string[];
  /**
   * Closed-cp completion records whose step_id is no longer in the
   * latest plan (acknowledged drops via `plan revise`). Audit-only.
   */
  historic_completions: HistoricCompletion[];
  /**
   * Open (in-flight) checkpoints — populated when the resumed thread
   * has any cps that were opened but not closed/abandoned. A fresh
   * agent can either close in-flight work, abandon stale opens, or
   * open a new cp on uncovered steps.
   */
  open_checkpoints: Array<{
    n: number;
    declared_step_ids: string[];
    agent_session_id?: string | null;
    /** Invoking agent at open time; null on pre-attribution checkpoints. */
    agent?: string | null;
    opened_at: string;
    idle_for_seconds: number;
  }>;
  /**
   * Plan step_ids with no claim from any closed cp and not declared
   * by any in-flight open cp. Computed as plan_step_ids minus
   * (closedClaimed ∪ openDeclared).
   */
  uncovered_step_ids: string[];
  /** A prompt block the developer can paste back to the agent. */
  agent_prompt: string;
}

export interface ResumeOutput {
  data: ResumeData;
  markdown: string;
}

export interface BuildResumeOptions {
  store: ArtifactStore;
  artifactId: string;
  /**
   * Apply secret redaction to the resume output (data + markdown +
   * cached resume.md). Defaults to `true`. The CLI wires this from
   * `config.digest.redact_secrets` — the same knob governs every
   * output site (digest, resume, why, search).
   */
  redactSecrets?: boolean;
}

export async function buildResume(opts: BuildResumeOptions): Promise<ResumeOutput> {
  const plan = await opts.store.readPlan(opts.artifactId);
  if (!plan) {
    throw new Error(`Cannot build resume: artifact "${opts.artifactId}" has no plan.`);
  }
  const checkpoints = await opts.store.readCheckpoints(opts.artifactId);
  const summary = await opts.store.readSummary(opts.artifactId);

  const sorted = [...checkpoints].sort((a, b) => a.n - b.n);
  // Step claims and uncertainty are derived from CLOSED cps only.
  // Open cps haven't claimed steps yet; abandoned cps explicitly didn't.
  const closedSorted = sorted.filter((c) => c.status === 'closed');

  // step_id-keyed claim map. Step renumbering across revisions is
  // invisible at this layer because step_ids are stable.
  const claimedBy = new Map<string, number>();
  for (const cp of closedSorted) {
    for (const stepId of cp.completed_step_ids) {
      claimedBy.set(stepId, cp.n);
    }
  }
  const planStepIdSet = new Set(plan.plan_steps.map((s) => s.step_id));
  const steps: ResumeStep[] = plan.plan_steps.map((step, idx) => {
    const evidence = claimedBy.get(step.step_id);
    const base = {
      step_id: step.step_id,
      idx: idx + 1,
      text: step.text,
      label: step.label,
      acceptance_criteria: step.acceptance_criteria.map((c) => ({
        criterion_id: c.criterion_id,
        text: c.text,
      })),
    };
    return evidence !== undefined
      ? { ...base, done: true, evidence_checkpoint: evidence }
      : { ...base, done: false };
  });

  // Historic completions: closed cps' completed_step_ids that no
  // longer appear in the latest plan revision (acknowledged drops).
  const historic_completions: HistoricCompletion[] = [];
  const seenHistoric = new Set<string>();
  for (const cp of closedSorted) {
    for (const stepId of cp.completed_step_ids) {
      if (planStepIdSet.has(stepId) || seenHistoric.has(stepId)) continue;
      seenHistoric.add(stepId);
      historic_completions.push({
        step_id: stepId,
        text_at_completion: null,
        evidence_checkpoint: cp.n,
      });
    }
  }

  const seenU = new Set<string>();
  const open_uncertainty: Array<{ item: string; checkpoint: number }> = [];
  for (const cp of closedSorted) {
    for (const u of cp.uncertainty) {
      const key = u.toLowerCase().trim();
      if (!seenU.has(key)) {
        seenU.add(key);
        open_uncertainty.push({ item: u, checkpoint: cp.n });
      }
    }
  }

  // Decisions a resuming agent inherits: plan-time decisions first (the up-front
  // architectural choices a resuming agent must inherit), then
  // checkpoint-close decisions in cp order. Not deduped — each
  // {decision, reason} pair is distinct reasoning (same as the digest builder).
  const decisions: ResumeData['decisions'] = [];
  for (const d of plan.decisions) {
    decisions.push({
      decision: d.decision,
      reason: d.reason,
      source: 'plan',
      revision_n: d.revision_n,
      ...(d.alternatives_considered && d.alternatives_considered.length > 0
        ? { alternatives_considered: d.alternatives_considered }
        : {}),
    });
  }
  for (const cp of closedSorted) {
    for (const d of cp.decisions) {
      decisions.push({
        decision: d.decision,
        reason: d.reason,
        source: 'checkpoint',
        checkpoint: cp.n,
        ...(d.alternatives_considered && d.alternatives_considered.length > 0
          ? { alternatives_considered: d.alternatives_considered }
          : {}),
      });
    }
  }

  // In-flight open cps + uncovered plan steps for the resume surface.
  const opens = checkpoints.filter((c): c is typeof c & { status: 'open' } => c.status === 'open');
  const nowMs = Date.now();
  const open_checkpoints = opens.map((cp) => ({
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    agent: cp.agent ?? null,
    opened_at: cp.opened_at,
    idle_for_seconds: Math.max(0, Math.round((nowMs - new Date(cp.opened_at).getTime()) / 1000)),
  }));
  // Shared coverage computation (also used by the lifecycle snapshot, so
  // the two can't drift). `uncovered_step_ids` = closed-claimed ∪
  // open-declared, complemented; `plan_coverage_complete` is keyed on
  // closed claims only. Distinct from `is_complete` (= summary exists).
  const { uncovered_step_ids, plan_coverage_complete: planCoverageComplete } = computeCoverage({
    planStepIds: plan.plan_steps.map((s) => s.step_id),
    closedCheckpoints: closedSorted,
    openCheckpoints: opens,
  });

  const rawData: ResumeData = {
    artifact_id: plan.artifact_id,
    branch: plan.branch,
    task: plan.task,
    authoring_agent: plan.agent,
    started_at: plan.started_at,
    is_complete: summary !== null,
    plan_coverage_complete: planCoverageComplete,
    checkpoint_count: closedSorted.length,
    last_checkpoint_head_sha: closedSorted.at(-1)?.head_sha ?? null,
    revision_n: plan.revision_n,
    plan_event_id: plan.source_event_id,
    steps,
    non_goals: plan.non_goals,
    decisions,
    open_uncertainty,
    open_items: summary?.open_items ?? [],
    historic_completions,
    open_checkpoints,
    uncovered_step_ids,
    agent_prompt: '', // filled below
  };
  // Redact at the data layer so the agent_prompt + markdown
  // renderers see scrubbed input — secrets in plan_steps,
  // open_items, etc. never reach the user-facing output.
  const data = opts.redactSecrets === false ? rawData : redactSecretsInObject(rawData);
  data.agent_prompt = renderAgentPrompt(data);
  if (opts.redactSecrets !== false) {
    // Defense in depth: the agent_prompt was just rendered from
    // already-redacted data, but a future renderer could quote
    // values that re-introduce a secret-shape. One more pass costs
    // nothing on already-clean text (idempotent).
    data.agent_prompt = redactSecretsInString(data.agent_prompt);
  }
  const markdown = renderResumeMarkdown(data);
  return { data, markdown };
}

/**
 * Build + persist the resume to `<artifact>/resume.md` (cache).
 * Returns the resume output AND the absolute file path.
 */
export async function writeResume(
  opts: BuildResumeOptions
): Promise<ResumeOutput & { path: string }> {
  const out = await buildResume(opts);
  const paths = artifactPathsFor(opts.store.repoRoot, opts.store.config, out.data.artifact_id);
  const resumePath = paths.resumeMd;
  await atomicWriteFile(resumePath, out.markdown, opts.store.repoRoot);
  return { ...out, path: resumePath };
}

// ── Renderers ────────────────────────────────────────────────────────────

/**
 * Render a step's `label` and `text` together as a single line. The
 * em-dash separates a short-form label (TL;DR) from the longer text;
 * when an agent writes them identically we collapse to bare label so
 * the output isn't `"Foo — Foo"`.
 */
export function labelText(label: string, text: string): string {
  return label === text ? label : `${label} — ${text}`;
}

function renderAgentPrompt(d: ResumeData): string {
  const lines: string[] = [];
  lines.push(`Continue work on: ${d.task}`);
  lines.push('');

  const completed = d.steps.filter((s) => s.done);
  const remaining = d.steps.filter((s) => !s.done);

  if (completed.length > 0) {
    lines.push('Completed:');
    for (const s of completed) lines.push(`- ${labelText(s.label, s.text)}`);
    lines.push('');
  }
  if (remaining.length > 0) {
    lines.push('Remaining:');
    for (const s of remaining) lines.push(`- ${labelText(s.label, s.text)}`);
    lines.push('');
  }
  if (d.non_goals.length > 0) {
    // Surface non-goals to the resumed agent — without them the
    // agent has no awareness of what's intentionally out of scope and
    // will trip `non-goals-violated` at the next checkpoint.
    lines.push('Non-goals (intentionally out of scope):');
    for (const ng of d.non_goals) lines.push(`- ${ng.text}`);
    lines.push('');
  }
  if (d.open_checkpoints.length > 0) {
    // In-flight cps the prior session left open. The resumed agent
    // must decide: close (work is actually done), abandon (stale or
    // dead), or pick up the declared scope and complete it.
    lines.push('Open checkpoints (in-flight from prior session):');
    for (const cp of d.open_checkpoints) {
      const session = cp.agent_session_id ? ` agent_session_id=${cp.agent_session_id}` : '';
      // Cross-agent handoff marker — only when the opener differs from
      // the authoring agent (single-agent threads stay noise-free).
      const opener = cp.agent && cp.agent !== d.authoring_agent ? ` opened by ${cp.agent}` : '';
      const declared = cp.declared_step_ids.join(', ');
      lines.push(
        `- cp ${cp.n}: declared step_ids [${declared}]${session}${opener}; idle ${cp.idle_for_seconds}s`
      );
    }
    lines.push('');
  }
  if (d.uncovered_step_ids.length > 0) {
    // Plan steps with no claim from any closed cp and not declared by
    // any in-flight open cp. These are the obvious next-work targets
    // for a fresh agent.
    lines.push('Uncovered plan steps (no closed cp claims them, no open cp declares them):');
    const stepById = new Map(d.steps.map((s) => [s.step_id, s] as const));
    for (const stepId of d.uncovered_step_ids) {
      const step = stepById.get(stepId);
      if (!step) continue;
      lines.push(`- ${step.idx}. ${labelText(step.label, step.text)} _(step_id ${step.step_id})_`);
    }
    lines.push('');
  }
  if (d.historic_completions.length > 0) {
    // Closed-cp completion records whose step_id was dropped in a
    // later plan revision. Audit-only — the resumed agent should
    // know prior work is recorded but the steps themselves have
    // been revised away.
    lines.push('Historic completions (step removed in a later revision):');
    for (const hc of d.historic_completions) {
      lines.push(`- step_id ${hc.step_id} _(cp ${hc.evidence_checkpoint})_`);
    }
    lines.push('');
  }
  if (d.decisions.length > 0) {
    // The WHY a resuming agent inherits: choices the prior session
    // already made + their rationale, so the fresh agent doesn't
    // re-litigate or silently contradict them.
    lines.push('Decisions made so far:');
    for (const dec of d.decisions) {
      const provenance =
        dec.source === 'plan' ? `plan rev ${dec.revision_n}` : `cp ${dec.checkpoint}`;
      lines.push(`- ${dec.decision}: ${dec.reason} _(${provenance})_`);
      if (dec.alternatives_considered && dec.alternatives_considered.length > 0) {
        for (const alt of dec.alternatives_considered) {
          lines.push(`    - considered ${alt.option} — rejected because ${alt.rejected_because}`);
        }
      }
    }
    lines.push('');
  }
  if (d.open_uncertainty.length > 0) {
    lines.push('Open questions:');
    for (const u of d.open_uncertainty) lines.push(`- ${u.item}`);
    lines.push('');
  }
  if (d.open_items.length > 0) {
    lines.push('Open items from prior summary:');
    for (const it of d.open_items) lines.push(`- ${it}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function renderResumeMarkdown(d: ResumeData): string {
  const lines: string[] = [];
  lines.push(`# resume — \`${d.branch}\` / \`${d.artifact_id}\``);
  lines.push('');
  if (d.is_complete) {
    lines.push('> _This artifact is already marked complete (a summary was captured)._');
    lines.push('');
  }
  lines.push(`**Task:** ${d.task}`);
  lines.push(`**Checkpoints captured:** ${d.checkpoint_count}`);
  lines.push('');

  lines.push('## progress');
  lines.push('');
  if (d.revision_n > 0) {
    lines.push(`_Plan has been revised ${d.revision_n} time(s); rendering the latest revision._`);
    lines.push('');
  }
  if (d.steps.length === 0) {
    lines.push('_No plan steps recorded._');
  } else {
    for (const s of d.steps) {
      const mark = s.done ? '☑' : '☐';
      const evidence =
        s.done && s.evidence_checkpoint !== undefined ? ` _(cp ${s.evidence_checkpoint})_` : '';
      lines.push(`- ${mark} ${labelText(s.label, s.text)}${evidence}`);
    }
  }
  lines.push('');
  if (d.plan_coverage_complete) {
    lines.push('_Coverage: every plan step is claimed by a closed checkpoint._');
    lines.push('');
  }

  if (d.non_goals.length > 0) {
    lines.push('## non-goals');
    lines.push('');
    for (const ng of d.non_goals) lines.push(`- ${ng.text}`);
    lines.push('');
  }

  if (d.open_checkpoints.length > 0) {
    // Surface in-flight cps the prior session left open. A fresh
    // agent can close (declared scope is actually done), abandon
    // (stale / dead), or pick up the declared scope and complete it.
    lines.push('## open checkpoints');
    lines.push('');
    for (const cp of d.open_checkpoints) {
      const declared = cp.declared_step_ids.join(', ');
      lines.push(`- **cp ${cp.n}** declared step_ids [${declared}]`);
      if (cp.agent_session_id) {
        lines.push(`  - agent_session_id: \`${cp.agent_session_id}\``);
      }
      if (cp.agent && cp.agent !== d.authoring_agent) {
        lines.push(`  - opened_by: \`${cp.agent}\``);
      }
      lines.push(`  - opened_at: ${cp.opened_at}`);
      lines.push(`  - idle_for_seconds: ${cp.idle_for_seconds}`);
    }
    lines.push('');
  }

  if (d.uncovered_step_ids.length > 0) {
    // Plan steps not claimed by any closed cp and not declared by any
    // in-flight open cp — the obvious next-work targets for a fresh
    // agent.
    lines.push('## uncovered plan steps');
    lines.push('');
    const stepById = new Map(d.steps.map((s) => [s.step_id, s] as const));
    for (const stepId of d.uncovered_step_ids) {
      const step = stepById.get(stepId);
      if (!step) continue;
      lines.push(`- ${step.idx}. ${labelText(step.label, step.text)} _(step_id ${step.step_id})_`);
    }
    lines.push('');
  }

  if (d.historic_completions.length > 0) {
    lines.push('## historic completions');
    lines.push('');
    lines.push(
      '_Closed-checkpoint completion records for step_ids removed in a later plan revision._'
    );
    lines.push('');
    for (const hc of d.historic_completions) {
      lines.push(`- step_id \`${hc.step_id}\` _(cp ${hc.evidence_checkpoint})_`);
    }
    lines.push('');
  }

  lines.push('## decisions');
  lines.push('');
  if (d.decisions.length === 0) {
    lines.push('_None recorded._');
  } else {
    for (const dec of d.decisions) {
      const provenance =
        dec.source === 'plan' ? `plan rev ${dec.revision_n}` : `cp ${dec.checkpoint}`;
      lines.push(`- **${dec.decision}** _(${provenance})_`);
      lines.push(`  - ${dec.reason}`);
      if (dec.alternatives_considered && dec.alternatives_considered.length > 0) {
        for (const alt of dec.alternatives_considered) {
          lines.push(
            `  - _considered_ **${alt.option}** — rejected because ${alt.rejected_because}`
          );
        }
      }
    }
  }
  lines.push('');

  lines.push('## open uncertainty');
  lines.push('');
  if (d.open_uncertainty.length === 0) {
    lines.push('_None._');
  } else {
    for (const u of d.open_uncertainty) lines.push(`- ${u.item} _(from cp ${u.checkpoint})_`);
  }
  lines.push('');

  if (d.open_items.length > 0) {
    lines.push('## open items (from summary)');
    lines.push('');
    for (const it of d.open_items) lines.push(`- ${it}`);
    lines.push('');
  }

  lines.push('## suggested agent prompt');
  lines.push('');
  lines.push('```');
  lines.push(d.agent_prompt.trimEnd());
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}
