import { uuidv7 } from '@orcaops/storage';
import type { ProjectDatabase } from '@orcaops/storage/history/database';

import {
  appendProjectUsageEvents,
  readProjectUsage,
} from '../../../../packages/storage/dist/history/database/usage.js';
import type { AgentUsageSnapshotPayload } from '../../../../packages/storage/dist/schema/usage-ledger.js';
import { deriveUsageLedgerRecord } from '../../../../packages/storage/dist/usage/record.js';

export function tokens(input: number) {
  return {
    input_tokens: input,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
export async function usageObservation(
  writer: ProjectDatabase,
  artifactId: string | null,
  count: number,
  changes: Partial<AgentUsageSnapshotPayload> = {}
) {
  const payload: AgentUsageSnapshotPayload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex',
    session_id: 'shared-session',
    artifact_id: artifactId,
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close',
    checkpoint_n: 1,
    cumulative_usage: tokens(count),
    delta_usage: null,
    baseline_kind: 'first_observation',
    model_breakdown: [{ model: 'model', speed: 'fast', cumulative: tokens(count), delta: null }],
    record_count: count,
    as_of: `2026-09-01T00:${String(count % 60).padStart(2, '0')}:00.000Z`,
    ...changes,
  };
  const record = deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts: payload.as_of,
    idempotency_key: payload.idempotency_key,
    payload,
  }).record;
  await appendProjectUsageEvents(writer, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(writer)?.revision ?? null,
    eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
