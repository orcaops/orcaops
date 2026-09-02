import type Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { SearchType } from '@orcaops/evaluator-protocol/search-types';

import { BASELINE_SCHEMA, CURRENT_VERSION } from './migrations/index.js';
import { SchemaAheadError } from '../artifacts/errors.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { assertResolvedWithin } from '../paths/containment.js';
import type { DoneCriterion, PolicyException } from '../schema/checkpoint.js';
import type { ArtifactOriginKind } from '../schema/origin.js';
import { redactSecretsInString } from '../secrets.js';

/**
 * better-sqlite3 loads LAZILY at first Store construction, never at module
 * load: the storage package root re-exports this file, so a static import
 * would put the native addon on the cold-start path of every consumer —
 * including `orcaops hook session-start`, which runs at every agent session
 * start and must survive a broken/missing prebuild on its no-store paths.
 * (Same rationale as packages/llm's OpenCode db-reader; `createRequire`
 * because the constructor is synchronous, and it also survives the esbuild
 * release bundle, which hoists external STATIC imports to the bundle top.)
 */
let DatabaseCtor: typeof Database | undefined;
function loadDatabase(): typeof Database {
  DatabaseCtor ??= createRequire(import.meta.url)('better-sqlite3') as typeof Database;
  return DatabaseCtor;
}

/**
 * npm's script-blocking installs (allow-scripts policies, --ignore-scripts)
 * skip better-sqlite3's install script, so no native binding exists. The
 * require still succeeds — v12 dlopens lazily inside `new Database()` — so
 * the failure surfaces at construction as a bindings-file stack that says
 * nothing about the cause. Name the cause and the reinstall fix.
 */
export function nativeModuleHint(cause: string): string {
  return (
    'better-sqlite3 has no native module for this install. Its install script was ' +
    'likely blocked (an npm allow-scripts policy, or --ignore-scripts). Reinstall ' +
    'allowing it: `npm install -g --allow-scripts=better-sqlite3 @orcaops/cli`. ' +
    `Underlying error: ${cause}`
  );
}

function isMissingBindingError(message: string): boolean {
  return message.includes('bindings file') || message.includes('better_sqlite3.node');
}

// Artifact-level 'abandoned' was never produced (only checkpoints abandon);
// the launch vocabulary is the derived artifact STATE — this coarse pair is
// internal storage plumbing.
export type ArtifactStatus = 'active' | 'complete';

export type CheckpointStatus = 'open' | 'closed' | 'abandoned';

export type ProjectionHealth = 'healthy' | 'rebuild_pending' | 'degraded';

const PROJECTION_HEALTH_KEY = 'projection_health';
const PROJECTION_SKIPPED_ARTIFACTS_KEY = 'projection_skipped_artifacts';

function isProjectionHealth(value: string): value is ProjectionHealth {
  return value === 'healthy' || value === 'rebuild_pending' || value === 'degraded';
}

/**
 * Lifecycle hook literals. The on-disk CHECK constraint on
 * `evaluator_lifecycles.fires_at` (025-baseline.ts) mirrors this set;
 * widening it means a new baseline version.
 */
export type LifecycleFiresAt =
  | 'post-plan'
  | 'post-plan-revision'
  | 'checkpoint-open'
  | 'checkpoint-close'
  | 'pre-pr';

export interface ArtifactRow {
  id: string;
  branch: string;
  task: string;
  /**
   * Plan-level short headline (1–70 chars, single line). Mirrored from
   * the latest plan revision's `label`; per-revision audit history
   * lives on the `plans` table.
   */
  label: string;
  agent: string;
  base_sha: string;
  started_at: string;
  completed_at: string | null;
  status: ArtifactStatus;
  /**
   * Denormalized projection of the LATEST plan revision's non_goals
   * (mirrored from `plans.non_goals` at MAX(revision_n)). Per-revision
   * audit history lives on the `plans` table.
   */
  non_goals: string;
  /** Null for live captures; git-import marks synthesized history. */
  origin_kind?: ArtifactOriginKind | null;
  /** ISO timestamp of the last successful push to cloud; null when never pushed. */
  cloud_synced_at?: string | null;
  /**
   * Private payload-version cell. Revalidation may populate it before the
   * first successful push, so `cloud_synced_at` — never hash nullability — is
   * the never-pushed sentinel. Public readers receive only the decoded last
   * acknowledged hash once the complete cloud state exists.
   */
  cloud_sync_hash?: string | null;
  /** Cloud-side CaptureThread id; null when never pushed. */
  cloud_external_id?: string | null;
  /** Cloud organization id the last push targeted; null when never pushed. */
  cloud_org_id?: string | null;
  /**
   * ISO timestamp of the last push attempt, success or failure. Set by
   * `recordCloudSyncFailure` for non-env-class failures, and by
   * `setCloudSyncState` (which mirrors `cloud_synced_at` on success).
   * Env-class outcomes (NotConnected / MissingGitRemote / ArtifactNotFound)
   * leave this field untouched so they don't pollute per-artifact failure state.
   */
  cloud_last_push_attempt_at?: string | null;
  /**
   * Discriminator for the most recent failure. One of `timeout`, `http-4xx`,
   * `http-5xx`, `network`, `unknown`. Cleared to NULL on a successful push.
   */
  cloud_last_push_error_kind?: string | null;
  /**
   * Scrubbed, length-capped error message from the most recent failure.
   * Cleared to NULL on a successful push. The scrubbing is performed by
   * the writer (`scrubError` in core); storage stores verbatim.
   */
  cloud_last_push_error_message?: string | null;
  /**
   * Failure counter driving the exponential backoff. Atomically
   * incremented on failure (`UPDATE … SET cloud_consecutive_failures =
   * cloud_consecutive_failures + 1`) and reset to 0 on success.
   */
  cloud_consecutive_failures?: number;
}

export interface CloudSyncState {
  syncedAt: string;
  hash: string;
  /**
   * Wire-stable artifact identity (UUIDv7) the CLI mints and sends to the
   * cloud as `externalId`. Persisted to the `cloud_external_id` column
   * (renamed from `cloud_thread_id` in migration 014 to match the TS
   * field name).
   */
  externalId: string;
  orgId: string;
}

/**
 * Discriminator for `recordCloudSyncFailure`. Env-class outcomes
 * (NotConnected / MissingGitRemote / ArtifactNotFound) are intentionally
 * absent — those are local-environment / race conditions, not
 * artifact-attributable failures, and must not be recorded here.
 *
 * `content-invalid` is special: a DETERMINISTIC content fault (a forbidden
 * control byte caught by the wire-side assert), not a transient push failure.
 * It is recorded so `cloud_sync` / doctor can steer the user to scrub+rebuild
 * instead of a `resync --force` loop that would re-trip the same assert forever.
 *
 * `upgrade-required` is likewise deterministic for the running binary: the
 * cloud rejected this client's version or payload schema via a typed launch
 * appCode, so retrying without upgrading fails identically — steering goes to
 * an upgrade, never a bare retry. `server-behind` is the opposite direction
 * (the deployed cloud predates this client's surface) and self-heals when the
 * cloud deploy lands, so it stays retryable.
 *
 * `wire-invalid` is a reachable-but-malformed cloud (a non-JSON body or an
 * envelope that failed validation), distinct from `network` (transport
 * failure before a usable response). Both stay retryable; the split exists so
 * diagnostics distinguish "cannot reach" from "reached something that does
 * not speak the protocol".
 */
export type CloudSyncFailureKind =
  | 'timeout'
  | 'http-4xx'
  | 'http-5xx'
  | 'network'
  | 'wire-invalid'
  | 'content-invalid'
  | 'upgrade-required'
  | 'server-behind'
  | 'unknown';

/**
 * Kinds a bare retry cannot clear — the fault is deterministic for the
 * current artifact bytes (`content-invalid`: scrub+rebuild first) or the
 * running binary (`upgrade-required`: upgrade first). User-facing guidance
 * (doctor, sync-status) must not recommend `resync --force` when only these
 * are stuck; the scan itself stays kind-agnostic so a post-remediation
 * force-retry always works.
 *
 * Adding a member here changes which guidance arm fires in BOTH consumers,
 * and their user-facing prose enumerates the membership by name — update the
 * footer strings in `apps/orcaops-cli/src/commands/sync-status.ts` and the
 * suppression footer in `apps/orcaops-cli/src/commands/doctor.ts` together
 * with this list.
 */
export const DETERMINISTIC_CLOUD_SYNC_KINDS: readonly CloudSyncFailureKind[] = [
  'content-invalid',
  'upgrade-required',
];

export class UnsupportedSchemaVersionError extends Error {
  readonly cacheVersion: string | null;
  readonly currentVersion: number;

  constructor(cacheVersion: string | null, currentVersion: number) {
    const rendered = cacheVersion === null ? 'missing' : JSON.stringify(cacheVersion);
    super(
      `SQLite cache schema version ${rendered} is unsupported; expected ${currentVersion}. ` +
        'Run `orcaops rebuild` to replace the disposable cache.'
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.cacheVersion = cacheVersion;
    this.currentVersion = currentVersion;
  }
}

export function parseCacheSchemaVersion(rawVersion: string | null): number | null {
  if (rawVersion === null || !/^(0|[1-9]\d*)$/.test(rawVersion)) return null;
  const parsedVersion = Number(rawVersion);
  return Number.isSafeInteger(parsedVersion) ? parsedVersion : null;
}

/**
 * The agent-facing `cloud_sync.reason` vocabulary. A runtime array, not a bare
 * union: types are erased, so only a value lets the steering golden fail when a
 * member is added undocumented.
 */
export const CLOUD_SYNC_REASONS = [
  'not_authenticated',
  'push_failed',
  'content_invalid',
  'upgrade_required',
  'missing_remote',
  'drain_disabled',
  'no_cloud_configured',
] as const;

export type CloudSyncReason = (typeof CLOUD_SYNC_REASONS)[number];

/**
 * Per-(repo_url, working_dir) state for the CLI's branch-rename chain.
 * The chain accumulates while pushes are queued / offline; it resets to
 * `[]` on a successful captureThread.start ack so subsequent renames
 * start a fresh window.
 */
export interface SessionBranchState {
  repoUrl: string;
  workingDir: string;
  currentBranch: string;
  branchHistory: string[];
  baseCommitSha: string | null;
  lastAckedAt: string | null;
}

/**
 * Common identity + scope fields on every checkpoint row, regardless of
 * lifecycle status. Set at open-time.
 */
interface CheckpointBaseFields {
  artifact_id: string;
  n: number;
  /**
   * UUIDv7 step_ids (not ordinals). Stable across plan revisions.
   * Storage validates uniqueness within the array and disjointness
   * against other open/closed cps' scopes at open time.
   */
  declared_step_ids: string[];
  agent_session_id: string | null;
  policy_exceptions: PolicyException[];
  /**
   * Optimistic-concurrency token: the event_id of the latest plan
   * event the agent observed at open time. Null when the agent
   * skipped the freshness check.
   */
  plan_revision_id: string | null;
  opened_at: string;
  /** Close-time head_sha for closed cps; open-time head_sha otherwise. */
  head_sha: string;
  /**
   * Server-derived `source_event_id` of the plan revision this checkpoint
   * opened against — always non-null for launch-written rows (a plan is
   * mandatory at open). Part of the launch baseline schema so `orcaops why`
   * can attribute plan decisions as-of the checkpoint's open revision
   * instead of the latest; the SQL column stays nullable as projection
   * plumbing only.
   */
  open_plan_revision_event_id: string | null;
}

export interface OpenCheckpointRow extends CheckpointBaseFields {
  status: 'open';
}

export interface ClosedCheckpointRow extends CheckpointBaseFields {
  status: 'closed';
  closed_at: string;
  /** Close-time payload. */
  summary: string;
  files_changed: string[];
  decisions: unknown[];
  uncertainty: string[];
  done_criteria: DoneCriterion[];
  /** UUIDv7 step_ids claimed; subset of declared_step_ids. */
  completed_step_ids: string[];
}

export interface AbandonedCheckpointRow extends CheckpointBaseFields {
  status: 'abandoned';
  abandoned_at: string;
  reason: string;
}

export type CheckpointRow = OpenCheckpointRow | ClosedCheckpointRow | AbandonedCheckpointRow;

/**
 * Per-revision plan metadata row from the `plans` table. One row per
 * `plan_captured | plan_revised` event. revision_n = 0 for the initial
 * capture; revisions increment by 1.
 */
export interface PlanRow {
  artifact_id: string;
  revision_n: number;
  captured_at: string;
  /** Plan-level short headline (1–70 chars, single line). */
  label: string;
  rationale: string | null;
  /** JSON-encoded `string[]`. */
  touched_scope: string;
  /** JSON-encoded `string[]`. */
  non_goals: string;
  /** JSON-encoded `PlanDecision[]`; each entry tagged with its `revision_n`. */
  decisions: string;
  /** JSON-encoded `StepLineage` object. */
  step_lineage: string;
  /** JSON-encoded `CriterionLineage` object. */
  criterion_lineage: string;
  /** event_id of the immediately-prior plan event; null on revision_n = 0. */
  prior_event_id: string | null;
  /** event_id of the plan_captured / plan_revised event this row was projected from. */
  source_event_id: string;
}

/** Per-revision plan_steps row. */
export interface PlanStepRow {
  artifact_id: string;
  revision_n: number;
  step_id: string;
  idx: number;
  text: string;
  label: string;
  /** JSON-encoded `AcceptanceCriterion[]` (parsed by the store mapper). */
  acceptance_criteria: string;
}

export interface SummaryRow {
  artifact_id: string;
  outcome: string;
  tests_written: string[];
  tests_run: string[];
  open_items: string[];
  ts: string;
}

/**
 * The searchable sources, which are the same set the `search --type` flag
 * selects from — aliased to the shared contract rather than repeated.
 *
 * Repeating it is what let the CLI, the storage layer, and the test harness
 * disagree: three copies, and adding a source to one of them changed nothing
 * about the other two and broke no test.
 */
export type SearchSource = SearchType;

/**
 * What an index row's `source` may be: a bare type, or a type with an
 * instance suffix (`plan:0`, `checkpoint:3`, `evaluator:<run id>`).
 *
 * Typed rather than left as `string` because this is the WRITER boundary,
 * and it is the only place that can hold every writer to the contract at
 * once — including the digest writer in `@orcaops/core`. Checking the
 * indexing call sites by scanning their source text instead was both more
 * elaborate and weaker: it could not see a static `'digest'`, and a new
 * writer in a file the scan did not name would simply not be looked at.
 */
export type SearchSourceRef = SearchSource | `${SearchSource}:${string}`;

export interface SearchEntry {
  artifact_id: string;
  /**
   * Source label. Plan rows use `plan:<revision_n>` so each revision
   * gets its own indexable row (initial capture = `plan:0`); the LIKE
   * prefix filter at search time accepts either `plan` or a specific
   * `plan:N`.
   */
  source: SearchSourceRef;
  branch: string;
  ts: string;
  content: string;
}

export interface SearchOptions {
  branch?: string;
  sourcePrefix?: SearchSource;
  limit?: number;
  includeImported?: boolean;
}

export interface SearchResultRow {
  artifact_id: string;
  source: string;
  branch: string;
  ts: string;
  snippet: string;
  rank: number;
  origin_kind?: ArtifactOriginKind | null;
}

/**
 * SQLite row shape for a single evaluator run. Mirrors
 * `MaterializedEvaluatorRun` from `@orcaops/storage/schema/evaluator-run`
 * one-for-one with JSON payloads serialized to TEXT.
 *
 * - `verdict` is NULL iff `run_status !== 'completed'`.
 * - `disposition` is NULL iff the run is not blocking-eligible
 *   (severity != 'block', OR run_status != 'completed', OR
 *   verdict != 'violation'); one of the four EvaluatorDisposition
 *   enum values otherwise.
 * - `raw` and `metrics` are JSON-serialized at the SQL boundary —
 *   parse them back to JS values via JSON.parse before handing to
 *   schema validators.
 * - `error_code` and `error_message` are populated iff
 *   `run_status === 'error'`.
 */
export interface EvaluatorRunRow {
  run_id: string;
  artifact_id: string;
  evaluator_ref: string;
  package_id: string;
  evaluator_id: string;
  phase: string;
  severity: string;
  run_status: 'completed' | 'error' | 'skipped';
  verdict: 'pass' | 'violation' | 'info' | null;
  body: string;
  raw: string | null;
  metrics: string | null;
  provider: 'claude' | 'codex' | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  checkpoint_n: number | null;
  error_code: string | null;
  error_message: string | null;
  ts: string;
  disposition: 'unresolved' | 'acknowledged' | 'dismissed' | 'policy-excepted' | null;
  source_event_index: number;
  local_kind_rank: 0;
  local_index: number;
}

/**
 * SQLite row shape for a single evaluator disposition. Mirrors
 * `MaterializedEvaluatorDisposition` from
 * `@orcaops/storage/schema/evaluator-run` with the order-key
 * components persisted on every row.
 */
export interface EvaluatorDispositionRow {
  disposition_id: string;
  artifact_id: string;
  run_id: string;
  evaluator_ref: string;
  disposition: 'acknowledged' | 'dismissed' | 'policy-excepted';
  reason: string;
  agent_session_id: string | null;
  ts: string;
  source_event_index: number;
  local_kind_rank: 1;
  local_index: number;
}

/**
 * Step claims across all of an artifact's checkpoints. Used by
 * `checkpoint open` to enforce open-time disjointness and by `resume`
 * to compute uncovered plan steps. Step references are by UUIDv7
 * step_id.
 */
export interface StepClaims {
  /** Union of `completed_step_ids` across all CLOSED cps. */
  closedClaimed: string[];
  /** Per-open cp: its `n` and its `declared_step_ids`. */
  openDeclared: Array<{ n: number; declared: string[] }>;
}

/** A projected `usage_snapshots` row (token cols flattened; tokens only). */
export interface UsageSnapshotRow {
  snapshot_id: string;
  idempotency_key: string;
  artifact_id: string | null;
  source_plan_ref_id: string | null;
  agent: string;
  session_id: string;
  lifecycle_event: string;
  checkpoint_n: number | null;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_cache_creation_input_tokens: number;
  cumulative_cache_read_input_tokens: number;
  delta_input_tokens: number | null;
  delta_output_tokens: number | null;
  delta_cache_creation_input_tokens: number | null;
  delta_cache_read_input_tokens: number | null;
  baseline_kind: string;
  /** JSON: Array<{ model, speed?, service_tier?, inference_geo?, cumulative, delta }>. */
  model_breakdown: string;
  /** JSON: the snapshot total's open `dimensions` map (per-model dims live in
   *  `model_breakdown`). Added in migration 020; defaults to '{}'. */
  dimensions: string;
  record_count: number;
  as_of: string;
  ts: string;
}

/** A `source_plan_links` row. */
export interface SourcePlanLinkRow {
  source_plan_ref_id: string;
  artifact_id: string;
  linked_at: string;
  pinned_version: string | null;
}

/** A `coding_sessions` view row — exact MAX(cumulative) per (agent, session_id). */
export interface CodingSessionRow {
  agent: string;
  session_id: string;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_cache_creation_input_tokens: number;
  cumulative_cache_read_input_tokens: number;
  as_of: string;
  record_count: number;
}

/**
 * The per-model breakdown JSON of a session's GLOBAL high-water snapshot — the
 * exact per-model split matching the `coding_sessions` scalar total (per-model
 * cumulative is monotonic, so the high-water snapshot carries it). Returned for
 * the cloud-emit `sessions[].model_breakdown`; `model_breakdown` is the raw JSON
 * string (parse to `UsageModelBreakdownEntry[]`).
 */
export interface SessionModelBreakdownRow {
  agent: string;
  session_id: string;
  model_breakdown: string;
  /** The high-water snapshot's total `dimensions` JSON (added migration 020). */
  dimensions: string;
}

/** Token cols from `attributedArtifactUsage` — an order-independent ESTIMATE
 * (never exact, never additive across artifacts; the cloud must roll up from
 * the first-class session total, NOT by summing these). */
export interface AttributedUsageRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Scope for a same-session baseline lookup — exactly one id is supplied. */
export interface UsageBaselineQuery {
  agent: string;
  sessionId: string;
  artifactId?: string;
  sourcePlanRefId?: string;
  lifecycleEvent?: string;
  checkpointN?: number;
  /** Upper time bound (ISO): consider only priors with `ts <= beforeTs`, so a
   * baseline is never drawn from a future-ts snapshot under out-of-order/
   * concurrent inserts (the audit delta stays sane; attribution is computed
   * order-independently elsewhere). */
  beforeTs?: string;
}

/**
 * The SQL predicate (over alias `us` on `usage_snapshots`, bound param
 * `@artifactId`) defining an artifact's ATTRIBUTION SCOPE: its own snapshots
 * PLUS each linked source plan's snapshots, time-bounded to the link's
 * `linked_at`. Single source of truth shared by every reader that emits OR
 * attributes artifact usage — emission scope and attribution scope MUST stay
 * identical (drift between them is exactly the bug this shared fragment
 * exists to prevent), so all readers interpolate THIS fragment rather than
 * re-spelling it.
 */
const ARTIFACT_USAGE_SCOPE_PREDICATE = `us.artifact_id = @artifactId
            OR EXISTS (
              SELECT 1 FROM source_plan_links l
              WHERE l.artifact_id = @artifactId
                AND l.source_plan_ref_id = us.source_plan_ref_id
                AND us.ts <= l.linked_at
            )`;

/**
 * The `(agent, session_id)` pairs in an artifact's attribution scope, as a
 * subquery over {@link ARTIFACT_USAGE_SCOPE_PREDICATE}. Shared verbatim by
 * `artifactCodingSessions` (an `IN (…)` filter) and
 * `artifactSessionModelBreakdowns` (a `scoped` CTE).
 */
const SCOPED_SESSIONS_SUBQUERY = `SELECT DISTINCT us.agent, us.session_id FROM usage_snapshots us
         WHERE ${ARTIFACT_USAGE_SCOPE_PREDICATE}`;

// A valid SHA-256 is hex-only, so this reversible prefix cannot collide with a real hash.
const CLOUD_SYNC_DIRTY_PREFIX = 'dirty:';

function publicCloudSyncHash(rawHash: string): string {
  if (!rawHash.startsWith(CLOUD_SYNC_DIRTY_PREFIX)) return rawHash;
  const dirtyBody = rawHash.slice(CLOUD_SYNC_DIRTY_PREFIX.length);
  const tokenSeparator = dirtyBody.indexOf(':');
  return tokenSeparator === -1 ? dirtyBody : dirtyBody.slice(tokenSeparator + 1);
}

/**
 * "Artifact has un-synced local activity" predicate. Assumes the artifacts
 * table is aliased `a`. Factored into one fragment so candidate, status,
 * per-artifact, and count surfaces cannot disagree.
 * Imported artifacts are local-only in v1. Reintroducing an opt-in push also
 * requires fixing direct pushArtifact failures to increment the retry counter.
 */
const CLOUD_SYNC_PENDING_PREDICATE = `(
           a.origin_kind IS NOT 'git-import'
           AND (
           a.cloud_synced_at IS NULL
           OR a.cloud_sync_hash LIKE '${CLOUD_SYNC_DIRTY_PREFIX}%'
           OR a.cloud_consecutive_failures > 0
           OR a.cloud_synced_at < (
                SELECT MAX(captured_at) FROM plans WHERE artifact_id = a.id
              )
           OR a.cloud_synced_at < (
                SELECT MAX(COALESCE(closed_at, abandoned_at, opened_at))
                FROM checkpoints
                WHERE artifact_id = a.id
              )
           OR a.cloud_synced_at < (
                SELECT ts FROM summaries WHERE artifact_id = a.id
              )
           OR a.cloud_synced_at < (
                SELECT MAX(ts) FROM evaluator_runs WHERE artifact_id = a.id
              )
           OR a.cloud_synced_at < (
                SELECT MAX(ts) FROM evaluator_dispositions WHERE artifact_id = a.id
              )
           OR a.cloud_synced_at < (
                SELECT MAX(ts) FROM usage_snapshots WHERE artifact_id = a.id
              )
           )
         )`;

/** Repo-wide counts returned by {@link Store.getStoreStats}. */
export interface StoreStats {
  artifacts: { total: number; by_status: Record<string, number> };
  checkpoints: { total: number; by_status: Record<string, number> };
  summaries: { total: number };
}

/** Per-(evaluator_ref, phase) run counts (for `orcaops stats`). */
export interface EvaluatorRunStatsRow {
  evaluator_ref: string;
  phase: string;
  total: number;
  completed: number;
  pass: number;
  violation: number;
  info: number;
  error: number;
  skipped: number;
}

/** Store-derivable capture-hygiene counters (for `orcaops stats`). */
export interface HygieneCounts {
  open_checkpoints_on_finished_artifacts: number;
  summaries_without_pre_pr_run: number;
  closed_cp_without_completed_steps: number;
  closed_cp_without_uncertainty: number;
  closed_cp_without_decisions: number;
  closed_cp_without_files_changed: number;
}

/** Time-window filters shared by `listArtifacts` and `listArtifactsByLineageBranch`. */
export interface ArtifactWindowOpts {
  /** Lower `started_at` bound (inclusive, ISO-8601 UTC). */
  since?: string;
  /** Upper `started_at` bound (inclusive, ISO-8601 UTC). */
  until?: string;
  /** Lower ACTIVITY-window bound (inclusive, ISO-8601 UTC). */
  activeSince?: string;
  /** Upper ACTIVITY-window bound (inclusive, ISO-8601 UTC). */
  activeUntil?: string;
}

/**
 * Append time-window predicates for artifact listing (assumes the artifacts
 * table is aliased `a`). Two independent windows:
 *
 *   - `since`/`until` — plain `started_at` bounds. ISO-8601-Z strings compare
 *     lexicographically (`idx_artifacts_started`).
 *   - `activeSince`/`activeUntil` — activity window with INTERVAL-OVERLAP
 *     semantics: a checkpoint occupies `[opened_at, COALESCE(closed_at,
 *     abandoned_at)]`, and a NULL end means STILL OPEN — in-flight work is
 *     activity, so an open checkpoint overlaps every window at-or-after its
 *     open. An artifact matches iff some checkpoint interval overlaps the
 *     window, OR its summary `ts` falls inside it, OR its `started_at` does
 *     (plan capture is itself activity). Point-event EXISTS would miss a
 *     checkpoint opened Monday and still open Wednesday when querying a
 *     Wednesday window; bounding MIN/MAX activity would wrongly exclude a
 *     yesterday+today artifact from a yesterday-only report — interval
 *     overlap handles both. Either bound may be omitted (open-ended).
 *
 * Correlated-subquery shape mirrors {@link CLOUD_SYNC_PENDING_PREDICATE}; the
 * unindexed checkpoint scan is acceptable at per-repo scale (same tradeoff
 * as `findCheckpointsTouchingFile`).
 */
function pushArtifactWindowPredicates(
  where: string[],
  params: string[],
  opts: ArtifactWindowOpts
): void {
  if (opts.since !== undefined) {
    where.push('a.started_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push('a.started_at <= ?');
    params.push(opts.until);
  }
  if (opts.activeSince === undefined && opts.activeUntil === undefined) return;

  // Interval overlap: opened_at <= activeUntil AND (end IS NULL OR end >=
  // activeSince). Omitted bounds drop their clause (open-ended window).
  const cpOverlap: string[] = [];
  const cpParams: string[] = [];
  if (opts.activeUntil !== undefined) {
    cpOverlap.push('c.opened_at <= ?');
    cpParams.push(opts.activeUntil);
  }
  if (opts.activeSince !== undefined) {
    cpOverlap.push(
      '(COALESCE(c.closed_at, c.abandoned_at) IS NULL OR COALESCE(c.closed_at, c.abandoned_at) >= ?)'
    );
    cpParams.push(opts.activeSince);
  }

  const summaryInWindow: string[] = [];
  const summaryParams: string[] = [];
  const startedInWindow: string[] = [];
  const startedParams: string[] = [];
  if (opts.activeSince !== undefined) {
    summaryInWindow.push('s.ts >= ?');
    summaryParams.push(opts.activeSince);
    startedInWindow.push('a.started_at >= ?');
    startedParams.push(opts.activeSince);
  }
  if (opts.activeUntil !== undefined) {
    summaryInWindow.push('s.ts <= ?');
    summaryParams.push(opts.activeUntil);
    startedInWindow.push('a.started_at <= ?');
    startedParams.push(opts.activeUntil);
  }

  where.push(
    `(EXISTS (SELECT 1 FROM checkpoints c WHERE c.artifact_id = a.id AND ${cpOverlap.join(' AND ')})
      OR EXISTS (SELECT 1 FROM summaries s WHERE s.artifact_id = a.id AND ${summaryInWindow.join(
        ' AND '
      )})
      OR (${startedInWindow.join(' AND ')}))`
  );
  params.push(...cpParams, ...summaryParams, ...startedParams);
}

export class Store {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(
    dbPath: string,
    opts: {
      containmentRoot?: string;
      rebuildFreshProjection?: boolean;
      rebuildExistingProjection?: boolean;
    } = {}
  ) {
    const resolveDbPaths = (): string => {
      if (opts.containmentRoot === undefined) return dbPath;
      const resolved = assertResolvedWithin(dbPath, opts.containmentRoot, 'SQLite cache path', {
        rejectSymlinks: true,
      });
      for (const candidate of new Set([path.resolve(dbPath), resolved])) {
        for (const suffix of ['-wal', '-shm', '-journal']) {
          assertResolvedWithin(
            `${candidate}${suffix}`,
            opts.containmentRoot,
            `SQLite cache${suffix} path`,
            { rejectSymlinks: true }
          );
        }
      }
      return resolved;
    };
    this.dbPath = resolveDbPaths();
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.dbPath = resolveDbPaths();
    try {
      this.db = new (loadDatabase())(this.dbPath);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (isMissingBindingError(cause)) throw new Error(nativeModuleHint(cause));
      throw error;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate(opts.rebuildFreshProjection === true, opts.rebuildExistingProjection === true);
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    const views = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
      .all() as Array<{ name: string }>;
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>;
    this.db.exec('PRAGMA foreign_keys = OFF;');
    // Drop views BEFORE tables: a view left over a since-dropped table would
    // dangle and break the next schema change (SQLite validates every view
    // then). The baseline re-exec below recreates them.
    for (const { name } of views) {
      this.db.exec(`DROP VIEW IF EXISTS "${name}"`);
    }
    for (const { name } of tables) {
      this.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private schemaRequiresRebuild = false;

  private migrate(rebuildSchemaLessProjection = false, rebuildExistingProjection = false): void {
    const hasSchemaMeta = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
      .get();

    if (!hasSchemaMeta) {
      const hasExistingSchema =
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' " +
              "AND type IN ('table', 'view', 'index', 'trigger') LIMIT 1"
          )
          .get() !== undefined;
      if (hasExistingSchema) {
        if (rebuildExistingProjection) {
          this.schemaRequiresRebuild = true;
          return;
        }
        throw new UnsupportedSchemaVersionError(null, CURRENT_VERSION);
      }
      this.db.exec(BASELINE_SCHEMA);
      this.setProjectionHealth(
        rebuildSchemaLessProjection || rebuildExistingProjection ? 'rebuild_pending' : 'healthy'
      );
      return;
    }

    const versionRow = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string } | undefined;
    const rawVersion = versionRow?.value ?? null;

    if (rawVersion === String(CURRENT_VERSION)) {
      this.initializeProjectionHealth();
      if (rebuildExistingProjection) {
        this.setProjectionHealth('rebuild_pending');
      }
      return;
    }
    const parsedVersion = parseCacheSchemaVersion(rawVersion);
    if (parsedVersion !== null && parsedVersion > CURRENT_VERSION) {
      throw new SchemaAheadError(parsedVersion, CURRENT_VERSION);
    }
    if (
      rebuildExistingProjection &&
      parsedVersion !== null &&
      parsedVersion >= 0 &&
      parsedVersion < CURRENT_VERSION
    ) {
      this.schemaRequiresRebuild = true;
      return;
    }
    throw new UnsupportedSchemaVersionError(rawVersion, CURRENT_VERSION);
  }

  private initializeProjectionHealth(): void {
    const legacyMarker = this.db
      .prepare("SELECT 1 FROM schema_meta WHERE key = 'needs_rebuild'")
      .get();
    const health = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(PROJECTION_HEALTH_KEY) as { value: string } | undefined;
    if (legacyMarker !== undefined) {
      this.setProjectionHealth('rebuild_pending');
    } else if (health === undefined) {
      // A current-version cache created before health was persisted has not
      // been certified under the new completeness contract.
      this.setProjectionHealth('rebuild_pending');
    }
  }

  /** Persisted health of the disposable SQLite projection. */
  get projectionHealth(): ProjectionHealth {
    if (this.schemaRequiresRebuild) return 'rebuild_pending';
    const row = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(PROJECTION_HEALTH_KEY) as { value: string } | undefined;
    return row !== undefined && isProjectionHealth(row.value) ? row.value : 'degraded';
  }

  /** True only when automatic durable-source replay should run on open. */
  get needsProjectionRebuild(): boolean {
    return this.projectionHealth === 'rebuild_pending';
  }

  get projectionSkippedArtifacts(): number | null {
    const row = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(PROJECTION_SKIPPED_ARTIFACTS_KEY) as { value: string } | undefined;
    if (row === undefined || !/^(0|[1-9]\d*)$/.test(row.value)) return null;
    const count = Number(row.value);
    return Number.isSafeInteger(count) ? count : null;
  }

  setProjectionHealth(
    health: ProjectionHealth,
    diagnostics: { skippedArtifacts?: number } = {}
  ): void {
    if (
      diagnostics.skippedArtifacts !== undefined &&
      (!Number.isSafeInteger(diagnostics.skippedArtifacts) || diagnostics.skippedArtifacts < 0)
    ) {
      throw new TypeError('skippedArtifacts must be a non-negative safe integer');
    }
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
        .run(PROJECTION_HEALTH_KEY, health);
      if (health === 'degraded' && diagnostics.skippedArtifacts !== undefined) {
        this.db
          .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
          .run(PROJECTION_SKIPPED_ARTIFACTS_KEY, String(diagnostics.skippedArtifacts));
      } else {
        this.db
          .prepare('DELETE FROM schema_meta WHERE key = ?')
          .run(PROJECTION_SKIPPED_ARTIFACTS_KEY);
      }
      this.db.prepare("DELETE FROM schema_meta WHERE key = 'needs_rebuild'").run();
    })();
    this.schemaRequiresRebuild = false;
  }

  // ────────────────────────────────────────
  // Artifacts
  // ────────────────────────────────────────

  upsertArtifact(row: ArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, branch, task, label, agent, base_sha, started_at, completed_at, status, non_goals, origin_kind)
         VALUES (@id, @branch, @task, @label, @agent, @base_sha, @started_at, @completed_at, @status, @non_goals, @origin_kind)
         ON CONFLICT(id) DO UPDATE SET
           branch       = excluded.branch,
           task         = excluded.task,
           label        = excluded.label,
           agent        = excluded.agent,
           base_sha     = excluded.base_sha,
           started_at   = excluded.started_at,
           completed_at = excluded.completed_at,
           status       = excluded.status,
           non_goals    = excluded.non_goals,
           origin_kind  = excluded.origin_kind`
      )
      .run({ ...row, origin_kind: row.origin_kind ?? null });
  }

  getArtifact(id: string): ArtifactRow | null {
    const row = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
      | ArtifactRow
      | undefined;
    return row ?? null;
  }

  listArtifacts(
    opts: { branch?: string; status?: ArtifactStatus } & ArtifactWindowOpts = {}
  ): ArtifactRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.branch !== undefined) {
      where.push('a.branch = ?');
      params.push(opts.branch);
    }
    if (opts.status !== undefined) {
      where.push('a.status = ?');
      params.push(opts.status);
    }
    pushArtifactWindowPredicates(where, params, opts);
    const sql =
      where.length === 0
        ? `SELECT a.* FROM artifacts a ORDER BY a.started_at DESC`
        : `SELECT a.* FROM artifacts a WHERE ${where.join(' AND ')} ORDER BY a.started_at DESC`;
    return this.db.prepare(sql).all(...params) as ArtifactRow[];
  }

  /**
   * Candidate artifact ids for an opportunistic cloud-sync drain. Returns
   * artifacts the local store has touched since their last cloud push, plus
   * never-synced ones, so the caller can blast each through `pushArtifact`'s
   * hash-dedup short-circuit. Bounded by `limit` so a long-lived store doesn't
   * make every capture command pay for hundreds of snapshot reads.
   *
   * Inclusion rules (any matches → candidate):
   *   - `cloud_synced_at IS NULL` — never pushed (e.g., user captured before
   *     login).
   *   - a recorded push failure remains unresolved.
   *   - the latest plan revision, evaluator run/disposition, or direct usage
   *     snapshot is newer than `cloud_synced_at`. Token rotation independently
   *     invalidates every artifact whose emitted shared-session or linked usage
   *     can change, including backdated observations.
   *   - latest checkpoint write (opened/closed/abandoned) is newer than
   *     `cloud_synced_at` — long-running artifact gained activity post-sync
   *     and the eager push didn't land.
   *   - summary write is newer than `cloud_synced_at` — finalize-time push
   *     missed.
   *
   * Backoff filter: artifacts with prior failures are also gated on
   * `cloud_last_push_attempt_at + delay <= now`, where `delay` follows
   * exponential backoff `30s * 2^(failures - 1)` capped at 1h. Bypassed
   * when `force` is true — that's the explicit knob `orcaops resync --force`
   * passes through. Implicit drains (capture / login) never bypass.
   *
   * Ordering puts never-synced rows first so a queue of 20 fresh-but-clean
   * artifacts can't crowd them out, then breaks ties by `started_at DESC`
   * (most recent first). Timestamps are normalized to ISO-8601-with-Z via
   * `strftime` so the lexicographic compare against artifact `started_at`
   * (which is `Date.toISOString()`) is exact rather than relying on the
   * `'T' > ' '` ASCII coincidence.
   *
   * Usage session totals are global on the cloud wire. One new snapshot can
   * therefore make multiple artifacts from the same agent session pending;
   * the limit intentionally amortizes that faithful fan-out across drains.
   */
  findArtifactsForCloudSyncDrain(
    opts: {
      limit?: number;
      /** When true, ignores the per-artifact backoff filter. Used by `orcaops resync --force`. */
      force?: boolean;
      /** Test seam: ISO-8601-with-Z timestamp substituted for SQLite's `'now'`
       *  in the backoff comparison. Production callers omit this. */
      nowOverride?: string;
      /**
       * Cross-tenant guard. When provided, excludes artifacts whose
       * `cloud_org_id` IS NOT NULL AND differs from this org id — these are
       * captures previously pushed to a different org. Fresh artifacts
       * (`cloud_org_id IS NULL`) are always included since we don't know
       * their target org yet (cloud-side tenancy gates the create path).
       *
       * Callers pass the just-authenticated org id from `isAuthReady` so
       * post-login drain doesn't re-push someone else's data to the
       * current org. `excludedForeignOrg` counts every otherwise-eligible
       * foreign-org row, independently of the included-row limit, so the UX
       * can disclose the full skipped set.
       */
      orgIdFilter?: string;
    } = {}
  ): { included: string[]; excludedForeignOrg: number } {
    const limit = opts.limit ?? 20;
    const force = opts.force === true;
    // SQLite's modifiers accept either the literal `'now'` or a real ISO
    // timestamp as the base. We resolve `'now'` once into a deterministic
    // value for tests; otherwise stay with the literal so SQLite uses
    // wall-clock time.
    const nowExpr = opts.nowOverride ?? 'now';

    // Backoff: 30 * 2^(failures - 1), capped at 1h. SQLite has bitwise `<<`,
    // so we can compute it inline. cf=0 short-circuits to 0 (no backoff).
    const backoffClause = force
      ? ''
      : `AND (
           a.cloud_consecutive_failures = 0
           OR a.cloud_last_push_attempt_at IS NULL
           OR CAST(strftime('%s', a.cloud_last_push_attempt_at) AS INTEGER)
                + MIN(30 * (1 << MIN(a.cloud_consecutive_failures - 1, 9)), 3600)
              <= CAST(strftime('%s', @nowExpr) AS INTEGER)
         )`;
    const orgEligibilityClause = opts.orgIdFilter
      ? 'AND (a.cloud_org_id IS NULL OR a.cloud_org_id = @orgId)'
      : '';
    const params = {
      limit,
      nowExpr,
      ...(opts.orgIdFilter ? { orgId: opts.orgIdFilter } : {}),
    };

    const rows = this.db
      .prepare(
        `SELECT a.id, a.cloud_org_id FROM artifacts a
         WHERE ${CLOUD_SYNC_PENDING_PREDICATE}
         ${backoffClause}
         ${orgEligibilityClause}
         ORDER BY (a.cloud_synced_at IS NOT NULL), a.started_at DESC
         LIMIT @limit`
      )
      .all(params) as Array<{
      id: string;
      cloud_org_id: string | null;
    }>;

    if (!opts.orgIdFilter) {
      return { included: rows.map((r) => r.id), excludedForeignOrg: 0 };
    }
    const excludedForeignOrg = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM artifacts a
           WHERE ${CLOUD_SYNC_PENDING_PREDICATE}
           ${backoffClause}
           AND a.cloud_org_id IS NOT NULL
           AND a.cloud_org_id != @orgId`
        )
        .get(params) as { n: number }
    ).n;
    return { included: rows.map((row) => row.id), excludedForeignOrg };
  }

  deleteArtifact(artifactId: string): void {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM search_idx WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM lineage_by_latest_sha WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM lineage_branches WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM plan_idempotency WHERE artifact_id = ?`).run(id);
    });
    tx(artifactId);
  }

  // ────────────────────────────────────────
  // Cloud sync state
  // ────────────────────────────────────────

  getCloudSyncState(artifactId: string): CloudSyncState | null {
    const row = this.db
      .prepare(
        `SELECT cloud_synced_at, cloud_sync_hash, cloud_external_id, cloud_org_id
         FROM artifacts WHERE id = ?`
      )
      .get(artifactId) as
      | {
          cloud_synced_at: string | null;
          cloud_sync_hash: string | null;
          cloud_external_id: string | null;
          cloud_org_id: string | null;
        }
      | undefined;
    if (
      !row ||
      !row.cloud_synced_at ||
      !row.cloud_sync_hash ||
      !row.cloud_external_id ||
      !row.cloud_org_id
    ) {
      return null;
    }
    return {
      syncedAt: row.cloud_synced_at,
      hash: publicCloudSyncHash(row.cloud_sync_hash),
      externalId: row.cloud_external_id,
      orgId: row.cloud_org_id,
    };
  }

  /** Exact private snapshot version used by cloud push finalization. */
  getCloudSyncRawHash(artifactId: string): string | null | undefined {
    const row = this.db
      .prepare(`SELECT cloud_sync_hash FROM artifacts WHERE id = ?`)
      .get(artifactId) as { cloud_sync_hash: string | null } | undefined;
    return row?.cloud_sync_hash;
  }

  setCloudSyncState(artifactId: string, state: CloudSyncState): void {
    // Success also clears all per-artifact failure state in the same UPDATE:
    // attempt_at advances to syncedAt, error fields go null, and the
    // consecutive-failures counter resets so the backoff filter stops
    // gating the next attempt.
    //
    // The `cloud_synced_at < @syncedAt` guard prevents a temporally-stale
    // success (process A finished its push at T_A, process B raced and
    // finished a push of an OLDER snapshot at T_B > T_A but with a syncedAt
    // sampled at T_B' < T_A) from overwriting newer cloud state — concretely
    // the `cloud_sync_hash` field, which the next drain reads for hash-dedup.
    // Without the guard, a stale write would silently roll back the recorded
    // hash and trigger a spurious re-push on the next drain cycle.
    this.db
      .prepare(
        `UPDATE artifacts SET
           cloud_synced_at = @syncedAt,
           cloud_sync_hash = @hash,
           cloud_external_id = @externalId,
           cloud_org_id    = @orgId,
           cloud_last_push_attempt_at = @syncedAt,
           cloud_last_push_error_kind = NULL,
           cloud_last_push_error_message = NULL,
           cloud_consecutive_failures = 0
         WHERE id = @id
           AND (cloud_synced_at IS NULL OR cloud_synced_at < @syncedAt)`
      )
      .run({ id: artifactId, ...state });
  }

  /**
   * Record a successful push only if the payload version captured before the
   * snapshot is still current. `IS` is load-bearing: the first push expects a
   * null hash, which `=` cannot match in SQLite.
   */
  setCloudSyncStateIfCurrent(
    artifactId: string,
    expectedRawHash: string | null,
    state: CloudSyncState
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE artifacts SET
           cloud_synced_at = @syncedAt,
           cloud_sync_hash = @hash,
           cloud_external_id = @externalId,
           cloud_org_id    = @orgId,
           cloud_last_push_attempt_at = @syncedAt,
           cloud_last_push_error_kind = NULL,
           cloud_last_push_error_message = NULL,
           cloud_consecutive_failures = 0
         WHERE id = @id
           AND cloud_sync_hash IS @expectedRawHash
           AND (cloud_synced_at IS NULL OR cloud_synced_at < @syncedAt)`
      )
      .run({ id: artifactId, expectedRawHash, ...state });
    return result.changes === 1;
  }

  /**
   * Rotate the private payload version for every named artifact. Null hashes
   * still rotate: that is what invalidates a first push whose snapshot began
   * before the mutation. One colon-free UUIDv7 token per batch is sufficient
   * because finalization compares the complete value on each artifact row.
   */
  rotateCloudSyncTokens(artifactIds: Iterable<string>): number {
    const ids = [...new Set(artifactIds)];
    if (ids.length === 0) return 0;
    const token = uuidv7();
    const rotate = this.db.prepare(
      `UPDATE artifacts
       SET cloud_sync_hash = @dirtyPrefix || @token || ':' ||
         CASE
           WHEN cloud_sync_hash IS NULL THEN ''
           WHEN cloud_sync_hash NOT LIKE @dirtyPattern THEN cloud_sync_hash
           WHEN instr(substr(cloud_sync_hash, @dirtyBodyStart), ':') = 0
             THEN substr(cloud_sync_hash, @dirtyBodyStart)
           ELSE substr(
             substr(cloud_sync_hash, @dirtyBodyStart),
             instr(substr(cloud_sync_hash, @dirtyBodyStart), ':') + 1
           )
         END
       WHERE id = @id`
    );
    const params = {
      dirtyPrefix: CLOUD_SYNC_DIRTY_PREFIX,
      dirtyPattern: `${CLOUD_SYNC_DIRTY_PREFIX}%`,
      dirtyBodyStart: CLOUD_SYNC_DIRTY_PREFIX.length + 1,
      token,
    };
    return this.db.transaction((artifactIdsToRotate: string[]) => {
      let changed = 0;
      for (const id of artifactIdsToRotate) changed += rotate.run({ ...params, id }).changes;
      return changed;
    })(ids);
  }

  /**
   * Rich-row variant of `findArtifactsForCloudSyncDrain` for the
   * `orcaops push-status` and `orcaops doctor` surfaces. Returns every
   * artifact the activity-window filter would consider a candidate
   * (never-synced or post-sync activity), regardless of backoff, with
   * the per-artifact failure state attached so the caller can render
   * "X is stuck with Y consecutive Z errors, next attempt at T."
   *
   * Backoff is intentionally NOT applied here — the user-facing surfaces
   * want to see ALL pending work, including artifacts in their backoff
   * window. The `next_attempt_at` field carries the resolved next-attempt
   * timestamp so the caller can render "due now" vs "in N seconds."
   *
   * `nowOverride` is a test seam mirroring `findArtifactsForCloudSyncDrain`'s.
   */
  getCloudSyncPendingArtifacts(opts: { limit?: number; nowOverride?: string } = {}): Array<{
    id: string;
    branch: string;
    started_at: string;
    cloud_synced_at: string | null;
    cloud_last_push_attempt_at: string | null;
    cloud_last_push_error_kind: string | null;
    cloud_last_push_error_message: string | null;
    cloud_consecutive_failures: number;
    next_attempt_at: string | null;
  }> {
    const limit = opts.limit ?? 20;
    const nowExpr = opts.nowOverride ?? 'now';
    const rows = this.db
      .prepare(
        `SELECT a.id, a.branch, a.started_at,
                a.cloud_synced_at,
                a.cloud_last_push_attempt_at,
                a.cloud_last_push_error_kind,
                a.cloud_last_push_error_message,
                a.cloud_consecutive_failures,
                CASE
                  WHEN a.cloud_consecutive_failures = 0 OR a.cloud_last_push_attempt_at IS NULL THEN NULL
                  ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                a.cloud_last_push_attempt_at,
                                '+' || MIN(30 * (1 << MIN(a.cloud_consecutive_failures - 1, 9)), 3600) || ' seconds')
                END AS next_attempt_at
         FROM artifacts a
         WHERE ${CLOUD_SYNC_PENDING_PREDICATE}
         ORDER BY (a.cloud_synced_at IS NOT NULL), a.started_at DESC
         LIMIT @limit`
      )
      .all({ limit, nowExpr }) as Array<{
      id: string;
      branch: string;
      started_at: string;
      cloud_synced_at: string | null;
      cloud_last_push_attempt_at: string | null;
      cloud_last_push_error_kind: string | null;
      cloud_last_push_error_message: string | null;
      cloud_consecutive_failures: number;
      next_attempt_at: string | null;
    }>;
    return rows;
  }

  /**
   * Targeted, cap-free probe of ONE artifact's cloud-sync state
   * (`cloud_sync`). Unlike {@link getCloudSyncPendingArtifacts} (a LIMIT 20 list,
   * unsound for membership when an already-synced-but-stale artifact sorts past
   * the cap), this answers "did THIS artifact land?" exactly. `pending` is the
   * shared un-synced-activity predicate; `consecutiveFailures` distinguishes a
   * recorded push failure (loud) from a never-attempted skip (env/config); and
   * `lastErrorKind` lets the classifier single out a non-retryable
   * `content-invalid` fault (scrub+rebuild) from a transient `push_failed`.
   * `syncedAt` is the artifact's landed fact — its last successful push, null
   * when it has never reached the cloud. Only {@link setCloudSyncState}
   * advances it and nothing clears it, so it stays true about the artifact
   * after the session that uploaded it is revoked.
   * Returns null when the artifact does not exist.
   */
  getCloudSyncStateForArtifact(artifactId: string): {
    pending: boolean;
    syncedAt: string | null;
    consecutiveFailures: number;
    lastErrorKind: CloudSyncFailureKind | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT a.cloud_consecutive_failures AS consecutiveFailures,
                a.cloud_last_push_error_kind AS lastErrorKind,
                a.cloud_synced_at AS syncedAt,
                CASE WHEN ${CLOUD_SYNC_PENDING_PREDICATE} THEN 1 ELSE 0 END AS pending
         FROM artifacts a
         WHERE a.id = @id`
      )
      .get({ id: artifactId }) as
      | {
          consecutiveFailures: number;
          lastErrorKind: string | null;
          syncedAt: string | null;
          pending: number;
        }
      | undefined;
    if (!row) return null;
    return {
      pending: row.pending === 1,
      syncedAt: row.syncedAt,
      consecutiveFailures: row.consecutiveFailures,
      lastErrorKind: (row.lastErrorKind as CloudSyncFailureKind | null) ?? null,
    };
  }

  /** Exact (uncapped) count of artifacts with un-synced local activity. */
  countCloudSyncPendingArtifacts(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${CLOUD_SYNC_PENDING_PREDICATE}`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Persist a failed push attempt: updates `cloud_last_push_attempt_at`,
   * stores the (already-scrubbed) error kind + message, and atomically
   * increments `cloud_consecutive_failures`. The atomic `+ 1` UPDATE is
   * load-bearing — concurrent capture commands can race on the same
   * artifact and a non-atomic read-modify-write would lose increments.
   *
   * `attemptStartedAt` gates the UPDATE so a stale failure from a
   * still-in-flight push cannot clobber a successful push that landed
   * during this attempt. Concretely: if process B started a push at
   * T_B_start and process A's push succeeded at T_A > T_B_start, A's
   * `setCloudSyncState` advanced `cloud_synced_at` to T_A. When B's push
   * eventually fails and we try to record it, the WHERE clause filters
   * on `cloud_synced_at < @attemptStartedAt` (T_A < T_B_start ⇒ false),
   * so B's failure write is dropped — the artifact is genuinely synced
   * and B's failure is racing observation, not artifact-attributable.
   *
   * Env-class outcomes (NotConnected / MissingGitRemote / ArtifactNotFound)
   * are intentionally absent from `CloudSyncFailureKind` and must not be
   * routed here — those are environmental, not artifact-attributable, and
   * mixing them into per-artifact failure state would inflate
   * `consecutive_failures` and cause spurious backoff during a logged-out
   * session.
   */
  recordCloudSyncFailure(
    artifactId: string,
    failure: {
      kind: CloudSyncFailureKind;
      message: string | null;
      attemptedAt: string;
      attemptStartedAt: string;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE artifacts SET
           cloud_last_push_attempt_at = @attemptedAt,
           cloud_last_push_error_kind = @kind,
           cloud_last_push_error_message = @message,
           cloud_consecutive_failures = cloud_consecutive_failures + 1
         WHERE id = @id
           AND (cloud_synced_at IS NULL OR cloud_synced_at < @attemptStartedAt)`
      )
      .run({
        id: artifactId,
        attemptedAt: failure.attemptedAt,
        attemptStartedAt: failure.attemptStartedAt,
        kind: failure.kind,
        message: failure.message,
      });
  }

  // ────────────────────────────────────────
  // CLI session branch state (rename-history chain)
  // ────────────────────────────────────────

  /**
   * Read the per-(repo_url, working_dir) session branch state. Returns
   * null when the row hasn't been initialized yet (first invocation in
   * this clone). Callers seed via `upsertSessionBranchState`.
   */
  getSessionBranchState(repoUrl: string, workingDir: string): SessionBranchState | null {
    const row = this.db
      .prepare(
        `SELECT current_branch, branch_history, base_commit_sha, last_acked_at
         FROM cli_session_branch_state
         WHERE repo_url = ? AND working_dir = ?`
      )
      .get(repoUrl, workingDir) as
      | {
          current_branch: string;
          branch_history: string;
          base_commit_sha: string | null;
          last_acked_at: string | null;
        }
      | undefined;
    if (!row) return null;
    let history: string[];
    try {
      const parsed = JSON.parse(row.branch_history) as unknown;
      history = Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
      history = [];
    }
    return {
      repoUrl,
      workingDir,
      currentBranch: row.current_branch,
      branchHistory: history,
      baseCommitSha: row.base_commit_sha,
      lastAckedAt: row.last_acked_at,
    };
  }

  /**
   * Upsert the session branch state. Use after every observed
   * git-symbolic-ref read so the row reflects the current truth — the
   * helper that owns rename detection invokes this with the new
   * `currentBranch` and the appended `branchHistory`.
   */
  upsertSessionBranchState(state: {
    repoUrl: string;
    workingDir: string;
    currentBranch: string;
    branchHistory: string[];
    baseCommitSha: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cli_session_branch_state
           (repo_url, working_dir, current_branch, branch_history, base_commit_sha)
         VALUES (@repoUrl, @workingDir, @currentBranch, @branchHistory, @baseCommitSha)
         ON CONFLICT (repo_url, working_dir) DO UPDATE SET
           current_branch  = excluded.current_branch,
           branch_history  = excluded.branch_history,
           base_commit_sha = excluded.base_commit_sha`
      )
      .run({
        repoUrl: state.repoUrl,
        workingDir: state.workingDir,
        currentBranch: state.currentBranch,
        branchHistory: JSON.stringify(state.branchHistory),
        baseCommitSha: state.baseCommitSha,
      });
  }

  /**
   * Mark a successful captureThread.start ack — clears the pending
   * branch-history chain and stamps `last_acked_at`. The next rename
   * starts a fresh window. Idempotent: a no-row-affected outcome is
   * fine (the caller may invoke this on the first push before any
   * state row exists).
   */
  markSessionAcked(repoUrl: string, workingDir: string, ackedAt: string): void {
    this.db
      .prepare(
        `UPDATE cli_session_branch_state
            SET branch_history = '[]',
                last_acked_at  = ?
          WHERE repo_url = ? AND working_dir = ?`
      )
      .run(ackedAt, repoUrl, workingDir);
  }

  // ────────────────────────────────────────
  // Plans (per-revision metadata)
  // ────────────────────────────────────────

  /**
   * Insert one revision's metadata + steps in a single transaction.
   * Idempotent under the (artifact_id, revision_n) primary key:
   * re-inserting the same revision is a no-op replace (event-first
   * projection layer is the canonical writer; SQLite is the index).
   */
  upsertPlanRevision(opts: {
    plan: PlanRow;
    steps: Array<{
      step_id: string;
      idx: number;
      text: string;
      label: string;
      acceptance_criteria: string;
    }>;
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plans (
             artifact_id, revision_n, captured_at, label, rationale,
             touched_scope, non_goals, decisions, step_lineage, criterion_lineage, prior_event_id, source_event_id
           )
           VALUES (
             @artifact_id, @revision_n, @captured_at, @label, @rationale,
             @touched_scope, @non_goals, @decisions, @step_lineage, @criterion_lineage, @prior_event_id, @source_event_id
           )
           ON CONFLICT(artifact_id, revision_n) DO UPDATE SET
             captured_at       = excluded.captured_at,
             label             = excluded.label,
             rationale         = excluded.rationale,
             touched_scope     = excluded.touched_scope,
             non_goals         = excluded.non_goals,
             decisions         = excluded.decisions,
             step_lineage      = excluded.step_lineage,
             criterion_lineage = excluded.criterion_lineage,
             prior_event_id    = excluded.prior_event_id,
             source_event_id   = excluded.source_event_id`
        )
        .run(opts.plan);

      this.db
        .prepare(`DELETE FROM plan_steps WHERE artifact_id = ? AND revision_n = ?`)
        .run(opts.plan.artifact_id, opts.plan.revision_n);

      const insertStep = this.db.prepare(
        `INSERT INTO plan_steps (artifact_id, revision_n, step_id, idx, text, label, acceptance_criteria)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of opts.steps) {
        insertStep.run(
          opts.plan.artifact_id,
          opts.plan.revision_n,
          s.step_id,
          s.idx,
          s.text,
          s.label,
          s.acceptance_criteria
        );
      }
    });
    tx();
  }

  /**
   * Latest plan revision for an artifact. Returns the plans row plus
   * its ordered steps. Null when no plan has been captured yet.
   */
  getLatestPlanRevision(artifactId: string): { plan: PlanRow; steps: PlanStepRow[] } | null {
    const planRow = this.db
      .prepare(
        `SELECT artifact_id, revision_n, captured_at, label, rationale,
                touched_scope, non_goals, decisions, step_lineage, criterion_lineage, prior_event_id, source_event_id
         FROM plans
         WHERE artifact_id = ?
         ORDER BY revision_n DESC
         LIMIT 1`
      )
      .get(artifactId) as PlanRow | undefined;
    if (!planRow) return null;
    const stepRows = this.db
      .prepare(
        `SELECT artifact_id, revision_n, step_id, idx, text, label, acceptance_criteria
         FROM plan_steps
         WHERE artifact_id = ? AND revision_n = ?
         ORDER BY idx ASC`
      )
      .all(artifactId, planRow.revision_n) as PlanStepRow[];
    return { plan: planRow, steps: stepRows };
  }

  /**
   * Specific revision's plan + steps. Used by digest's "Plan revisions"
   * section and by show's lineage trailer.
   */
  getPlanRevision(
    artifactId: string,
    revisionN: number
  ): { plan: PlanRow; steps: PlanStepRow[] } | null {
    const planRow = this.db
      .prepare(
        `SELECT artifact_id, revision_n, captured_at, label, rationale,
                touched_scope, non_goals, decisions, step_lineage, criterion_lineage, prior_event_id, source_event_id
         FROM plans
         WHERE artifact_id = ? AND revision_n = ?`
      )
      .get(artifactId, revisionN) as PlanRow | undefined;
    if (!planRow) return null;
    const stepRows = this.db
      .prepare(
        `SELECT artifact_id, revision_n, step_id, idx, text, label, acceptance_criteria
         FROM plan_steps
         WHERE artifact_id = ? AND revision_n = ?
         ORDER BY idx ASC`
      )
      .all(artifactId, revisionN) as PlanStepRow[];
    return { plan: planRow, steps: stepRows };
  }

  /**
   * All revisions for an artifact, ordered ascending by revision_n.
   * Used by digest, show, and doctor's per-revision audit checks.
   */
  listPlanRevisions(artifactId: string): Array<{ plan: PlanRow; steps: PlanStepRow[] }> {
    const planRows = this.db
      .prepare(
        `SELECT artifact_id, revision_n, captured_at, label, rationale,
                touched_scope, non_goals, decisions, step_lineage, criterion_lineage, prior_event_id, source_event_id
         FROM plans
         WHERE artifact_id = ?
         ORDER BY revision_n ASC`
      )
      .all(artifactId) as PlanRow[];
    if (planRows.length === 0) return [];
    const stepRows = this.db
      .prepare(
        `SELECT artifact_id, revision_n, step_id, idx, text, label, acceptance_criteria
         FROM plan_steps
         WHERE artifact_id = ?
         ORDER BY revision_n ASC, idx ASC`
      )
      .all(artifactId) as PlanStepRow[];
    const stepsByRev = new Map<number, PlanStepRow[]>();
    for (const s of stepRows) {
      const list = stepsByRev.get(s.revision_n) ?? [];
      list.push(s);
      stepsByRev.set(s.revision_n, list);
    }
    return planRows.map((p) => ({ plan: p, steps: stepsByRev.get(p.revision_n) ?? [] }));
  }

  /**
   * MAX(revision_n) for an artifact. Returns -1 when no plan has been
   * captured yet (so that a fresh capture writes revision_n = 0).
   */
  latestPlanRevisionN(artifactId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(revision_n), -1) AS max_n FROM plans WHERE artifact_id = ?`)
      .get(artifactId) as { max_n: number };
    return row.max_n;
  }

  /**
   * source_event_id of the latest plan event for an artifact, or null
   * if no plan exists. Used by the optimistic-concurrency token check
   * on `plan revise` and `checkpoint open`.
   */
  latestPlanSourceEventId(artifactId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT source_event_id FROM plans
         WHERE artifact_id = ?
         ORDER BY revision_n DESC
         LIMIT 1`
      )
      .get(artifactId) as { source_event_id: string } | undefined;
    return row?.source_event_id ?? null;
  }

  // ────────────────────────────────────────
  // Checkpoints (two-phase lifecycle)
  // ────────────────────────────────────────

  upsertCheckpoint(cp: CheckpointRow): void {
    const common = {
      artifact_id: cp.artifact_id,
      n: cp.n,
      status: cp.status,
      declared_step_ids: JSON.stringify(cp.declared_step_ids),
      agent_session_id: cp.agent_session_id,
      policy_exceptions: JSON.stringify(cp.policy_exceptions),
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      head_sha: cp.head_sha,
      open_plan_revision_event_id: cp.open_plan_revision_event_id,
    };
    if (cp.status === 'open') {
      this.db
        .prepare(
          `INSERT INTO checkpoints (
             artifact_id, n, status, declared_step_ids, agent_session_id,
             policy_exceptions, plan_revision_id, opened_at, head_sha, open_plan_revision_event_id,
             closed_at, abandoned_at, reason,
             summary, files_changed, decisions, uncertainty, done_criteria, completed_step_ids
           )
           VALUES (
             @artifact_id, @n, @status, @declared_step_ids, @agent_session_id,
             @policy_exceptions, @plan_revision_id, @opened_at, @head_sha, @open_plan_revision_event_id,
             NULL, NULL, NULL,
             NULL, '[]', '[]', '[]', '[]', '[]'
           )
           ON CONFLICT(artifact_id, n) DO UPDATE SET
             status              = excluded.status,
             declared_step_ids   = excluded.declared_step_ids,
             agent_session_id    = excluded.agent_session_id,
             policy_exceptions   = excluded.policy_exceptions,
             plan_revision_id    = excluded.plan_revision_id,
             opened_at           = excluded.opened_at,
             head_sha            = excluded.head_sha,
             open_plan_revision_event_id = excluded.open_plan_revision_event_id,
             closed_at           = NULL,
             abandoned_at        = NULL,
             reason              = NULL,
             summary             = NULL,
             files_changed       = '[]',
             decisions           = '[]',
             uncertainty         = '[]',
             done_criteria       = '[]',
             completed_step_ids  = '[]'`
        )
        .run(common);
      return;
    }
    if (cp.status === 'closed') {
      this.db
        .prepare(
          `INSERT INTO checkpoints (
             artifact_id, n, status, declared_step_ids, agent_session_id,
             policy_exceptions, plan_revision_id, opened_at, head_sha, open_plan_revision_event_id,
             closed_at, abandoned_at, reason,
             summary, files_changed, decisions, uncertainty, done_criteria, completed_step_ids
           )
           VALUES (
             @artifact_id, @n, @status, @declared_step_ids, @agent_session_id,
             @policy_exceptions, @plan_revision_id, @opened_at, @head_sha, @open_plan_revision_event_id,
             @closed_at, NULL, NULL,
             @summary, @files_changed, @decisions, @uncertainty, @done_criteria, @completed_step_ids
           )
           ON CONFLICT(artifact_id, n) DO UPDATE SET
             status              = excluded.status,
             declared_step_ids   = excluded.declared_step_ids,
             agent_session_id    = excluded.agent_session_id,
             policy_exceptions   = excluded.policy_exceptions,
             plan_revision_id    = excluded.plan_revision_id,
             opened_at           = excluded.opened_at,
             head_sha            = excluded.head_sha,
             open_plan_revision_event_id = excluded.open_plan_revision_event_id,
             closed_at           = excluded.closed_at,
             abandoned_at        = NULL,
             reason              = NULL,
             summary             = excluded.summary,
             files_changed       = excluded.files_changed,
             decisions           = excluded.decisions,
             uncertainty         = excluded.uncertainty,
             done_criteria       = excluded.done_criteria,
             completed_step_ids  = excluded.completed_step_ids`
        )
        .run({
          ...common,
          closed_at: cp.closed_at,
          summary: cp.summary,
          files_changed: JSON.stringify(cp.files_changed),
          decisions: JSON.stringify(cp.decisions),
          uncertainty: JSON.stringify(cp.uncertainty),
          done_criteria: JSON.stringify(cp.done_criteria),
          completed_step_ids: JSON.stringify(cp.completed_step_ids),
        });
      return;
    }
    // abandoned
    this.db
      .prepare(
        `INSERT INTO checkpoints (
           artifact_id, n, status, declared_step_ids, agent_session_id,
           policy_exceptions, plan_revision_id, opened_at, head_sha, open_plan_revision_event_id,
           closed_at, abandoned_at, reason,
           summary, files_changed, decisions, uncertainty, done_criteria, completed_step_ids
         )
         VALUES (
           @artifact_id, @n, @status, @declared_step_ids, @agent_session_id,
           @policy_exceptions, @plan_revision_id, @opened_at, @head_sha, @open_plan_revision_event_id,
           NULL, @abandoned_at, @reason,
           NULL, '[]', '[]', '[]', '[]', '[]'
         )
         ON CONFLICT(artifact_id, n) DO UPDATE SET
           status              = excluded.status,
           declared_step_ids   = excluded.declared_step_ids,
           agent_session_id    = excluded.agent_session_id,
           policy_exceptions   = excluded.policy_exceptions,
           plan_revision_id    = excluded.plan_revision_id,
           opened_at           = excluded.opened_at,
           head_sha            = excluded.head_sha,
           open_plan_revision_event_id = excluded.open_plan_revision_event_id,
           closed_at           = NULL,
           abandoned_at        = excluded.abandoned_at,
           reason              = excluded.reason,
           summary             = NULL,
           files_changed       = '[]',
           decisions           = '[]',
           uncertainty         = '[]',
           done_criteria       = '[]',
           completed_step_ids  = '[]'`
      )
      .run({
        ...common,
        abandoned_at: cp.abandoned_at,
        reason: cp.reason,
      });
  }

  /**
   * All checkpoint rows for an artifact, in `n` order. Returns the
   * lifecycle-typed shape; consumers must branch on `status`.
   */
  getCheckpoints(artifactId: string): CheckpointRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM checkpoints WHERE artifact_id = ? ORDER BY n ASC`)
      .all(artifactId) as RawCheckpointRow[];
    return rows.map(rawToCheckpointRow);
  }

  getOpenCheckpoints(artifactId: string): OpenCheckpointRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM checkpoints WHERE artifact_id = ? AND status = 'open' ORDER BY n ASC`)
      .all(artifactId) as RawCheckpointRow[];
    return rows.map(rawToCheckpointRow).filter((r): r is OpenCheckpointRow => r.status === 'open');
  }

  getClosedCheckpoints(artifactId: string): ClosedCheckpointRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE artifact_id = ? AND status = 'closed' ORDER BY n ASC`
      )
      .all(artifactId) as RawCheckpointRow[];
    return rows
      .map(rawToCheckpointRow)
      .filter((r): r is ClosedCheckpointRow => r.status === 'closed');
  }

  getAbandonedCheckpoints(artifactId: string): AbandonedCheckpointRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE artifact_id = ? AND status = 'abandoned' ORDER BY n ASC`
      )
      .all(artifactId) as RawCheckpointRow[];
    return rows
      .map(rawToCheckpointRow)
      .filter((r): r is AbandonedCheckpointRow => r.status === 'abandoned');
  }

  /**
   * Cross-ARTIFACT wall-clock overlap scan:
   * checkpoints of OTHER artifacts whose `[opened_at,
   * COALESCE(closed_at, abandoned_at)]` interval intersects the closing
   * cp's window — the within-artifact detector cannot see them (it
   * scans one artifact's event log by index, and the close path locks
   * only its own artifact). Best-effort BY DESIGN: timestamp ordering
   * across event logs is weaker than index order, which is exactly why
   * cross-artifact overlap gets claims-only treatment, never segment
   * evidence. Interval semantics mirror the artifact-window predicates
   * above: a NULL end means STILL OPEN (open-ended). Note that rows
   * update only after event append/rebuild, so simultaneous closes can
   * each see the other as open-with-no-claims — callers must record
   * PENDING overlap only, never finalize at close.
   */
  findWallClockOverlappingCheckpoints(opts: {
    excludeArtifactId: string;
    /** Closing cp's opened_at (ISO). */
    windowStart: string;
    /** Closing cp's close timestamp (ISO). */
    windowEnd: string;
  }): Array<{ artifact_id: string; n: number; status: 'open' | 'closed' | 'abandoned' }> {
    const rows = this.db
      .prepare(
        `SELECT c.artifact_id, c.n, c.status FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE c.artifact_id != ?
           AND a.origin_kind IS NOT 'git-import'
           AND c.opened_at <= ?
           AND (COALESCE(c.closed_at, c.abandoned_at) IS NULL
                OR COALESCE(c.closed_at, c.abandoned_at) >= ?)
         ORDER BY c.artifact_id ASC, c.n ASC`
      )
      .all(opts.excludeArtifactId, opts.windowEnd, opts.windowStart) as Array<{
      artifact_id: string;
      n: number;
      status: 'open' | 'closed' | 'abandoned';
    }>;
    return rows;
  }

  /**
   * Compute the union of step claims across all checkpoints. Used by
   * `checkpoint open` for disjointness validation and by `resume` for
   * the "uncovered steps" surface. Recomputed under the artifact lock
   * per call (no cache; opens happen at human/subagent workflow speed,
   * cache invalidation under concurrency would be its own bug surface).
   */
  getStepClaims(artifactId: string): StepClaims {
    const closed = this.getClosedCheckpoints(artifactId);
    const open = this.getOpenCheckpoints(artifactId);
    const closedClaimed = new Set<string>();
    for (const cp of closed) {
      for (const s of cp.completed_step_ids) closedClaimed.add(s);
    }
    return {
      closedClaimed: [...closedClaimed].sort(),
      openDeclared: open.map((cp) => ({ n: cp.n, declared: [...cp.declared_step_ids] })),
    };
  }

  /**
   * DISTINCT artifact ids whose plan_steps (ANY revision — dropped steps
   * remain findable) contain the given step_id. Step ids are UUIDv7s minted
   * per artifact, so multi-hit only happens on pathological store states —
   * `step brief` surfaces it as AMBIGUOUS_ARTIFACT rather than guessing.
   */
  findArtifactIdsByStepId(stepId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT artifact_id FROM plan_steps WHERE step_id = ? ORDER BY artifact_id`)
      .all(stepId) as Array<{ artifact_id: string }>;
    return rows.map((r) => r.artifact_id);
  }

  /**
   * Repo-wide store counts for `orcaops stats`: artifacts and checkpoints
   * grouped by status, plus the summary count.
   */
  getStoreStats(): StoreStats {
    const artifactRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM artifacts GROUP BY status ORDER BY status`)
      .all() as Array<{ status: string; n: number }>;
    const checkpointRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM checkpoints GROUP BY status ORDER BY status`)
      .all() as Array<{ status: string; n: number }>;
    const summaries = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM summaries`).get() as { n: number }
    ).n;
    const toBreakdown = (
      rows: Array<{ status: string; n: number }>
    ): { total: number; by_status: Record<string, number> } => ({
      total: rows.reduce((acc, r) => acc + r.n, 0),
      by_status: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    });
    return {
      artifacts: toBreakdown(artifactRows),
      checkpoints: toBreakdown(checkpointRows),
      summaries: { total: summaries },
    };
  }

  /**
   * Per-(evaluator_ref, phase) run counts for `orcaops stats`.
   * Repo-wide GROUP BY full scan — acceptable at per-repo scale (the
   * evaluator_runs indexes are artifact-scoped only).
   */
  evaluatorRunStats(): EvaluatorRunStatsRow[] {
    return this.db
      .prepare(
        `SELECT evaluator_ref, phase,
                COUNT(*) AS total,
                SUM(CASE WHEN run_status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) AS pass,
                SUM(CASE WHEN verdict = 'violation' THEN 1 ELSE 0 END) AS violation,
                SUM(CASE WHEN verdict = 'info' THEN 1 ELSE 0 END) AS info,
                SUM(CASE WHEN run_status = 'error' THEN 1 ELSE 0 END) AS error,
                SUM(CASE WHEN run_status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM evaluator_runs
         GROUP BY evaluator_ref, phase
         ORDER BY evaluator_ref ASC, phase ASC`
      )
      .all() as EvaluatorRunStatsRow[];
  }

  /** Latest plan revision_n per artifact (revision-churn stats). */
  planRevisionCounts(): Array<{ artifact_id: string; max_revision_n: number }> {
    return this.db
      .prepare(
        `SELECT p.artifact_id, MAX(p.revision_n) AS max_revision_n
         FROM plans p
         JOIN artifacts a ON a.id = p.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
         GROUP BY p.artifact_id ORDER BY p.artifact_id ASC`
      )
      .all() as Array<{ artifact_id: string; max_revision_n: number }>;
  }

  /**
   * Raw closed-checkpoint intervals. Duration math (median/p90)
   * lives in the CLI's pure collector so seeded-timestamp tests pin it.
   */
  closedCheckpointIntervals(): Array<{
    artifact_id: string;
    n: number;
    opened_at: string;
    closed_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT c.artifact_id, c.n, c.opened_at, c.closed_at
         FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE c.status = 'closed' AND a.origin_kind IS NOT 'git-import'
         ORDER BY c.artifact_id ASC, c.n ASC`
      )
      .all() as Array<{ artifact_id: string; n: number; opened_at: string; closed_at: string }>;
  }

  /**
   * Store-derivable capture-hygiene counters. All four list
   * columns are `TEXT NOT NULL DEFAULT '[]'` so JSON1's json_array_length
   * is safe. `summaries_without_pre_pr_run` reads `evaluator_lifecycles`
   * (recorded after a completed dispatch, including zero-run dispatches) — NOT `evaluator_runs`
   * (zero rows when no pre-pr evaluator is enabled) and NOT
   * `pre_pr_checked_head_sha` (only written on pass, stale by design).
   */
  hygieneCounts(): HygieneCounts {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      open_checkpoints_on_finished_artifacts: one(
        `SELECT COUNT(*) AS n FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
           AND c.status = 'open' AND a.status != 'active'`
      ),
      summaries_without_pre_pr_run: one(
        `SELECT COUNT(*) AS n FROM summaries s
         JOIN artifacts a ON a.id = s.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
         AND NOT EXISTS (
           SELECT 1 FROM evaluator_lifecycles el
           WHERE el.artifact_id = s.artifact_id AND el.fires_at = 'pre-pr'
         )`
      ),
      closed_cp_without_completed_steps: one(
        `SELECT COUNT(*) AS n FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
           AND c.status = 'closed' AND json_array_length(c.completed_step_ids) = 0`
      ),
      closed_cp_without_uncertainty: one(
        `SELECT COUNT(*) AS n FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
           AND c.status = 'closed' AND json_array_length(c.uncertainty) = 0`
      ),
      closed_cp_without_decisions: one(
        `SELECT COUNT(*) AS n FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
           AND c.status = 'closed' AND json_array_length(c.decisions) = 0`
      ),
      closed_cp_without_files_changed: one(
        `SELECT COUNT(*) AS n FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind IS NOT 'git-import'
           AND c.status = 'closed' AND json_array_length(c.files_changed) = 0`
      ),
    };
  }

  /**
   * Server-assigned `n`: max(existing) + 1 across every checkpoint
   * status (open/closed/abandoned share the `n` namespace). Caller
   * must hold the per-artifact lock.
   */
  nextCheckpointN(artifactId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(n), 0) AS max_n FROM checkpoints WHERE artifact_id = ?`)
      .get(artifactId) as { max_n: number };
    return row.max_n + 1;
  }

  /**
   * Find every closed checkpoint whose `files_changed` contains the
   * given path. Joined with `artifacts` so the caller gets `branch`,
   * `task`, and `base_sha` without a second lookup.
   */
  findCheckpointsTouchingFile(opts: { file: string; branch?: string }): Array<
    ClosedCheckpointRow & {
      branch: string;
      task: string;
      base_sha: string;
      origin_kind: ArtifactOriginKind | null;
    }
  > {
    const likePattern = `%${JSON.stringify(opts.file)}%`;
    const params: unknown[] = [likePattern];
    let sql = `SELECT c.*, a.branch AS branch, a.task AS task, a.base_sha AS base_sha,
                      a.origin_kind AS origin_kind
               FROM checkpoints c
               JOIN artifacts a ON a.id = c.artifact_id
               WHERE c.status = 'closed' AND c.files_changed LIKE ?`;
    if (opts.branch !== undefined) {
      sql += ` AND a.branch = ?`;
      params.push(opts.branch);
    }
    sql += ` ORDER BY c.closed_at DESC`;

    const rows = this.db.prepare(sql).all(...params) as Array<
      RawCheckpointRow & {
        branch: string;
        task: string;
        base_sha: string;
        origin_kind: ArtifactOriginKind | null;
      }
    >;

    return rows
      .map((r) => {
        const cp = rawToCheckpointRow(r);
        if (cp.status !== 'closed') return null;
        return {
          ...cp,
          branch: r.branch,
          task: r.task,
          base_sha: r.base_sha,
          origin_kind: r.origin_kind,
        };
      })
      .filter(
        (
          r
        ): r is ClosedCheckpointRow & {
          branch: string;
          task: string;
          base_sha: string;
          origin_kind: ArtifactOriginKind | null;
        } => r !== null
      )
      .filter((r) => r.files_changed.includes(opts.file));
  }

  /**
   * Whether any imported (`git-import`) artifact recorded this commit as a
   * checkpoint head. Imported clusters checkpoint per commit GROUP, so a
   * mid-group member answers false — callers treat that as "offer the
   * import", and a redundant `seed --commit` reports the cluster covered.
   */
  hasImportedCommitCoverage(sha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM checkpoints c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE a.origin_kind = 'git-import' AND c.head_sha = ?
         LIMIT 1`
      )
      .get(sha);
    return row !== undefined;
  }

  // ────────────────────────────────────────
  // Summaries
  // ────────────────────────────────────────

  upsertSummary(s: SummaryRow): void {
    this.db
      .prepare(
        `INSERT INTO summaries (artifact_id, outcome, tests_written, tests_run, open_items, ts)
         VALUES (@artifact_id, @outcome, @tests_written, @tests_run, @open_items, @ts)
         ON CONFLICT(artifact_id) DO UPDATE SET
           outcome       = excluded.outcome,
           tests_written = excluded.tests_written,
           tests_run     = excluded.tests_run,
           open_items    = excluded.open_items,
           ts            = excluded.ts`
      )
      .run({
        ...s,
        tests_written: JSON.stringify(s.tests_written),
        tests_run: JSON.stringify(s.tests_run),
        open_items: JSON.stringify(s.open_items),
      });
  }

  getSummary(artifactId: string): SummaryRow | null {
    const row = this.db.prepare(`SELECT * FROM summaries WHERE artifact_id = ?`).get(artifactId) as
      | {
          artifact_id: string;
          outcome: string;
          tests_written: string;
          tests_run: string;
          open_items: string;
          ts: string;
        }
      | undefined;
    if (!row) return null;
    return {
      ...row,
      tests_written: JSON.parse(row.tests_written) as string[],
      tests_run: JSON.parse(row.tests_run) as string[],
      open_items: JSON.parse(row.open_items) as string[],
    };
  }

  // ────────────────────────────────────────
  // Search index (FTS5)
  // ────────────────────────────────────────

  replaceSearchEntry(entry: SearchEntry): void {
    const redactedContent = redactSecretsInString(entry.content);
    const tx = this.db.transaction((e: SearchEntry) => {
      this.db
        .prepare(`DELETE FROM search_idx WHERE artifact_id = ? AND source = ?`)
        .run(e.artifact_id, e.source);
      this.db
        .prepare(
          `INSERT INTO search_idx (artifact_id, source, branch, ts, content)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(e.artifact_id, e.source, e.branch, e.ts, redactedContent);
    });
    tx(entry);
  }

  /**
   * Whether an entry exists for this artifact + source. `replaceSearchEntry`
   * is the LAST write of the plan / close / summary commit groups, so its
   * absence is the only witness that distinguishes a group torn after the
   * cache row landed from one that finished.
   */
  hasSearchEntry(artifactId: string, source: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM search_idx WHERE artifact_id = ? AND source = ? LIMIT 1`)
      .get(artifactId, source) as { present: number } | undefined;
    return row !== undefined;
  }

  searchCount(query: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM search_idx WHERE search_idx MATCH ?`)
      .get(query) as { c: number };
    return row.c;
  }

  search(query: string, opts: SearchOptions = {}): SearchResultRow[] {
    const where: string[] = [`search_idx MATCH ?`];
    const params: unknown[] = [query];
    if (opts.branch) {
      where.push(`search_idx.branch = ?`);
      params.push(opts.branch);
    }
    if (opts.sourcePrefix) {
      where.push(`(search_idx.source = ? OR search_idx.source LIKE ?)`);
      params.push(opts.sourcePrefix, `${opts.sourcePrefix}:%`);
    }
    if (opts.includeImported === false) where.push(`a.origin_kind IS NOT 'git-import'`);
    const limit = opts.limit ?? 25;
    const sql = `
      SELECT
        search_idx.artifact_id,
        search_idx.source,
        search_idx.branch,
        search_idx.ts,
        snippet(search_idx, 4, '<<', '>>', '…', 16) AS snippet,
        rank,
        a.origin_kind AS origin_kind
      FROM search_idx
      LEFT JOIN artifacts a ON a.id = search_idx.artifact_id
      WHERE ${where.join(' AND ')}
      ORDER BY rank, (a.origin_kind IS 'git-import'), search_idx.ts DESC
      LIMIT ${limit}
    `;
    return this.db.prepare(sql).all(...params) as SearchResultRow[];
  }

  // ────────────────────────────────────────
  // Evaluator lifecycles
  // ────────────────────────────────────────

  recordLifecycle(opts: {
    artifact_id: string;
    fires_at: LifecycleFiresAt;
    cp_n?: number;
    triggered_at: string;
  }): void {
    const cpN = opts.cp_n ?? 0;
    this.db
      .prepare(
        `INSERT INTO evaluator_lifecycles (artifact_id, fires_at, cp_n, triggered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(artifact_id, fires_at, cp_n) DO UPDATE SET
           triggered_at = excluded.triggered_at`
      )
      .run(opts.artifact_id, opts.fires_at, cpN, opts.triggered_at);
  }

  hasLifecycle(opts: { artifact_id: string; fires_at: LifecycleFiresAt; cp_n?: number }): boolean {
    const cpN = opts.cp_n ?? 0;
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM evaluator_lifecycles
         WHERE artifact_id = ? AND fires_at = ? AND cp_n = ?`
      )
      .get(opts.artifact_id, opts.fires_at, cpN) as { hit: number } | undefined;
    return row !== undefined;
  }

  listLifecycles(artifactId: string): Array<{
    fires_at: LifecycleFiresAt;
    cp_n: number;
    triggered_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT fires_at, cp_n, triggered_at
         FROM evaluator_lifecycles
         WHERE artifact_id = ?
         ORDER BY triggered_at ASC`
      )
      .all(artifactId) as Array<{
      fires_at: LifecycleFiresAt;
      cp_n: number;
      triggered_at: string;
    }>;
  }

  // ────────────────────────────────────────
  // Evaluator runs
  // ────────────────────────────────────────

  /**
   * Materialized run row as stored in the `evaluator_runs` SQLite
   * table. Mirrors `MaterializedEvaluatorRun` from
   * `@orcaops/storage/schema/evaluator-run` one-for-one, with JSON
   * payloads (`raw`, `metrics`, `error`) serialized to TEXT.
   *
   * The materialized `disposition` column is maintained by the
   * storage layer on every write: a new run is seeded with
   * `'unresolved'` if blocking-eligible (severity=block AND
   * run_status=completed AND verdict=violation) or `null` otherwise,
   * and `insertEvaluatorDisposition` UPDATEs the targeted run's
   * column in the same transaction as the disposition INSERT
   * (disposition writes maintain the materialized column).
   */
  insertEvaluatorRun(row: EvaluatorRunRow): void {
    this.db
      .prepare(
        `INSERT INTO evaluator_runs (
           run_id, artifact_id, evaluator_ref, package_id, evaluator_id,
           phase, severity, run_status, verdict, body, raw, metrics,
           provider, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
           cost_usd, duration_ms, checkpoint_n, error_code, error_message,
           ts, disposition, source_event_index, local_kind_rank, local_index
         ) VALUES (
           @run_id, @artifact_id, @evaluator_ref, @package_id, @evaluator_id,
           @phase, @severity, @run_status, @verdict, @body, @raw, @metrics,
           @provider, @model, @tokens_in, @tokens_out, @tokens_cache_read, @tokens_cache_write,
           @cost_usd, @duration_ms, @checkpoint_n, @error_code, @error_message,
           @ts, @disposition, @source_event_index, @local_kind_rank, @local_index
         )`
      )
      .run(row);
  }

  /**
   * Insert a disposition row AND update the targeted run's
   * materialized `disposition` column atomically. Wraps both
   * statements in a single SQLite transaction so partial state is
   * not observable.
   *
   * Dispositions only resolve the CURRENT blocking run for a ref. The
   * store-layer write is unconditional (it writes the disposition row and
   * updates the materialized column for the targeted `run_id`); the
   * block-state derivation
   * in the projection rebuilder handles supersession semantics
   * (e.g., a disposition targeting a superseded run still
   * materializes on that older run but doesn't clear the active
   * block).
   */
  insertEvaluatorDisposition(row: EvaluatorDispositionRow): void {
    const insert = this.db.prepare(
      `INSERT INTO evaluator_dispositions (
         disposition_id, artifact_id, run_id, evaluator_ref,
         disposition, reason, agent_session_id, ts,
         source_event_index, local_kind_rank, local_index
       ) VALUES (
         @disposition_id, @artifact_id, @run_id, @evaluator_ref,
         @disposition, @reason, @agent_session_id, @ts,
         @source_event_index, @local_kind_rank, @local_index
       )`
    );
    const updateRun = this.db.prepare(
      `UPDATE evaluator_runs
       SET disposition = @disposition
       WHERE run_id = @run_id`
    );
    const tx = this.db.transaction((r: EvaluatorDispositionRow) => {
      insert.run(r);
      updateRun.run({ run_id: r.run_id, disposition: r.disposition });
    });
    tx(row);
  }

  /**
   * Read every materialized run for an artifact in `order_key`
   * order. The order key is the strict total order over runs +
   * dispositions; consumers that need to interleave runs and dispositions
   * in a single walk should
   * iterate both this and `listEvaluatorDispositions` and merge by
   * `(source_event_index, local_kind_rank, local_index)`.
   */
  listEvaluatorRuns(artifactId: string): EvaluatorRunRow[] {
    return this.db
      .prepare(
        `SELECT run_id, artifact_id, evaluator_ref, package_id, evaluator_id,
                phase, severity, run_status, verdict, body, raw, metrics,
                provider, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
                cost_usd, duration_ms, checkpoint_n, error_code, error_message,
                ts, disposition, source_event_index, local_kind_rank, local_index
         FROM evaluator_runs
         WHERE artifact_id = ?
         ORDER BY source_event_index ASC, local_kind_rank ASC, local_index ASC`
      )
      .all(artifactId) as EvaluatorRunRow[];
  }

  // ────────────────────────────────────────
  // Usage ledger projection (migration 019)
  // ────────────────────────────────────────

  /** Replace/rebuild support for the archive index's non-authoritative usage projection. */
  clearUsageProjection(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM source_plan_links`).run();
      this.db.prepare(`DELETE FROM usage_snapshots`).run();
    });
    tx();
  }

  /** Project one usage snapshot. `idempotency_key` is UNIQUE — the caller
   * (UsageLedger) skips-if-seen first, so this never races within the lock. */
  insertUsageSnapshot(row: UsageSnapshotRow): void {
    const insert = this.db.prepare(
      // OR IGNORE on the UNIQUE idempotency_key: the live path skips-if-seen
      // first, so this is a DB-level dedupe backstop that makes a rebuild
      // replay (and any duplicate ledger line) idempotent rather than fatal.
      `INSERT OR IGNORE INTO usage_snapshots (
           snapshot_id, idempotency_key, artifact_id, source_plan_ref_id,
           agent, session_id, lifecycle_event, checkpoint_n,
           cumulative_input_tokens, cumulative_output_tokens,
           cumulative_cache_creation_input_tokens, cumulative_cache_read_input_tokens,
           delta_input_tokens, delta_output_tokens,
           delta_cache_creation_input_tokens, delta_cache_read_input_tokens,
           baseline_kind, model_breakdown, dimensions, record_count, as_of, ts
         ) VALUES (
           @snapshot_id, @idempotency_key, @artifact_id, @source_plan_ref_id,
           @agent, @session_id, @lifecycle_event, @checkpoint_n,
           @cumulative_input_tokens, @cumulative_output_tokens,
           @cumulative_cache_creation_input_tokens, @cumulative_cache_read_input_tokens,
           @delta_input_tokens, @delta_output_tokens,
           @delta_cache_creation_input_tokens, @delta_cache_read_input_tokens,
           @baseline_kind, @model_breakdown, @dimensions, @record_count, @as_of, @ts
         )`
    );
    this.db.transaction((snapshot: UsageSnapshotRow) => {
      insert.run(snapshot);
      // Session totals and model breakdowns are global high-waters. Event
      // timestamps can be backdated, so timestamp comparison alone cannot
      // prove a previously synced artifact still matches its emitted payload.
      this.rotateCloudSyncTokensForUsageSession(snapshot.agent, snapshot.session_id);
    })(row);
  }

  /** Rotate every artifact whose emitted usage reads this session's high-water. */
  rotateCloudSyncTokensForUsageSession(agent: string, sessionId: string): number {
    const affected = this.db
      .prepare(
        `SELECT artifact_id AS id
         FROM usage_snapshots
         WHERE agent = @agent
           AND session_id = @sessionId
           AND artifact_id IS NOT NULL
         UNION
         SELECT link.artifact_id AS id
         FROM usage_snapshots AS scoped_usage
         JOIN source_plan_links AS link
           ON link.source_plan_ref_id = scoped_usage.source_plan_ref_id
          AND scoped_usage.ts <= link.linked_at
         WHERE scoped_usage.agent = @agent
           AND scoped_usage.session_id = @sessionId`
      )
      .all({ agent, sessionId }) as Array<{ id: string }>;
    return this.rotateCloudSyncTokens(affected.map((artifact) => artifact.id));
  }

  /** Look up a snapshot by its idempotency key (the skip-if-seen guard). */
  getUsageSnapshotByKey(idempotencyKey: string): UsageSnapshotRow | undefined {
    return this.db
      .prepare(`SELECT * FROM usage_snapshots WHERE idempotency_key = ?`)
      .get(idempotencyKey) as UsageSnapshotRow | undefined;
  }

  /**
   * The latest same-session snapshot matching a baseline scope — the prior
   * `delta_usage` is measured against. Order by `ts` then `snapshot_id`
   * (UUIDv7, time-ordered) so the result is the high-water mark.
   */
  getLatestUsageSnapshot(q: UsageBaselineQuery): UsageSnapshotRow | undefined {
    const clauses = ['agent = @agent', 'session_id = @sessionId'];
    const params: Record<string, unknown> = { agent: q.agent, sessionId: q.sessionId };
    if (q.artifactId !== undefined) {
      clauses.push('artifact_id = @artifactId');
      params.artifactId = q.artifactId;
    }
    if (q.sourcePlanRefId !== undefined) {
      clauses.push('source_plan_ref_id = @sourcePlanRefId');
      params.sourcePlanRefId = q.sourcePlanRefId;
    }
    if (q.lifecycleEvent !== undefined) {
      clauses.push('lifecycle_event = @lifecycleEvent');
      params.lifecycleEvent = q.lifecycleEvent;
    }
    if (q.checkpointN !== undefined) {
      clauses.push('checkpoint_n = @checkpointN');
      params.checkpointN = q.checkpointN;
    }
    if (q.beforeTs !== undefined) {
      clauses.push('ts <= @beforeTs');
      params.beforeTs = q.beforeTs;
    }
    return this.db
      .prepare(
        `SELECT * FROM usage_snapshots WHERE ${clauses.join(' AND ')}
         ORDER BY ts DESC, snapshot_id DESC LIMIT 1`
      )
      .get(params) as UsageSnapshotRow | undefined;
  }

  /** True if `artifactId` already has a snapshot under a DIFFERENT
   * `(agent, session_id)` — the resumed-leg signal. */
  artifactHasSnapshotUnderDifferentSession(
    artifactId: string,
    agent: string,
    sessionId: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM usage_snapshots
         WHERE artifact_id = ? AND NOT (agent = ? AND session_id = ?) LIMIT 1`
      )
      .get(artifactId, agent, sessionId);
    return row !== undefined;
  }

  hasSourcePlanLink(sourcePlanRefId: string, artifactId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM source_plan_links WHERE source_plan_ref_id = ? AND artifact_id = ?`)
      .get(sourcePlanRefId, artifactId);
    return row !== undefined;
  }

  /** Idempotent link (first link wins; keeps the original `linked_at` so the
   * attribution time-bound stays stable). */
  applySourcePlanLink(row: SourcePlanLinkRow): void {
    const insert = this.db.prepare(
      `INSERT INTO source_plan_links (source_plan_ref_id, artifact_id, linked_at, pinned_version)
       VALUES (@source_plan_ref_id, @artifact_id, @linked_at, @pinned_version)
       ON CONFLICT(source_plan_ref_id, artifact_id) DO NOTHING`
    );
    const changesEmittedUsage = this.db.prepare(
      `SELECT 1
       FROM usage_snapshots
       WHERE source_plan_ref_id = @source_plan_ref_id
         AND ts <= @linked_at
       LIMIT 1`
    );
    this.db.transaction((link: SourcePlanLinkRow) => {
      if (insert.run(link).changes === 1 && changesEmittedUsage.get(link) !== undefined) {
        this.rotateCloudSyncTokens([link.artifact_id]);
      }
    })(row);
  }

  /** All source-plan links for an artifact, ordered by link time (the cloud's
   * `source_plan_links[]` for one push; read counterpart of applySourcePlanLink). */
  readSourcePlanLinks(artifactId: string): SourcePlanLinkRow[] {
    return this.db
      .prepare(
        `SELECT source_plan_ref_id, artifact_id, linked_at, pinned_version
         FROM source_plan_links WHERE artifact_id = ?
         ORDER BY linked_at ASC, source_plan_ref_id ASC`
      )
      .all(artifactId) as SourcePlanLinkRow[];
  }

  readUsageSnapshots(artifactId: string): UsageSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM usage_snapshots WHERE artifact_id = ? ORDER BY ts ASC, snapshot_id ASC`
      )
      .all(artifactId) as UsageSnapshotRow[];
  }

  /**
   * The usage snapshots in an artifact's ATTRIBUTION scope: its own snapshots
   * (artifact_id = X) PLUS each linked source plan's snapshots time-bounded to
   * linked_at — the same scope as attributedArtifactUsage / artifactCodingSessions
   * (NOT readUsageSnapshots, which is artifact_id-only). This is what the cloud
   * wire emits, so the cloud receives the artifact_id=null pre-capture source-plan
   * snapshots it needs to recompute the `ts <= linked_at` span for source-plan
   * usage; readUsageSnapshots stays the narrow artifact-only reader.
   */
  artifactScopedUsageSnapshots(artifactId: string): UsageSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM usage_snapshots us
         WHERE ${ARTIFACT_USAGE_SCOPE_PREDICATE}
         ORDER BY us.ts ASC, us.snapshot_id ASC`
      )
      .all({ artifactId }) as UsageSnapshotRow[];
  }

  /** Exact session totals (the accounting headline) from the reset-safe view. */
  listCodingSessions(): CodingSessionRow[] {
    return this.db
      .prepare(
        `SELECT agent, session_id,
                cumulative_input_tokens, cumulative_output_tokens,
                cumulative_cache_creation_input_tokens, cumulative_cache_read_input_tokens,
                as_of, record_count
         FROM coding_sessions ORDER BY agent ASC, session_id ASC`
      )
      .all() as CodingSessionRow[];
  }

  /**
   * Exact session totals (the accounting headline) for the sessions that
   * touched an artifact — directly (`artifact_id`) or via a linked source plan
   * (time-bounded to `linked_at`), matching the attribution scope.
   */
  artifactCodingSessions(artifactId: string): CodingSessionRow[] {
    return this.db
      .prepare(
        `SELECT agent, session_id,
                cumulative_input_tokens, cumulative_output_tokens,
                cumulative_cache_creation_input_tokens, cumulative_cache_read_input_tokens,
                as_of, record_count
         FROM coding_sessions
         WHERE (agent, session_id) IN (
           ${SCOPED_SESSIONS_SUBQUERY}
         )
         ORDER BY agent ASC, session_id ASC`
      )
      .all({ artifactId }) as CodingSessionRow[];
  }

  /**
   * The exact per-model breakdown for each session that touched an artifact: the
   * `model_breakdown` JSON of each in-scope session's GLOBAL high-water snapshot
   * (the row with the greatest total cumulative). Per-model cumulative is
   * monotonic, so the high-water snapshot's breakdown IS the exact per-model
   * session total — consistent with the scalar MAX in `artifactCodingSessions`
   * (so a wire `sessions[]` entry's `total` and `model_breakdown` describe the
   * same session). Scope mirrors `artifactCodingSessions` exactly (own snapshots
   * plus each linked source plan's snapshots, time-bounded to `linked_at`); the
   * high-water search itself ranges over the session GLOBALLY (a session's peak
   * may live on another artifact's snapshot). Tie-broken by ts then snapshot_id
   * for an insertion-order-independent pick.
   */
  artifactSessionModelBreakdowns(artifactId: string): SessionModelBreakdownRow[] {
    return this.db
      .prepare(
        `WITH scoped(agent, session_id) AS (
           ${SCOPED_SESSIONS_SUBQUERY}
         ),
         ranked AS (
           SELECT s.agent, s.session_id, s.model_breakdown, s.dimensions,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.agent, s.session_id
                    ORDER BY (s.cumulative_input_tokens + s.cumulative_output_tokens
                              + s.cumulative_cache_creation_input_tokens
                              + s.cumulative_cache_read_input_tokens) DESC,
                             s.ts DESC, s.snapshot_id DESC
                  ) AS rn
           FROM usage_snapshots s
           JOIN scoped ON scoped.agent = s.agent AND scoped.session_id = s.session_id
         )
         SELECT agent, session_id, model_breakdown, dimensions FROM ranked
         WHERE rn = 1
         ORDER BY agent ASC, session_id ASC`
      )
      .all({ artifactId }) as SessionModelBreakdownRow[];
  }

  /**
   * The GLOBAL analog of {@link artifactSessionModelBreakdowns}: each session's
   * high-water `model_breakdown` + `dimensions` across ALL snapshots (no artifact
   * scope), keyed by (agent, session_id). Mirrors `listCodingSessions` for the
   * branch-level surfaces (`status`), which filter the result to their own branch
   * session keys — they never render the whole global set.
   */
  listSessionModelBreakdowns(): SessionModelBreakdownRow[] {
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT s.agent, s.session_id, s.model_breakdown, s.dimensions,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.agent, s.session_id
                    ORDER BY (s.cumulative_input_tokens + s.cumulative_output_tokens
                              + s.cumulative_cache_creation_input_tokens
                              + s.cumulative_cache_read_input_tokens) DESC,
                             s.ts DESC, s.snapshot_id DESC
                  ) AS rn
           FROM usage_snapshots s
         )
         SELECT agent, session_id, model_breakdown, dimensions FROM ranked
         WHERE rn = 1
         ORDER BY agent ASC, session_id ASC`
      )
      .all() as SessionModelBreakdownRow[];
  }

  /**
   * Estimated attributed usage for an artifact — an estimate,
   * never the accounting base, never additive across artifacts.
   *
   * ORDER-INDEPENDENT high-water span, NOT `SUM(delta_usage)`: the embedded
   * per-snapshot delta is order-dependent (an out-of-order stamp under-counts
   * via the clamp; overlapping checkpoint windows double-count the overlap), so
   * it is audit/debug-only. Instead, per `(agent, session_id, scope)` group we
   * take `MAX(cumulative) − floor` and sum the spans, where the floor is the
   * group's EARLIEST snapshot's cumulative (`first_observation` — pre-existing
   * usage we don't attribute) or 0 (`whole_session` — a resumed/cross-agent leg
   * counts from session start). This telescopes to SUM(delta) for
   * chronological, non-overlapping stamps, but is robust to insertion order
   * AND overlap.
   *
   * `scope` = the artifact's own snapshots (`artifact_id = X`) plus each linked
   * source plan's snapshots (`ts <= linked_at`); every snapshot is assigned to
   * exactly ONE scope (its own artifact scope when set, else its source-plan
   * scope) and de-duped by `snapshot_id`, so a row can never inflate two scopes.
   *
   * Cloud corollary: the cloud must recompute this SAME span from the
   * cumulative snapshots + the first-class `(agent, session_id)` session total —
   * NEVER by summing per-artifact estimates or per-snapshot embedded deltas, or
   * it re-inherits the exact order/overlap bug this removes.
   */
  attributedArtifactUsage(artifactId: string): AttributedUsageRow {
    const rows = this.db
      .prepare(
        `SELECT us.snapshot_id, us.agent, us.session_id, us.artifact_id,
                us.source_plan_ref_id, us.ts, us.baseline_kind,
                us.cumulative_input_tokens                AS i,
                us.cumulative_output_tokens               AS o,
                us.cumulative_cache_creation_input_tokens AS cw,
                us.cumulative_cache_read_input_tokens     AS cr
         FROM usage_snapshots us
         WHERE ${ARTIFACT_USAGE_SCOPE_PREDICATE}`
      )
      .all({ artifactId }) as Array<{
      snapshot_id: string;
      agent: string;
      session_id: string;
      artifact_id: string | null;
      source_plan_ref_id: string | null;
      ts: string;
      baseline_kind: string;
      i: number;
      o: number;
      cw: number;
      cr: number;
    }>;

    interface SpanGroup {
      firstTs: string;
      firstSnapshotId: string;
      floorWholeSession: boolean;
      floor: { i: number; o: number; cw: number; cr: number };
      max: { i: number; o: number; cw: number; cr: number };
    }
    const groups = new Map<string, SpanGroup>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.snapshot_id)) continue; // de-dupe by snapshot_id before grouping
      seen.add(r.snapshot_id);
      // Exactly one scope per snapshot: its own artifact scope when set, else
      // its source-plan scope (NUL-free, collision-free key via JSON.stringify).
      const scope =
        r.artifact_id === artifactId
          ? `artifact:${artifactId}`
          : `plan:${r.source_plan_ref_id ?? ''}`;
      const key = JSON.stringify([r.agent, r.session_id, scope]);
      const g = groups.get(key);
      if (g === undefined) {
        groups.set(key, {
          firstTs: r.ts,
          firstSnapshotId: r.snapshot_id,
          floorWholeSession: r.baseline_kind === 'whole_session',
          floor: { i: r.i, o: r.o, cw: r.cw, cr: r.cr },
          max: { i: r.i, o: r.o, cw: r.cw, cr: r.cr },
        });
        continue;
      }
      // Track the group's high-water cumulative per field…
      g.max.i = Math.max(g.max.i, r.i);
      g.max.o = Math.max(g.max.o, r.o);
      g.max.cw = Math.max(g.max.cw, r.cw);
      g.max.cr = Math.max(g.max.cr, r.cr);
      // …and the floor from the EARLIEST snapshot by (ts, snapshot_id).
      if (r.ts < g.firstTs || (r.ts === g.firstTs && r.snapshot_id < g.firstSnapshotId)) {
        g.firstTs = r.ts;
        g.firstSnapshotId = r.snapshot_id;
        g.floorWholeSession = r.baseline_kind === 'whole_session';
        g.floor = { i: r.i, o: r.o, cw: r.cw, cr: r.cr };
      }
    }

    const total: AttributedUsageRow = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    for (const g of groups.values()) {
      const fi = g.floorWholeSession ? 0 : g.floor.i;
      const fo = g.floorWholeSession ? 0 : g.floor.o;
      const fcw = g.floorWholeSession ? 0 : g.floor.cw;
      const fcr = g.floorWholeSession ? 0 : g.floor.cr;
      total.input_tokens += Math.max(0, g.max.i - fi);
      total.output_tokens += Math.max(0, g.max.o - fo);
      total.cache_creation_input_tokens += Math.max(0, g.max.cw - fcw);
      total.cache_read_input_tokens += Math.max(0, g.max.cr - fcr);
    }
    return total;
  }

  listEvaluatorDispositions(artifactId: string): EvaluatorDispositionRow[] {
    return this.db
      .prepare(
        `SELECT disposition_id, artifact_id, run_id, evaluator_ref,
                disposition, reason, agent_session_id, ts,
                source_event_index, local_kind_rank, local_index
         FROM evaluator_dispositions
         WHERE artifact_id = ?
         ORDER BY source_event_index ASC, local_kind_rank ASC, local_index ASC`
      )
      .all(artifactId) as EvaluatorDispositionRow[];
  }

  // ────────────────────────────────────────
  // Plan idempotency (project-wide, initial-capture only)
  // ────────────────────────────────────────

  lookupPlanIdempotency(idempotencyKey: string): PlanIdempotencyRow | null {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, artifact_id, created_at
         FROM plan_idempotency
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as PlanIdempotencyRow | undefined;
    return row ?? null;
  }

  hasPlanIdempotencyReservation(idempotencyKey: string, artifactId: string): boolean {
    return this.lookupPlanIdempotency(idempotencyKey)?.artifact_id === artifactId;
  }

  insertPlanIdempotency(row: PlanIdempotencyRow): void {
    this.db
      .prepare(
        `INSERT INTO plan_idempotency (idempotency_key, artifact_id, created_at)
         VALUES (@idempotency_key, @artifact_id, @created_at)`
      )
      .run(row);
  }

  /**
   * Roll back ONE plan-idempotency reservation. Exists solely for the
   * capture-plan failure path: when capture aborts between the key
   * commit and `writePlan`, the reservation must not survive to turn a
   * retry into a replay of a planless artifact.
   */
  /**
   * Atomically remove a plan-idempotency reservation ONLY while its
   * artifact has no published plan. Single-statement, so there is no
   * check-then-delete window. Returns true when the reservation was
   * removed. Called ONLY by the capture failure-path rollback — the
   * reservation's owner, before its own plan write; a planless
   * reservation seen by anyone else refuses via
   * PlanIdempotencyPendingError, never reclaims.
   */
  deletePlanIdempotencyIfUnpublished(idempotencyKey: string, artifactId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM plan_idempotency
         WHERE idempotency_key = ? AND artifact_id = ?
           AND NOT EXISTS (SELECT 1 FROM plans WHERE plans.artifact_id = ?)`
      )
      .run(idempotencyKey, artifactId, artifactId);
    return result.changes > 0;
  }

  truncatePlanIdempotency(): void {
    this.db.exec(`DELETE FROM plan_idempotency`);
  }

  // ────────────────────────────────────────
  // Idempotency blocks (soft_blocked / hard_rejected)
  // ────────────────────────────────────────

  getIdempotencyBlock(opts: {
    artifact_id: string;
    idempotency_key: string;
    event_type: string;
  }): IdempotencyBlockRow | null {
    const row = this.db
      .prepare(
        `SELECT artifact_id, idempotency_key, event_type, outcome,
                payload_hash, evaluator_fingerprint, envelope, recorded_at
         FROM idempotency_blocks
         WHERE artifact_id = ? AND idempotency_key = ? AND event_type = ?`
      )
      .get(opts.artifact_id, opts.idempotency_key, opts.event_type) as
      | IdempotencyBlockRow
      | undefined;
    return row ?? null;
  }

  upsertIdempotencyBlock(row: IdempotencyBlockRow): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_blocks (
           artifact_id, idempotency_key, event_type, outcome,
           payload_hash, evaluator_fingerprint, envelope, recorded_at
         )
         VALUES (
           @artifact_id, @idempotency_key, @event_type, @outcome,
           @payload_hash, @evaluator_fingerprint, @envelope, @recorded_at
         )
         ON CONFLICT(artifact_id, idempotency_key, event_type) DO UPDATE SET
           outcome               = excluded.outcome,
           payload_hash          = excluded.payload_hash,
           evaluator_fingerprint = excluded.evaluator_fingerprint,
           envelope              = excluded.envelope,
           recorded_at           = excluded.recorded_at`
      )
      .run(row);
  }

  deleteIdempotencyBlock(opts: {
    artifact_id: string;
    idempotency_key: string;
    event_type: string;
  }): void {
    this.db
      .prepare(
        `DELETE FROM idempotency_blocks
         WHERE artifact_id = ? AND idempotency_key = ? AND event_type = ?`
      )
      .run(opts.artifact_id, opts.idempotency_key, opts.event_type);
  }

  // ────────────────────────────────────────
  // Lineage
  // ────────────────────────────────────────

  upsertLineageByLatestSha(row: LineageByLatestShaRow): void {
    this.db
      .prepare(
        `INSERT INTO lineage_by_latest_sha (artifact_id, latest_lineage_sha, branch_name)
         VALUES (@artifact_id, @latest_lineage_sha, @branch_name)
         ON CONFLICT(artifact_id) DO UPDATE SET
           latest_lineage_sha = excluded.latest_lineage_sha,
           branch_name        = excluded.branch_name`
      )
      .run(row);
  }

  artifactsAtLatestLineageSha(sha: string): LineageByLatestShaRow[] {
    return this.db
      .prepare(
        `SELECT artifact_id, latest_lineage_sha, branch_name
         FROM lineage_by_latest_sha
         WHERE latest_lineage_sha = ?`
      )
      .all(sha) as LineageByLatestShaRow[];
  }

  truncateLineageByLatestSha(): void {
    this.db.exec(`DELETE FROM lineage_by_latest_sha`);
  }

  upsertLineageBranch(row: { artifact_id: string; branch_name: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lineage_branches (artifact_id, branch_name)
         VALUES (@artifact_id, @branch_name)`
      )
      .run(row);
  }

  truncateLineageBranches(): void {
    this.db.exec(`DELETE FROM lineage_branches`);
  }

  /**
   * Branch names in this artifact's lineage (the derived index over
   * artifact.json's `branch_lineage[]`), sorted for determinism. Feeds the
   * `list --between` rebase-disclosure bucket.
   */
  listLineageBranchNames(artifactId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT branch_name FROM lineage_branches
         WHERE artifact_id = ? ORDER BY branch_name ASC`
      )
      .all(artifactId) as Array<{ branch_name: string }>;
    return rows.map((r) => r.branch_name);
  }

  listArtifactsByLineageBranch(
    opts: { branch: string; status?: ArtifactStatus } & ArtifactWindowOpts
  ): ArtifactRow[] {
    const where: string[] = ['lb.branch_name = ?'];
    const params: string[] = [opts.branch];
    if (opts.status !== undefined) {
      where.push('a.status = ?');
      params.push(opts.status);
    }
    pushArtifactWindowPredicates(where, params, opts);
    const sql = `SELECT a.* FROM artifacts a
       INNER JOIN lineage_branches lb ON a.id = lb.artifact_id
       WHERE ${where.join(' AND ')} ORDER BY a.started_at DESC`;
    return this.db.prepare(sql).all(...params) as ArtifactRow[];
  }
}

interface RawCheckpointRow {
  artifact_id: string;
  n: number;
  status: string;
  declared_step_ids: string;
  agent_session_id: string | null;
  policy_exceptions: string;
  plan_revision_id: string | null;
  opened_at: string;
  closed_at: string | null;
  abandoned_at: string | null;
  reason: string | null;
  summary: string | null;
  files_changed: string;
  decisions: string;
  uncertainty: string;
  done_criteria: string;
  completed_step_ids: string;
  head_sha: string;
  open_plan_revision_event_id: string | null;
}

function rawToCheckpointRow(r: RawCheckpointRow): CheckpointRow {
  const emptyTerminalArrays =
    r.files_changed === '[]' &&
    r.decisions === '[]' &&
    r.uncertainty === '[]' &&
    r.done_criteria === '[]' &&
    r.completed_step_ids === '[]';
  const corrupt = (detail: string): never => {
    throw new Error(
      `Checkpoint projection corruption at ${r.artifact_id}#${r.n} (${r.status}): ${detail}`
    );
  };
  const base: CheckpointBaseFields = {
    artifact_id: r.artifact_id,
    n: r.n,
    declared_step_ids: JSON.parse(r.declared_step_ids) as string[],
    agent_session_id: r.agent_session_id,
    policy_exceptions: JSON.parse(r.policy_exceptions) as PolicyException[],
    plan_revision_id: r.plan_revision_id,
    opened_at: r.opened_at,
    head_sha: r.head_sha,
    open_plan_revision_event_id: r.open_plan_revision_event_id,
  };
  if (r.status === 'open') {
    if (
      r.closed_at !== null ||
      r.abandoned_at !== null ||
      r.reason !== null ||
      r.summary !== null ||
      !emptyTerminalArrays
    ) {
      return corrupt('OPEN row contains terminal fields');
    }
    return { ...base, status: 'open' };
  }
  if (r.status === 'closed') {
    if (
      r.closed_at === null ||
      r.summary === null ||
      r.abandoned_at !== null ||
      r.reason !== null
    ) {
      return corrupt('CLOSED row is missing close fields or contains abandon fields');
    }
    return {
      ...base,
      status: 'closed',
      closed_at: r.closed_at,
      summary: r.summary,
      files_changed: JSON.parse(r.files_changed) as string[],
      decisions: JSON.parse(r.decisions) as unknown[],
      uncertainty: JSON.parse(r.uncertainty) as string[],
      done_criteria: JSON.parse(r.done_criteria) as DoneCriterion[],
      completed_step_ids: JSON.parse(r.completed_step_ids) as string[],
    };
  }
  if (r.status !== 'abandoned') {
    return corrupt('unknown lifecycle status');
  }
  if (
    r.abandoned_at === null ||
    r.reason === null ||
    r.closed_at !== null ||
    r.summary !== null ||
    !emptyTerminalArrays
  ) {
    return corrupt('ABANDONED row is missing abandon fields or contains close fields');
  }
  return {
    ...base,
    status: 'abandoned',
    abandoned_at: r.abandoned_at,
    reason: r.reason,
  };
}

export interface PlanIdempotencyRow {
  idempotency_key: string;
  artifact_id: string;
  created_at: string;
}

export interface IdempotencyBlockRow {
  artifact_id: string;
  idempotency_key: string;
  event_type: string;
  outcome: 'soft_blocked' | 'hard_rejected';
  payload_hash: string;
  evaluator_fingerprint: string | null;
  envelope: string | null;
  recorded_at: string;
}

export interface LineageByLatestShaRow {
  artifact_id: string;
  latest_lineage_sha: string;
  branch_name: string;
}
