import {
  sessionDetailKey,
  type SessionUsageDetail,
  sessionUsageDetailByKey,
  sourcePlanView,
} from '@orcaops/core';
import {
  type ArtifactState,
  type CodingSessionRow,
  readPin,
  redactSecretsInObject,
  redactSecretsInString,
} from '@orcaops/storage';

import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import {
  importedArtifactsDisclosure,
  importedTrailerLine,
  resolveBranchReadScope,
} from '../lib/artifact-scope.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { detectInstallDrift, formatDriftNudge, type InstallDrift } from '../lib/install-drift.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { fallbackState } from '../lib/lifecycle-state.js';
import { discoverAcknowledgeByRef, renderedNextActionsForArtifact } from '../lib/next-actions.js';
import { resolvePinTargetsForRead } from '../lib/pin-helpers.js';
import { deriveArtifactThreadStatus } from '../lib/thread-status.js';
import { codingSessionsJson, renderCodingSessionsLines } from '../lib/usage-display.js';

export interface StatusOptions {
  branch?: string;
  json?: boolean;
}

export async function statusAction(opts: StatusOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      // Strict branch-name membership: an artifact appears under
      // branch X if any entry in its branch_lineage[] matches. The thread
      // list is live work; imported artifacts are disclosed via the trailer.
      const scope = await resolveBranchReadScope(
        ctx,
        { branch: opts.branch },
        { imported: 'disclose' }
      );
      const branch = scope.branch!;
      const importedArtifactCount = scope.importedRows.length;
      const importedArtifacts = importedArtifactsDisclosure(importedArtifactCount);
      const artifacts = scope.rows.filter((artifact) => artifact.origin_kind !== 'git-import');
      // Output-time redaction: an artifact's task and label are agent
      // narrative and can quote a pasted credential. Governed by the same
      // `digest.redact_secrets` knob as digest, resume, search and why —
      // `status` and `show` were the two read surfaces it did not reach.
      const redact = ctx.config.digest.redact_secrets;
      const threads = artifacts
        .map((a) => deriveArtifactThreadStatus(ctx.store, a.id))
        .filter((x): x is NonNullable<typeof x> => x !== null);
      // Augment each thread with the artifact.json `state`
      // so consumers see the lifecycle state machine output, not just
      // the cached SQLite status. One file read per artifact —
      // bounded to the per-branch list, fine for OSS scale.
      const enriched = await Promise.all(
        threads.map(async (t) => {
          const read = await readForEnumeration(t.id, 'status', () => ctx.store.readArtifact(t.id));
          const unreadable = read.kind === 'unreadable';
          const artifactJson = read.kind === 'readable' ? read.value : null;
          // Unreadable rows say UNKNOWN: state null, no substituted value.
          const state: ArtifactState | null = unreadable
            ? null
            : (artifactJson?.state ?? fallbackState(t.status));
          // Surface in-flight cps so concurrency is visible. Empty
          // array when none are open.
          const opens = ctx.store.store.getOpenCheckpoints(t.id);
          const nowMs = Date.now();
          const open_checkpoints = opens.map((cp) => ({
            n: cp.n,
            declared_step_ids: cp.declared_step_ids,
            agent_session_id: cp.agent_session_id,
            opened_at: cp.opened_at,
            idle_for_seconds: Math.max(
              0,
              Math.round((nowMs - new Date(cp.opened_at).getTime()) / 1000)
            ),
            policy_exceptions: cp.policy_exceptions,
          }));
          // Surface the artifact's pinned source plan (content-free) per
          // artifact, so `status --json` — the standard task-start read —
          // confirms a pin without a separate `show`. Per-artifact, NOT
          // top-level: it must not be conflated with the orthogonal shell
          // `current_pin` below.
          // Unreadable ⇒ the pin is unknown, not absent — null under the
          // `unreadable` marker, so a plan-approval flow cannot mistake
          // rot for "never pinned".
          const source_plan = unreadable ? null : sourcePlanView(artifactJson?.source_plan ?? null);
          // One public vocabulary: the derived state replaces the internal
          // coarse status in the JSON envelope.
          const { status: _internal, ...pub } = t;
          return {
            ...pub,
            state,
            open_checkpoints,
            source_plan,
            ...(unreadable ? { unreadable: true as const } : {}),
          };
        })
      );

      // Branch-scoped coding sessions: the exact (agent, session_id) totals for
      // the sessions that produced this branch's artifacts (deduped). The exact
      // total is the accounting base; per-artifact attribution stays an estimate.
      const sessionByKey = new Map<string, CodingSessionRow>();
      for (const e of enriched) {
        for (const s of ctx.store.store.artifactCodingSessions(e.id)) {
          sessionByKey.set(JSON.stringify([s.agent, s.session_id]), s);
        }
      }
      const codingSessions = [...sessionByKey.values()].sort(
        (a, b) => a.agent.localeCompare(b.agent) || a.session_id.localeCompare(b.session_id)
      );

      // Branch-scoped high-water dimensions + rate-class detail: the GLOBAL
      // per-session reader (the coding_sessions view can't carry JSON, and the
      // artifact-scoped reader is out of scope here) filtered to THIS branch's
      // session keys — never the whole global set, which would leak unrelated
      // sessions into branch status.
      const branchSessionKeys = new Set(
        codingSessions.map((s) => sessionDetailKey(s.agent, s.session_id))
      );
      const sessionDetailByKey = new Map<string, SessionUsageDetail>();
      for (const [k, v] of sessionUsageDetailByKey(ctx.store.store.listSessionModelBreakdowns())) {
        if (branchSessionKeys.has(k)) sessionDetailByKey.set(k, v);
      }

      // Surface the pin for the current shell so skill bodies
      // can confirm "you are pinned to X" before any capture. Null when
      // shell-key is unresolvable or no pin exists.
      const targets = await resolvePinTargetsForRead(ctx);
      const currentPin =
        targets.shellKey.kind === 'none' || targets.repoId === null
          ? null
          : await readPin({
              repoId: targets.repoId,
              key: targets.shellKey,
              env: getInvocationEnv(),
            });

      // Cloud-sync summary block: at-a-glance counts of pending and
      // stuck pushes so consumers (skills, doctor, web UI) can flag
      // when local state has drifted from cloud without fetching the
      // full per-artifact list. `pending_count` is "anything in the
      // drain candidate set"; `stuck_count` is the subset with at least
      // one recorded failure (i.e., a real push attempt has failed,
      // not just "we haven't gotten around to it").
      const pending = ctx.store.store.getCloudSyncPendingArtifacts();
      const nowMs = Date.now();
      const stuck = pending.filter((p) => p.cloud_consecutive_failures > 0);
      const oldestPending = pending.reduce<number | null>((acc, p) => {
        const ageS = Math.round((nowMs - new Date(p.started_at).getTime()) / 1000);
        return acc === null || ageS > acc ? ageS : acc;
      }, null);
      const lastFailure =
        stuck.length === 0
          ? null
          : (stuck
              .filter((p) => p.cloud_last_push_attempt_at !== null)
              .sort(
                (a, b) =>
                  Date.parse(b.cloud_last_push_attempt_at!) -
                  Date.parse(a.cloud_last_push_attempt_at!)
              )[0] ?? null);
      const cloudSync = {
        pending_count: pending.length,
        stuck_count: stuck.length,
        oldest_pending_age_seconds: oldestPending,
        last_failure: lastFailure
          ? {
              artifact_id: lastFailure.id,
              kind: lastFailure.cloud_last_push_error_kind,
              at: lastFailure.cloud_last_push_attempt_at,
              consecutive_failures: lastFailure.cloud_consecutive_failures,
            }
          : null,
      };

      // Drift nudge: surface a stale install (skills/commands/block vs the
      // running CLI). Best-effort, never throws; null when fresh or agent=other.
      let drift: InstallDrift | null = null;
      try {
        drift = await detectInstallDrift(ctx.repoRoot, ctx.config, CLI_VERSION, ctx.gates);
      } catch {
        // best-effort: a drift-detection failure must never break status output
      }

      // Unmerged-index nudge (the drift-nudge model): while conflicts are
      // unresolved, checkpoint snapshots still capture but the conflicted
      // paths are excluded from per-line attribution — keep that visible on
      // every status until the index is clean. Best-effort; a null probe
      // (unavailable) stays quiet rather than guessing.
      let unmergedPaths: string[] | null = null;
      try {
        unmergedPaths = await ctx.repo.listUnmergedPaths();
      } catch {
        // best-effort: an index probe failure must never break status output
      }
      const indexConflicts =
        unmergedPaths !== null && unmergedPaths.length > 0
          ? { unmerged_paths: unmergedPaths }
          : null;

      if (opts.json) {
        // Per-artifact next_actions. Fetch HEAD once; discover ack
        // eligibility once, and only if some artifact is blocked (the only
        // case ack eligibility matters) — keeps the common path cheap.
        const currentHeadSha = await ctx.repo.getHeadSha().catch(() => undefined);
        let acknowledgeByRef: (ref: string) => boolean = () => false;
        if (enriched.some((e) => e.state === 'blocked')) {
          try {
            acknowledgeByRef = await discoverAcknowledgeByRef(ctx);
          } catch {
            /* broken evaluator config → dismiss-only */
          }
        }
        const artifactsWithHints = await Promise.all(
          enriched.map(async (e) => ({
            ...e,
            next_actions: await renderedNextActionsForArtifact(ctx, e.id, {
              currentHeadSha,
              acknowledgeByRef,
            }),
          }))
        );
        const payload = {
          schema_version: 2,
          branch,
          current_pin: currentPin,
          artifacts: artifactsWithHints,
          imported_artifacts: importedArtifacts,
          cloud_sync: cloudSync,
          coding_sessions: codingSessionsJson(codingSessions, sessionDetailByKey),
          ...(drift ? { drift } : {}),
          ...(indexConflicts ? { index_conflicts: indexConflicts } : {}),
        };
        emitOk(redact ? redactSecretsInObject(payload) : payload);
        return;
      }
      const human = formatHumanStatus(
        branch,
        enriched,
        currentPin,
        codingSessions,
        sessionDetailByKey,
        importedArtifactCount
      );
      writeTerminalSafeStdout(redact ? redactSecretsInString(human) : human);
      if (drift) writeTerminalSafeStderr(formatDriftNudge(drift) + '\n');
      if (indexConflicts) {
        writeTerminalSafeStderr(
          `⚠ unresolved merge conflicts in the index ` +
            `(${indexConflicts.unmerged_paths.length} path(s): ` +
            `${indexConflicts.unmerged_paths.join(', ')}) — checkpoint snapshots still ` +
            `capture, but these paths are excluded from per-line attribution until ` +
            `resolved. Inspect with \`git status --short\`; resolve, then \`git add <path>\`.\n`
        );
      }
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

type EnrichedThread = Omit<NonNullable<ReturnType<typeof deriveArtifactThreadStatus>>, 'status'> & {
  /** Null when the artifact is unreadable — unknown, never substituted. */
  state: ArtifactState | null;
  unreadable?: true;
};

function formatHumanStatus(
  branch: string,
  artifacts: EnrichedThread[],
  currentPin: { artifact_id: string; shell_key: { kind: string } } | null,
  codingSessions: CodingSessionRow[],
  sessionDetailByKey: Map<string, SessionUsageDetail>,
  importedArtifactCount = 0
): string {
  if (artifacts.length === 0) {
    let out = `Branch: ${branch}\n`;
    if (currentPin) {
      out += `Pin:    ${currentPin.artifact_id}  (${currentPin.shell_key.kind})\n`;
    }
    out += '\nNo live artifacts captured yet.\n';
    if (importedArtifactCount > 0) {
      out += `${importedTrailerLine(importedArtifactCount)}\n`;
    }
    return out;
  }
  const lines: string[] = [`Branch: ${branch}`];
  if (currentPin) {
    lines.push(`Pin:    ${currentPin.artifact_id}  (${currentPin.shell_key.kind})`);
  }
  lines.push('');
  const sessionLines = renderCodingSessionsLines(codingSessions, sessionDetailByKey);
  if (sessionLines.length > 0) {
    lines.push(...sessionLines, '');
  }
  for (const a of artifacts) {
    if (!a) continue;
    lines.push(`  ${a.id}  ${a.task}`);
    const stateCol = a.state ?? 'unreadable (see `orcaops doctor`)';
    lines.push(`    state: ${stateCol}    capture_health: ${a.capture_health}`);
    for (const [key, entry] of Object.entries(a.thread)) {
      const extras =
        entry.status === 'done'
          ? Object.entries(entry)
              .filter(([k]) => k !== 'status')
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(' ')
          : 'blocked_by' in entry && entry.blocked_by.length > 0
            ? `blocked_by=[${entry.blocked_by.join(', ')}]`
            : '';
      lines.push(`    ${key.padEnd(11)} ${entry.status.padEnd(8)} ${extras}`.trimEnd());
    }
    if (a.blocking_evaluators.length > 0) {
      lines.push(`    blocking: ${a.blocking_evaluators.map((e) => e.evaluator_ref).join(', ')}`);
    }
    lines.push('');
  }
  if (importedArtifactCount > 0) {
    lines.push(importedTrailerLine(importedArtifactCount), '');
  }
  return lines.join('\n');
}
