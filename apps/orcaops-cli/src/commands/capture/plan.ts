import {
  captureBaselineSnapshot,
  pinBaselineTree,
  resolveReviewBaseline,
  sourcePlanView,
} from '@orcaops/core';
import {
  assertNoSecretsInPayload,
  canonicalSourcePlanRefId,
  CapturePlanInputSchema,
  lookupOrInsertPlanIdempotency,
  PlanIdempotencyPendingError,
  type PlanInput,
  type PlanStep,
  RecoveryRefusedError,
  resolveCaptureExcludes,
  type SecretFinding,
  uuidv7,
  withNonDerivableWriteLease,
} from '@orcaops/storage';

import { InfoCodes } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { writeTerminalSafeStderr } from '../../io/output.js';
import { assertNoSecretsOutbound } from '../../lib/cloud-secret-gate.js';
import type { CliContext } from '../../lib/context.js';
import {
  hasLifecycleCompletion,
  recordLifecycleCompletion,
  runLifecycleEvaluators,
} from '../../lib/evaluator-bridge.js';
import { replacePin, resolvePinTargets } from '../../lib/pin-helpers.js';
import { loadSecretAllowlist, runCaptureWithSync } from '../../lib/run-capture.js';
import { resolveSourcePlan } from '../../lib/source-plan-resolver.js';
import {
  stampSourcePlanLink,
  type UsageStampDescriptor,
  usageStampKey,
} from '../../lib/usage-stamp.js';

export interface CapturePlanOptions {
  input?: string;
  noLlm?: boolean;
  /**
   * `--source-plan <ref>` — a ref (MVP: a local path) whose
   * content is read, hashed, and pinned immutably on the artifact.
   */
  sourcePlan?: string;
}

export async function capturePlanAction(opts: CapturePlanOptions = {}): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const branch = input.branch ?? (await ctx.repo.getCurrentBranch());
      const baseSha = await ctx.repo.getHeadSha();
      const startedAt = new Date().toISOString();
      const secretAllowlist = await loadSecretAllowlist();

      // Resolve the pinned source plan BEFORE the idempotency
      // insert below. `lookupOrInsertPlanIdempotency` eagerly commits the
      // key→artifact_id row; resolving (and failing on a missing/unreadable
      // file) AFTER it would leave a committed replay row pointing at an
      // artifact `writePlan` never wrote. Resolve-first → fail loud before
      // any persistent state exists. (The pin is excluded from the
      // idempotency payload — see writePlan.)
      const sourcePlanResolution = opts.sourcePlan
        ? await resolveSourcePlan(opts.sourcePlan, ctx.repoRoot, secretAllowlist)
        : undefined;
      const resolved = sourcePlanResolution?.pin;

      const assembledPlanSecretWarnings: readonly SecretFinding[] = assertNoSecretsInPayload(
        { ...input, branch },
        secretAllowlist
      );
      const planSecretWarnings = [
        ...(sourcePlanResolution?.secretWarnings.map((finding) => ({
          ...finding,
          path: `source_plan.${finding.path}`,
        })) ?? []),
        ...assembledPlanSecretWarnings,
      ];

      // Project-wide idempotency: same key → reuse the prior artifact.
      // Hash the agent-supplied input shape (text-only steps) so a
      // replay matches independent of which step_ids the runtime
      // mints — the runtime mints fresh UUIDv7 step_ids on the first
      // call, and a same-key replay returns the prior artifact intact.
      const dedup = await withNonDerivableWriteLease(ctx.repoRoot, () =>
        lookupOrInsertPlanIdempotency({
          store: ctx.store.store,
          idempotencyKey: input.idempotency_key,
          payload: {
            task: input.task,
            label: input.label,
            plan_steps: input.plan_steps,
            branch,
            non_goals: input.non_goals,
            // Included for payload parity with non_goals. The key-only
            // initial-capture path does not load or compare a prior payload.
            decisions: input.decisions,
          },
          mintArtifactId: () => uuidv7(),
          now: () => startedAt,
          // A planless cache reservation is never replayed as success. A
          // confirmed pre-append failure is rolled back below; a durable
          // event with incomplete projections stays reserved for rebuild +
          // same-key replay.
          hasPublishedPlan: (id) => ctx.store.store.latestPlanRevisionN(id) >= 0,
        })
      );

      if (dedup.outcome === 'replay') {
        // Idempotent replay: the user is still working on the same
        // artifact, so re-establish the pin for this shell. Same-id
        // overwrite is silent (no pin_displaced). The frozen pin (baseline
        // included) is freeze-at-capture: returning here, BEFORE the
        // baseline freeze below, makes the no-rewrite rule structural — a
        // replay with a moved HEAD never resolves git state it would have
        // to discard.
        const completionKey = {
          artifactId: dedup.artifactId,
          firesAt: 'post-plan' as const,
        };
        const resumesPostEventWork = !hasLifecycleCompletion(ctx, completionKey);
        if (resumesPostEventWork) {
          await runLifecycleEvaluators({
            ctx,
            artifactId: dedup.artifactId,
            firesAt: 'post-plan',
            noLlm: opts.noLlm,
          });
          await recordLifecycleCompletion(ctx, completionKey);
        }
        await maybeAutoPin(ctx, dedup.artifactId, branch, startedAt);
        return {
          artifact_id: dedup.artifactId,
          branch,
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: resumesPostEventWork
            ? `Returning prior artifact for idempotency_key="${input.idempotency_key}"; ` +
              `missing post-event evaluator work was resumed.`
            : `Returning prior artifact for idempotency_key="${input.idempotency_key}"; ` +
              `no new evaluators ran.`,
          secretWarnings: planSecretWarnings,
        };
      }

      const artifactId = dedup.artifactId;

      // Mint a stable UUIDv7 step_id per input step. Step_ids are the
      // canonical identity for plan steps across revisions; ordinals
      // are just display position; `label` is the renamable short-form
      // human headline displayed alongside the full step text.
      const planSteps: PlanStep[] = input.plan_steps.map((s) => ({
        step_id: uuidv7(),
        text: s.text,
        label: s.label,
        // Mint a stable UUIDv7 criterion_id per acceptance criterion
        // (mirrors step_id); revision-stable, keyed by done_criteria at close.
        acceptance_criteria: s.acceptance_criteria.map((c) => ({
          criterion_id: uuidv7(),
          text: c.text,
        })),
      }));

      const plan: PlanInput = {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: baseSha,
        // Runtime-resolved invoking agent (flag > env > ambient > 'other')
        // — the authoring agent of this artifact, frozen at capture.
        agent: ctx.invokingAgent.agent,
        agent_session_id: input.agent_session_id ?? null,
        task: input.task,
        label: input.label,
        plan_steps: planSteps,
        touched_scope: input.touched_scope,
        non_goals: input.non_goals,
        // Stamp revision_n: 0 on every initial-capture decision — the agent
        // supplies the base shape (no revision_n); the write path owns the tag.
        decisions: input.decisions.map((d) => ({ ...d, revision_n: 0 })),
        started_at: startedAt,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      };

      // Plan-time baseline seed (created path only — the replay early-return above means a
      // replay never captures a baseline). GATED on the SAME condition as
      // checkpoint snapshot capture (`diff_fingerprint.enabled`, the privacy
      // opt-out — capture is local-first and deliberately NOT gated on cloud
      // auth): the plan-time baseline only feeds empty-fence recovery, and
      // recovery only runs when checkpoint snapshots are captured (same gate).
      // Capturing it when fingerprinting is disabled would write a
      // full-worktree tree and pin a lingering `refs/orcaops/baseline/<artifact>`
      // ref that recovery can never consume. When the gate is closed both
      // fields stay null.
      let baselineSeedTreeSha: string | null = null;
      let baselineUnmergedPaths: readonly string[] = [];
      let supersededArtifactId: string | null = null;
      let sourcePlan = resolved;
      let planEventId: string;
      try {
        // Freeze the authoring baseline at CAPTURE time on the created path.
        // Replays returned above without observing new git state. Scan the
        // exact values that will be persisted before snapshots or events are
        // written; the catch below releases an unpublished reservation.
        if (resolved?.source_ref.kind === 'local') {
          const baseline = await resolveReviewBaseline(ctx.repo);
          // head_sha is derived structural identity, not authored metadata.
          const baselineSecretWarnings = assertNoSecretsOutbound(
            'source-plan',
            [
              ['source_plan.baseline.repo_url', baseline?.repo_url],
              ['source_plan.baseline.branch', baseline?.branch],
            ],
            secretAllowlist
          );
          const repeatsPlanBranch =
            baseline?.branch === branch &&
            assembledPlanSecretWarnings.some((finding) => finding.path === 'branch');
          planSecretWarnings.push(
            ...baselineSecretWarnings.filter(
              (finding) => !(repeatsPlanBranch && finding.path === 'source_plan.baseline.branch')
            )
          );
          sourcePlan = { ...resolved, baseline };
        }

        if (ctx.config.diff_fingerprint.enabled) {
          // ALWAYS snapshot the plan-time baseline: the worktree tree at `capture
          // plan`, pinned to `refs/orcaops/baseline/<artifact>`. Empty-fence
          // recovery diffs from it for the FIRST checkpoint when there is no prior
          // finalized cp. Fail-open — a failed snapshot leaves the seed null; it
          // must never throw capture.
          const baseSnap = await captureBaselineSnapshot(ctx.repo, artifactId, {
            excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
          });
          if (baseSnap.ok) {
            baselineSeedTreeSha = baseSnap.tree_sha;
            baselineUnmergedPaths = baseSnap.unmerged_paths ?? [];
            if (baselineUnmergedPaths.length > 0) {
              // The set is persisted payload-only on plan_captured; the close
              // path blocks SEED recovery off it (a mid-conflict baseline
              // carries marker bytes no boundary-time union can filter).
              writeTerminalSafeStderr(
                `⚠ plan baseline captured with ${baselineUnmergedPaths.length} unmerged git ` +
                  `path(s): ${baselineUnmergedPaths.join(', ')}. Empty-fence seed recovery is ` +
                  `disabled for this artifact's first checkpoint; checkpoint capture itself is ` +
                  `unaffected. Resolve the conflicts before opening a checkpoint.\n`
              );
            }
          }

          // OVERRIDE the seed ONLY on a confirmed `--source-plan` re-capture: when
          // exactly ONE OTHER in-flight artifact (one with an open checkpoint, id
          // !== this artifact) exists on the branch. That artifact is the one this
          // re-capture supersedes — adopt its earliest OPEN checkpoint's pre-work
          // tree (NEVER an abandon tree) as the baseline so recovery diffs from
          // where the superseded work actually started. Ambiguity (zero or >1) →
          // KEEP the plan-time baseline; never guess, never fail the capture.
          if (opts.sourcePlan) {
            const override = await resolveSupersededBaseline(ctx, branch, artifactId);
            if (override) {
              // Only override with a NON-NULL pre-work tree — never overwrite a
              // valid plan-time seed with a null (the superseded cp's open
              // snapshot may have been skipped).
              if (override.openTreeSha !== null) {
                baselineSeedTreeSha = override.openTreeSha;
                // The plan-time unmerged set describes the plan-time tree,
                // not the adopted superseded tree — drop it with the seed.
                baselineUnmergedPaths = [];
                // Repin THIS artifact's own baseline ref to the superseded tree
                // so the seed stays reachable after the superseded artifact's snap refs
                // are pruned (its open snap ref is otherwise the only thing holding the
                // tree). Fail-open — a failed repin is no worse than the prior state.
                await pinBaselineTree(ctx.repo, artifactId, override.openTreeSha);
              }
              // Record the supersession regardless of whether its tree was usable —
              // it is the artifact this re-capture supersedes (auditability).
              supersededArtifactId = override.artifactId;
              // The "exactly one other in-flight artifact" heuristic has no
              // relatedness check, so a single coincidental in-flight artifact would be
              // adopted. Surface it (superseded_artifact_id also records it) so a
              // mis-adoption is visible immediately, not just in the digest.
              writeTerminalSafeStderr(
                `note: treated artifact ${override.artifactId} as the superseded artifact — ` +
                  `its pre-work tree is this artifact's empty-fence recovery baseline. ` +
                  `Verify if unexpected.\n`
              );
            }
          }
        }

        ({ event_id: planEventId } = await ctx.store.writePlan(plan, {
          idempotencyKey: input.idempotency_key,
          sourcePlan,
          baselineSeedTreeSha,
          ...(baselineUnmergedPaths.length > 0 ? { baselineUnmergedPaths } : {}),
          supersededArtifactId,
        }));
      } catch (err) {
        let committed = true;
        try {
          committed = await ctx.store.hasCommittedPlanCapture(artifactId, input.idempotency_key);
        } catch {
          // Inspection failure cannot prove the append absent. Preserve
          // the reservation so repair cannot mint a second identity.
        }
        if (!committed) {
          const rollback = await withNonDerivableWriteLease(
            ctx.repoRoot,
            () => {
              const rolledBack = ctx.store.store.deletePlanIdempotencyIfUnpublished(
                input.idempotency_key,
                artifactId
              );
              return {
                rolledBack,
                reservationRemains: ctx.store.store.hasPlanIdempotencyReservation(
                  input.idempotency_key,
                  artifactId
                ),
              };
            },
            { retryOnLeaseLoss: true }
          );
          if (rollback.rolledBack || !rollback.reservationRemains) {
            throw err;
          }
        }
        throw new PlanIdempotencyPendingError(input.idempotency_key, artifactId);
      }

      // Link the pinned source plan so its review-cycle usage attributes to this
      // artifact, time-bounded to linked_at. Best-effort.
      if (resolved) {
        await stampSourcePlanLink(ctx, {
          canonical_ref_id: canonicalSourcePlanRefId({
            source_ref: resolved.source_ref,
            hash: resolved.hash,
          }),
          artifact_id: artifactId,
          linked_at: startedAt,
          pinned_version: resolved.source_ref.kind === 'cloud' ? resolved.source_ref.version : null,
        });
      }

      const evalResult = await runLifecycleEvaluators({
        ctx,
        artifactId,
        firesAt: 'post-plan',
        noLlm: opts.noLlm,
      });
      await recordLifecycleCompletion(ctx, {
        artifactId,
        firesAt: 'post-plan',
      });

      await maybeAutoPin(ctx, artifactId, branch, startedAt);

      return {
        artifact_id: artifactId,
        branch,
        idempotency_status: 'created' as const,
        label: plan.label,
        plan_steps: planSteps.map((s, idx) => ({
          step_id: s.step_id,
          idx: idx + 1,
          text: s.text,
          label: s.label,
          acceptance_criteria: s.acceptance_criteria,
        })),
        revision_n: 0,
        // The plan_captured event_id, surfaced top-level so the caller can
        // pass it straight into cp-open's plan_revision_id (the optimistic-
        // concurrency token) — matching plan revise and resume, which already
        // expose it.
        plan_event_id: planEventId,
        // Echo the pinned source plan (content-free) so the caller can confirm
        // the pin attached in the SAME response — no follow-up `show` needed.
        // Created path only; the replay arm returns before the pin resolves.
        source_plan: sourcePlanView(sourcePlan ?? null),
        ...evalResult,
        secretWarnings: planSecretWarnings,
        usageStamp: {
          lifecycle_event: 'plan',
          artifactId,
          baselineHint: 'prior_same_artifact',
          asOf: startedAt,
          stableEventId: usageStampKey(artifactId, 'plan', 0),
        } satisfies UsageStampDescriptor,
      };
    },
    {
      parseInput: async () =>
        CapturePlanInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    }
  );
}

/**
 * Resolve the supersession-override baseline for a confirmed `--source-plan`
 * re-capture. Finds the OTHER in-flight artifacts on `branch` (id
 * !== `selfArtifactId`) that have at least one OPEN checkpoint; requires
 * EXACTLY ONE — that is the artifact this re-capture supersedes. Returns its
 * id plus its EARLIEST OPEN checkpoint's `open_snapshot.tree_sha` (the
 * pre-work state — never an abandon tree). Returns null on ambiguity (zero
 * or more than one candidate) so the caller keeps the plan-time baseline.
 *
 * `openTreeSha` may itself be null (the superseded cp's open snapshot was
 * skipped); the caller keeps the valid plan-time seed in that case but still
 * records the supersession id for auditability.
 */
async function resolveSupersededBaseline(
  ctx: CliContext,
  branch: string,
  selfArtifactId: string
): Promise<{ artifactId: string; openTreeSha: string | null } | null> {
  // Enumerate rows DIRECTLY with per-row guarded reads: delegating to
  // loadInFlightOnBranch would do an UNguarded readArtifact per row,
  // letting a rotted sibling throw before the guard below — inside the
  // window where the idempotency key is already committed, permanently
  // converting retries into replays for a planless artifact.
  const rows = ctx.store.store.listArtifactsByLineageBranch({ branch });
  const candidates: Array<{ artifactId: string; openTreeSha: string | null }> = [];
  let unreadableSiblings = 0;
  for (const row of rows) {
    if (row.id === selfArtifactId) continue;
    const json = await ctx.store.readArtifact(row.id).catch((err: unknown) => {
      // Only a recovery refusal is containable-as-unreadable; a
      // containment/symlink violation or programming error propagates —
      // the caller rolls the idempotency reservation back, so the
      // failure cannot strand a replay key.
      if (!(err instanceof RecoveryRefusedError)) throw err;
      return 'unreadable' as const;
    });
    if (json === 'unreadable' || json === null) {
      // Both count toward ambiguity (conservative — rot never picks the
      // winner), but only genuine read failures claim corruption.
      unreadableSiblings += 1;
      writeTerminalSafeStderr(
        json === 'unreadable'
          ? `warning: skipping unreadable in-flight artifact ${row.id} during supersession ` +
              `resolution — run \`orcaops doctor\` to see its corruption\n`
          : `warning: skipping in-flight artifact ${row.id} — it has no artifact.json yet ` +
              `— during supersession resolution\n`
      );
      continue;
    }
    if (json.state === 'summarized') continue;
    // A sibling with a rotted event log refuses on read. Rot must not
    // fail THIS capture, but it must not cast the deciding vote either:
    // an unreadable sibling still counts toward the ambiguity guard
    // below, so rot converts the decision to keep-the-plan-time-
    // baseline, never to adopt-the-survivor. Non-recovery errors are
    // NOT contained — they propagate to the rollback at the call site.
    const checkpoints = await ctx.store.readCheckpoints(row.id).catch((err: unknown) => {
      if (!(err instanceof RecoveryRefusedError)) throw err;
      return null;
    });
    if (checkpoints === null) {
      unreadableSiblings += 1;
      writeTerminalSafeStderr(
        `warning: skipping unreadable in-flight artifact ${row.id} during supersession ` +
          `resolution — run \`orcaops doctor\` to see its corruption\n`
      );
      continue;
    }
    // Earliest OPEN checkpoint = lowest-`n` cp with status 'open'. Its
    // open_snapshot is the pre-work tree we adopt as the baseline.
    const earliestOpen = checkpoints
      .filter((cp) => cp.status === 'open')
      .sort((a, b) => a.n - b.n)[0];
    if (earliestOpen === undefined) continue; // no open cp → not a supersession target
    candidates.push({ artifactId: row.id, openTreeSha: earliestOpen.open_snapshot.tree_sha });
  }
  // Ambiguity guard: only an UNAMBIGUOUS single other in-flight artifact is a
  // supersession target. Zero or >1 → keep the plan-time baseline — and an
  // unreadable sibling counts as ambiguity, so rot never picks the winner.
  return candidates.length === 1 && unreadableSiblings === 0 ? candidates[0] : null;
}

/**
 * Auto-pin the artifact to the current shell-key. Headless / CI shells
 * with no resolvable session env var (`kind: 'none'`) are silent
 * no-ops — we don't fail capture plan because the shell can't pin.
 *
 * The shared `replacePin` helper handles the pin_displaced emission
 * when overwriting a pin still pointing at an active or blocked
 * artifact.
 */
async function maybeAutoPin(
  ctx: CliContext,
  artifactId: string,
  branch: string,
  pinnedAt: string
): Promise<void> {
  const targets = await resolvePinTargets(ctx);
  if (targets.shellKey.kind === 'none') return;
  const result = await replacePin({
    ctx,
    artifactId,
    branch,
    pinnedAt,
    pinnedVia: 'auto-on-capture-plan',
    targets,
    containPriorArtifactFailure: true,
  });
  if (result.priorArtifactFailure !== undefined) {
    const { artifactId: priorId, kind } = result.priorArtifactFailure;
    const detail =
      kind === 'unreadable'
        ? 'is unreadable (projection recovery refused)'
        : kind === 'append_refused'
          ? 'has a corrupt event log that refuses the displacement event'
          : kind === 'lock_timeout'
            ? 'is locked by another process'
            : 'could not be read (filesystem error)';
    writeTerminalSafeStderr(
      `warning: previously pinned artifact ${priorId} ${detail} — the pin moved to ` +
        `${artifactId} without a pin_displaced event on the prior artifact. ` +
        `Run \`orcaops doctor\` to inspect it.\n`
    );
  }
}
