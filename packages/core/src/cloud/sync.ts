import { realpath } from 'node:fs/promises';

import {
  type CredentialStore,
  OssCheckpointOpenedPayload,
  OssCheckpointPayload,
  OssCodingSessionsUsagePayload,
  type OssCodingSessionUsageEntry,
  type OssCodingUsageModelBreakdown,
  type OssCodingUsageSnapshot,
  type OssEvaluatorDispositionRow,
  type OssEvaluatorRun,
  OssEvaluatorsPayload,
  type OssLlmTokenUsage,
  OssPlanPayload,
  type OssSourcePlanUsageLink,
  type OssSummaryPayload,
  type OssCheckpointPayload as WireCheckpoint,
  type OssCheckpointOpenedPayload as WireCheckpointOpened,
} from '@orcaops/sdk';
import { withNonDerivableWriteLease } from '@orcaops/storage';
import {
  assertNoForbiddenControlChars,
  sha256Hex,
  UsageModelBreakdownEntrySchema,
} from '@orcaops/storage';
import type {
  ArtifactStore,
  Checkpoint,
  CloudSyncState,
  CodingSessionRow,
  DiffFingerprintManifest,
  EvaluatorLog,
  MaterializedEvaluatorDisposition,
  MaterializedEvaluatorRun,
  Plan,
  SourcePlanLinkRow,
  Summary,
  UsageSnapshotRow,
} from '@orcaops/storage';

import { createCloudClient } from './client.js';
import {
  ArtifactNotFoundError,
  DoneCriterionTextUnresolvableError,
  FingerprintManifestMissingError,
  ImportedArtifactLocalOnlyError,
  MissingGitRemoteError,
  RepoUrlTooLongError,
  SourcePlanIntegrityError,
} from './errors.js';
import { assertCloudSupports, ORCAOPS_CAPABILITIES } from './handshake.js';
import {
  type ArtifactSnapshot,
  type ArtifactUsageData,
  computeArtifactHash,
  computeUsageAnchor,
} from './hash.js';
import { canonicalizeRemoteUrl, type HostResolver, normalizeRepoUrl } from './repo-url.js';
import { scrubAndBound } from './scrub-error.js';
import { markAcked, syncToGit } from './session-branch-state.js';
import {
  attachSourcePlanPin,
  preflightSourcePlan,
  type SourcePlanPinBranch,
} from './source-plan-pin.js';
import type { Repo } from '../git/repo.js';
import {
  collectBaselineRefsForArtifact,
  collectPrunableRefsForArtifact,
  pruneBaselineRefs,
  pruneSnapshotRefs,
} from '../git/snapshots.js';

/**
 * Mirrors `OssCaptureThreadStartPayload.repo_url.max(2048)` — the cloud
 * rejects anything past this with a Zod refine failure. The local guard
 * gives the CLI a clear remediation hint instead of an opaque 400.
 */
const REPO_URL_MAX_CHARS = 2048;

/**
 * Max checkpoint-attach RPCs in flight per push. Bounded so a deep artifact's
 * sync latency stops growing one full round-trip per checkpoint, without
 * stampeding the cloud; safe because the cloud upserts checkpoint rows keyed
 * by (artifact_id, n), making the attaches mutually order-independent. This
 * is the tuning point — raise deliberately, with cloud rate limits in mind.
 */
export const CHECKPOINT_ATTACH_CONCURRENCY = 4;

/**
 * Minimal bounded-concurrency runner (no dependency). Starts up to `limit`
 * workers over `items` in order; once a rejection is OBSERVED no new item
 * starts, everything already in flight is awaited, and the first error is
 * rethrown. Observation is promise-reaction-granular: reactions run in
 * settle order, so a lane whose worker settled in the same turn BEFORE the
 * failing lane's catch runs can still claim one more item — the overshoot is
 * bounded by `limit - 1` extra starts, never unbounded. Making that strict
 * would require wave barriers, reintroducing the per-wave latency this pool
 * exists to remove; the attaches are idempotent upserts, so a bounded
 * overshoot is harmless.
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]!);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  });
  await Promise.all(lanes);
  if (failed) throw firstError;
}

export interface PushArtifactOptions {
  store: ArtifactStore;
  repo: Repo;
  artifactId: string;
  /** When true, ignore the hash short-circuit and push regardless. */
  force?: boolean;
  /** Cloud base URL injected by the caller. */
  baseUrl: string;
  /** Credential store the caller resolved (distinct from `store`, the SQLite ArtifactStore). */
  credentialStore: CredentialStore;
  /** CLI release version sent on every cloud request. */
  cliVersion?: string;
  /**
   * Repo root, threaded for the Branch-B `derived_from` lineage lookup ONLY.
   * OPTIONAL by design: it is the sole push-side consumer of `repoRoot`, so an
   * unthreaded call path degrades a born-pin's lineage to null rather than
   * failing — the pin, guard, and change-detection hash never need it.
   */
  repoRoot?: string;
  /**
   * Override the SSH host-alias resolver used to canonicalize the remote URL
   * before it ships. Defaults to an `ssh -G` shell-out. Tests inject a fake so
   * canonicalization is deterministic without spawning a process.
   */
  resolveHost?: HostResolver;
  /** Internal eager-operation cancellation; not part of the CLI contract. */
  signal?: AbortSignal;
}

export interface PushArtifactResult {
  /** True when the push was skipped because the local hash matched cloud_sync_hash. */
  skipped: boolean;
  reason?: 'unchanged';
  /**
   * Wire-stable artifact identity (UUIDv7) the CLI minted; same value the
   * cloud's `externalId` column holds. The cloud's internal thread.id is
   * not surfaced; `externalId` is the wire-stable identity.
   */
  externalId?: string;
  attached?: {
    plan: boolean;
    checkpoints: number;
    summary: boolean;
    evaluators: number;
  };
  /**
   * Which source-plan branch attached this push. 'A' (cloud) / 'B'
   * (born-pin) on a full push that carried a pin; 'skipped' on the unchanged
   * short-circuit when a pin is present (already attached); null when unpinned.
   * TOP-LEVEL (not under `attached`) because the skip path builds no `attached`.
   */
  source_plan_pinned: SourcePlanPinBranch | 'skipped' | null;
}

/**
 * Read the artifact tree from disk and ingest it into the cloud.
 *
 * Order matters and mirrors the cloud's data dependencies:
 *   1. captureThread.start     → ships repoUrl; cloud resolves to Repo row
 *                                via RepoService.upsertByRemote internally.
 *                                Idempotent on caller-supplied id (= artifact_id)
 *   2. attachPlan              → 1:1 upsert keyed on captureThreadId
 *   3. attachCheckpoint × N    → each upsert keyed on (captureThreadId, n)
 *   4. attachSummary           → 1:1 upsert; flips thread to COMPLETE
 *   5. attachEvaluators        → REPLACE-ALL; CLI sends the entire log
 *
 * Hash check skips work when nothing has changed AND the same cloud org is
 * targeted as the previous push. Switching orgs invalidates the markers.
 */
export async function pushArtifact(opts: PushArtifactOptions): Promise<PushArtifactResult> {
  const { store, repo, artifactId, force, baseUrl, credentialStore } = opts;
  opts.signal?.throwIfAborted();

  // Local-only containment for imported history (origin_kind choke point):
  // the shared pending predicate keeps `git-import` rows out of every drain
  // enumeration, and this guard closes the explicit-id path. It must run
  // BEFORE createCloudClient so a refused push provably constructs no
  // network client.
  const artifactRow = store.store.getArtifact(artifactId);
  if (!artifactRow) throw new ArtifactNotFoundError(artifactId);
  if (artifactRow.origin_kind === 'git-import') {
    throw new ImportedArtifactLocalOnlyError(artifactId);
  }

  const { client, credentials } = await createCloudClient({
    baseUrl,
    store: credentialStore,
    cliVersion: opts.cliVersion,
    signal: opts.signal,
  });
  opts.signal?.throwIfAborted();

  const expectedRawHash = store.store.getCloudSyncRawHash(artifactId);
  if (expectedRawHash === undefined) throw new ArtifactNotFoundError(artifactId);
  const snapshot = await readSnapshot(store, artifactId);
  opts.signal?.throwIfAborted();
  if (!snapshot.plan) throw new ArtifactNotFoundError(artifactId);

  // Required wire-side net: refuse to push any artifact whose content carries a
  // cloud-incompatible control char — a NUL would 5xx Postgres with an opaque
  // "unsupported Unicode escape sequence". Field-aware input sanitization is the
  // primary defense; this asserts (never strips, so a hash-anchored source-plan
  // pin's content is untouched) and turns a would-be opaque 5xx into a clear
  // local failure, making "every author-facing source was enumerated"
  // runtime-verifiable. The wire policy equals the capture input policy,
  // including C1 display controls.
  assertNoForbiddenControlChars(snapshot);

  // Source-plan org resolution. A pinned push must key EVERY org decision (this
  // skip compare, setCloudSyncState, the Branch-A guard, Branch-B derived_from)
  // on the AUTHORITATIVE org from cli.ping — never `credentials.orgId`, which
  // EnvStore synthesizes as '' under env auth. Gated on a pin existing so
  // pinless pushes keep the existing fast path with no added ping. The ping's
  // required handshake is always validated, and a failure FAILS the push.
  //
  // This is deliberately FAIL-CLOSED: we do NOT catch a ping failure and return
  // `skipped`. Skipping on a ping failure would be fail-OPEN — it could report
  // "up to date" and auto-prune snapshot refs against an org we never confirmed,
  // when the injected cloud target is unreachable. On the
  // drain / eager-push path a transient ping failure for an unchanged pinned
  // artifact just bumps `cloud_consecutive_failures` (self-healing; the next
  // drain retries) and surfaces in doctor's `cloud-sync-pending` — that backoff
  // bump is the expected cost of fail-closed, not a leak.
  // A CLOUD-pinned push additionally REQUIRES the ownership contract: its
  // preflight decides whether the plan is already attached to another thread,
  // and a cloud that cannot answer that leaves the guard unable to do its job.
  // Checked off the ping this branch already makes, so no round trip is added.
  //
  // The ownership CAPABILITY is scoped to `kind === 'cloud'` on purpose. A
  // born-pin is "create in the current org" by definition and never reads
  // ownership, but it still consumes the ping handshake and version floors.
  // Pinless pushes remain un-pinged entirely.
  let currentOrgId: string;
  if (snapshot.source_plan) {
    const ping = await client.cli.ping();
    const cloudPin = snapshot.source_plan.source_ref.kind === 'cloud';
    assertCloudSupports(
      ping,
      cloudPin ? [ORCAOPS_CAPABILITIES.SOURCE_PLAN_OWNER_REF] : [],
      cloudPin ? 'a push carrying a pinned cloud plan' : 'a push carrying a pinned plan',
      { cliVersion: opts.cliVersion }
    );
    currentOrgId = ping.orgId;
  } else {
    currentOrgId = credentials.orgId;
  }

  const hash = computeArtifactHash(snapshot);
  const previous = store.store.getCloudSyncState(artifactId);
  if (!force && previous && previous.hash === hash && previous.orgId === currentOrgId) {
    // Unchanged short-circuit. The precondition `previous.hash === hash`
    // means a PRIOR push already landed the current fingerprint-bearing
    // state, so this still routes through the single auto-prune tail
    // (shouldAutoPrune returns true for `skipped`).
    const result: PushArtifactResult = {
      skipped: true,
      reason: 'unchanged',
      externalId: previous.externalId,
      // A present pin was attached by the push that first landed this hash; the
      // skip tail correctly does NOT re-attach. null when unpinned. The skip
      // intentionally does NOT re-validate the cloud pin (no preflight, no
      // re-attach): a no-op neither publishes a thread nor mutates the pin, so
      // there is nothing to guard — re-pinging here would violate the
      // no-network-on-an-unchanged-no-op contract for one already-attached pin.
      source_plan_pinned: snapshot.source_plan ? 'skipped' : null,
    };
    let cleanFinalized = true;
    if (store.store.getCloudSyncStateForArtifact(artifactId)?.pending === true) {
      const syncedAt = new Date(
        Math.max(Date.now(), Date.parse(previous.syncedAt) + 1)
      ).toISOString();
      cleanFinalized = await withNonDerivableWriteLease(
        store.repoRoot,
        () =>
          store.store.setCloudSyncStateIfCurrent(artifactId, expectedRawHash, {
            syncedAt,
            hash,
            externalId: previous.externalId,
            orgId: currentOrgId,
          }),
        { retryOnLeaseLoss: true, acquireTimeoutMs: 2_000 }
      );
    }
    const finalized = await finalizePush({
      result,
      store,
      repo,
      artifactId,
      snapshot,
      currentHash: hash,
      cleanFinalized,
    });
    opts.signal?.throwIfAborted();
    return finalized;
  }

  // Branch-A read-only preflight — runs BEFORE captureThread.start publishes the
  // artifact (a wrong-origin / missing / stale / not-approved cloud pin must
  // abort with zero captureThread writes, else a COMPLETE orphan lands in the
  // wrong org and only the pin is blocked). No-op for local (Branch-B) pins.
  if (snapshot.source_plan) {
    await preflightSourcePlan(client, {
      sourcePlan: snapshot.source_plan,
      baseUrl,
      currentOrgId,
      // This artifact's own cloud thread, when a prior push in THIS org
      // published it — an other-org prior push means this push creates a new
      // thread here, so any existing pin attachment is a foreign owner.
      currentThreadExternalId:
        previous && previous.orgId === currentOrgId ? previous.externalId : null,
    });
  }

  const rawRepoUrl = await repo.getRemoteUrl();
  if (!rawRepoUrl) throw new MissingGitRemoteError();

  // Resolve SSH host aliases (e.g. `git@github.com-work:org/repo.git`, where
  // ~/.ssh/config maps the alias to a real HostName) to the canonical host
  // before shipping, so multi-account remotes pass the cloud's host allowlist.
  // Only genuine aliases are rewritten — every other remote ships its raw value
  // unchanged — and a missing/failing `ssh` degrades to the raw URL rather than
  // failing the push (the cloud stays the host-validation backstop).
  const wireRepoUrl = await canonicalizeRemoteUrl(rawRepoUrl, opts.resolveHost);

  // Mirror the cloud's wire-contract cap (`OssCaptureThreadStartPayload.
  // repo_url.max(2048)`) on the value we actually ship, so a too-long URL fails
  // with an actionable CLI message instead of an opaque cloud-side 400.
  if (wireRepoUrl.length > REPO_URL_MAX_CHARS) {
    throw new RepoUrlTooLongError(wireRepoUrl.length, REPO_URL_MAX_CHARS);
  }

  // The CLI ships the alias-resolved canonical URL; the cloud's
  // `captureThread.start` listener still resolves it to a Repo row at handle
  // time via RepoService.upsertByRemote (idempotent + canonicalized). The
  // session-state PK uses the CLI-side normalized form of the RAW url so
  // https/git@/dot-git variants collapse onto a single row AND the key stays
  // stable regardless of whether `ssh` was available on a given push.
  const sessionRepoUrl = normalizeRepoUrl(rawRepoUrl);
  const sessionWorkingDir = await canonicalizeWorkingDir(repo.cwd);

  // Reconcile the per-(repoUrl, workingDir) session state against live git
  // and capture the branch-history chain that ships with the start payload.
  // Renames since the last successful start ack are surfaced here so the
  // cloud's findOpenTaskByBranchOrHistory can route the capture into the
  // existing task instead of orphaning onto a new one.
  //
  // syncToGit returns null when there is no reliable live branch to track
  // (detached HEAD, getCurrentBranch / getHeadSha throw on empty repo or
  // worktree corruption). We fall back to the snapshot-time branch so a
  // tooling hiccup in rename detection never blocks the capture push. The
  // onError sink lets a persistently-broken git invocation surface as a
  // stderr warning instead of silently disabling rename detection.
  const sessionState = await syncToGit({
    repo,
    store,
    repoUrl: sessionRepoUrl,
    workingDir: sessionWorkingDir,
    signal: opts.signal,
    onError: (err, { stage }) => {
      // eslint-disable-next-line no-console -- CLI runtime; user-visible warning channel
      console.warn(
        scrubAndBound(
          `[orcaops] rename detection skipped: git ${stage} failed (${
            err instanceof Error ? err.message : String(err)
          }). Capture push continues with snapshot-time branch.`,
          1024
        )
      );
    },
  });

  // Historical-fork guard: when the captured branch differs from the live
  // branch AND the captured branch is not in the rename chain, the artifact
  // is being pushed from a NEW branch forked off the original (e.g. agent
  // captured on `feat-a`, ran `git checkout -b feat-b feat-a`, then pushed
  // the still-historical `feat-a` artifact from `feat-b`). Routing through
  // the live branch would silently re-attribute the historical capture to
  // `feat-b`'s task and overwrite the cloud row's `branch` column. Ship the
  // captured branch instead and omit the rename chain — the session-state
  // chain belongs to the in-flight branch, not this historical artifact.
  //
  // When the captured branch IS in the chain (`feat-a` after `git branch -m
  // feat-a feat-b`), the rename path still applies: ship the live branch +
  // chain so `findOpenTaskByBranchOrHistory` routes the artifact through
  // the renamed task.
  const inRenameChain =
    sessionState != null && sessionState.branchHistory.includes(snapshot.plan.branch);
  const isHistoricalFork =
    sessionState != null && sessionState.currentBranch !== snapshot.plan.branch && !inRenameChain;

  const wireBranch = isHistoricalFork
    ? snapshot.plan.branch
    : (sessionState?.currentBranch ?? snapshot.plan.branch);
  const wireHistory = !isHistoricalFork && sessionState ? sessionState.branchHistory : [];

  await client.captureThread.start({
    repoUrl: wireRepoUrl,
    externalId: artifactId,
    // Live git branch, not snapshot.plan.branch — the cloud's task-routing path
    // keys on "where the CLI is right now" to detect renames since the prior
    // start. Falls back to snapshot.plan.branch when syncToGit signals "no
    // reliable live signal" (detached HEAD, git introspection error) OR when
    // the historical-fork guard above identifies a cross-branch push.
    branch: wireBranch,
    branchHistory: wireHistory,
    description: snapshot.plan.task,
    label: snapshot.plan.label,
    agent: snapshot.plan.agent,
    startedAt: snapshot.plan.started_at,
  });

  // attachPlan handles the initial plan_captured (revision_n = 0);
  // attachPlanRevision handles every subsequent plan_revised. Distinct
  // SDK methods so the call site documents intent and the cloud's
  // ingest path applies the right idempotency contract. The OSS push
  // surface carries only the LATEST plan revision — full
  // revision-history replay would require walking events.ndjson on
  // every push. The cloud derives "N revisions" from `revision_n`
  // regardless.
  const planPayload = toWirePlan(snapshot.plan);
  if (snapshot.plan.revision_n === 0) {
    await client.captureThread.attachPlan(planPayload);
  } else {
    await client.captureThread.attachPlanRevision(planPayload);
  }
  // Checkpoint attaches dispatch with bounded concurrency: the cloud upserts
  // rows keyed by (artifact_id, n), so checkpoints are mutually
  // order-independent — but ALL of them must settle before the summary attach
  // below (the COMPLETE flip) and the plan attach above must precede them.
  // Failure is fail-stop at observation granularity: once a rejection is
  // observed no new attach starts (same-turn settles may claim at most
  // limit-1 more — see runBounded), everything in flight is awaited, and the
  // first error is rethrown — which still precedes
  // markAcked/setCloudSyncState, so the hash stays unstored and the next
  // push retries the idempotent upserts cleanly.
  await runBounded(snapshot.checkpoints, CHECKPOINT_ATTACH_CONCURRENCY, async (cp) => {
    if (cp.status === 'open') {
      // Eager-push the open-state row so the cloud viewer can render the
      // in-flight checkpoint card. Cloud upserts an OPEN row keyed by
      // (artifact_id, n) which the close payload later flips to CLOSED.
      await client.captureThread.attachCheckpointOpened(toWireCheckpointOpened(cp));
      return;
    }
    // readSnapshot already materialized (or hard-threw for) every closed
    // cp with a non-null manifest_hash; null here means a skipped cp whose
    // manifest is legitimately absent.
    const manifest = snapshot.fingerprintByN.get(cp.n) ?? null;
    // Resolve each done-criterion's open-time text from the revision the cp
    // opened against (fails fast — never ships a degraded/latest read).
    const criterionText = await resolveDoneCriterionText(store, cp);
    const wire = toWireCheckpoint(cp, manifest, criterionText);
    if (!wire) return; // abandoned cps — cloud doesn't model them
    await client.captureThread.attachCheckpoint(wire);
  });
  if (snapshot.summary) {
    await client.captureThread.attachSummary(toWireSummary(snapshot.summary));
  }
  if (snapshot.evaluators) {
    await client.captureThread.attachEvaluators(toWireEvaluators(snapshot.evaluators));
  }
  // Coding-agent usage: attach AFTER evaluators, same null-guard idiom
  // — skipped entirely for a usage-less artifact (whose hash also omits usage, so
  // no spurious re-push). Idempotency-keyed + cumulative-only; the cloud merges
  // the snapshots append-only and recomputes attribution from the cumulative rows
  // + the first-class session total, never by summing deltas.
  if (snapshot.usage) {
    await client.captureThread.attachCodingSessionsUsage(toWireUsage(snapshot.usage, artifactId));
  }

  // Attach the source-plan pin AFTER the plan/thread + attaches land, and
  // BEFORE markAcked / setCloudSyncState: a failed attach throws here, leaving
  // the rename chain intact AND the cloud_sync hash unstored → the next push
  // retries cleanly. An unchanged-already-attached pin never reaches here (the
  // short-circuit returned above). Dispatches Branch A (cloud) / B (born-pin).
  //
  // Do NOT reorder this before attachSummary to "avoid the orphan". The known
  // residual is a plan already PINNED to a DIFFERENT capture thread: the
  // preflight can't tell "my thread" from "another's" (get returns PINNED with
  // no captureThreadId), so the attach 409s here AFTER attachSummary has flipped
  // this thread COMPLETE — a published-but-unpinned thread. That is the
  // RETRY-SAFE shape: the hash is left unstored (the throw precedes
  // setCloudSyncState), so the next push re-runs and re-attaches; moving the
  // attach earlier would instead orphan the pin against a thread with no
  // summary, which is strictly worse to reconcile. Properly closing the
  // different-thread 409 needs the cloud to return captureThreadId on get so the
  // preflight can pass an already-mine pin.
  let sourcePlanPinned: SourcePlanPinBranch | null = null;
  if (snapshot.source_plan) {
    sourcePlanPinned = await attachSourcePlanPin(client, {
      artifactId,
      sourcePlan: snapshot.source_plan,
      planLabel: snapshot.plan.label,
      baseUrl,
      currentOrgId,
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
      authoredAt: new Date().toISOString(),
    });
  }

  // Clear the rename chain only AFTER every attach has acked. If we ack
  // earlier (right after captureThread.start) a transient failure on any
  // of attachPlan / attachCheckpoint / attachSummary / attachEvaluators
  // would wipe the chain, and the next retry would start with an empty
  // history — losing the rename context the cloud needs to route a peer
  // rename through to the existing task. setCloudSyncState below records
  // the successful push hash so subsequent invocations short-circuit; the
  // markAcked + setCloudSyncState pair represents "this push fully landed."
  //
  // Skip the ack on a historical-fork push: that push didn't ship the
  // session-state's `currentBranch` / chain to the cloud (we sent the
  // captured branch instead), so the cloud doesn't yet "know the canonical
  // current branch" — leaving the chain intact lets a follow-up in-flight
  // push still surface a pending rename.
  // The cloud returns { commandId, status: 'accepted' } for every
  // cliProcedure. The CLI's wire-stable identity for this thread is the
  // externalId it owns (= artifactId), so session-state records that — the
  // cloud's internal thread.id is not surfaced and isn't needed for any CLI
  // flow.
  const ackedAt = sessionState && !isHistoricalFork ? new Date().toISOString() : null;
  const syncedAt = new Date().toISOString();
  const cleanFinalized = await withNonDerivableWriteLease(
    store.repoRoot,
    () => {
      if (ackedAt) {
        markAcked({
          store,
          repoUrl: sessionRepoUrl,
          workingDir: sessionWorkingDir,
          ackedAt,
        });
      }
      return store.store.setCloudSyncStateIfCurrent(artifactId, expectedRawHash, {
        syncedAt,
        hash,
        externalId: artifactId,
        // currentOrgId, not credentials.orgId: for a pinned push this is the
        // authoritative cli.ping org, so the next push's skip compare is consistent
        // (no source-plan org decision rests on the env-synthesizable blob).
        orgId: currentOrgId,
      });
    },
    // One bounded tail lease covers both local success writes. A miss remains
    // durable because the artifact is still pending for the next drain.
    { retryOnLeaseLoss: true, acquireTimeoutMs: 2_000 }
  );

  const result: PushArtifactResult = {
    skipped: false,
    externalId: artifactId,
    attached: {
      plan: true,
      checkpoints: snapshot.checkpoints.length,
      summary: !!snapshot.summary,
      evaluators: snapshot.evaluators?.runs.length ?? 0,
    },
    source_plan_pinned: sourcePlanPinned,
  };
  const finalized = await finalizePush({
    result,
    store,
    repo,
    artifactId,
    snapshot,
    currentHash: hash,
    cleanFinalized,
  });
  opts.signal?.throwIfAborted();
  return finalized;
}

/**
 * Auto-prune predicate. Evaluated exactly
 * once per successful push, on BOTH the unchanged-skip and the
 * full-push paths, and NEVER on a throw (a throw in `pushArtifact`
 * occurs textually before either `finalizePush` call, so the tail is
 * structurally unreachable on failure — refs stay pinned).
 */
function shouldAutoPrune(opts: {
  pushResult: PushArtifactResult;
  syncState: CloudSyncState | null;
  snapshot: ArtifactSnapshot;
  currentHash: string;
  cleanFinalized: boolean;
}): boolean {
  if (!opts.cleanFinalized) return false;
  // In-flight artifact (no summary) — never auto-prune.
  if (opts.snapshot.summary === null) return false;
  // Short-circuited because cloud already has current state; the
  // short-circuit precondition (previous.hash === hash) guarantees a
  // prior push already landed the fingerprint.
  if (opts.pushResult.skipped) return true;
  // A full push must have attached and recorded sync state at the
  // current hash.
  if (!opts.pushResult.attached) return false;
  if (opts.syncState === null) return false;
  return opts.syncState.hash === opts.currentHash;
}

/**
 * The SELECTIVE auto-prune (not a total wipe — skipped/abandon/
 * in-flight refs are kept by `collectPrunableRefsForArtifact`).
 *
 * Deliberately NOT wrapped in try/catch: a throw here happens AFTER
 * the durable `setCloudSyncState`, so the push is already recorded.
 * Letting it propagate surfaces a benign, self-clearing failure (the
 * next push short-circuits since the hash now matches) and doctor's
 * `stale-snapshot-refs` flags any stranded refs. Swallowing would risk
 * a silent ref leak — strictly worse.
 */
async function maybePruneSnapshots(
  repo: Repo,
  artifactId: string,
  snapshot: ArtifactSnapshot
): Promise<void> {
  const refs = await collectPrunableRefsForArtifact(repo, artifactId, snapshot);
  if (refs.length > 0) await pruneSnapshotRefs(repo, refs);
  // Also auto-prune the plan-time baseline ref once the artifact is
  // finalized-and-accounted (`collectBaselineRefsForArtifact` keeps it while
  // empty-fence recovery for the first checkpoint may still need it).
  const baselineRefs = await collectBaselineRefsForArtifact(repo, artifactId, snapshot);
  if (baselineRefs.length > 0) await pruneBaselineRefs(repo, baselineRefs);
}

/**
 * Single auto-prune decision site (one place, not three across
 * summary/push/resync). Reached by BOTH `pushArtifact` return points.
 * Reads `cloud_sync_state` AFTER the merge: on the full-push path
 * `setCloudSyncState` just wrote the current hash; on the
 * unchanged-skip path the current or prior push recorded it. The three CLI callers
 * inherit this through the shared `pushArtifact`.
 */
async function finalizePush(args: {
  result: PushArtifactResult;
  store: ArtifactStore;
  repo: Repo;
  artifactId: string;
  snapshot: ArtifactSnapshot;
  currentHash: string;
  cleanFinalized: boolean;
}): Promise<PushArtifactResult> {
  const syncState = args.store.store.getCloudSyncState(args.artifactId);
  if (
    shouldAutoPrune({
      pushResult: args.result,
      syncState,
      snapshot: args.snapshot,
      currentHash: args.currentHash,
      cleanFinalized: args.cleanFinalized,
    })
  ) {
    await maybePruneSnapshots(args.repo, args.artifactId, args.snapshot);
  }
  return args.result;
}

/**
 * Resolve symlinks in the working dir so two cwd entry points to the same
 * underlying inode (e.g. `/tmp/foo` vs `/private/tmp/foo` on macOS) collapse
 * onto a single session-state row. Falls back to the unresolved input if
 * realpath fails — better to key on a non-canonical path than to crash the
 * push on a worktree resolving quirk.
 */
async function canonicalizeWorkingDir(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Translate an OSS open checkpoint into the cloud's `checkpoint_opened`
 * wire shape. The open payload carries declared scope, plan-revision id,
 * head_sha (set at open time), and opened-at — no summary / files /
 * decisions yet.
 *
 * `policy_exceptions` is joined into display-only strings to match the
 * close payload's wire format; cloud stores them as `String[]` and never
 * reparses, so the format is keyed to `${evaluator}: ${reason}` on both
 * sides of the OPEN→CLOSED lifecycle.
 */
function toWireCheckpointOpened(cp: Checkpoint & { status: 'open' }): WireCheckpointOpened {
  // .parse (not a bare object literal) so the cloud's strict v2 schema +
  // boundary superRefine fail fast LOCALLY with a clear error instead of an
  // opaque cloud 400. Matches the toWireEvaluators precedent below.
  return OssCheckpointOpenedPayload.parse({
    schema_version: 2,
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: cp.declared_step_ids,
    // The server-derived event id of the plan revision this cp opened against
    // (authoritative; the cloud resolves it against Plan.sourceEventId).
    plan_revision_id: cp.open_plan_revision_event_id,
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((p) => `${p.evaluator}: ${p.reason}`),
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
    open_snapshot: cp.open_snapshot,
    ...(cp.source_event_id ? { source_event_id: cp.source_event_id } : {}),
  });
}

/**
 * Translate one OSS checkpoint into the cloud's v4 wire shape, or return
 * null if the cloud can't model it. Local checkpoints are a discriminated
 * union (open / closed / abandoned) — only `closed` carries the close-
 * time payload (summary, files_changed, decisions) the cloud expects.
 * Open cps go through `toWireCheckpointOpened`; abandoned cps are skipped
 * (the v1 wire has no abandoned payload).
 *
 * `manifest` is the materialized full diff-fingerprint manifest from
 * `readSnapshot`'s `fingerprintByN` (null for skipped cps, whose
 * `manifest_hash` is null). It is sent iff non-null; the cloud's payload
 * superRefine enforces "manifest_hash non-null ⇔ diff_fingerprint present".
 *
 * .parse (not a bare literal) so the cloud's strict v4 schema + summary /
 * manifest / boundary superRefines fail fast LOCALLY instead of as an
 * opaque cloud 400. The cloud STILL re-validates + recomputes manifest_hash
 * + cross-checks tree SHAs server-side; this is a fast local mirror of the
 * self-contained shape checks only, not a replacement for ingest.
 */
function toWireCheckpoint(
  cp: Checkpoint,
  manifest: DiffFingerprintManifest | null,
  criterionText: Map<string, string>
): WireCheckpoint | null {
  if (cp.status !== 'closed') return null;
  return OssCheckpointPayload.parse({
    schema_version: 4,
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: cp.declared_step_ids,
    completed_step_ids: cp.completed_step_ids,
    // Authoritative open-time plan-revision event id (cloud resolves it against
    // Plan.sourceEventId for open-time step ordinals + the stale-plan badge).
    plan_revision_id: cp.open_plan_revision_event_id,
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((p) => `${p.evaluator}: ${p.reason}`),
    summary: cp.summary,
    files_changed: cp.files_changed,
    // V4 `OssCheckpointDecision` carries `alternatives_considered`, structurally
    // identical to the stored shape — passes through verbatim.
    decisions: cp.decisions,
    uncertainty: cp.uncertainty,
    // V4 carries structured done_criteria; `text` is the acceptance-criterion
    // text as it read in the plan revision this cp OPENED against, resolved by
    // resolveDoneCriterionText (which guarantees a map hit for every entry).
    done_criteria: cp.done_criteria.map((d) => ({
      criterion_id: d.criterion_id,
      evidence: d.evidence,
      text: criterionText.get(d.criterion_id)!,
    })),
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
    ts: cp.closed_at,
    open_snapshot: cp.open_snapshot,
    close_snapshot: cp.close_snapshot,
    diff_fingerprint_summary: cp.diff_fingerprint_summary,
    ...(manifest !== null ? { diff_fingerprint: manifest } : {}),
    ...(cp.source_event_id ? { source_event_id: cp.source_event_id } : {}),
  });
}

/**
 * Resolve each done-criterion's open-time `text` for the V4 wire. The cloud
 * snapshots the criterion text as it read in the plan revision the checkpoint
 * OPENED against and does not replay plan history itself, so we resolve it here
 * from `open_plan_revision_event_id` — never the latest revision — and FAIL
 * FAST (DoneCriterionTextUnresolvableError) rather than ship a degraded read.
 * That way a transient cache miss redrives clean instead of durably recording
 * the wrong rubric. Returns an empty map when there is nothing to resolve
 * (non-closed cp). In normal operation this never
 * throws: close-time validation already proved every criterion_id resolves
 * to a completed step in the open revision, on the same strict rule.
 */
async function resolveDoneCriterionText(
  store: ArtifactStore,
  cp: Checkpoint
): Promise<Map<string, string>> {
  if (cp.status !== 'closed') return new Map();
  // Resolve for EVERY closed cp — an empty rubric must not bypass the
  // strict open-revision rule, or a push would ship an unresolvable
  // revision id that close/why/rebuild all refuse.
  const resolved = await store.resolveOpenRevisionPlanStrict(
    cp.artifact_id,
    cp.open_plan_revision_event_id
  );
  if (resolved.kind === 'unresolved') {
    throw new DoneCriterionTextUnresolvableError(
      cp.artifact_id,
      cp.n,
      null,
      'open-revision-not-in-cache'
    );
  }
  const textByCriterion = new Map<string, string>();
  for (const step of resolved.plan.plan_steps) {
    for (const criterion of step.acceptance_criteria) {
      textByCriterion.set(criterion.criterion_id, criterion.text);
    }
  }
  for (const dc of cp.done_criteria) {
    if (!textByCriterion.has(dc.criterion_id)) {
      throw new DoneCriterionTextUnresolvableError(
        cp.artifact_id,
        cp.n,
        dc.criterion_id,
        'criterion-absent-in-open-revision'
      );
    }
  }
  return textByCriterion;
}

/**
 * Build the evaluator wire payload. The shape mirrors the materialized
 * projection one-for-one (distinct phase / run_status / verdict /
 * disposition fields plus an explicit dispositions array). Validates
 * at the SDK boundary via the protocol's own Zod schema so contract
 * violations — enum drift, missing required fields, broken cross-field
 * invariants — fail loud here instead of on the cloud's ingest.
 */
export function toWireEvaluators(log: EvaluatorLog): OssEvaluatorsPayload {
  return OssEvaluatorsPayload.parse({
    schema_version: 1,
    artifact_id: log.artifact_id,
    runs: log.runs.map(toWireEvaluatorRun),
    dispositions: log.dispositions.map(toWireEvaluatorDisposition),
  });
}

function toWireEvaluatorRun(run: MaterializedEvaluatorRun): OssEvaluatorRun {
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: run.run_id,
    evaluator_ref: run.evaluator_ref,
    package_id: run.package_id,
    evaluator_id: run.evaluator_id,
    phase: run.phase,
    severity: run.severity,
    run_status: run.run_status,
    verdict: run.verdict,
    disposition: run.disposition,
    body: run.body,
    ...(run.raw !== undefined ? { raw: run.raw } : {}),
    ...(run.metrics !== undefined ? { metrics: run.metrics } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
    ...(run.cost_usd !== undefined ? { cost_usd: run.cost_usd } : {}),
    ...(run.duration_ms !== undefined ? { duration_ms: run.duration_ms } : {}),
    ...(run.checkpoint_n !== undefined ? { checkpoint_n: run.checkpoint_n } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ts: run.ts,
    source_event_index: run.source_event_index,
    local_kind_rank: 0,
    local_index: run.local_index,
  };
}

function toWireEvaluatorDisposition(
  dispo: MaterializedEvaluatorDisposition
): OssEvaluatorDispositionRow {
  return {
    schema: 'orcaops.evaluator_disposition/v1',
    disposition_id: dispo.disposition_id,
    run_id: dispo.run_id,
    evaluator_ref: dispo.evaluator_ref,
    disposition: dispo.disposition,
    reason: dispo.reason,
    agent_session_id: dispo.agent_session_id,
    ts: dispo.ts,
    source_event_index: dispo.source_event_index,
    local_kind_rank: 1,
    local_index: dispo.local_index,
  };
}

/**
 * Build the coding-agent usage wire payload. The native Claude token
 * names are renamed to the wire's in/out/cache_read/cache_write ONLY here, and
 * every per-snapshot `delta_*` is dropped — the payload is cumulative-only, so
 * the cloud recomputes the high-water span from the cumulative rows + the
 * first-class session total and NEVER by summing deltas, structurally.
 * `.parse` validates at the SDK boundary so contract drift fails
 * loud here instead of as an opaque cloud 400 — matching the other producers.
 */
export function toWireUsage(
  usage: ArtifactUsageData,
  artifactId: string
): OssCodingSessionsUsagePayload {
  const breakdownBySession = new Map<string, OssCodingUsageModelBreakdown[]>();
  // The per-session high-water TOTAL dimensions — a sibling of the per-model
  // breakdown, both read from the same high-water SessionModelBreakdownRow.
  const dimensionsBySession = new Map<string, Record<string, number>>();
  for (const mb of usage.modelBreakdowns) {
    const key = usageSessionKey(mb.agent, mb.session_id);
    breakdownBySession.set(key, toWireModelBreakdown(mb.model_breakdown));
    dimensionsBySession.set(key, parseDimensions(mb.dimensions));
  }
  return OssCodingSessionsUsagePayload.parse({
    schema_version: 1,
    artifact_id: artifactId,
    sessions: usage.sessions.map((s) =>
      toWireSessionUsageEntry(s, breakdownBySession, dimensionsBySession)
    ),
    snapshots: usage.snapshots.map(toWireUsageSnapshot),
    source_plan_links: usage.source_plan_links.map(toWireSourcePlanUsageLink),
  });
}

/** (agent, session_id) join key — JSON, never a control-char delimiter. */
function usageSessionKey(agent: string, sessionId: string): string {
  return JSON.stringify([agent, sessionId]);
}

/** Parse a stored `dimensions` JSON column → a numeric map ({} on any failure).
 *  The column is `TEXT NOT NULL DEFAULT '{}'` (migration 020), so this normally
 *  parses an object; the guard keeps a malformed/legacy value from throwing. */
function parseDimensions(json: string): Record<string, number> {
  try {
    const raw = JSON.parse(json) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, number>;
    }
  } catch {
    // fall through to the empty default
  }
  return {};
}

/** Native Claude token names → wire names. The ONLY place this rename happens.
 *  `dimensions` (the open numeric counters) rides inside every OssLlmTokenUsage —
 *  emitted only when non-empty so a default session stays byte-identical on the wire. */
function toWireUsageTokens(
  t: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  },
  dimensions?: Record<string, number>
): OssLlmTokenUsage {
  return {
    in: t.input_tokens,
    out: t.output_tokens,
    cache_read: t.cache_read_input_tokens,
    cache_write: t.cache_creation_input_tokens,
    ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
  };
}

/** Parse a stored `model_breakdown` JSON and map to the wire shape (drops delta).
 *  Carries the price-determining rate classes + per-model dimensions; each is
 *  omitted when default/empty (the parser already canonicalizes), matching the
 *  wire's optional-omit convention. */
function toWireModelBreakdown(json: string): OssCodingUsageModelBreakdown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const parsed = UsageModelBreakdownEntrySchema.array().safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((e) => ({
    model: e.model,
    ...(e.speed ? { speed: e.speed } : {}),
    ...(e.service_tier ? { service_tier: e.service_tier } : {}),
    ...(e.inference_geo ? { inference_geo: e.inference_geo } : {}),
    cumulative: toWireUsageTokens(e.cumulative, e.cumulative.dimensions),
  }));
}

function toWireSessionUsageEntry(
  s: CodingSessionRow,
  breakdownBySession: Map<string, OssCodingUsageModelBreakdown[]>,
  dimensionsBySession: Map<string, Record<string, number>>
): OssCodingSessionUsageEntry {
  const key = usageSessionKey(s.agent, s.session_id);
  return {
    agent: s.agent,
    session_id: s.session_id,
    // The session total's high-water dimensions ride inside `total` — sourced
    // from the per-session breakdown row, since CodingSessionRow has no JSON column.
    total: toWireUsageTokens(
      {
        input_tokens: s.cumulative_input_tokens,
        output_tokens: s.cumulative_output_tokens,
        cache_creation_input_tokens: s.cumulative_cache_creation_input_tokens,
        cache_read_input_tokens: s.cumulative_cache_read_input_tokens,
      },
      dimensionsBySession.get(key)
    ),
    model_breakdown: breakdownBySession.get(key) ?? [],
    as_of: s.as_of,
    record_count: s.record_count,
  };
}

function toWireUsageSnapshot(row: UsageSnapshotRow): OssCodingUsageSnapshot {
  return {
    snapshot_id: row.snapshot_id,
    idempotency_key: row.idempotency_key,
    session_id: row.session_id,
    agent: row.agent,
    artifact_id: row.artifact_id,
    source_plan_ref_id: row.source_plan_ref_id,
    lifecycle_event: row.lifecycle_event,
    // checkpoint_n is wire-optional + must be positive; plan / plan_review rows
    // carry null. Omit when null (never emit 0).
    ...(row.checkpoint_n !== null ? { checkpoint_n: row.checkpoint_n } : {}),
    baseline_kind: row.baseline_kind as OssCodingUsageSnapshot['baseline_kind'],
    // The snapshot total's dimensions ride inside `cumulative` (the per-model
    // dimensions ride inside `model_breakdown` via toWireModelBreakdown).
    cumulative: toWireUsageTokens(
      {
        input_tokens: row.cumulative_input_tokens,
        output_tokens: row.cumulative_output_tokens,
        cache_creation_input_tokens: row.cumulative_cache_creation_input_tokens,
        cache_read_input_tokens: row.cumulative_cache_read_input_tokens,
      },
      parseDimensions(row.dimensions)
    ),
    model_breakdown: toWireModelBreakdown(row.model_breakdown),
    as_of: row.as_of,
    ts: row.ts,
  };
}

function toWireSourcePlanUsageLink(row: SourcePlanLinkRow): OssSourcePlanUsageLink {
  return {
    source_plan_ref_id: row.source_plan_ref_id,
    linked_at: row.linked_at,
    ...(row.pinned_version !== null ? { pinned_version: row.pinned_version } : {}),
  };
}

function toWirePlan(plan: Plan): OssPlanPayload {
  // .parse (not a bare literal) so the V4 schema's step-label / criterion_id
  // uniqueness superRefines fail fast LOCALLY instead of as an opaque cloud
  // 400 — matching the checkpoint producers. Storage already enforces the same
  // uniqueness, so a valid stored plan always parses.
  return OssPlanPayload.parse({
    schema_version: 4,
    artifact_id: plan.artifact_id,
    branch: plan.branch,
    base_sha: plan.base_sha,
    agent: plan.agent,
    agent_session_id: plan.agent_session_id,
    task: plan.task,
    label: plan.label,
    // V4 carries per-step acceptance_criteria ({criterion_id, text}),
    // structurally identical to storage — pass through.
    plan_steps: plan.plan_steps.map((s) => ({
      step_id: s.step_id,
      label: s.label,
      text: s.text,
      acceptance_criteria: s.acceptance_criteria,
    })),
    // V4 non_goals are structured {text, rationale, source_refs} — pass the
    // stored shape straight through (was flattened to text-only on the v3 wire).
    non_goals: plan.non_goals,
    touched_scope: plan.touched_scope,
    started_at: plan.started_at,
    revision_n: plan.revision_n,
    revised_at: plan.revised_at,
    rationale: plan.rationale,
    step_lineage: plan.step_lineage,
    // V4 carries the criterion-level diff against the prior revision; cloud
    // renders removed/rewritten (added is ignored cloud-side).
    criterion_lineage: plan.criterion_lineage,
    // V4 OssPlanDecision is structurally identical to the stored PlanDecision
    // (decision, reason, alternatives_considered?, revision_n) — pass the
    // cumulative set straight through, mirroring toWireCheckpoint. The store
    // cumulates plan decisions at write and we sync only the latest revision,
    // so this array is the full append-only history (each entry keeps its
    // made-at revision_n); both attachPlan (rev 0) and attachPlanRevision
    // (rev >= 1) carry the complete set, which is what the cloud relies on.
    decisions: plan.decisions,
    prior_plan_event_id: plan.prior_plan_event_id,
    ...(plan.source_event_id ? { source_event_id: plan.source_event_id } : {}),
  });
}

function toWireSummary(summary: Summary): OssSummaryPayload {
  return {
    schema_version: summary.schema_version,
    artifact_id: summary.artifact_id,
    outcome: summary.outcome,
    tests_written: summary.tests_written,
    tests_run: summary.tests_run,
    open_items: summary.open_items,
    deferred_decisions: summary.deferred_decisions,
    head_sha: summary.head_sha,
    ts: summary.ts,
    ...(summary.source_event_id ? { source_event_id: summary.source_event_id } : {}),
  };
}

async function readSnapshot(store: ArtifactStore, artifactId: string): Promise<ArtifactSnapshot> {
  const [plan, checkpoints, summary, evaluators, artifact] = await Promise.all([
    store.readPlan(artifactId),
    // Recovery-aware read: any non-tail loss (a corrupted close or its
    // sidecar included) REFUSES the push entirely — a corrupt-dropped
    // close can never silently degrade a closed cp to `open` and bypass
    // the strict-fingerprint check below.
    store.readCheckpointsRecovered(artifactId),
    store.readSummary(artifactId),
    store.readEvaluatorLog(artifactId),
    // source_plan lives on the ARTIFACT projection, NOT the Plan projection
    // (readPlan drops it — the silent-no-op trap). Read the artifact so the pin
    // joins change-detection (hash) and the attach.
    store.readArtifact(artifactId),
  ]);
  const source_plan = artifact?.source_plan ?? null;
  if (source_plan) {
    // The pin schema only requires a non-empty hash; re-verify on materialize —
    // a pin is a graded conformance anchor and must never ship a body that
    // drifted from its recorded hash. Shares the one sha256Hex with doctor's
    // pin-drift check, which predicts exactly this throw — they must hash alike.
    const actual = sha256Hex(source_plan.content);
    if (actual !== source_plan.hash) {
      throw new SourcePlanIntegrityError(artifactId, source_plan.hash, actual);
    }
  }
  // Strict-fingerprint materialization: every closed cp
  // whose projection declares a non-null manifest_hash MUST have its full
  // manifest present on the wire, or the push fails outright. Never sync
  // `diff_fingerprint` absent while the summary says it exists — that opens
  // the attribution gap auto-prune would then make unrecoverable.
  const fingerprintByN = new Map<number, DiffFingerprintManifest>();
  for (const cp of checkpoints) {
    if (cp.status !== 'closed') continue;
    if (cp.diff_fingerprint_summary.manifest_hash === null) continue;
    const manifest = await store.readCheckpointDiffFingerprint(artifactId, cp.n);
    if (manifest === null) {
      throw new FingerprintManifestMissingError(artifactId, cp.n);
    }
    fingerprintByN.set(cp.n, manifest);
  }
  // Coding-agent usage — null when the artifact has none, so its hash and
  // attach omit usage entirely. Shared with doctor's
  // prune-eligibility hash via materializeArtifactUsage so both fold the same anchor.
  const usage = materializeArtifactUsage(store, artifactId);
  return { plan, checkpoints, summary, evaluators, source_plan, fingerprintByN, usage };
}

/**
 * Materialize an artifact's coding-agent usage from the ledger projection:
 * exact per-session totals + cumulative snapshot rows + each
 * session's high-water model breakdown + source-plan links — or null when the
 * artifact has none. Shared by `readSnapshot` (the push) and `doctor`'s
 * prune-eligibility check so BOTH fold the IDENTICAL usage anchor into
 * `computeArtifactHash`; otherwise doctor would mis-flag every usage-bearing
 * artifact as unsynced (its snapshot hash would omit the usage the push folded in).
 */
export function materializeArtifactUsage(
  store: ArtifactStore,
  artifactId: string
): ArtifactUsageData | null {
  const sessions = store.store.artifactCodingSessions(artifactId);
  // The artifact's ATTRIBUTION scope (own + time-bounded source-plan-linked),
  // NOT readUsageSnapshots' artifact_id-only set — so the cloud receives the
  // artifact_id=null pre-capture source-plan snapshots it needs to recompute the
  // `ts <= linked_at` span for source-plan usage.
  const snapshots = store.store.artifactScopedUsageSnapshots(artifactId);
  const modelBreakdowns = store.store.artifactSessionModelBreakdowns(artifactId);
  const source_plan_links = store.store.readSourcePlanLinks(artifactId);
  // Token data is the trigger: a links-only artifact (a source-plan pin with no
  // in-scope sessions or snapshots) has nothing to attribute, so it is not a
  // usage payload — keep both the attach and the hash anchor off it.
  if (sessions.length === 0 && snapshots.length === 0) {
    return null;
  }
  return {
    sessions,
    snapshots,
    modelBreakdowns,
    source_plan_links,
    anchor: computeUsageAnchor({ sessions, snapshots, modelBreakdowns, source_plan_links }),
  };
}
