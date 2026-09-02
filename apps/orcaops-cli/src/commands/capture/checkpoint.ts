import { run } from 'effection';

import {
  buildDiffFingerprintManifest,
  captureCheckpointSnapshot,
  computeWindowSegments,
  diffSnapshotTrees,
  type SnapshotFailureReason,
  type SnapshotPhase,
  type SnapshotResult,
  type WindowSegment,
} from '@orcaops/core';
import {
  type EvaluatorRunPayload,
  type GateAuditDisposition,
  type GateAuditPayload,
  type GateAuditRun,
  isBlockingEligibleViolation,
  isBlockingEvaluatorFailure,
} from '@orcaops/evaluator-protocol';
import {
  combineEvaluatorFingerprints,
  createParamsValidator,
  discoverEvaluators,
  dispatchEvaluators,
} from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import {
  type AttributionDegraded,
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  CaptureCheckpointAbandonInputSchema,
  CaptureCheckpointCloseInputSchema,
  CaptureCheckpointOpenInputSchema,
  type CheckpointSnapshotBoundary,
  type DiffFingerprintFailureReason,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
  type PolicyException,
  PolicyExceptionInvalidError,
  resolveCaptureExcludes,
  uuidv7,
  type WindowOverlap,
} from '@orcaops/storage';

import {
  ErrorCodes,
  InfoCodes,
  type OpenCheckpointCandidate,
  type OpenRejectionEnvelope,
  OrcaopsError,
} from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { writeTerminalSafeStderr } from '../../io/output.js';
import { resolveActiveArtifactId } from '../../lib/active-artifact.js';
import type { CliContext } from '../../lib/context.js';
import {
  buildEvaluatorContext,
  hasLifecycleCompletion,
  recordLifecycleCompletion,
  runLifecycleEvaluators,
} from '../../lib/evaluator-bridge.js';
import { computePackTrustDecisions } from '../../lib/evaluator-grants.js';
import { CLI_ROOT } from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';
import { runCaptureWithSync } from '../../lib/run-capture.js';
import {
  lifecycleUsageStamp,
  type UsageStampDescriptor,
  usageStampKey,
} from '../../lib/usage-stamp.js';

export interface CaptureCheckpointOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * The empty-diff-window warning. A non-blocking,
 * response-only signal — deliberately NOT an `evaluator_results` entry: a
 * discovered evaluator is blind to the fence (its context omits the tree SHAs),
 * and a synthetic EvaluatorRunPayload can't be authored honestly (the schema
 * requires a real evaluator identity). Emitted when the open/close fence is
 * empty yet the cp reported changed files.
 */
function emptyDiffWindowWarning(n: number): { code: string; message: string } {
  return {
    code: 'empty-diff-window',
    message:
      `Checkpoint ${n} closed with an EMPTY diff even though it reported changed ` +
      `files: those changes landed outside its open-to-close window and lose ` +
      `per-line attribution. Open the next checkpoint before you change the worktree.`,
  };
}

/**
 * A snapshot capture that failed, carried from the snapshot callback out
 * to the command's response.
 *
 * Storage destructures ONLY `{boundary}` (open / abandon) or
 * `{boundary, summary, manifest}` (close) from the snapshot callbacks, so a
 * field RETURNED from a callback would be silently dropped. The callbacks
 * therefore push onto a closure-local array, the same propagation path the
 * close path's `fenceEmpty` already uses.
 *
 * At most one entry is ever recorded per command (one capture per lifecycle
 * boundary); the array shape exists so it composes straight into the
 * `warnings[]` spread and can never hit a control-flow-narrowing trap the way
 * a reassigned `let` captured in a callback would.
 */
interface SnapshotCaptureFailure {
  phase: SnapshotPhase;
  reason: SnapshotFailureReason;
  /**
   * Raw git stderr. Present on every path that routes through
   * `classifySnapshotFailure` — i.e. precisely the paths that can produce the
   * uninformative `'unknown'`, which is the whole reason this field exists.
   * Absent only on `captureWorktreeTree`'s unborn-HEAD pre-flight
   * short-circuit, whose reason — 'unborn_repo' — already names itself.
   * `merge_conflict` always carries one: an unmerged index does not fail
   * capture, so that reason only ever arrives via stderr classification.
   */
  message?: string;
}

/**
 * Cap on the raw git stderr echoed into a `snapshot-capture-failed` warning.
 * Comfortably above a real git error (a few lines of `error:`/`fatal:`, hint
 * lines included) and low enough that a pathological stderr — `git add` can
 * enumerate every path it refused — cannot bloat the JSON envelope agents
 * parse. Over-cap output is cut with an explicit disclosure, never silently.
 */
const SNAPSHOT_ERROR_MESSAGE_MAX_CHARS = 600;

/** What a failed boundary costs, per lifecycle phase. */
const SNAPSHOT_FAILURE_CONSEQUENCE: Record<SnapshotPhase, string> = {
  open:
    `The open boundary has no tree, so this checkpoint's close has nothing to ` +
    `diff against ('missing_open_tree_sha') and its work loses per-line attribution.`,
  close:
    `The close boundary has no tree, so this checkpoint's diff fingerprint is ` +
    `skipped and its work loses per-line attribution.`,
  abandon:
    `The abandon boundary has no tree, so the abandoned work cannot be ` +
    `materialized from its snapshot ref later.`,
};

/** Bound the echoed stderr, disclosing that (and by how much) it was cut. */
function truncateSnapshotErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= SNAPSHOT_ERROR_MESSAGE_MAX_CHARS) return trimmed;
  return (
    `${trimmed.slice(0, SNAPSHOT_ERROR_MESSAGE_MAX_CHARS)}… ` +
    `[truncated; ${trimmed.length} chars total]`
  );
}

/**
 * An exclude pattern that is not valid glob syntax is dropped by
 * `resolveCaptureExcludes`, so the path it names is captured as if it had never
 * been listed. Silently narrowing a security control is the failure worth
 * shouting about, even though the capture itself is still sound.
 */
function captureExcludeInvalidWarning(invalid: readonly string[]): {
  code: string;
  message: string;
} {
  return {
    code: 'capture-exclude-invalid',
    message:
      `capture.exclude has ${invalid.length} invalid pattern(s) ` +
      `[${invalid.map((p) => JSON.stringify(p)).join(', ')}] — each was IGNORED, so any path ` +
      `it was meant to withhold was captured. Fix or remove the entry in capture.exclude.`,
  };
}

/**
 * The exclude probe itself failed, so this capture was taken with NO exclusion.
 * Distinct from `capture-exclude-invalid`, which names the patterns it ignored:
 * here every pattern was live and none of them ran. The checkout disclosure
 * re-runs them against the recorded tree, but that is after the fact — this
 * says so at the boundary, where the empty exclusion set would otherwise read
 * as "there was nothing to withhold".
 */
function captureExcludeProbeFailedWarning(
  n: number,
  phase: SnapshotPhase
): { code: string; message: string } {
  return {
    code: 'capture-exclude-probe-failed',
    message:
      `Checkpoint ${n} ${phase} snapshot captured, but the exclude probe ` +
      `(git ls-files --others) failed — capture.exclude did not run at this boundary, so ` +
      `every path it was meant to withhold is in the snapshot tree. ` +
      `Inspect with: orcaops snapshots checkout`,
  };
}

/**
 * The loud half of the snapshot-failure story: the raw git error, on the
 * response, at the moment of failure.
 *
 * `snapshot_error_reason` is ALL the persisted boundary can hold (see
 * `toBoundary` for why the message cannot be stored), and `'unknown'` names
 * nothing: a boundary can fail silently while the git stderr that explains
 * it is discarded. Reporting it here is the substitute for persisting it.
 *
 * Non-blocking, and the same `{code, message}` shape as `empty-diff-window`
 * and the `window-overlap-*` codes: snapshot capture is fail-open, so the
 * checkpoint still commits and the command still exits 0.
 */
function snapshotCaptureFailedWarning(
  n: number,
  failure: SnapshotCaptureFailure
): { code: string; message: string } {
  const detail =
    failure.message === undefined || failure.message.length === 0
      ? '(git reported no message)'
      : truncateSnapshotErrorMessage(failure.message);
  return {
    code: 'snapshot-capture-failed',
    message:
      `Checkpoint ${n} ${failure.phase} snapshot capture FAILED ` +
      `(snapshot_error_reason: ${failure.reason}). ` +
      `${SNAPSHOT_FAILURE_CONSEQUENCE[failure.phase]} ` +
      `Capture is fail-open, so the checkpoint itself committed. git said: ${detail}`,
  };
}

/** What degraded (not lost) attribution means, per lifecycle phase. */
const UNMERGED_DEGRADED_CONSEQUENCE: Record<SnapshotPhase, string> = {
  open:
    `The snapshot captured, but these paths will be EXCLUDED from per-line ` +
    `attribution for this checkpoint — attribution will be PARTIAL, not lost; ` +
    `other files attribute normally. Resolve the conflicts (edit, then ` +
    `\`git add <path>\`, or \`git merge --abort\`) before closing to keep the ` +
    `exclusion set from growing.`,
  close:
    `Attribution is PARTIAL: hunks touching these paths were removed from the ` +
    `diff fingerprint; all other files attribute normally. Resolve the ` +
    `conflicts before the next checkpoint boundary.`,
  abandon:
    `The abandon snapshot captured the conflicted worktree bytes (markers ` +
    `included) — a later salvage of this checkpoint materializes them as-is.`,
};

/**
 * The degraded-attribution warning: WHICH paths lost exact attribution, and
 * that everything else kept it. Capture succeeded, so this is the only place
 * the partial-attribution consequence is stated. Same non-blocking
 * `{code, message}` shape as `snapshot-capture-failed`.
 */
function unmergedPathsDegradedWarning(
  n: number,
  phase: SnapshotPhase,
  paths: readonly string[]
): { code: string; message: string } {
  return {
    code: 'unmerged-paths-degraded',
    message:
      `Checkpoint ${n} ${phase === 'close' ? 'closed' : `${phase}ed`} with ` +
      `${paths.length} unmerged git path(s): ${paths.join(', ')}. ` +
      `${UNMERGED_DEGRADED_CONSEQUENCE[phase]} Inspect with: git status --short`,
  };
}

/**
 * The unmerged-index probe itself failed: the boundary captured, but
 * degraded-path detection was unavailable — the empty set must never be
 * read as verified-clean.
 */
function unmergedProbeFailedWarning(
  n: number,
  phase: SnapshotPhase
): { code: string; message: string } {
  return {
    code: 'unmerged-probe-failed',
    message:
      `Checkpoint ${n} ${phase} snapshot captured, but the unmerged-index probe ` +
      `(git ls-files -u) failed — degraded-path detection was unavailable at this ` +
      `boundary, so per-line attribution may silently include conflicted paths. ` +
      `Inspect with: git status --short`,
  };
}

/**
 * Both close-side degraded warnings, derived from the PERSISTED
 * `attribution_degraded` record — the single source the fresh and replay
 * arms share, so a replayed degraded close stays as loud as the original.
 * The path-list warning requires a non-empty union (a probe-failed-only
 * record must not render "0 unmerged path(s)"); the probe warning is
 * boundary-neutral because the persisted flag is the open∪close merge.
 */
function attributionDegradedWarnings(
  n: number,
  degraded: AttributionDegraded | undefined
): Array<{ code: string; message: string }> {
  if (degraded === undefined) return [];
  return [
    ...(degraded.unmerged_paths.length > 0
      ? [unmergedPathsDegradedWarning(n, 'close', degraded.unmerged_paths)]
      : []),
    ...(degraded.probe_failed === true
      ? [
          {
            code: 'unmerged-probe-failed',
            message:
              `Checkpoint ${n} closed, but the unmerged-index probe (git ls-files -u) ` +
              `failed at one of its boundaries — the empty exclusion set must not be ` +
              `read as verified-clean; per-line attribution may silently include ` +
              `conflicted paths. Inspect with: git status --short`,
          },
        ]
      : []),
  ];
}

/**
 * Open a checkpoint. Two-phase lifecycle: open declares the plan steps
 * the cp will cover, close (or abandon) finalizes it. Pre-append
 * `checkpoint-open` evaluators run in dry-run mode against the
 * proposed projection; if any block AND no matching policy_exceptions
 * entry resolves it, the open is rejected without writing.
 */
export async function captureCheckpointOpenAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });

      const policy_exceptions: PolicyException[] = input.policy_exceptions;

      // Resolve git HEAD before the lock. Required for fresh opens;
      // replays of committed events return the prior head_sha
      // regardless of what we resolve here, so this is harmless on
      // the replay path.
      const headSha = await ctx.repo.getHeadSha();

      // Storage owns ALL post-parse validation (in-range, no-dups,
      // disjointness, policy_exceptions opt-in) so a previously
      // committed open is replayable even if the registry has
      // drifted. The lazy evaluatorContext thunk runs only when
      // storage needs it (i.e., past stage-1 committed-event lookup).
      const exceptionRefs = new Set(policy_exceptions.map((p) => p.evaluator));

      // Snapshot-capture failures the open callback observed. The callback is a
      // CLI-defined closure and storage destructures only `{boundary}` from its
      // result, so this closure-local is the propagation path (same mechanism as
      // the close path's `fenceEmpty`). It is the ONLY channel the git error has:
      // capture is fail-open, the open commits regardless, and the boundary the
      // event persists can hold nothing but the typed reason.
      const openSnapshotFailures: SnapshotCaptureFailure[] = [];
      // Same closure-local propagation as `openSnapshotFailures` above. The
      // path list ALSO returns to the store, which persists it payload-only
      // for close's degraded union.
      const openDegraded = { paths: [] as string[], probeFailed: false };
      let openExcludeProbeFailed = false;

      const result = await ctx.store.writeCheckpointOpened(
        {
          artifact_id: artifactId,
          declared_step_ids: input.declared_step_ids,
          agent_session_id: input.agent_session_id,
          policy_exceptions,
          plan_revision_id: input.plan_revision_id ?? null,
        },
        {
          idempotencyKey: input.idempotency_key,
          // Runtime provenance — deliberately NOT part of replayPayload:
          // a cross-agent retry of the same open must replay, not conflict.
          invokedByAgent: ctx.invokingAgent.agent,
          replayPayload: {
            artifact_id: artifactId,
            declared_step_ids: input.declared_step_ids,
            agent_session_id: input.agent_session_id,
            policy_exceptions,
            plan_revision_id: input.plan_revision_id ?? null,
          },
          extractReplayShape: (priorPayload) => extractOpenReplayShape(priorPayload),
          headSha,
          evaluatorContext: async () => {
            // Lazy — runs only past stage-1 committed-event lookup.
            // Capture mode (no onError) throws on the first discovery
            // error, so misconfigured checkpoint-open evaluators fail
            // loudly here. Committed replays bypass this entirely.
            const { config: evalConfig, evaluators: discovered } = await discoverEvaluators(
              ctx.repoRoot,
              {
                cliRoot: CLI_ROOT,
              }
            );
            const maxConcurrent = evalConfig?.runtime.max_concurrent ?? 4;
            const cpOpenEvaluators = discovered.filter(
              (e) => e.enabled && e.phase === 'checkpoint-open'
            );
            const cpOpenPackageIds = new Set(cpOpenEvaluators.map((e) => e.package_id));
            const cpOpenTrust = await computePackTrustDecisions({
              packs: (evalConfig?.packages ?? [])
                .filter((entry) => cpOpenPackageIds.has(entry.id))
                .map((entry) => ({
                  packageId: entry.id,
                  source: entry.source,
                })),
              repoRoot: ctx.repoRoot,
              cliRoot: CLI_ROOT,
              warn: (msg) => writeTerminalSafeStderr(`${msg}\n`),
            });
            const fingerprint = await combineEvaluatorFingerprints(cpOpenEvaluators);

            return {
              fingerprint,
              validatePolicyExceptions: () => {
                if (policy_exceptions.length === 0) return;
                for (const ex of policy_exceptions) {
                  const ev = cpOpenEvaluators.find((e) => e.ref === ex.evaluator);
                  if (!ev) {
                    const existsElsewhere = discovered.some((e) => e.ref === ex.evaluator);
                    throw new PolicyExceptionInvalidError(
                      artifactId,
                      existsElsewhere
                        ? `policy_exceptions[] names "${ex.evaluator}", which is not a ` +
                            `\`fires_at: checkpoint-open\` evaluator. Inline policy exceptions ` +
                            `only apply to pre-append blocks; use \`orcaops block dismiss\` ` +
                            `for post-write resolution instead.`
                        : `policy_exceptions[] names unknown evaluator "${ex.evaluator}".`,
                      ex.evaluator
                    );
                  }
                  if (!ev.resolution.policy_exception.enabled) {
                    throw new PolicyExceptionInvalidError(
                      artifactId,
                      `evaluator "${ex.evaluator}" does not opt into policy exceptions ` +
                        `(\`resolution.policy_exception.enabled\` is false on its spec). ` +
                        `Use \`orcaops block dismiss\` after-the-fact instead, or rewrite ` +
                        `the open with smaller scope.`,
                      ex.evaluator
                    );
                  }
                }
              },
              preAppend: async (proposedOpen) => {
                if (cpOpenEvaluators.length === 0) {
                  return { ok: true };
                }

                const baseContext = await buildEvaluatorContext({
                  ctx,
                  artifactId: artifactId,
                  firesAt: 'checkpoint-open',
                  checkpointN: proposedOpen.n,
                  proposedOpenCheckpoint: proposedOpen,
                });
                const llm = await run(function* () {
                  return yield* buildLLMClient(ctx.config.llm, {
                    ...(opts.noLlm !== undefined ? { noLlm: opts.noLlm } : {}),
                    env: getInvocationEnv(),
                  });
                });
                const validator = createParamsValidator();
                const { runs } = await dispatchEvaluators({
                  evaluators: cpOpenEvaluators,
                  context: baseContext,
                  llm,
                  trust: cpOpenTrust,
                  maxConcurrent,
                  runIdFactory: uuidv7,
                  validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
                });
                const stampedRuns: EvaluatorRunPayload[] = runs.map((r) => ({
                  ...r,
                  checkpoint_n: proposedOpen.n,
                }));

                // Mint paired policy-excepted dispositions for each
                // blocking-eligible run whose ref is named in
                // policy_exceptions[]. Storage's validatePolicyExceptions
                // already enforced that every named ref opts into the
                // inline exception flow.
                const ts = new Date().toISOString();
                const dispositions: GateAuditDisposition[] = [];
                for (const r of stampedRuns) {
                  if (!isBlockingEligibleViolation(r)) continue;
                  if (!exceptionRefs.has(r.evaluator_ref)) continue;
                  const ex = policy_exceptions.find((p) => p.evaluator === r.evaluator_ref);
                  if (!ex) continue;
                  dispositions.push({
                    disposition_id: uuidv7(),
                    run_id: r.run_id,
                    evaluator_ref: r.evaluator_ref,
                    disposition: 'policy-excepted',
                    reason: ex.reason,
                    ts,
                  });
                }

                const policyExceptedRunIds = new Set(dispositions.map((d) => d.run_id));
                const unresolvedBlocks = stampedRuns.filter(
                  (r) => isBlockingEvaluatorFailure(r) && !policyExceptedRunIds.has(r.run_id)
                );

                const gate_audit: GateAuditPayload = {
                  runs: stampedRuns.map(toGateAuditRun),
                  dispositions,
                };

                if (unresolvedBlocks.length > 0) {
                  return {
                    ok: false,
                    // `satisfies` ties this producer to the shared
                    // OpenRejectionEnvelope the next_actions consumer reads:
                    // a rename of declared_step_ids/blocked_evaluator_refs/etc.
                    // breaks the build here rather than silently degrading the
                    // hint. Extra fields (evaluator_results/blocking/message) are
                    // allowed by `satisfies`.
                    envelope: {
                      ok: false as const,
                      status: 'blocked',
                      artifact_id: artifactId,
                      // Attempted scope + blocked refs power the next_actions
                      // remediation template (the block is pre-append, so it
                      // never lands as a persisted run the snapshot can see).
                      declared_step_ids: input.declared_step_ids,
                      blocked_evaluator_refs: unresolvedBlocks.map((b) => b.evaluator_ref),
                      evaluator_results: stampedRuns,
                      gate_audit,
                      blocking: true,
                      message:
                        `Open rejected by ${unresolvedBlocks.length} blocking evaluator outcome(s): ` +
                        `${unresolvedBlocks.map((b) => b.evaluator_ref).join(', ')}. ` +
                        `Fix evaluator errors and retry. Completed policy violations may instead ` +
                        `be retried with smaller scope or \`policy_exceptions[]\` entries.`,
                    } satisfies OpenRejectionEnvelope,
                  };
                }
                return { ok: true, gate_audit };
              },
            };
          },
          snapshotCallbacks: {
            captureOpenSnapshot: async ({ artifact_id, n }) => {
              if (!ctx.config.diff_fingerprint.enabled) {
                return { boundary: buildDefaultSkippedSnapshotBoundary() };
              }
              const snap = await captureCheckpointSnapshot({
                excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
                repo: ctx.repo,
                artifactId: artifact_id,
                checkpointN: n,
                phase: 'open',
              });
              const mapped = toBoundary(snap);
              if (mapped.failure !== undefined) openSnapshotFailures.push(mapped.failure);
              if (snap.ok) {
                openDegraded.paths.push(...snap.unmerged_paths);
                openDegraded.probeFailed = snap.unmerged_probe_failed === true;
                openExcludeProbeFailed = snap.exclusion_probe_failed === true;
              }
              return {
                boundary: mapped.boundary,
                ...(snap.ok && snap.unmerged_paths.length > 0
                  ? { unmerged_paths: [...snap.unmerged_paths] }
                  : {}),
                ...(snap.ok && snap.unmerged_probe_failed === true
                  ? { unmerged_probe_failed: true }
                  : {}),
              };
            },
          },
        }
      );

      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior open with a ` +
            `different payload. Use a fresh key.`,
          'idempotency_key'
        );
      }

      if (result.outcome === 'blocked') {
        // Either fresh block (idempotencyOutcome='created') or
        // soft_blocked replay (idempotencyOutcome='replay'). The
        // envelope shape is identical; tests can disambiguate via the
        // record's recorded_at if needed.
        return result.envelope as Record<string, unknown>;
      }

      if (result.outcome === 'replay') {
        if (
          !hasLifecycleCompletion(ctx, {
            artifactId,
            firesAt: 'checkpoint-open',
            sequenceN: result.checkpoint.n,
          })
        ) {
          await recordLifecycleCompletion(ctx, {
            artifactId,
            firesAt: 'checkpoint-open',
            sequenceN: result.checkpoint.n,
          });
        }
        return {
          artifact_id: artifactId,
          n: result.checkpoint.n,
          status: 'open',
          declared_step_ids: result.checkpoint.declared_step_ids,
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: `Returning prior open cp for idempotency_key="${input.idempotency_key}".`,
        };
      }

      await recordLifecycleCompletion(ctx, {
        artifactId,
        firesAt: 'checkpoint-open',
        sequenceN: result.checkpoint.n,
      });

      // Loud, non-blocking open-output warnings — the same `warnings[]` surface
      // close already emits (`empty-diff-window`, `window-overlap-*`), added here
      // because open had none at all. This is the consequential half: a failed
      // open poisons the close fingerprint via 'missing_open_tree_sha' long after
      // the fact, so an unreported open failure is how a capture outage stays
      // invisible. Only the FRESH path warns — the replay arm above returns
      // before this, and its callback never ran (nothing was captured, and the
      // prior run's stderr was never persisted to re-derive).
      const invalidExcludes = resolveCaptureExcludes(ctx.config.capture).invalid;
      const openWarnings = [
        ...(invalidExcludes.length > 0 ? [captureExcludeInvalidWarning(invalidExcludes)] : []),
        ...openSnapshotFailures.map((f) => snapshotCaptureFailedWarning(result.checkpoint.n, f)),
        ...(openDegraded.paths.length > 0
          ? [unmergedPathsDegradedWarning(result.checkpoint.n, 'open', openDegraded.paths)]
          : []),
        ...(openDegraded.probeFailed
          ? [unmergedProbeFailedWarning(result.checkpoint.n, 'open')]
          : []),
        ...(openExcludeProbeFailed
          ? [captureExcludeProbeFailedWarning(result.checkpoint.n, 'open')]
          : []),
      ];

      return {
        artifact_id: artifactId,
        n: result.checkpoint.n,
        status: 'open',
        declared_step_ids: result.checkpoint.declared_step_ids,
        agent_session_id: result.checkpoint.agent_session_id,
        policy_exceptions: result.checkpoint.policy_exceptions,
        opened_at: result.checkpoint.opened_at,
        usageStamp: {
          lifecycle_event: 'checkpoint_open',
          artifactId,
          checkpoint_n: result.checkpoint.n,
          baselineHint: 'prior_same_artifact',
          asOf: result.checkpoint.opened_at,
          stableEventId: usageStampKey(artifactId, 'checkpoint_open', result.checkpoint.n),
        } satisfies UsageStampDescriptor,
        ...(openWarnings.length > 0 ? { warnings: openWarnings } : {}),
      };
    },
    {
      parseInput: async () =>
        CaptureCheckpointOpenInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    }
  );
}

/**
 * Close an open checkpoint. The agent passes back `n` from the prior
 * open call; runtime validates that an open cp at `n` exists and that
 * `completed_step_ids ⊆ declared_step_ids`. Fires
 * `checkpoint-close` evaluators.
 */
export async function captureCheckpointCloseAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });

      // Resolve which open checkpoint to close: explicit `n`, or — when
      // omitted — the single open cp (AMBIGUOUS_CHECKPOINT if more than one
      // is open under concurrent subagent work). Storage re-validates `n`
      // under the lock, so this pre-lock read is convenience only.
      const committedReplayN =
        input.n === undefined
          ? await ctx.store.findCommittedCheckpointCloseN(artifactId, input.idempotency_key)
          : null;
      const n = committedReplayN ?? resolveCloseCheckpointN(ctx, artifactId, input.n);

      // Storage owns all post-parse validation: in-range, no-dups,
      // and subset-of-declared. Each surfaces as a typed
      // CheckpointValidationError mapped to INVALID_INPUT at the CLI
      // boundary (see run-capture.ts).

      const closeHeadSha = await ctx.repo.getHeadSha();

      // The close callback below is a CLI-defined closure, so it sets
      // this closure-local directly when it sees an empty open/close fence.
      // Storage destructures only {boundary, summary, manifest} from the callback
      // result, so a *returned* field would be dropped — the closure variable is
      // the propagation path. It is fixed from tree equality BEFORE the diff, so a
      // later diff/build/recovery failure cannot reset it.
      let fenceEmpty = false;

      // Same closure-local propagation, for the close snapshot's own capture
      // failure. Storage destructures only {boundary, summary, manifest}, and
      // neither of those can carry the git stderr (see toBoundary).
      const closeSnapshotFailures: SnapshotCaptureFailure[] = [];
      let closeExcludeProbeFailed = false;

      const result = await ctx.store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n,
          summary: input.summary,
          files_changed: input.files_changed,
          decisions: input.decisions,
          uncertainty: input.uncertainty,
          done_criteria: input.done_criteria,
          verification: input.verification,
          completed_step_ids: input.completed_step_ids,
          head_sha: closeHeadSha,
        },
        {
          idempotencyKey: input.idempotency_key,
          // Runtime provenance — kept OUT of replayPayload (see open).
          invokedByAgent: ctx.invokingAgent.agent,
          // `verification` rides both replay-shape sides conditionally
          // (this payload + extractCloseReplayShape) — the SECOND replay
          // shape the optional-absent contract must cover; asymmetry here
          // turns a retried close into IDEMPOTENCY_CONFLICT.
          replayPayload: {
            artifact_id: artifactId,
            n,
            summary: input.summary,
            files_changed: input.files_changed,
            decisions: input.decisions,
            uncertainty: input.uncertainty,
            done_criteria: input.done_criteria,
            ...(input.verification.length > 0 ? { verification: input.verification } : {}),
            completed_step_ids: input.completed_step_ids,
          },
          extractReplayShape: (priorPayload) => extractCloseReplayShape(priorPayload),
          snapshotCallbacks: {
            captureCloseFingerprint: async ({
              openCheckpoint,
              closeContext,
              recovery,
              overlap,
            }) => {
              const cap = ctx.config.diff_fingerprint;
              if (!cap.enabled) return makeSkippedCloseResult(null);

              const closeSnap = await captureCheckpointSnapshot({
                excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
                repo: ctx.repo,
                artifactId: closeContext.artifact_id,
                checkpointN: closeContext.n,
                phase: 'close',
              });
              closeExcludeProbeFailed = closeSnap.ok && closeSnap.exclusion_probe_failed === true;
              if (!closeSnap.ok) {
                closeSnapshotFailures.push(toSnapshotFailure(closeSnap));
                return makeSkippedCloseResult(closeSnap.error_reason, closeSnap);
              }
              const openTreeSha = openCheckpoint.open_snapshot.tree_sha;
              if (openTreeSha === null) {
                return makeSkippedCloseResult('missing_open_tree_sha', closeSnap);
              }

              // Ground-truth the empty fence by TREE EQUALITY, the moment
              // both trees are known and BEFORE the diff. NOT hunk_count === 0: a
              // truncated large in-window change also has zero hunks, which would
              // both falsely warn and wrongly trigger C recovery on a correctly
              // opened cp. fenceEmpty stays false when a tree is unavailable (the
              // early returns above), and survives any later diff/build failure.
              fenceEmpty = closeSnap.tree_sha !== null && openTreeSha === closeSnap.tree_sha;

              const diff = await diffSnapshotTrees({
                repo: ctx.repo,
                openTreeSha,
                closeTreeSha: closeSnap.tree_sha,
                maxDiffBytes: cap.max_diff_bytes,
              });
              if (!diff.ok) return makeSkippedCloseResult('git_diff_failed', closeSnap);

              const built = await buildDiffFingerprintManifest({
                artifactId: closeContext.artifact_id,
                checkpointN: closeContext.n,
                openTreeSha,
                closeTreeSha: closeSnap.tree_sha,
                diffBytes: diff.diff,
                truncated: diff.truncated,
                maxDiffBytes: cap.max_diff_bytes,
              });

              // Empty-fence recovery (silent salvage; the empty-window warning is
              // the behaviour signal and already fired off `fenceEmpty`). When the
              // open/close fence is empty but files were claimed and recovery is
              // not blocked, re-diff from the HWM baseline (or the plan-time seed)
              // scoped to the declared files, and emit a real captured/truncated
              // manifest whose open_tree_sha is the baseline (≠ the cp's real open
              // — readers MUST treat the manifest's own tree fields as
              // authoritative). The close boundary stays the REAL close tree.
              // Fail-open: this MUST NOT throw out of the callback — any failure
              // falls back to `built` (the empty summary), so the store keeps the
              // real close boundary and the warning still stands.
              if (fenceEmpty && recovery.filesChanged.length > 0 && !recovery.recoveryBlocked) {
                const baseline = recovery.hwmBaselineTreeSha ?? recovery.seedBaselineTreeSha;
                if (baseline !== null) {
                  try {
                    const recoveredDiff = await diffSnapshotTrees({
                      repo: ctx.repo,
                      openTreeSha: baseline,
                      closeTreeSha: closeSnap.tree_sha,
                      maxDiffBytes: cap.max_diff_bytes,
                      pathspecs: [...recovery.filesChanged],
                    });
                    if (recoveredDiff.ok) {
                      const recovered = await buildDiffFingerprintManifest({
                        artifactId: closeContext.artifact_id,
                        checkpointN: closeContext.n,
                        openTreeSha: baseline,
                        closeTreeSha: closeSnap.tree_sha,
                        diffBytes: recoveredDiff.diff,
                        truncated: recoveredDiff.truncated,
                        maxDiffBytes: cap.max_diff_bytes,
                      });
                      // Keep the recovery only if it attributed something — status
                      // 'captured' OR 'truncated' (an over-cap recovery is useful
                      // partial attribution). 'empty'/'skipped' → fall through to
                      // the empty `built` (e.g. files_changed under-reported).
                      if (
                        recovered.manifest !== null &&
                        // Require real hunks.
                        // A cap-truncated recovery can have hunk_count 0 — accepting
                        // it would flip the cp to a misleading 'truncated' with zero
                        // per-line attribution; fall back to the empty summary instead.
                        recovered.summary.hunk_count > 0 &&
                        (recovered.summary.status === 'captured' ||
                          recovered.summary.status === 'truncated')
                      ) {
                        return {
                          boundary: toBoundary(closeSnap).boundary,
                          summary: recovered.summary,
                          manifest: recovered.manifest,
                          ...(closeSnap.unmerged_paths.length > 0
                            ? { unmerged_paths: [...closeSnap.unmerged_paths] }
                            : {}),
                          ...(closeSnap.unmerged_probe_failed === true
                            ? { unmerged_probe_failed: true }
                            : {}),
                        };
                      }
                    }
                  } catch {
                    // Fail-open: fall through to the empty `built` below. The
                    // warning (off fenceEmpty) still fires.
                  }
                }
              }

              // Segment evidence for the claims partition. The
              // store detected the overlap under its lock and passed the
              // group's boundary list; this callback owns the git work, so
              // it appends its fresh close boundary and computes the
              // per-segment file-sets (uncapped name-status tree diffs —
              // never the byte-capped patch pipeline). Fail-open: any
              // failure returns no evidence and the store partitions
              // claims-only, disclosed.
              let segmentEvidence: WindowSegment[] | undefined;
              if (overlap !== undefined && closeSnap.tree_sha !== null) {
                try {
                  segmentEvidence = await computeWindowSegments({
                    repo: ctx.repo,
                    boundaries: [
                      ...overlap.boundaries,
                      {
                        eventIdx: overlap.currentCloseIdx,
                        n: closeContext.n,
                        phase: 'close',
                        treeSha: closeSnap.tree_sha,
                      },
                    ],
                  });
                } catch {
                  // Degraded to claims-only; the store discloses it.
                }
              }

              return {
                boundary: toBoundary(closeSnap).boundary,
                summary: built.summary,
                manifest: built.manifest,
                ...(segmentEvidence !== undefined ? { segment_evidence: segmentEvidence } : {}),
                ...(closeSnap.unmerged_paths.length > 0
                  ? { unmerged_paths: [...closeSnap.unmerged_paths] }
                  : {}),
                ...(closeSnap.unmerged_probe_failed === true
                  ? { unmerged_probe_failed: true }
                  : {}),
              };
            },
          },
        }
      );

      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior close with a ` +
            `different payload. Use a fresh key.`,
          'idempotency_key'
        );
      }
      if (result.outcome === 'replay') {
        // The success-path `fenceEmpty` closure never ran (writeCheckpointClosed
        // short-circuited to the committed cp), so re-derive the warning from the
        // PERSISTED open/close tree equality. This mirrors the live definition and
        // survives C recovery — recovery rewrites only the manifest's base tree,
        // never the checkpoint's snapshot boundaries — so the replay re-emits the
        // warning whether or not recovery landed. Do NOT proxy on summary.status
        // ('empty' diverges from tree equality once recovery sets 'captured').
        const cp = result.checkpoint;
        const replayFenceEmpty =
          cp.open_snapshot.tree_sha !== null &&
          cp.close_snapshot.tree_sha !== null &&
          cp.open_snapshot.tree_sha === cp.close_snapshot.tree_sha;
        const replayWarnings = [
          ...(replayFenceEmpty && cp.files_changed.length > 0
            ? [emptyDiffWindowWarning(cp.n)]
            : []),
          ...attributionDegradedWarnings(cp.n, cp.attribution_degraded),
          ...windowOverlapWarnings(cp.n, cp.window_overlap),
        ];
        const completionKey = {
          artifactId,
          firesAt: 'checkpoint-close' as const,
          sequenceN: cp.n,
        };
        const resumesPostEventWork = !hasLifecycleCompletion(ctx, completionKey);
        if (resumesPostEventWork) {
          await runLifecycleEvaluators({
            ctx,
            artifactId,
            firesAt: 'checkpoint-close',
            checkpointN: cp.n,
            noLlm: opts.noLlm,
          });
          await recordLifecycleCompletion(ctx, completionKey);
        }
        return {
          artifact_id: artifactId,
          n: cp.n,
          status: 'closed',
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: resumesPostEventWork
            ? `Returning prior closed cp for idempotency_key="${input.idempotency_key}"; ` +
              `missing post-event evaluator work was resumed.`
            : `Returning prior closed cp for idempotency_key="${input.idempotency_key}".`,
          ...(replayWarnings.length > 0 ? { warnings: replayWarnings } : {}),
        };
      }

      const evalResult = await runLifecycleEvaluators({
        ctx,
        artifactId: artifactId,
        firesAt: 'checkpoint-close',
        checkpointN: n,
        noLlm: opts.noLlm,
      });
      await recordLifecycleCompletion(ctx, {
        artifactId,
        firesAt: 'checkpoint-close',
        sequenceN: n,
      });

      // Non-blocking empty-diff-window warning. Keyed on the
      // closure-local fenceEmpty (fixed before any C recovery rewrote the
      // summary) AND files_changed — NOT completed_step_ids, so verification-only
      // checkpoints never warn (doc Invariant 2). Leaves blocking /
      // evaluator_results untouched. The loud window-overlap warnings
      // (unclaimed/unattributed files, rejected claims, ambiguity,
      // mixed-segment) ride the persisted partition record.
      //
      // The snapshot-capture failure leads: it is the most fundamental of the
      // three (no close tree ⇒ no fingerprint at all), and it is the only one
      // carrying diagnostic text that exists nowhere else — the persisted
      // boundary keeps just the typed reason (see toBoundary).
      const closeWarnings = [
        ...closeSnapshotFailures.map((f) => snapshotCaptureFailedWarning(n, f)),
        ...attributionDegradedWarnings(n, result.checkpoint.attribution_degraded),
        ...(fenceEmpty && input.files_changed.length > 0 ? [emptyDiffWindowWarning(n)] : []),
        ...windowOverlapWarnings(n, result.checkpoint.window_overlap),
        ...(closeExcludeProbeFailed ? [captureExcludeProbeFailedWarning(n, 'close')] : []),
      ];

      return {
        artifact_id: artifactId,
        n,
        status: 'closed',
        usageStamp: {
          lifecycle_event: 'checkpoint_close',
          artifactId,
          checkpoint_n: n,
          baselineHint: 'checkpoint_open',
          asOf: new Date().toISOString(),
          stableEventId: usageStampKey(artifactId, 'checkpoint_close', n),
        } satisfies UsageStampDescriptor,
        ...evalResult,
        ...(closeWarnings.length > 0 ? { warnings: closeWarnings } : {}),
      };
    },
    {
      parseInput: async () =>
        CaptureCheckpointCloseInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    }
  );
}

/**
 * Loud, non-blocking close-output warnings off the persisted
 * `window_overlap` partition record: every removed-unclaimed
 * or finalized-unattributed file, rejected claims, ambiguity, and
 * mixed-segment downgrades. Attribution trust failures must never scroll
 * past silently.
 */
function windowOverlapWarnings(
  n: number,
  wo: WindowOverlap | undefined
): Array<{ code: string; message: string }> {
  if (wo === undefined) return [];
  const warnings: Array<{ code: string; message: string }> = [];
  const droppedUnclaimed = wo.dropped_files
    .filter((d) => d.status === 'unclaimed')
    .map((d) => d.file_after ?? d.file_before ?? '(unknown)');
  const unattributed = [...new Set([...droppedUnclaimed, ...wo.unattributed_in_window])].sort();
  if (unattributed.length > 0) {
    warnings.push({
      code: 'window-overlap-unattributed',
      message:
        `Checkpoint ${n} closed a concurrent window with in-window changes NO checkpoint ` +
        `accounts for: ${unattributed.join(', ')}. This work has no attribution owner — ` +
        `claim it on the checkpoint that produced it.`,
    });
  }
  if (wo.rejected_claims.length > 0) {
    warnings.push({
      code: 'window-overlap-rejected-claims',
      message:
        `Checkpoint ${n} claimed files that segment evidence contradicts (changed only ` +
        `while this checkpoint was not open): ${wo.rejected_claims.join(', ')}. The claims ` +
        `were not honored.`,
    });
  }
  if (wo.ambiguous_files.length > 0) {
    warnings.push({
      code: 'window-overlap-ambiguous',
      message:
        `Checkpoint ${n} and a concurrent sibling both claim: ${wo.ambiguous_files
          .map((f) => f.file_after ?? f.file_before ?? '(unknown)')
          .join(', ')}. Kept in both manifests, flagged ambiguous — attribution consumers ` +
        `treat these as weak evidence.`,
    });
  }
  if (wo.mixed_segment.length > 0) {
    warnings.push({
      code: 'window-overlap-mixed-segment',
      message:
        `Checkpoint ${n} has files with both exclusive and concurrent-segment changes: ` +
        `${wo.mixed_segment
          .map((f) => f.file_after ?? f.file_before ?? '(unknown)')
          .join(', ')}. Kept on segment evidence, downgraded for attribution.`,
    });
  }
  if (wo.segment_attributed.length > 0) {
    warnings.push({
      code: 'window-overlap-unreported-attributed',
      message:
        `Checkpoint ${n} did not report ${wo.segment_attributed.join(', ')} in ` +
        `files_changed, but exclusive-segment evidence attributes them to it — kept. ` +
        `Report files_changed accurately: it is the attribution claim under overlap.`,
    });
  }
  return warnings;
}

/**
 * Resolve which open checkpoint `close` targets. With `n` supplied, use it
 * verbatim (storage re-validates in range under the lock). With `n` omitted,
 * target the single open checkpoint; 0 open → INVALID_INPUT, >1 open →
 * AMBIGUOUS_CHECKPOINT with a structured `open_checkpoints[]` list so the
 * agent re-issues naming one `n`. Highest-`n` is deliberately NOT auto-picked
 * — under concurrent subagent work it could close another agent's cp.
 */
function resolveCloseCheckpointN(
  ctx: CliContext,
  artifactId: string,
  explicitN: number | undefined
): number {
  if (explicitN !== undefined) return explicitN;

  const open = ctx.store.store.getOpenCheckpoints(artifactId);
  if (open.length === 1) return open[0].n;
  if (open.length === 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No open checkpoint to close on artifact "${artifactId}".`,
      'n'
    );
  }
  const candidates: OpenCheckpointCandidate[] = open.map((c) => ({
    n: c.n,
    declared_step_ids: c.declared_step_ids,
    agent_session_id: c.agent_session_id,
    opened_at: c.opened_at,
  }));
  const ns = candidates.map((c) => `#${c.n}`).join(', ');
  throw new OrcaopsError(
    ErrorCodes.AMBIGUOUS_CHECKPOINT,
    `${candidates.length} open checkpoints (${ns}) under concurrent work; pass n explicitly.`,
    'n',
    { open_checkpoints: candidates }
  );
}

/**
 * Abandon an open checkpoint without claiming work. Releases the
 * declared_step_ids so they can be re-opened. Bookkeeping only —
 * no evaluators fire on abandon.
 */
export async function captureCheckpointAbandonAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });

      // Same closure-local propagation as open/close — abandon shares the
      // mapper, so it gets the same surface for free.
      const abandonSnapshotFailures: SnapshotCaptureFailure[] = [];
      const abandonDegraded = {
        paths: [] as string[],
        probeFailed: false,
        excludeProbeFailed: false,
      };

      const result = await ctx.store.writeCheckpointAbandoned(
        {
          artifact_id: artifactId,
          n: input.n,
          reason: input.reason,
        },
        {
          idempotencyKey: input.idempotency_key,
          // Runtime provenance — kept OUT of replayPayload (see open).
          invokedByAgent: ctx.invokingAgent.agent,
          replayPayload: { artifact_id: artifactId, n: input.n, reason: input.reason },
          extractReplayShape: (priorPayload) => extractAbandonReplayShape(priorPayload),
          snapshotCallbacks: {
            captureAbandonSnapshot: async ({ artifact_id, n }) => {
              if (!ctx.config.diff_fingerprint.enabled) {
                return { boundary: buildDefaultSkippedSnapshotBoundary() };
              }
              const snap = await captureCheckpointSnapshot({
                excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
                repo: ctx.repo,
                artifactId: artifact_id,
                checkpointN: n,
                phase: 'abandon',
              });
              const mapped = toBoundary(snap);
              if (mapped.failure !== undefined) abandonSnapshotFailures.push(mapped.failure);
              if (snap.ok) {
                abandonDegraded.paths.push(...snap.unmerged_paths);
                abandonDegraded.probeFailed = snap.unmerged_probe_failed === true;
                abandonDegraded.excludeProbeFailed = snap.exclusion_probe_failed === true;
              }
              return { boundary: mapped.boundary };
            },
          },
        }
      );
      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior abandon with a ` +
            `different payload. Use a fresh key.`,
          'idempotency_key'
        );
      }
      if (result.outcome === 'replay') {
        return {
          artifact_id: artifactId,
          n: result.checkpoint.n,
          status: 'abandoned',
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: `Returning prior abandoned cp for idempotency_key="${input.idempotency_key}".`,
        };
      }

      const abandonWarnings = [
        ...abandonSnapshotFailures.map((f) => snapshotCaptureFailedWarning(input.n, f)),
        // Disclosure only — abandon persists nothing beyond the boundary.
        ...(abandonDegraded.paths.length > 0
          ? [unmergedPathsDegradedWarning(input.n, 'abandon', abandonDegraded.paths)]
          : []),
        ...(abandonDegraded.probeFailed ? [unmergedProbeFailedWarning(input.n, 'abandon')] : []),
        ...(abandonDegraded.excludeProbeFailed
          ? [captureExcludeProbeFailedWarning(input.n, 'abandon')]
          : []),
      ];

      return {
        artifact_id: artifactId,
        n: input.n,
        status: 'abandoned',
        reason: result.checkpoint.reason,
        abandoned_at: result.checkpoint.abandoned_at,
        ...(abandonWarnings.length > 0 ? { warnings: abandonWarnings } : {}),
        // Stamp usage for the abandoned span (delta vs this cp's open snapshot,
        // mirroring checkpoint_close). The replay arm above returns earlier
        // without this field, so a re-abandon never re-stamps.
        usageStamp: lifecycleUsageStamp({
          event: 'checkpoint_abandon',
          artifactId,
          baselineHint: 'checkpoint_open',
          checkpoint_n: input.n,
          asOf: result.checkpoint.abandoned_at,
          discriminator: input.n,
        }),
      };
    },
    {
      parseInput: async () =>
        CaptureCheckpointAbandonInputSchema.parse(
          await readPayloadInput({ inputPath: opts.input })
        ),
    }
  );
}

function extractOpenReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    declared_step_ids: p.declared_step_ids,
    agent_session_id: p.agent_session_id,
    policy_exceptions: p.policy_exceptions,
    plan_revision_id: p.plan_revision_id ?? null,
  };
}

function extractCloseReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    n: p.n,
    summary: p.summary,
    files_changed: p.files_changed,
    decisions: p.decisions,
    uncertainty: p.uncertainty,
    done_criteria: p.done_criteria,
    // Symmetric conditional include — optional-absent.
    ...(p.verification !== undefined ? { verification: p.verification } : {}),
    completed_step_ids: p.completed_step_ids,
  };
}

function extractAbandonReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    n: p.n,
    reason: p.reason,
  };
}

/**
 * The single place that decides what a failed capture's response-time record
 * looks like. `toBoundary` produces it for open/abandon; the close callback
 * calls it directly (its boundary is built by `makeSkippedCloseResult`).
 */
function toSnapshotFailure(snap: Extract<SnapshotResult, { ok: false }>): SnapshotCaptureFailure {
  return {
    phase: snap.phase,
    reason: snap.error_reason,
    ...(snap.error_message !== undefined ? { message: snap.error_message } : {}),
  };
}

/**
 * Maps a SnapshotResult onto a CheckpointSnapshotBoundary. Success
 * populates ref/tree/commit; failure flips into the default-skip shape
 * with snapshot_error_reason set to the typed failure reason. Open and
 * abandon callbacks use this directly (their boundary IS the
 * failure-reporting channel since they have no summary); the close
 * callback uses it on its success path (close-snap failures route
 * through makeSkippedCloseResult instead, since the summary carries
 * the failure reason there too).
 *
 * `failure` (the git stderr) rides ALONGSIDE the boundary and is never put
 * INSIDE it: `CheckpointSnapshotBoundary` is `.strict()` — an extra key is a
 * parse error, not an ignored field — and it is declared in the VENDORED
 * prebuilt `@orcaops/protocol` 0.0.24 tarball, reached via
 * `@orcaops/diff-fingerprint` 0.0.4 (see `packages/storage/package.json`).
 * Its four fields (snapshot_ref, tree_sha, snapshot_commit_sha,
 * snapshot_error_reason) are all nullable and none can carry free text, and
 * `snapshot_error_reason` is pinned to the same vendored
 * `SnapshotFailureReasonSchema` enum. So NEITHER adding a message field NOR
 * minting a more specific reason is a local change: both need an upstream
 * protocol release plus a re-vendor.
 *
 * Until then the message is surfaced at the MOMENT OF FAILURE — a
 * `snapshot-capture-failed` entry in the command response's `warnings[]` —
 * rather than stored. Callers MUST forward it; a persisted
 * `snapshot_error_reason: 'unknown'` with the stderr dropped here is a silent
 * capture failure.
 */
function toBoundary(snap: SnapshotResult): {
  boundary: CheckpointSnapshotBoundary;
  failure?: SnapshotCaptureFailure;
} {
  if (snap.ok) {
    return {
      boundary: {
        snapshot_ref: snap.ref,
        tree_sha: snap.tree_sha,
        snapshot_commit_sha: snap.commit_sha,
        snapshot_error_reason: null,
      },
    };
  }
  return {
    boundary: {
      ...buildDefaultSkippedSnapshotBoundary(),
      snapshot_error_reason: snap.error_reason,
    },
    failure: toSnapshotFailure(snap),
  };
}

/**
 * Builds the close callback's skip-result triple. Three call shapes:
 *
 *   makeSkippedCloseResult(null)
 *     — config disabled; no snap attempted. Boundary is default-skip.
 *
 *   makeSkippedCloseResult(closeSnap.error_reason, closeSnap)
 *     — close-snap was attempted and failed. Boundary preserves
 *       snapshot_error_reason via toBoundary's failure branch — the
 *       diagnostic stays visible at the boundary layer alongside
 *       summary.error_reason.
 *
 *   makeSkippedCloseResult(reason, closeSnap)
 *     — close-snap succeeded but diff/build couldn't run; boundary
 *       pinned from the successful snap.
 *
 * `snap` widens to the full SnapshotResult union (not just the
 * ok-variant) so the close-snap-failed path preserves the boundary's
 * error_reason. toBoundary handles both ok and !ok cases.
 */
function makeSkippedCloseResult(
  errorReason: DiffFingerprintFailureReason | null,
  snap?: SnapshotResult
): {
  boundary: CheckpointSnapshotBoundary;
  summary: DiffFingerprintSummary;
  manifest: DiffFingerprintManifest | null;
  unmerged_paths?: string[];
  unmerged_probe_failed?: boolean;
} {
  const boundary = snap ? toBoundary(snap).boundary : buildDefaultSkippedSnapshotBoundary();
  return {
    boundary,
    summary: { ...buildDefaultSkippedFingerprintSummary(), error_reason: errorReason },
    manifest: null,
    // A successful close snap still reports its unmerged set (and a failed
    // probe) even when the fingerprint is skipped — the degraded disclosure
    // must not depend on the manifest existing.
    ...(snap?.ok === true && snap.unmerged_paths.length > 0
      ? { unmerged_paths: [...snap.unmerged_paths] }
      : {}),
    ...(snap?.ok === true && snap.unmerged_probe_failed === true
      ? { unmerged_probe_failed: true }
      : {}),
  };
}

/**
 * Project the full EvaluatorRunPayload to the embedded GateAuditRun
 * shape. The rebuilder re-synthesizes the dropped
 * fields (artifact_id, package_id, evaluator_id, checkpoint_n,
 * agent_session_id) from the parent `checkpoint_opened` event, so we
 * deliberately omit them on the wire to keep the payload compact.
 */
function toGateAuditRun(r: EvaluatorRunPayload): GateAuditRun {
  return {
    run_id: r.run_id,
    evaluator_ref: r.evaluator_ref,
    phase: r.phase,
    severity: r.severity,
    run_status: r.run_status,
    verdict: r.verdict,
    body: r.body,
    ...(r.raw !== undefined ? { raw: r.raw } : {}),
    ...(r.metrics !== undefined ? { metrics: r.metrics } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
    ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}),
    ...(r.duration_ms !== undefined ? { duration_ms: r.duration_ms } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ts: r.ts,
  };
}
