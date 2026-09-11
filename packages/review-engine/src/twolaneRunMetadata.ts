import { type TwolaneAttemptRecord } from './twolaneRunFile.js';
import { type ComposedStory, type Lane } from './twolaneSlice.js';

export type IsolationStatus = 'SUBAGENT_FRESH' | 'SEQUENTIAL' | 'UNKNOWN';

export type RoutineLatencyTier = 'LT_250KB' | 'FROM_250KB_TO_LT_1MB' | 'FROM_1MB_TO_2MB';
export interface RoutineLatencyProfile {
  latency_input_bytes: number;
  latency_tier: RoutineLatencyTier;
  latency_budget_ms: number;
}

/** Decimal-byte tiers over the exact policy-eligible forensic diff. */
export function latencyProfileFor(eligibleDiffBytes: number): RoutineLatencyProfile {
  if (!Number.isInteger(eligibleDiffBytes) || eligibleDiffBytes < 0)
    throw new Error(`latency input bytes must be a non-negative integer, got ${eligibleDiffBytes}`);
  if (eligibleDiffBytes < 250_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'LT_250KB',
      latency_budget_ms: 180_000,
    };
  if (eligibleDiffBytes < 1_000_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'FROM_250KB_TO_LT_1MB',
      latency_budget_ms: 300_000,
    };
  if (eligibleDiffBytes <= 2_000_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'FROM_1MB_TO_2MB',
      latency_budget_ms: 480_000,
    };
  throw new Error(
    `latency input ${eligibleDiffBytes} exceeds the 2,000,000-byte forensic transport ceiling`
  );
}

export const laneIsolation = (
  attempts: readonly TwolaneAttemptRecord[],
  lane: Lane
): IsolationStatus | null => {
  const mine = attempts.filter((a) => a.lane === lane);
  if (mine.length === 0) return null;
  if (mine.some((a) => a.declared_isolation === 'sequential')) return 'SEQUENTIAL';
  if (mine.some((a) => a.declared_isolation === 'unknown')) return 'UNKNOWN';
  return 'SUBAGENT_FRESH';
};

export const aggregateIsolation = (
  perLane: Record<Lane, IsolationStatus | null>
): IsolationStatus => {
  const present = Object.values(perLane).filter((v): v is IsolationStatus => v !== null);
  if (present.length === 0) return 'UNKNOWN';
  if (present.includes('SEQUENTIAL')) return 'SEQUENTIAL';
  if (present.includes('UNKNOWN')) return 'UNKNOWN';
  return 'SUBAGENT_FRESH';
};

export interface TwolaneOwnershipSummary {
  label: ComposedStory['ownership']['label'];
  reviewable_rows: number;
  attributed_rows: number;
  /** Stored at the composed model's full numeric precision; round only for display. */
  attributed_pct: number;
  ambiguous_rows: number;
  contested_rows: number;
  unattributed_rows: number;
  missing_boundary_checkpoints: number;
}

/** Project only the composed output's authoritative ownership accounting. */
export const ownershipSummaryFromComposed = (composed: ComposedStory): TwolaneOwnershipSummary => {
  const metrics = composed.ownership.metrics;
  const classifiedRows =
    metrics.attributedRows +
    metrics.ambiguousRows +
    metrics.contestedRows +
    metrics.unattributedRows;
  if (classifiedRows !== metrics.reviewableRows) {
    throw new Error(
      `ownership summary partition mismatch: reviewable=${metrics.reviewableRows}, ` +
        `attributed=${metrics.attributedRows}, ambiguous=${metrics.ambiguousRows}, ` +
        `contested=${metrics.contestedRows}, unattributed=${metrics.unattributedRows}`
    );
  }
  return {
    label: composed.ownership.label,
    reviewable_rows: metrics.reviewableRows,
    attributed_rows: metrics.attributedRows,
    attributed_pct: metrics.attributedPct,
    ambiguous_rows: metrics.ambiguousRows,
    contested_rows: metrics.contestedRows,
    unattributed_rows: metrics.unattributedRows,
    missing_boundary_checkpoints: composed.ownership.missingBoundaryCheckpoints,
  };
};
