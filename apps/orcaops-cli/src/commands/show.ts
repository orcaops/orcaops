import { buildRepoState, labelText, sourcePlanView } from '@orcaops/core';
import { redactSecretsInObject, redactSecretsInString } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { IMPORTED_BADGE } from '../lib/artifact-scope.js';
import { buildContext } from '../lib/context.js';
import { fallbackState } from '../lib/lifecycle-state.js';
import {
  artifactUsageJson,
  buildArtifactUsageView,
  renderArtifactUsageLines,
} from '../lib/usage-display.js';

export interface ShowOptions {
  json?: boolean;
}

interface LineageShaDrift {
  branch: string;
  recorded_sha: string;
  current_sha: string;
}

export async function showAction(artifactId: string, opts: ShowOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const artifactRow = ctx.store.store.getArtifact(artifactId);
      if (!artifactRow) {
        throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
      }
      const plan = await ctx.store.readPlan(artifactId);
      const checkpoints = await ctx.store.readCheckpoints(artifactId);
      const summary = await ctx.store.readSummary(artifactId);
      const evaluatorLog = await ctx.store.readEvaluatorLog(artifactId);
      // SHA drift: when the artifact's latest lineage entry on the
      // current branch records a head_sha that no longer matches the
      // current branch HEAD, the user should run `orcaops lineage`. Only
      // signal drift when the artifact actually has a lineage entry
      // on the current branch — otherwise the comparison is noise.
      const artifactJson = await ctx.store.readArtifact(artifactId);
      const currentBranch = await ctx.repo.getCurrentBranch();
      const currentSha = await ctx.repo.getHeadSha();
      let lineageShaDrift: LineageShaDrift | null = null;
      if (artifactJson) {
        const onBranch = artifactJson.branch_lineage.filter((e) => e.branch === currentBranch);
        const latestOnBranch = onBranch[onBranch.length - 1];
        if (latestOnBranch && latestOnBranch.head_sha !== currentSha) {
          lineageShaDrift = {
            branch: currentBranch,
            recorded_sha: latestOnBranch.head_sha,
            current_sha: currentSha,
          };
        }
      }

      // Repo-state context: surface the surrounding repo's
      // current state so consumers can spot drift from the artifact's
      // last-recorded head and notice open_items addressed since.
      const repoState = await buildRepoState({
        store: ctx.store,
        repo: ctx.repo,
        artifactId,
      });

      const usageView = buildArtifactUsageView(ctx.store.store, artifactId);
      // Content-free projection of the pinned source plan, shared by the JSON
      // projection and the human render below (computed once; the two paths
      // are mutually exclusive).
      const sourcePlan = sourcePlanView(artifactJson?.source_plan ?? null);

      // Output-time redaction: plan steps, checkpoint summaries and the
      // summary body are agent narrative and can quote a pasted credential.
      // Governed by the same `digest.redact_secrets` knob as digest, resume,
      // search and why — `show` and `status` were the two read surfaces it
      // did not reach.
      const redact = ctx.config.digest.redact_secrets;

      if (opts.json) {
        const payload = {
          artifact: {
            id: artifactRow.id,
            branch: artifactRow.branch,
            // The launch vocabulary: the lifecycle state machine output
            // (planned/active/blocked/summarized), source of truth
            // artifact.json, with the coarse SQLite status folded in as the
            // same fallback every other surface uses — never null, never
            // dual-vocabulary.
            state: artifactJson?.state ?? fallbackState(artifactRow.status),
            started_at: artifactRow.started_at,
            completed_at: artifactRow.completed_at,
            plan,
            checkpoints,
            summary,
            evaluator_log: evaluatorLog,
            branch_lineage: artifactJson?.branch_lineage ?? [],
            lineage_sha_drift: lineageShaDrift,
            repo_state: repoState,
            usage: artifactUsageJson(usageView),
            source_plan: sourcePlan,
            origin: plan?.origin ?? null,
          },
        };
        emitOk(redact ? redactSecretsInObject(payload) : payload);
        return;
      }

      const lines: string[] = [];
      const stateLabel = artifactJson?.state ?? artifactRow.status;
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
      const usageLines = renderArtifactUsageLines(usageView);
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
          lines.push(`  #${cp.n} [${cp.closed_at}]  ${cp.summary}`);
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
        lines.push(`Summary: ${summary.outcome}`);
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
      const rendered = lines.join('\n');
      writeTerminalSafeStdout(redact ? redactSecretsInString(rendered) : rendered);
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
