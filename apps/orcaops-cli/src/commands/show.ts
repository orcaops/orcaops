import { labelText } from '@orcaops/core';

import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { renderCanonicalUsageLines } from '../lib/canonical-usage-display.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type DatabaseShowOptions,
  readDatabaseShow,
  validateDatabaseShow,
} from '../lib/database-show.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { IMPORTED_BADGE } from '../lib/imported-provenance.js';

export type ShowOptions = DatabaseShowOptions;
export async function showAction(artifactId: string, opts: ShowOptions = {}): Promise<void> {
  opts = { ...opts };
  try {
    const selector = validateDatabaseShow(artifactId, opts);
    const context = await resolveDatabaseHistoryCommandContext({ profile: 'exact', selector });
    let result: Awaited<ReturnType<typeof readDatabaseShow>>;
    try {
      result = await readDatabaseShow(context, artifactId);
    } catch (cause) {
      closeFailedHistoryRead(context.scope);
      throw cause;
    }
    context.scope.close();
    if (opts.json) {
      emitOk(result);
      return;
    }
    const artifactRow = result.artifact;
    const {
      plan,
      checkpoints,
      summary,
      evaluator_log: evaluatorLog,
      source_plan: sourcePlan,
      lineage_sha_drift: lineageShaDrift,
      repo_state: repoState,
    } = artifactRow;
    const lines: string[] = [];
    const stateLabel = artifactRow.state;
    const imported = plan?.origin?.kind === 'git-import';
    lines.push(
      `Artifact ${artifactRow.id}${imported ? `  ${IMPORTED_BADGE}` : ''}  (${stateLabel})`
    );
    lines.push(`Branch: ${artifactRow.branch}`);
    lines.push(`Task:   ${artifactRow.task}`);
    if (imported) lines.push('Origin: imported from git history (synthesized)');
    // Source-plan pin (content-free): make a pinned anchor legible on the
    // detail surface. Cloud → cloud:<id>@<version>; local → <path> (local).
    if (sourcePlan) {
      const ref = sourcePlan.source_ref;
      const refStr =
        ref.kind === 'cloud' ? `cloud:${ref.locator}@${ref.version}` : `${ref.locator} (local)`;
      lines.push(`Source plan: ${refStr}  (${sourcePlan.hash.slice(0, 12)})`);
    }
    if (lineageShaDrift) {
      lines.push(
        `Lineage drift on ${lineageShaDrift.branch}: ` +
          `recorded ${lineageShaDrift.recorded_sha.slice(0, 7)}, ` +
          `HEAD ${lineageShaDrift.current_sha.slice(0, 7)} ` +
          `— run \`orcaops lineage\` to update.`
      );
    }
    lines.push('');
    const usageLines = renderCanonicalUsageLines(artifactRow.usage);
    if (usageLines.length > 0) {
      lines.push(...usageLines);
      lines.push('');
    }
    if (plan) {
      lines.push('Plan steps:');
      for (const [i, s] of plan.plan_steps.entries()) {
        lines.push(`  ${i + 1}. ${labelText(s.label, s.text)}`);
        for (const c of s.acceptance_criteria) {
          lines.push(`       ◦ [${c.criterion_id}] ${c.text}`);
        }
      }
      if (plan.non_goals.length > 0) {
        lines.push('');
        lines.push('Non-goals:');
        for (const ng of plan.non_goals) lines.push(`  - ${ng.text}`);
      }
      // Plan-time decisions: the load-bearing architectural choices, each
      // tagged with the revision it was made at. Mirrors the digest render
      // (key decisions) in plain-text form; alternatives are sub-bullets.
      if (plan.decisions.length > 0) {
        lines.push('');
        lines.push('Decisions:');
        for (const dec of plan.decisions) {
          lines.push(`  - ${dec.decision}  (plan rev ${dec.revision_n})`);
          lines.push(`      ${dec.reason}`);
          if (dec.evidence) {
            lines.push(`      evidence: commit ${dec.evidence.commit_sha} — ${dec.evidence.quote}`);
          }
          for (const alt of dec.alternatives_considered ?? []) {
            lines.push(
              `      ◦ considered ${alt.option} — rejected because ${alt.rejected_because}`
            );
          }
        }
      }
      lines.push('');
    }
    lines.push(`Checkpoints (${checkpoints.length}):`);
    for (const cp of checkpoints) {
      if (cp.status === 'closed') {
        lines.push(`  #${cp.n} [${cp.closed_at}]  Agent-reported: ${cp.summary}`);
        for (const entry of cp.verification ?? []) {
          const snapshot = cp.close_snapshot.snapshot_commit_sha ?? cp.close_snapshot.tree_sha;
          lines.push(
            `     ${entry.command} — Agent reports command exited ${entry.exit_code}. ${snapshot ? `Checkpoint subsequently closed at snapshot ${snapshot}.` : 'Checkpoint subsequently closed; snapshot unavailable.'}`
          );
          if (entry.output_digest) lines.push(`     Agent-supplied output: ${entry.output_digest}`);
          if (entry.note) lines.push(`     Agent-supplied note: ${entry.note}`);
        }
        if (cp.uncertainty.length > 0) {
          lines.push(`     uncertainty: ${cp.uncertainty.join('; ')}`);
        }
      } else if (cp.status === 'open') {
        lines.push(
          `  #${cp.n} [open since ${cp.opened_at}]  declared step_ids [${cp.declared_step_ids.join(', ')}]` +
            (cp.agent_session_id ? `  (${cp.agent_session_id})` : '')
        );
      } else {
        lines.push(`  #${cp.n} [abandoned ${cp.abandoned_at}]  reason: ${cp.reason}`);
      }
    }
    lines.push('');
    if (summary) {
      lines.push(`Summary (agent-reported): ${summary.outcome}`);
      if (summary.open_items.length > 0) {
        lines.push(`  open: ${summary.open_items.join('; ')}`);
      }
    } else {
      lines.push('Summary: (none)');
    }
    lines.push('');
    lines.push(`Evaluator runs: ${evaluatorLog?.runs.length ?? 0}`);
    lines.push('');
    if (repoState) {
      lines.push('Repo state:');
      lines.push(
        `  current_branch=${repoState.current_branch} ` +
          `head=${repoState.current_head_sha.slice(0, 7)} ` +
          `artifact_head=${repoState.artifact_head_sha?.slice(0, 7) ?? '(none)'} ` +
          `dirty=${repoState.working_tree_dirty}`
      );
      const ahead = repoState.commits_since_artifact_head_touching_artifact_files.length;
      if (ahead > 0) {
        lines.push(`  ${ahead} commit(s) since artifact_head touch artifact files`);
      }
      if (repoState.open_items_addressed_since.length > 0) {
        lines.push(
          `  ${repoState.open_items_addressed_since.length} open item(s) may already be addressed`
        );
      }
      lines.push('');
    }
    if (artifactRow.git_context.state === 'unavailable')
      lines.push(`Git context unavailable: ${artifactRow.git_context.reason}`);
    writeTerminalSafeStdout(lines.join('\n'));
  } catch (cause) {
    const err = historyScopeCommandError(cause);
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
