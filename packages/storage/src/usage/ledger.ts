import {
  appendUsageLedgerRecord,
  type LoadedUsageEvent,
  readUsageLedger,
  type UsageLedgerPaths,
} from './ledger-log.js';
import type { ArchiveMirror } from '../archive/mirror.js';
import { locksDir, usageLedgerPath, usageSidecarsDir } from '../artifacts/paths.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { ArtifactLock } from '../locks.js';
import {
  type AgentUsage,
  type AgentUsageSnapshotPayload,
  AgentUsageSnapshotPayloadSchema,
  type SourcePlanLinkPayload,
  SourcePlanLinkPayloadSchema,
  type UsageBaselineKind,
  type UsageModelBreakdownEntry,
} from '../schema/usage-ledger.js';
import { Store, type UsageSnapshotRow } from '../store/sqlite.js';
import { withNonDerivableWriteLease } from '../store/write-lease.js';

/**
 * Repo-level usage ledger — the single source of truth for the coding agent's
 * own token usage. Append-only ndjson + sidecars, projected into
 * SQLite. It is NOT artifact-local: usage can predate any artifact.
 *
 * Concurrency + idempotency are enforced HERE: a single
 * repo-level locked critical section wraps baseline-read + append + project,
 * so concurrent subagent stamps telescope instead of double-counting, and a
 * pre-append skip-if-seen (backed by the UNIQUE `idempotency_key` index)
 * makes a retried stamp a no-op. The lock reuses {@link ArtifactLock} with a
 * synthetic, repo-wide lock id.
 */
const USAGE_LOCK_ID = '__usage_ledger__';

export interface UsageLedgerOptions {
  repoRoot: string;
  store: Store;
  /** Override the lock (tests); defaults to the repo's `.orcaops/tmp/locks`. */
  lock?: ArtifactLock;
  /**
   * Optional archive mirror: every ledger append is write-through
   * mirrored, fail-open, inside the held repo-level usage lock.
   */
  mirror?: ArchiveMirror | null;
}

export interface RecordUsageSnapshotInput {
  agent: string;
  session_id: string;
  artifact_id?: string | null;
  source_plan_ref_id?: string | null;
  lifecycle_event: string;
  checkpoint_n?: number | null;
  /** Cumulative (session-start → as_of) token usage — the exact fact. */
  cumulative_usage: AgentUsage;
  /** Per-model cumulative usage, partitioned by the price-determining rate class
   *  (speed/service_tier/inference_geo; omitted when default). Deltas are derived
   *  against the baseline, scalar-only. */
  model_breakdown: Array<{
    model: string;
    speed?: string;
    service_tier?: string;
    inference_geo?: string;
    cumulative: AgentUsage;
  }>;
  record_count: number;
  as_of: string;
  ts: string;
  /**
   * The caller's baseline hint. Honored only when a valid same-session prior
   * exists; the ledger records the ACTUAL resolved `baseline_kind`.
   */
  baseline_hint: UsageBaselineKind;
  idempotency_key: string;
}

export interface RecordUsageSnapshotResult {
  snapshot: AgentUsageSnapshotPayload;
  /** True when `idempotency_key` was already recorded (no new write). */
  replayed: boolean;
}

export interface AppendSourcePlanLinkInput {
  canonical_ref_id: string;
  artifact_id: string;
  linked_at: string;
  pinned_version?: string | null;
  idempotency_key: string;
}

export class UsageLedger {
  private readonly repoRoot: string;
  private readonly store: Store;
  private readonly lock: ArtifactLock;
  private readonly mirror: ArchiveMirror | null;

  constructor(opts: UsageLedgerOptions) {
    this.repoRoot = opts.repoRoot;
    this.store = opts.store;
    this.lock =
      opts.lock ??
      new ArtifactLock({
        locksDir: locksDir(this.repoRoot),
        containmentRoot: this.repoRoot,
      });
    this.mirror = opts.mirror ?? null;
  }

  private paths(): UsageLedgerPaths {
    return {
      ledgerPath: usageLedgerPath(this.repoRoot),
      sidecarsDir: usageSidecarsDir(this.repoRoot),
      containmentRoot: this.repoRoot,
    };
  }

  /**
   * Record a usage snapshot. Inside the repo-level lock: skip-if-seen →
   * resolve the actual baseline + delta → append the ledger event → project
   * to SQLite. The delta is embedded: a rebuild never recomputes it from
   * transcripts.
   */
  async appendUsageSnapshot(input: RecordUsageSnapshotInput): Promise<RecordUsageSnapshotResult> {
    return this.lock.withLock(USAGE_LOCK_ID, () =>
      withNonDerivableWriteLease(
        this.repoRoot,
        async () => {
          const seen = this.store.getUsageSnapshotByKey(input.idempotency_key);
          if (seen) {
            this.store.rotateCloudSyncTokensForUsageSession(seen.agent, seen.session_id);
            return { snapshot: rowToPayload(seen), replayed: true };
          }

          const { baseline_kind, priorRow } = this.resolveBaseline(input);
          const delta_usage = deltaFor(baseline_kind, input.cumulative_usage, priorRow);
          const model_breakdown = buildModelBreakdown(
            input.model_breakdown,
            baseline_kind,
            priorRow
          );

          const payload: AgentUsageSnapshotPayload = {
            snapshot_id: uuidv7(),
            idempotency_key: input.idempotency_key,
            agent: input.agent,
            session_id: input.session_id,
            artifact_id: input.artifact_id ?? null,
            source_plan_ref_id: input.source_plan_ref_id ?? null,
            lifecycle_event: input.lifecycle_event,
            checkpoint_n: input.checkpoint_n ?? null,
            cumulative_usage: input.cumulative_usage,
            delta_usage,
            baseline_kind,
            model_breakdown,
            record_count: input.record_count,
            as_of: input.as_of,
          };
          AgentUsageSnapshotPayloadSchema.parse(payload);

          const record = await appendUsageLedgerRecord(
            {
              type: 'agent_usage_snapshot_recorded',
              ts: input.ts,
              idempotency_key: input.idempotency_key,
              payload,
            },
            this.paths()
          );
          await this.mirror?.mirrorUsageRecord(record, this.paths().sidecarsDir, this.repoRoot);
          this.store.insertUsageSnapshot(payloadToRow(payload, input.ts));
          return { snapshot: payload, replayed: false };
        },
        { acquireTimeoutMs: 2_000 }
      )
    );
  }

  /**
   * Link a source plan to an artifact (idempotent on `(ref, artifact)`).
   * Returns `{ linked: false }` when the link already exists.
   */
  async appendSourcePlanLink(input: AppendSourcePlanLinkInput): Promise<{ linked: boolean }> {
    return this.lock.withLock(USAGE_LOCK_ID, async () => {
      if (this.store.hasSourcePlanLink(input.canonical_ref_id, input.artifact_id)) {
        return { linked: false };
      }
      const payload: SourcePlanLinkPayload = {
        canonical_ref_id: input.canonical_ref_id,
        artifact_id: input.artifact_id,
        linked_at: input.linked_at,
        pinned_version: input.pinned_version ?? null,
      };
      SourcePlanLinkPayloadSchema.parse(payload);

      const record = await appendUsageLedgerRecord(
        {
          type: 'source_plan_linked',
          ts: input.linked_at,
          idempotency_key: input.idempotency_key,
          payload,
        },
        this.paths()
      );
      await this.mirror?.mirrorUsageRecord(record, this.paths().sidecarsDir, this.repoRoot);
      this.store.applySourcePlanLink({
        source_plan_ref_id: payload.canonical_ref_id,
        artifact_id: payload.artifact_id,
        linked_at: payload.linked_at,
        pinned_version: payload.pinned_version,
      });
      return { linked: true };
    });
  }

  /**
   * Resolve the actual baseline for a new snapshot. The
   * caller's hint is honored only when a valid same-session prior exists;
   * otherwise it degrades to a resumed-leg `whole_session` (when the artifact
   * already has snapshots under a different session) or `first_observation`.
   */
  private resolveBaseline(input: RecordUsageSnapshotInput): {
    baseline_kind: UsageBaselineKind;
    priorRow: UsageSnapshotRow | null;
  } {
    const { agent, session_id: sessionId } = input;

    // Manual / pre-decided whole-session (e.g. --count-whole-session).
    if (input.baseline_hint === 'whole_session') {
      return { baseline_kind: 'whole_session', priorRow: null };
    }

    // checkpoint_open: delta vs this checkpoint's open snapshot (same session).
    if (
      input.baseline_hint === 'checkpoint_open' &&
      input.artifact_id != null &&
      input.checkpoint_n != null
    ) {
      const open = this.store.getLatestUsageSnapshot({
        agent,
        sessionId,
        artifactId: input.artifact_id,
        lifecycleEvent: 'checkpoint_open',
        checkpointN: input.checkpoint_n,
        beforeTs: input.ts,
      });
      if (open) return { baseline_kind: 'checkpoint_open', priorRow: open };
      // else fall through to a same-session prior / first observation
    }

    // Same-session prior in the hinted scope.
    const useSourcePlanScope = input.baseline_hint === 'prior_same_source_plan';
    const scopeId = useSourcePlanScope ? input.source_plan_ref_id : input.artifact_id;
    if (scopeId != null) {
      const prior = this.store.getLatestUsageSnapshot(
        useSourcePlanScope
          ? { agent, sessionId, sourcePlanRefId: scopeId, beforeTs: input.ts }
          : { agent, sessionId, artifactId: scopeId, beforeTs: input.ts }
      );
      if (prior) {
        return {
          baseline_kind: useSourcePlanScope ? 'prior_same_source_plan' : 'prior_same_artifact',
          priorRow: prior,
        };
      }
    }

    // Resumed leg: the artifact has snapshots under a DIFFERENT session →
    // baseline from session-start so the re-orientation read is captured.
    if (
      input.artifact_id != null &&
      this.store.artifactHasSnapshotUnderDifferentSession(input.artifact_id, agent, sessionId)
    ) {
      return { baseline_kind: 'whole_session', priorRow: null };
    }

    return { baseline_kind: 'first_observation', priorRow: null };
  }
}

/** Counts projected by {@link rebuildUsageLedger}, split so callers can
 * surface snapshots and links as distinct, unambiguous figures. */
export interface RebuildUsageLedgerResult {
  snapshots: number;
  links: number;
}

/**
 * Replay the usage ledger into SQLite (called by `rebuildCache` after
 * `store.reset()`). Snapshots first, then links; deduped by idempotency key.
 * Embedded deltas are inserted as-is — never recomputed. Returns the snapshot
 * and link counts separately (a single summed number conflated the two).
 */
export async function rebuildUsageLedger(
  store: Store,
  repoRoot: string
): Promise<RebuildUsageLedgerResult> {
  const events = await readUsageLedger({
    ledgerPath: usageLedgerPath(repoRoot),
    sidecarsDir: usageSidecarsDir(repoRoot),
    containmentRoot: repoRoot,
  });
  return replayUsageEventsIntoStore(store, events);
}

/**
 * The replay body, factored out so the archive global index can
 * project a MIRRORED usage ledger into a per-project index Store with the
 * exact semantics of the hot rebuild (snapshots first, links second,
 * last-valid-form idempotency dedupe, embedded deltas never recomputed).
 */
export function replayUsageEventsIntoStore(
  store: Store,
  events: LoadedUsageEvent[]
): RebuildUsageLedgerResult {
  const lastByKey = new Map<string, number>();
  let snapshots = 0;
  let links = 0;

  for (const [index, ev] of events.entries()) {
    if (ev.type === 'agent_usage_snapshot_recorded') {
      const parsed = AgentUsageSnapshotPayloadSchema.safeParse(ev.payload);
      if (!parsed.success || parsed.data.idempotency_key !== ev.idempotency_key) continue;
    } else if (!SourcePlanLinkPayloadSchema.safeParse(ev.payload).success) {
      continue;
    }
    lastByKey.set(`${ev.type}\0${ev.idempotency_key}`, index);
  }

  for (const [index, ev] of events.entries()) {
    if (ev.type !== 'agent_usage_snapshot_recorded') continue;
    const parsed = AgentUsageSnapshotPayloadSchema.safeParse(ev.payload);
    if (
      !parsed.success ||
      parsed.data.idempotency_key !== ev.idempotency_key ||
      lastByKey.get(`${ev.type}\0${ev.idempotency_key}`) !== index
    ) {
      continue;
    }
    store.insertUsageSnapshot(payloadToRow(parsed.data, ev.ts));
    snapshots += 1;
  }

  for (const [index, ev] of events.entries()) {
    if (ev.type !== 'source_plan_linked') continue;
    const parsed = SourcePlanLinkPayloadSchema.safeParse(ev.payload);
    if (!parsed.success || lastByKey.get(`${ev.type}\0${ev.idempotency_key}`) !== index) continue;
    store.applySourcePlanLink({
      source_plan_ref_id: parsed.data.canonical_ref_id,
      artifact_id: parsed.data.artifact_id,
      linked_at: parsed.data.linked_at,
      pinned_version: parsed.data.pinned_version,
    });
    links += 1;
  }

  return { snapshots, links };
}

// ── pure helpers ──────────────────────────────────────────────────────────

function zeroUsage(): AgentUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** Per-field `max(0, cur - base)` — cumulative is monotonic, so this never
 * goes negative in practice; the clamp guards against out-of-order reads. */
function subtractClamp(cur: AgentUsage, base: AgentUsage): AgentUsage {
  return {
    input_tokens: Math.max(0, cur.input_tokens - base.input_tokens),
    output_tokens: Math.max(0, cur.output_tokens - base.output_tokens),
    cache_creation_input_tokens: Math.max(
      0,
      cur.cache_creation_input_tokens - base.cache_creation_input_tokens
    ),
    cache_read_input_tokens: Math.max(
      0,
      cur.cache_read_input_tokens - base.cache_read_input_tokens
    ),
  };
}

/** A scalar-only copy of a usage value (drops `dimensions`). Deltas are
 *  scalar-only by design — `dimensions` lives on cumulative only, never on a
 *  delta — so the `whole_session` branches copy through this, not `{ ...u }`. */
function scalarOnly(u: AgentUsage): AgentUsage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  };
}

/** The per-model breakdown partition key — model + the price-determining rate
 *  classes (byte-stable JSON; matches the parser's grouping). */
function breakdownKey(e: {
  model: string;
  speed?: string;
  service_tier?: string;
  inference_geo?: string;
}): string {
  return JSON.stringify([e.model, e.speed ?? '', e.service_tier ?? '', e.inference_geo ?? '']);
}

/** Parse a stored `dimensions` JSON column into a sparse counter map, or
 *  undefined when empty/corrupt (so cumulative carries no empty `dimensions`). */
function parseDimensions(json: string): Record<string, number> | undefined {
  try {
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== 'object' || raw === null) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function rowCumulative(row: UsageSnapshotRow): AgentUsage {
  const u: AgentUsage = {
    input_tokens: row.cumulative_input_tokens,
    output_tokens: row.cumulative_output_tokens,
    cache_creation_input_tokens: row.cumulative_cache_creation_input_tokens,
    cache_read_input_tokens: row.cumulative_cache_read_input_tokens,
  };
  const dimensions = parseDimensions(row.dimensions);
  if (dimensions) u.dimensions = dimensions;
  return u;
}

function rowDelta(row: UsageSnapshotRow): AgentUsage | null {
  if (row.delta_input_tokens === null) return null;
  return {
    input_tokens: row.delta_input_tokens,
    output_tokens: row.delta_output_tokens ?? 0,
    cache_creation_input_tokens: row.delta_cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: row.delta_cache_read_input_tokens ?? 0,
  };
}

/**
 * The embedded per-snapshot delta. AUDIT/DEBUG ONLY: attribution is
 * computed order-independently from cumulative high-water spans
 * ({@link Store.attributedArtifactUsage}), never by summing these deltas — that
 * sum is order-dependent and double-counts overlapping windows. `beforeTs` in
 * `resolveBaseline` keeps this delta from baselining against a future-ts row.
 */
function deltaFor(
  kind: UsageBaselineKind,
  cumulative: AgentUsage,
  priorRow: UsageSnapshotRow | null
): AgentUsage | null {
  if (kind === 'first_observation') return null;
  // Scalar-only: the delta never carries `dimensions` (see scalarOnly).
  if (kind === 'whole_session') return scalarOnly(cumulative);
  return subtractClamp(cumulative, rowCumulative(priorRow as UsageSnapshotRow));
}

function buildModelBreakdown(
  cumulativeByModel: Array<{
    model: string;
    speed?: string;
    service_tier?: string;
    inference_geo?: string;
    cumulative: AgentUsage;
  }>,
  kind: UsageBaselineKind,
  priorRow: UsageSnapshotRow | null
): UsageModelBreakdownEntry[] {
  // Key the prior by the FULL rate class (model + speed/service_tier/inference_geo),
  // not the model alone — otherwise fast/standard entries for the same model
  // cross-subtract deltas from the wrong bucket.
  const priorMap = new Map<string, AgentUsage>();
  if (priorRow) {
    try {
      const prev = JSON.parse(priorRow.model_breakdown) as UsageModelBreakdownEntry[];
      for (const e of prev) priorMap.set(breakdownKey(e), e.cumulative);
    } catch {
      // corrupt prior breakdown → treat as no per-model prior (deltas vs zero)
    }
  }
  return cumulativeByModel.map((entry) => {
    const { model, speed, service_tier, inference_geo, cumulative } = entry;
    let delta: AgentUsage | null;
    if (kind === 'first_observation') {
      delta = null;
    } else if (kind === 'whole_session') {
      delta = scalarOnly(cumulative); // delta never carries dimensions
    } else {
      delta = subtractClamp(cumulative, priorMap.get(breakdownKey(entry)) ?? zeroUsage());
    }
    return {
      model,
      ...(speed !== undefined ? { speed } : {}),
      ...(service_tier !== undefined ? { service_tier } : {}),
      ...(inference_geo !== undefined ? { inference_geo } : {}),
      cumulative,
      delta,
    };
  });
}

function payloadToRow(payload: AgentUsageSnapshotPayload, ts: string): UsageSnapshotRow {
  const d = payload.delta_usage;
  return {
    snapshot_id: payload.snapshot_id,
    idempotency_key: payload.idempotency_key,
    artifact_id: payload.artifact_id,
    source_plan_ref_id: payload.source_plan_ref_id,
    agent: payload.agent,
    session_id: payload.session_id,
    lifecycle_event: payload.lifecycle_event,
    checkpoint_n: payload.checkpoint_n,
    cumulative_input_tokens: payload.cumulative_usage.input_tokens,
    cumulative_output_tokens: payload.cumulative_usage.output_tokens,
    cumulative_cache_creation_input_tokens: payload.cumulative_usage.cache_creation_input_tokens,
    cumulative_cache_read_input_tokens: payload.cumulative_usage.cache_read_input_tokens,
    delta_input_tokens: d ? d.input_tokens : null,
    delta_output_tokens: d ? d.output_tokens : null,
    delta_cache_creation_input_tokens: d ? d.cache_creation_input_tokens : null,
    delta_cache_read_input_tokens: d ? d.cache_read_input_tokens : null,
    baseline_kind: payload.baseline_kind,
    model_breakdown: JSON.stringify(payload.model_breakdown),
    // The snapshot TOTAL's open dimensions (per-model dimensions ride inside
    // model_breakdown). Empty map when absent — the NOT NULL column default.
    dimensions: JSON.stringify(payload.cumulative_usage.dimensions ?? {}),
    record_count: payload.record_count,
    as_of: payload.as_of,
    ts,
  };
}

function rowToPayload(row: UsageSnapshotRow): AgentUsageSnapshotPayload {
  let model_breakdown: UsageModelBreakdownEntry[] = [];
  try {
    model_breakdown = JSON.parse(row.model_breakdown) as UsageModelBreakdownEntry[];
  } catch {
    model_breakdown = [];
  }
  return {
    snapshot_id: row.snapshot_id,
    idempotency_key: row.idempotency_key,
    agent: row.agent,
    session_id: row.session_id,
    artifact_id: row.artifact_id,
    source_plan_ref_id: row.source_plan_ref_id,
    lifecycle_event: row.lifecycle_event,
    checkpoint_n: row.checkpoint_n,
    cumulative_usage: rowCumulative(row),
    delta_usage: rowDelta(row),
    baseline_kind: row.baseline_kind as UsageBaselineKind,
    model_breakdown,
    record_count: row.record_count,
    as_of: row.as_of,
  };
}
