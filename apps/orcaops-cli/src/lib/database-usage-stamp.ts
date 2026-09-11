import {
  type AppendSourcePlanLinkInput,
  type AppendUsageRecordInput,
  deriveUsageLedgerRecord,
  SourcePlanLinkPayloadSchema,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectUsageEvents,
  type ProjectDatabase,
  type ProjectOperationOptions,
  readProjectUsage,
  type RetainedUsageEvent,
  type UsageSidecarPayload,
} from '@orcaops/storage/history/database';
import { deriveCanonicalUsageSnapshot } from '@orcaops/storage/history/usage-accounting';

import { captureFailure } from './canonical-capture-outcome.js';
import { resolveAgentSession } from './coding-session.js';
import type { UsageStampDescriptor } from './usage-stamp-types.js';

export interface DatabaseUsageStampInput {
  descriptor: UsageStampDescriptor;
  invokingAgent: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  secretAllow: readonly string[];
  sourcePlanLinks?: readonly AppendSourcePlanLinkInput[];
}
export type DatabaseUsageStampOutcome = {
  usage_source: 'available' | 'unavailable';
} & (
  | { state: 'committed'; operation_id: string; event_ids: string[] }
  | { state: 'replayed' }
  | { state: 'unavailable'; reason: 'session_unavailable' | 'source_unavailable' }
  | { state: 'failed'; error: ReturnType<typeof captureFailure> }
);

function hasEvent(events: readonly RetainedUsageEvent[], type: string, key: string) {
  return events.some((event) => event.record.type === type && event.record.idempotency_key === key);
}

/**
 * Best-effort like the file ledger it replaces: a missing agent session or transcript
 * is a silent no-op, and a publication failure is reported beside the capture, never
 * thrown into it. The stable event key makes a retried command replay, not re-stamp.
 */
export async function stampDatabaseUsage(
  handle: ProjectDatabase,
  input: DatabaseUsageStampInput,
  options: ProjectOperationOptions = {}
): Promise<DatabaseUsageStampOutcome> {
  const d = structuredClone(input.descriptor);
  const links = structuredClone(input.sourcePlanLinks ?? []);
  try {
    const resolved = await resolveAgentSession({
      env: input.env,
      cwd: input.cwd,
      invokingAgent: input.invokingAgent,
      now: d.asOf,
    });
    const source = resolved
      ? await resolved.source.readUsage(resolved.sessionId, { until: d.asOf, cwd: input.cwd })
      : null;
    const usageSource = source ? ('available' as const) : ('unavailable' as const);
    const current = readProjectUsage(handle);
    const events = current?.events ?? [];
    const records: AppendUsageRecordInput[] = [];
    if (resolved && source && !hasEvent(events, 'agent_usage_snapshot_recorded', d.stableEventId))
      records.push({
        type: 'agent_usage_snapshot_recorded',
        ts: d.asOf,
        idempotency_key: d.stableEventId,
        payload: deriveCanonicalUsageSnapshot(
          {
            agent: resolved.agent,
            session_id: resolved.sessionId,
            artifact_id: d.artifactId ?? null,
            source_plan_ref_id: d.sourcePlanRefId ?? null,
            lifecycle_event: d.lifecycle_event,
            checkpoint_n: d.checkpoint_n ?? null,
            cumulative_usage: source.total,
            model_breakdown: source.modelBreakdown.map((entry) => ({
              model: entry.model,
              ...(entry.speed === undefined ? {} : { speed: entry.speed }),
              ...(entry.service_tier === undefined ? {} : { service_tier: entry.service_tier }),
              ...(entry.inference_geo === undefined ? {} : { inference_geo: entry.inference_geo }),
              cumulative: entry.usage,
            })),
            record_count: source.recordCount,
            as_of: source.asOf,
            ts: d.asOf,
            baseline_hint: d.countWholeSession ? 'whole_session' : d.baselineHint,
            idempotency_key: d.stableEventId,
          },
          events
        ),
      });
    for (const link of links)
      if (!hasEvent(events, 'source_plan_linked', link.idempotency_key))
        records.push({
          type: 'source_plan_linked',
          ts: link.linked_at,
          idempotency_key: link.idempotency_key,
          payload: SourcePlanLinkPayloadSchema.parse({
            canonical_ref_id: link.canonical_ref_id,
            artifact_id: link.artifact_id,
            linked_at: link.linked_at,
            pinned_version: link.pinned_version ?? null,
          }),
        });
    if (!records.length) {
      if (source || links.length) return { state: 'replayed', usage_source: usageSource };
      return {
        state: 'unavailable',
        usage_source: usageSource,
        reason: resolved ? 'source_unavailable' : 'session_unavailable',
      };
    }
    const derived = records.map((record) => deriveUsageLedgerRecord(record));
    const sidecarPayloads: UsageSidecarPayload[] = derived.flatMap((entry) =>
      entry.sidecarJson === null
        ? []
        : [{ eventId: entry.record.event_id, bytes: Buffer.from(entry.sidecarJson, 'utf8') }]
    );
    const operationId = uuidv7();
    const published = await appendProjectUsageEvents(
      handle,
      {
        operationId,
        expectedRevision: current?.revision ?? null,
        eventBytes: Buffer.from(
          derived.map((entry) => JSON.stringify(entry.record) + '\n').join(''),
          'utf8'
        ),
        sidecarPayloads,
        secretAllow: [...input.secretAllow],
      },
      options
    );
    return {
      state: 'committed',
      usage_source: usageSource,
      operation_id: operationId,
      event_ids: published.value.eventIds,
    };
  } catch (cause) {
    return { state: 'failed', usage_source: 'unavailable', error: captureFailure(cause) };
  }
}
