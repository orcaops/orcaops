// The shared call and spend ledger. Both windows are computed from the retained rows, so they are
// shared by every worktree of this project database and are never reset by a restart or a retry.
// A reservation is taken before a paid call and settled with what the provider reported, or as
// unknown when the result was lost, in which case the conservative reservation is retained in
// full. Missing usage stays NULL; it is never counted as zero.
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertProcessingLeaseGeneration } from './processing-lease.js';
import {
  processingGeneration,
  processingInstant,
  type ProcessingMaintenance,
  processingMicros,
  processingRecordId,
  runProcessingMaintenance,
} from './processing-maintenance.js';
import type { ProjectOperationOptions } from './transactions.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';

export const PROCESSING_CALL_WINDOW_MS = 60 * 60 * 1000;
export const PROCESSING_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProcessingUsageState = 'reserved' | 'settled' | 'released' | 'unknown';

export interface ProcessingUsageRecord {
  usageId: string;
  attemptId: string;
  reservedAt: string;
  reservedCostUsd: number | null;
  state: ProcessingUsageState;
  settledAt: string | null;
  reportedCostUsd: number | null;
  usage: DatabaseJson;
}

export interface ProcessingCallWindow {
  used: number;
  limit: number;
  available: number;
  windowStart: string;
  /** When the oldest counted reservation leaves this window, or null when none is counted. */
  freesUpAt: string | null;
}

export interface ProcessingSpendWindow {
  usedUsd: number;
  budgetUsd: number | null;
  availableUsd: number | null;
  windowStart: string;
  freesUpAt: string | null;
}

export interface ProcessingUsageWindows {
  calls: ProcessingCallWindow;
  spend: ProcessingSpendWindow;
}

const USAGE_COLUMNS = `usage_id AS usageId, attempt_id AS attemptId, reserved_at AS reservedAt,
  reserved_cost_usd AS reservedCostUsd, state, settled_at AS settledAt,
  reported_cost_usd AS reportedCostUsd, usage_json AS usageJson`;

interface UsageRow {
  usageId: string;
  attemptId: string;
  reservedAt: string;
  reservedCostUsd: number | null;
  state: string;
  settledAt: string | null;
  reportedCostUsd: number | null;
  usageJson: string | null;
}

const USAGE_STATES: readonly string[] = ['reserved', 'settled', 'released', 'unknown'];

function decodeProcessingUsage(row: UsageRow): ProcessingUsageRecord {
  if (!USAGE_STATES.includes(row.state))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained processing reservation has an unknown state'
    );
  return {
    usageId: row.usageId,
    attemptId: row.attemptId,
    reservedAt: row.reservedAt,
    reservedCostUsd: row.reservedCostUsd,
    state: row.state as ProcessingUsageState,
    settledAt: row.settledAt,
    reportedCostUsd: row.reportedCostUsd,
    usage: row.usageJson === null ? null : (JSON.parse(row.usageJson) as DatabaseJson),
  };
}

function windowStart(now: string, span: number): string {
  return new Date(Date.parse(now) - span).toISOString();
}

function leavesAt(oldest: string | null, span: number): string | null {
  return oldest === null ? null : new Date(Date.parse(oldest) + span).toISOString();
}

interface WindowRow {
  calls: number;
  oldest: string | null;
  spentMicros: number | null;
}

/**
 * A released reservation never became a call, so it counts against neither
 * window. A settled one whose provider reported no cost keeps its conservative
 * reservation rather than falling to zero. Each row is scaled to whole
 * micro-dollars before it is summed, so the total is exact.
 */
function windowRow(view: ProjectReadView, from: string): WindowRow {
  const row = view.get<WindowRow>(
    `SELECT count(*) AS calls, min(reserved_at) AS oldest,
      sum(CAST(round(coalesce(reported_cost_usd, reserved_cost_usd, 0) * 1000000) AS INTEGER)) AS spentMicros
      FROM processing_usage WHERE reserved_at > ? AND state <> 'released'`,
    from
  );
  return row ?? { calls: 0, oldest: null, spentMicros: 0 };
}

interface WindowState {
  windows: ProcessingUsageWindows;
  spentMicros: number;
}

function computeWindows(
  view: ProjectReadView,
  now: string,
  limit: number,
  budgetUsd: number | null,
  budgetMicros: number | null
): WindowState {
  const callsFrom = windowStart(now, PROCESSING_CALL_WINDOW_MS);
  const spendFrom = windowStart(now, PROCESSING_SPEND_WINDOW_MS);
  const calls = windowRow(view, callsFrom);
  const spend = windowRow(view, spendFrom);
  const spentMicros = spend.spentMicros ?? 0;
  if (!Number.isSafeInteger(spentMicros))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained processing spend is outside the recordable range; explicit repair is required'
    );
  return {
    spentMicros,
    windows: {
      calls: {
        used: calls.calls,
        limit,
        available: Math.max(0, limit - calls.calls),
        windowStart: callsFrom,
        freesUpAt: leavesAt(calls.oldest, PROCESSING_CALL_WINDOW_MS),
      },
      spend: {
        usedUsd: spentMicros / 1_000_000,
        budgetUsd,
        availableUsd:
          budgetMicros === null ? null : Math.max(0, budgetMicros - spentMicros) / 1_000_000,
        windowStart: spendFrom,
        freesUpAt: leavesAt(spend.oldest, PROCESSING_SPEND_WINDOW_MS),
      },
    },
  };
}

export interface ReadProcessingUsageWindows {
  now: string;
  maxCallsPerHour: number;
  maxCostUsdPerDay?: number | null;
}

/** What the current windows hold. Reads only; starts nothing and reserves nothing. */
export function readProcessingUsageWindows(
  handle: ProjectDatabase,
  input: ReadProcessingUsageWindows
): ProcessingUsageWindows {
  const now = processingInstant(input.now, 'the current time');
  const limit = callLimit(input.maxCallsPerHour);
  const budgetUsd = dailyBudget(input.maxCostUsdPerDay ?? null);
  const budgetMicros = budgetUsd === null ? null : processingMicros(budgetUsd, 'the daily budget');
  assertProjectDatabasePath(handle);
  return handle.read((view) => computeWindows(view, now, limit, budgetUsd, budgetMicros).windows)
    .value;
}

function callLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the calls-per-hour limit from the effective configuration'
    );
  return value as number;
}

function dailyBudget(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the daily budget as a non-negative amount, or null when none is configured'
    );
  return value;
}

export interface ProcessingCallLimits {
  maxCallsPerHour: number;
  /** Null when no daily budget is configured; then nothing is held against spend. */
  maxCostUsdPerDay?: number | null;
  /** The conservative amount held for this call; required with a daily budget. */
  reservationUsd?: number | null;
}

export interface ProcessingCallHold {
  limit: number;
  budgetUsd: number | null;
  budgetMicros: number | null;
  reservationUsd: number | null;
  reservationMicros: number;
}

/**
 * Judge the limits before anything is read. A limit that cannot admit even an
 * empty window's first call is a configuration that can never dispatch, which
 * §6 pauses the workload over; it is not a job that waits, so it is refused
 * here and never reaches a job row.
 */
export function processingCallHold(input: ProcessingCallLimits): ProcessingCallHold {
  const limit = callLimit(input.maxCallsPerHour);
  if (limit < 1)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'A calls-per-hour limit below one admits no call at all; pause the workload instead'
    );
  const budgetUsd = dailyBudget(input.maxCostUsdPerDay ?? null);
  const reservationUsd = input.reservationUsd ?? null;
  if (budgetUsd === null) {
    if (reservationUsd !== null)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'A per-call reservation amount is held only against a configured daily budget'
      );
  } else if (typeof reservationUsd !== 'number' || !(reservationUsd > 0))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'A daily budget dispatches only against a positive conservative per-call reservation'
    );
  const reservationMicros =
    reservationUsd === null ? 0 : processingMicros(reservationUsd, 'the per-call reservation');
  const budgetMicros = budgetUsd === null ? null : processingMicros(budgetUsd, 'the daily budget');
  if (budgetMicros !== null && reservationMicros > budgetMicros)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'A per-call reservation larger than the whole daily budget can never dispatch; pause the workload instead'
    );
  return { limit, budgetUsd, budgetMicros, reservationUsd, reservationMicros };
}

export type ProcessingWindowDecision =
  | { outcome: 'fits'; windows: ProcessingUsageWindows }
  | {
      outcome: 'refused';
      limit: 'calls_per_hour' | 'cost_per_day';
      windows: ProcessingUsageWindows;
      /**
       * When the refusing window next changes. Never null: a refusal needs a
       * counted row in that window, which `processingCallHold` guarantees.
       */
      freesUpAt: string;
    };

/** Whether one more call fits both windows, reading only. */
export function decideProcessingCall(
  transaction: ProcessingMaintenance,
  hold: ProcessingCallHold,
  reservedAt: string
): ProcessingWindowDecision {
  const before = computeWindows(
    transaction,
    reservedAt,
    hold.limit,
    hold.budgetUsd,
    hold.budgetMicros
  );
  const refused = (
    limit: 'calls_per_hour' | 'cost_per_day',
    freesUpAt: string | null
  ): ProcessingWindowDecision => {
    if (freesUpAt === null)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A processing window refused a call with nothing in it; preserve the ledger for explicit repair'
      );
    return { outcome: 'refused', limit, windows: before.windows, freesUpAt };
  };
  if (before.windows.calls.used + 1 > hold.limit)
    return refused('calls_per_hour', before.windows.calls.freesUpAt);
  if (hold.budgetMicros !== null && before.spentMicros + hold.reservationMicros > hold.budgetMicros)
    return refused('cost_per_day', before.windows.spend.freesUpAt);
  return { outcome: 'fits', windows: before.windows };
}

/** Write the hold. Its attempt must already exist, which the ledger's key requires. */
export function holdProcessingCall(
  transaction: ProcessingMaintenance,
  hold: ProcessingCallHold,
  input: { usageId: string; attemptId: string; reservedAt: string }
): { usage: ProcessingUsageRecord; windows: ProcessingUsageWindows } {
  if (transaction.get('SELECT usage_id FROM processing_usage WHERE usage_id=?', input.usageId))
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The reservation identity already belongs to the retained ledger'
    );
  transaction.run(
    `INSERT INTO processing_usage (usage_id,attempt_id,reserved_at,reserved_cost_usd,state,settled_at,reported_cost_usd,usage_json)
      VALUES (?,?,?,?,'reserved',NULL,NULL,NULL)`,
    input.usageId,
    input.attemptId,
    input.reservedAt,
    hold.reservationUsd
  );
  return {
    usage: {
      usageId: input.usageId,
      attemptId: input.attemptId,
      reservedAt: input.reservedAt,
      reservedCostUsd: hold.reservationUsd,
      state: 'reserved',
      settledAt: null,
      reportedCostUsd: null,
      usage: null,
    },
    windows: computeWindows(
      transaction,
      input.reservedAt,
      hold.limit,
      hold.budgetUsd,
      hold.budgetMicros
    ).windows,
  };
}

export type ProcessingCallResult =
  /** What the provider reported. A cost it did not report is null, never zero. */
  | { kind: 'reported'; costUsd: number | null; usage: DatabaseJson }
  /** The result was lost, so the conservative reservation is retained in full. */
  | { kind: 'unknown' }
  /** No call was made, so the hold is returned to both windows. */
  | { kind: 'released' };

export interface SettleProcessingCall {
  generation: number;
  usageId: string;
  settledAt: string;
  result: ProcessingCallResult;
}

export function settleReservation(
  transaction: ProcessingMaintenance,
  usageId: string,
  settledAt: string,
  result: ProcessingCallResult
): ProcessingUsageRecord {
  const row = transaction.get<UsageRow>(
    `SELECT ${USAGE_COLUMNS} FROM processing_usage WHERE usage_id=?`,
    usageId
  );
  if (!row)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The processing reservation is missing; preserve the ledger for explicit repair'
    );
  if (row.state !== 'reserved')
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing reservation has already ended; a settled reservation is retained as it ended'
    );
  let state: ProcessingUsageState;
  let reportedCostUsd: number | null = null;
  let usageJson: string | null = null;
  if (result.kind === 'reported') {
    state = 'settled';
    if (result.costUsd !== null) {
      if (typeof result.costUsd !== 'number' || !Number.isFinite(result.costUsd))
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Report the call cost as an amount, or null when the provider reported none'
        );
      processingMicros(result.costUsd, 'the reported cost');
      reportedCostUsd = result.costUsd;
    }
    usageJson = serializeDatabaseValue(result.usage);
  } else if (result.kind === 'unknown') state = 'unknown';
  else if (result.kind === 'released') state = 'released';
  else
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Settle a reservation as reported, unknown or released'
    );
  const changes = transaction.run(
    'UPDATE processing_usage SET state=?, settled_at=?, reported_cost_usd=?, usage_json=? WHERE usage_id=? AND state=?',
    state,
    settledAt,
    reportedCostUsd,
    usageJson,
    usageId,
    'reserved'
  ).changes;
  if (changes !== 1)
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'The processing reservation did not settle; inspect storage before retrying'
    );
  return decodeProcessingUsage({
    ...row,
    state,
    settledAt,
    reportedCostUsd,
    usageJson,
  });
}

/**
 * Settle one reservation, as the owner of the attempt that made the call.
 * Holding the lease is not enough: a new owner must not report what a
 * superseded owner's call did or return its hold. Recovery settles what a lost
 * owner left, through its own path.
 */
export async function settleProcessingCall(
  handle: ProjectDatabase,
  input: SettleProcessingCall,
  options: ProjectOperationOptions = {}
): Promise<ProcessingUsageRecord> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const usageId = processingRecordId(input.usageId, 'processing reservation');
  const settledAt = processingInstant(input.settledAt, 'the settlement time');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.usage.settle',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const owner = transaction.get<{ ownerGeneration: number }>(
        `SELECT a.owner_generation AS ownerGeneration FROM processing_usage u
          JOIN processing_attempts a ON a.attempt_id=u.attempt_id WHERE u.usage_id=?`,
        usageId
      );
      if (!owner)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The processing reservation is missing; preserve the ledger for explicit repair'
        );
      if (owner.ownerGeneration !== generation)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The call this reservation paid for belongs to an earlier owner; recovery settles what a lost owner left'
        );
      return settleReservation(transaction, usageId, settledAt, input.result);
    },
    options
  );
}

export function readProcessingAttemptUsage(
  view: ProjectReadView,
  attemptId: string
): ProcessingUsageRecord[] {
  return view
    .all<UsageRow>(
      `SELECT ${USAGE_COLUMNS} FROM processing_usage WHERE attempt_id=? ORDER BY reserved_at, usage_id`,
      attemptId
    )
    .map(decodeProcessingUsage);
}
