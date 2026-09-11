import { serializeMarkdown } from '../markdown/serialize.js';
import type { Checkpoint } from '../schema/checkpoint.js';
import type { Plan } from '../schema/plan.js';
import type { Summary } from '../schema/summary.js';
export function planMarkdown(plan: Plan): string {
  const frontmatter: Record<string, unknown> = {
    artifact_id: plan.artifact_id,
    branch: plan.branch,
    base_sha: plan.base_sha,
    agent: plan.agent,
    agent_session_id: plan.agent_session_id,
    task: plan.task,
    label: plan.label,
    plan_steps: plan.plan_steps,
    touched_scope: plan.touched_scope,
  };
  frontmatter.non_goals = plan.non_goals;
  frontmatter.decisions = plan.decisions;
  if (plan.origin !== undefined) frontmatter.origin = plan.origin;
  frontmatter.started_at = plan.started_at;
  frontmatter.revision_n = plan.revision_n;
  frontmatter.revised_at = plan.revised_at;
  frontmatter.rationale = plan.rationale;
  frontmatter.prior_plan_event_id = plan.prior_plan_event_id;
  frontmatter.step_lineage = plan.step_lineage;
  frontmatter.criterion_lineage = plan.criterion_lineage;
  return serializeMarkdown({
    frontmatter,
    body: `# ${plan.task}`,
  });
}
export function checkpointMarkdown(cp: Checkpoint): string {
  if (cp.status === 'open') {
    return serializeMarkdown({
      frontmatter: {
        artifact_id: cp.artifact_id,
        n: cp.n,
        status: 'open',
        declared_step_ids: cp.declared_step_ids,
        agent_session_id: cp.agent_session_id,
        policy_exceptions: cp.policy_exceptions,
        plan_revision_id: cp.plan_revision_id,
        opened_at: cp.opened_at,
        head_sha: cp.head_sha,
        open_snapshot: cp.open_snapshot,
      },
      body: `# Checkpoint #${cp.n} — open`,
    });
  }
  if (cp.status === 'closed') {
    return serializeMarkdown({
      frontmatter: {
        artifact_id: cp.artifact_id,
        n: cp.n,
        status: 'closed',
        declared_step_ids: cp.declared_step_ids,
        agent_session_id: cp.agent_session_id,
        policy_exceptions: cp.policy_exceptions,
        plan_revision_id: cp.plan_revision_id,
        opened_at: cp.opened_at,
        closed_at: cp.closed_at,
        files_changed: cp.files_changed,
        decisions: cp.decisions,
        uncertainty: cp.uncertainty,
        done_criteria: cp.done_criteria,
        ...(cp.verification !== undefined && cp.verification.length > 0
          ? { verification: cp.verification }
          : {}),
        ...(cp.window_overlap !== undefined ? { window_overlap: cp.window_overlap } : {}),
        ...(cp.attribution_degraded !== undefined
          ? { attribution_degraded: cp.attribution_degraded }
          : {}),
        completed_step_ids: cp.completed_step_ids,
        head_sha: cp.head_sha,
        ...(cp.open_head_sha !== undefined ? { open_head_sha: cp.open_head_sha } : {}),
        open_snapshot: cp.open_snapshot,
        close_snapshot: cp.close_snapshot,
        diff_fingerprint_summary: cp.diff_fingerprint_summary,
      },
      body: cp.summary,
    });
  }
  return serializeMarkdown({
    frontmatter: {
      artifact_id: cp.artifact_id,
      n: cp.n,
      status: 'abandoned',
      declared_step_ids: cp.declared_step_ids,
      agent_session_id: cp.agent_session_id,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      abandoned_at: cp.abandoned_at,
      reason: cp.reason,
      head_sha: cp.head_sha,
      open_snapshot: cp.open_snapshot,
      abandon_snapshot: cp.abandon_snapshot,
    },
    body: `# Checkpoint #${cp.n} — abandoned\n\n${cp.reason}`,
  });
}
export function summaryMarkdown(s: Summary): string {
  return serializeMarkdown({
    frontmatter: {
      artifact_id: s.artifact_id,
      ts: s.ts,
      outcome: s.outcome,
      tests_written: s.tests_written,
      tests_run: s.tests_run,
      open_items: s.open_items,
      deferred_decisions: s.deferred_decisions,
      ...(s.accepted_warnings === undefined ? {} : { accepted_warnings: s.accepted_warnings }),
      head_sha: s.head_sha,
    },
    body: s.outcome,
  });
}
