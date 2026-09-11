import {
  type AgentUsageSnapshotPayload,
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
  type UsageSnapshotRow,
} from '@orcaops/storage';
import type { UsageAccountingResult } from '@orcaops/storage/history/usage-accounting';

import { type ArtifactUsageData, computeUsageAnchor } from './hash.js';

/**
 * The retained-usage facts both journals expose: an event's type + timestamp, its parsed
 * payload, and whether the retained prefix could account for it exactly. Structural so the
 * append-log and project-database event shapes both satisfy it.
 */
export interface RetainedUsageFacts {
  readonly record: { readonly type: string; readonly ts: string };
  readonly payload: unknown;
  readonly completeness: { readonly state: 'complete' | 'incomplete' };
}

function snapshotRow(payload: AgentUsageSnapshotPayload, ts: string): UsageSnapshotRow {
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
    delta_input_tokens: d?.input_tokens ?? null,
    delta_output_tokens: d?.output_tokens ?? null,
    delta_cache_creation_input_tokens: d?.cache_creation_input_tokens ?? null,
    delta_cache_read_input_tokens: d?.cache_read_input_tokens ?? null,
    baseline_kind: payload.baseline_kind,
    model_breakdown: JSON.stringify(payload.model_breakdown),
    dimensions: JSON.stringify(payload.cumulative_usage.dimensions ?? {}),
    record_count: payload.record_count,
    as_of: payload.as_of,
    ts,
  };
}

/**
 * Reduce one artifact's retained usage events plus their exact accounting to the cloud usage
 * rows, or `null` when the artifact has no sessions, snapshots or retained incompleteness.
 *
 * Shared by the append-log and project-database usage sources: the only per-source difference
 * is where `events` (the whole publication's events) and `accounting` (the exact per-session
 * totals) come from. A snapshot is in scope for the artifact directly, or through a source-plan
 * link recorded no earlier than the snapshot; sessions come only from `status === 'exact'`
 * accounting so the cloud never receives an inexact total.
 */
export function artifactUsageFromRetainedEvents(
  events: readonly RetainedUsageFacts[],
  accounting: UsageAccountingResult,
  artifactId: string
): ArtifactUsageData | null {
  const links = events
    .filter((event) => event.record.type === 'source_plan_linked')
    .map((event) => SourcePlanLinkPayloadSchema.parse(event.payload))
    .filter((link) => link.artifact_id === artifactId);
  const snapshots = events
    .filter((event) => event.record.type === 'agent_usage_snapshot_recorded')
    .map((event) => ({
      payload: AgentUsageSnapshotPayloadSchema.parse(event.payload),
      ts: event.record.ts,
    }))
    .filter(
      ({ payload, ts }) =>
        payload.artifact_id === artifactId ||
        links.some(
          (link) => link.canonical_ref_id === payload.source_plan_ref_id && ts <= link.linked_at
        )
    )
    .map(({ payload, ts }) => snapshotRow(payload, ts));
  if (
    !snapshots.length &&
    !accounting.sessions.length &&
    !events.some((event) => event.completeness.state === 'incomplete')
  )
    return null;
  if (accounting.status !== 'exact')
    throw Object.assign(
      new Error('Retained usage cannot be represented as exact cloud session totals'),
      { code: 'HISTORY_INCOMPLETE', accounting }
    );
  const sessions = accounting.sessions.map((session) => ({
    agent: session.agent,
    session_id: session.session_id,
    cumulative_input_tokens: session.totals!.input_tokens,
    cumulative_output_tokens: session.totals!.output_tokens,
    cumulative_cache_creation_input_tokens: session.totals!.cache_creation_input_tokens,
    cumulative_cache_read_input_tokens: session.totals!.cache_read_input_tokens,
    as_of: session.as_of,
    record_count: session.record_count,
  }));
  const modelBreakdowns = accounting.sessions.map((session) => ({
    agent: session.agent,
    session_id: session.session_id,
    model_breakdown: JSON.stringify(session.model_breakdown),
    dimensions: JSON.stringify(session.dimensions ?? {}),
  }));
  const source_plan_links = links.map((link) => ({
    source_plan_ref_id: link.canonical_ref_id,
    artifact_id: link.artifact_id,
    linked_at: link.linked_at,
    pinned_version: link.pinned_version,
  }));
  const result = { sessions, snapshots, modelBreakdowns, source_plan_links };
  return { ...result, anchor: computeUsageAnchor(result) };
}
