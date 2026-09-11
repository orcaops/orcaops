import type { LoadedUsageEvent } from './ledger-log.js';
import {
  type AgentUsageSnapshotPayload,
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
} from '../schema/usage-ledger.js';
import type { SourcePlanLinkRow, UsageSnapshotRow } from '../store/sqlite.js';
type Store = {
  insertUsageSnapshot(row: UsageSnapshotRow): unknown;
  applySourcePlanLink(row: SourcePlanLinkRow): unknown;
};
export interface RebuildUsageLedgerResult {
  snapshots: number;
  links: number;
}
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
    dimensions: JSON.stringify(payload.cumulative_usage.dimensions ?? {}),
    record_count: payload.record_count,
    as_of: payload.as_of,
    ts,
  };
}
