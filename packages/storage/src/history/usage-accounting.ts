import { createHash } from 'node:crypto';

import { HistoryPersistenceError } from './persistence-error.js';
import { canonicalJson } from '../events/canonical-json.js';
import { uuidv7 } from '../ids/uuidv7.js';
import {
  type AgentUsage,
  type AgentUsageSnapshotPayload,
  AgentUsageSnapshotPayloadSchema,
  type SourcePlanLinkPayload,
  SourcePlanLinkPayloadSchema,
  type UsageBaselineKind,
  type UsageLedgerRecord,
  type UsageModelBreakdownEntry,
} from '../schema/usage-ledger.js';
import type { RecordUsageSnapshotInput } from '../usage/snapshot-input.js';

export interface UsageAccountingEvent {
  record: UsageLedgerRecord;
  payload: unknown;
  completeness: { state: 'complete' | 'incomplete'; reasons: string[] };
  eventIdentity?: string;
  snapshotIdentity?: string;
}
export function usageAccountingIdentities(event: UsageAccountingEvent): {
  eventIdentity: string;
  snapshotIdentity: string;
} {
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  return {
    eventIdentity: event.eventIdentity ?? hash({ record: event.record, payload: event.payload }),
    snapshotIdentity:
      event.snapshotIdentity ?? hash({ payload: event.payload, ts: event.record.ts }),
  };
}

export const USAGE_SCALARS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;
export type UsageScalars = Pick<AgentUsage, (typeof USAGE_SCALARS)[number]>;
export interface UsageObservation {
  payload: AgentUsageSnapshotPayload;
  ts: string;
  incomplete: string[];
}
export function usageSessionKey(agent: string, sessionId: string): string {
  return JSON.stringify([agent, sessionId]);
}
export function usageModelKey(
  model: Pick<UsageModelBreakdownEntry, 'model' | 'speed' | 'service_tier' | 'inference_geo'>
): string {
  return JSON.stringify([
    model.model,
    model.speed ?? '',
    model.service_tier ?? '',
    model.inference_geo ?? '',
  ]);
}
function zero(): UsageScalars {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
function scalars(value: AgentUsage): UsageScalars {
  return Object.fromEntries(
    USAGE_SCALARS.map((field) => [field, value[field]])
  ) as unknown as UsageScalars;
}
function subtract(current: AgentUsage, floor: AgentUsage): UsageScalars {
  return Object.fromEntries(
    USAGE_SCALARS.map((field) => [field, Math.max(0, current[field] - floor[field])])
  ) as unknown as UsageScalars;
}
function sum(value: AgentUsage): number {
  return USAGE_SCALARS.reduce((total, field) => total + value[field], 0);
}
function chronological(a: UsageObservation, b: UsageObservation): number {
  return a.ts.localeCompare(b.ts) || a.payload.snapshot_id.localeCompare(b.payload.snapshot_id);
}
function sameSession(
  a: Pick<AgentUsageSnapshotPayload, 'agent' | 'session_id'>,
  b: Pick<AgentUsageSnapshotPayload, 'agent' | 'session_id'>
): boolean {
  return a.agent === b.agent && a.session_id === b.session_id;
}

export function deriveCanonicalUsageSnapshot(
  input: RecordUsageSnapshotInput,
  events: readonly UsageAccountingEvent[],
  snapshotId = uuidv7()
): AgentUsageSnapshotPayload {
  const facts: UsageObservation[] = [];
  for (const event of events) {
    if (event.record.type !== 'agent_usage_snapshot_recorded') continue;
    const parsed = AgentUsageSnapshotPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const raw = event.payload as Partial<AgentUsageSnapshotPayload> | null;
      if (
        raw &&
        (sameSession(input, raw as AgentUsageSnapshotPayload) ||
          (input.artifact_id != null && raw.artifact_id === input.artifact_id))
      )
        throw new HistoryPersistenceError(
          'USAGE_INCOMPLETE',
          'Required usage baseline facts are incomplete'
        );
      continue;
    }
    facts.push({
      payload: parsed.data,
      ts: event.record.ts,
      incomplete: event.completeness.reasons,
    });
  }
  const latest = (predicate: (fact: UsageObservation) => boolean) =>
    facts
      .filter((fact) => sameSession(input, fact.payload) && fact.ts <= input.ts && predicate(fact))
      .sort(chronological)
      .at(-1) ?? null;
  let kind: UsageBaselineKind = 'first_observation';
  let prior: UsageObservation | null = null;
  if (input.baseline_hint === 'whole_session') kind = 'whole_session';
  else {
    if (
      input.baseline_hint === 'checkpoint_open' &&
      input.artifact_id != null &&
      input.checkpoint_n != null
    )
      prior = latest(
        ({ payload }) =>
          payload.artifact_id === input.artifact_id &&
          payload.checkpoint_n === input.checkpoint_n &&
          payload.lifecycle_event === 'checkpoint_open'
      );
    if (prior) kind = 'checkpoint_open';
    else {
      const sourcePlan = input.baseline_hint === 'prior_same_source_plan';
      const scope = sourcePlan ? input.source_plan_ref_id : input.artifact_id;
      if (scope != null)
        prior = latest(
          ({ payload }) => (sourcePlan ? payload.source_plan_ref_id : payload.artifact_id) === scope
        );
      if (prior) kind = sourcePlan ? 'prior_same_source_plan' : 'prior_same_artifact';
      else if (
        input.artifact_id != null &&
        facts.some(
          ({ payload }) => payload.artifact_id === input.artifact_id && !sameSession(input, payload)
        )
      )
        kind = 'whole_session';
    }
  }
  if (prior?.incomplete.length)
    throw new HistoryPersistenceError(
      'USAGE_INCOMPLETE',
      'Selected baseline has incomplete retained source facts'
    );
  const previous = new Map(
    prior?.payload.model_breakdown.map((entry) => [usageModelKey(entry), entry.cumulative]) ?? []
  );
  const delta = (value: AgentUsage, baseline: AgentUsage) =>
    kind === 'first_observation'
      ? null
      : kind === 'whole_session'
        ? scalars(value)
        : subtract(value, baseline);
  return AgentUsageSnapshotPayloadSchema.parse({
    snapshot_id: snapshotId,
    idempotency_key: input.idempotency_key,
    agent: input.agent,
    session_id: input.session_id,
    artifact_id: input.artifact_id ?? null,
    source_plan_ref_id: input.source_plan_ref_id ?? null,
    lifecycle_event: input.lifecycle_event,
    checkpoint_n: input.checkpoint_n ?? null,
    cumulative_usage: structuredClone(input.cumulative_usage),
    delta_usage: delta(input.cumulative_usage, prior?.payload.cumulative_usage ?? zero()),
    baseline_kind: kind,
    model_breakdown: input.model_breakdown.map((entry) => ({
      ...structuredClone(entry),
      delta: delta(entry.cumulative, previous.get(usageModelKey(entry)) ?? zero()),
    })),
    record_count: input.record_count,
    as_of: input.as_of,
  });
}

export interface UsageAccountingInput {
  projectId: string;
  artifactIds?: readonly string[];
  events: readonly UsageAccountingEvent[];
  unavailable?: readonly string[];
}
export interface SessionUsageAccounting {
  agent: string;
  session_id: string;
  status: 'exact' | 'incomplete';
  totals: UsageScalars | null;
  observed_high_water: UsageScalars;
  model_breakdown: UsageModelBreakdownEntry[];
  dimensions?: Record<string, number>;
  record_count: number;
  as_of: string;
  reasons: string[];
}
export interface UsageAccountingResult {
  status: 'exact' | 'partial' | 'unavailable';
  totals: UsageScalars | null;
  known_exact_totals: UsageScalars | null;
  sessions: SessionUsageAccounting[];
  reasons: string[];
}
function payloadScope(
  payload: AgentUsageSnapshotPayload,
  ts: string,
  artifactIds: Set<string>,
  links: SourcePlanLinkPayload[]
): boolean {
  return (
    (payload.artifact_id !== null && artifactIds.has(payload.artifact_id)) ||
    links.some(
      (link) =>
        artifactIds.has(link.artifact_id) &&
        link.canonical_ref_id === payload.source_plan_ref_id &&
        ts <= link.linked_at
    )
  );
}
function modelProblems(payload: AgentUsageSnapshotPayload): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const model of payload.model_breakdown) {
    const key = usageModelKey(model);
    if (keys.has(key)) problems.push('duplicate model partition');
    keys.add(key);
  }
  for (const field of USAGE_SCALARS) {
    if (
      !Number.isSafeInteger(payload.cumulative_usage[field]) ||
      payload.model_breakdown.some((entry) => !Number.isSafeInteger(entry.cumulative[field]))
    )
      problems.push('source counter exceeds safe integer precision');
    if (
      payload.model_breakdown.reduce((total, entry) => total + entry.cumulative[field], 0) !==
      payload.cumulative_usage[field]
    )
      problems.push('model partitions do not match session counters');
  }
  return problems;
}
function sessionAccounting(facts: UsageObservation[], reasons: string[]): SessionUsageAccounting {
  const high = facts
    .slice()
    .sort(
      (a, b) =>
        sum(b.payload.cumulative_usage) - sum(a.payload.cumulative_usage) ||
        b.payload.as_of.localeCompare(a.payload.as_of) ||
        b.ts.localeCompare(a.ts) ||
        b.payload.snapshot_id.localeCompare(a.payload.snapshot_id)
    )[0];
  const observed = zero();
  const chronologicalFacts = facts
    .slice()
    .sort((a, b) => a.payload.as_of.localeCompare(b.payload.as_of) || chronological(a, b));
  let prior: AgentUsageSnapshotPayload | undefined;
  for (const fact of chronologicalFacts) {
    const payload = fact.payload;
    reasons.push(...fact.incomplete, ...modelProblems(payload));
    for (const field of USAGE_SCALARS) {
      observed[field] = Math.max(observed[field], payload.cumulative_usage[field]);
      if (prior && payload.cumulative_usage[field] < prior.cumulative_usage[field])
        reasons.push('incompatible cumulative counter reset');
    }
    if (prior) {
      const currentModels = new Map(
        payload.model_breakdown.map((entry) => [usageModelKey(entry), entry.cumulative])
      );
      for (const model of prior.model_breakdown) {
        const current = currentModels.get(usageModelKey(model));
        if (!current || USAGE_SCALARS.some((field) => current[field] < model.cumulative[field]))
          reasons.push('incompatible model partition history');
        for (const [key, count] of Object.entries(model.cumulative.dimensions ?? {}))
          if (current?.dimensions?.[key] === undefined || current.dimensions[key] < count)
            reasons.push('incomplete model dimensions history');
      }
      for (const [key, count] of Object.entries(prior.cumulative_usage.dimensions ?? {}))
        if (
          payload.cumulative_usage.dimensions?.[key] === undefined ||
          payload.cumulative_usage.dimensions[key] < count
        )
          reasons.push('incomplete session dimensions history');
      if (payload.record_count < prior.record_count)
        reasons.push('incompatible source record count reset');
    }
    prior = payload;
  }
  const unique = [...new Set(reasons)].sort();
  return {
    agent: high.payload.agent,
    session_id: high.payload.session_id,
    status: unique.length ? 'incomplete' : 'exact',
    totals: unique.length ? null : observed,
    observed_high_water: observed,
    model_breakdown: structuredClone(high.payload.model_breakdown),
    ...(high.payload.cumulative_usage.dimensions
      ? { dimensions: structuredClone(high.payload.cumulative_usage.dimensions) }
      : {}),
    record_count: Math.max(...facts.map((fact) => fact.payload.record_count)),
    as_of: facts
      .map((fact) => fact.payload.as_of)
      .sort()
      .at(-1)!,
    reasons: unique,
  };
}

export function aggregateCanonicalUsage(
  inputs: readonly UsageAccountingInput[],
  selection: { artifactIds?: readonly string[] } = {}
): UsageAccountingResult {
  const artifactIds = selection.artifactIds === undefined ? null : new Set(selection.artifactIds);
  const selectedSessions = new Set<string>();
  const sessions = new Map<string, UsageObservation[]>();
  const problems = new Map<string, string[]>();
  const globalProblems = inputs.flatMap((input) => [...(input.unavailable ?? [])]);
  const events = new Map<string, { identity: string; session: string }>();
  const snapshots = new Map<string, { identity: string; session: string }>();
  for (const input of inputs) {
    const projectArtifacts =
      input.artifactIds === undefined ? artifactIds : new Set(input.artifactIds);
    const links: SourcePlanLinkPayload[] = [];
    for (const event of input.events) {
      if (event.record.type !== 'source_plan_linked') continue;
      const parsed = SourcePlanLinkPayloadSchema.safeParse(event.payload);
      if (parsed.success) links.push(parsed.data);
      else globalProblems.push('retained source-plan link is incomplete');
    }
    for (const event of input.events) {
      if (event.record.type !== 'agent_usage_snapshot_recorded') continue;
      const parsed = AgentUsageSnapshotPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        globalProblems.push(
          ...event.completeness.reasons,
          'retained usage snapshot fields are incomplete'
        );
        continue;
      }
      const payload = parsed.data;
      const session = usageSessionKey(payload.agent, payload.session_id);
      if (!projectArtifacts || payloadScope(payload, event.record.ts, projectArtifacts, links))
        selectedSessions.add(session);
      const { snapshotIdentity: identity, eventIdentity } = usageAccountingIdentities(event);
      const previousEvent = events.get(event.record.event_id);
      const previousSnapshot = snapshots.get(payload.snapshot_id);
      if (
        (previousEvent !== undefined && previousEvent.identity !== eventIdentity) ||
        (previousSnapshot && previousSnapshot.identity !== identity)
      ) {
        problems.set(session, [
          ...(problems.get(session) ?? []),
          'divergent duplicate source identity',
        ]);
        if (previousSnapshot)
          problems.set(previousSnapshot.session, [
            ...(problems.get(previousSnapshot.session) ?? []),
            'divergent duplicate source identity',
          ]);
        if (previousEvent)
          problems.set(previousEvent.session, [
            ...(problems.get(previousEvent.session) ?? []),
            'divergent duplicate source identity',
          ]);
      }
      events.set(event.record.event_id, { identity: eventIdentity, session });
      if (previousSnapshot?.identity === identity) {
        if (event.completeness.state === 'incomplete')
          problems.set(session, [...(problems.get(session) ?? []), ...event.completeness.reasons]);
        continue;
      }
      snapshots.set(payload.snapshot_id, { identity, session });
      const facts = sessions.get(session) ?? [];
      facts.push({
        payload,
        ts: event.record.ts,
        incomplete: event.completeness.state === 'incomplete' ? event.completeness.reasons : [],
      });
      sessions.set(session, facts);
    }
  }
  const results = [...selectedSessions].sort().flatMap((key) => {
    const facts = sessions.get(key);
    return facts?.length ? [sessionAccounting(facts, problems.get(key) ?? [])] : [];
  });
  const exact = results.filter((session) => session.totals !== null);
  let known = exact.length ? zero() : null;
  if (known)
    for (const session of exact)
      for (const field of USAGE_SCALARS) known[field] += session.totals![field];
  if (known && USAGE_SCALARS.some((field) => !Number.isSafeInteger(known![field]))) {
    globalProblems.push('aggregate exceeds safe integer precision');
    known = null;
  }
  const reasons = [...new Set(globalProblems)].sort();
  const status = !results.length
    ? 'unavailable'
    : reasons.length || exact.length !== results.length
      ? 'partial'
      : 'exact';
  return {
    status,
    totals: status === 'exact' ? known : null,
    known_exact_totals: known,
    sessions: results,
    reasons: !results.length
      ? [...reasons, 'no retained usage facts for the selected scope']
      : reasons,
  };
}

export function estimateArtifactUsage(
  events: readonly UsageAccountingEvent[],
  artifactId: string
): {
  kind: 'estimate';
  totals: UsageScalars | null;
  reasons: string[];
  checkpoints: Array<{
    checkpoint_n: number;
    agent: string;
    session_id: string;
    lifecycle_event: string;
    deltas: UsageScalars;
  }>;
} {
  const links = events
    .filter((event) => event.record.type === 'source_plan_linked')
    .map((event) => SourcePlanLinkPayloadSchema.safeParse(event.payload))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  const facts: UsageObservation[] = [];
  const seen = new Map<string, string>();
  const reasons: string[] = [];
  for (const event of events) {
    if (event.record.type !== 'agent_usage_snapshot_recorded') continue;
    const parsed = AgentUsageSnapshotPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      reasons.push('retained usage fields are incomplete');
      continue;
    }
    if (!payloadScope(parsed.data, event.record.ts, new Set([artifactId]), links)) continue;
    const { snapshotIdentity: identity } = usageAccountingIdentities(event);
    const prior = seen.get(parsed.data.snapshot_id);
    if (prior && prior !== identity) reasons.push('divergent duplicate source identity');
    if (prior) continue;
    seen.set(parsed.data.snapshot_id, identity);
    reasons.push(...event.completeness.reasons);
    facts.push({
      payload: parsed.data,
      ts: event.record.ts,
      incomplete: event.completeness.reasons,
    });
  }
  facts.sort(chronological);
  const groups = new Map<string, { first: AgentUsageSnapshotPayload; high: UsageScalars }>();
  const checkpoints = new Map<
    string,
    {
      checkpoint_n: number;
      agent: string;
      session_id: string;
      lifecycle_event: string;
      deltas: UsageScalars;
    }
  >();
  for (const { payload } of facts) {
    const scope =
      payload.artifact_id === artifactId
        ? `artifact:${artifactId}`
        : `plan:${payload.source_plan_ref_id ?? ''}`;
    const key = JSON.stringify([payload.agent, payload.session_id, scope]);
    const group = groups.get(key) ?? { first: payload, high: scalars(payload.cumulative_usage) };
    for (const field of USAGE_SCALARS)
      group.high[field] = Math.max(group.high[field], payload.cumulative_usage[field]);
    groups.set(key, group);
    if (
      payload.checkpoint_n !== null &&
      payload.baseline_kind === 'checkpoint_open' &&
      payload.delta_usage !== null
    )
      checkpoints.set(JSON.stringify([payload.checkpoint_n, payload.agent, payload.session_id]), {
        checkpoint_n: payload.checkpoint_n,
        agent: payload.agent,
        session_id: payload.session_id,
        lifecycle_event: payload.lifecycle_event,
        deltas: scalars(payload.delta_usage),
      });
  }
  const total = zero();
  for (const group of groups.values()) {
    const floor =
      group.first.baseline_kind === 'whole_session' ? zero() : group.first.cumulative_usage;
    for (const field of USAGE_SCALARS)
      total[field] += Math.max(0, group.high[field] - floor[field]);
  }
  if (USAGE_SCALARS.some((field) => !Number.isSafeInteger(total[field])))
    reasons.push('estimate exceeds safe integer precision');
  return {
    kind: 'estimate',
    totals: facts.length && !reasons.length ? total : null,
    reasons: [...new Set(reasons)],
    checkpoints: [...checkpoints.values()].sort(
      (a, b) =>
        a.checkpoint_n - b.checkpoint_n ||
        a.agent.localeCompare(b.agent) ||
        a.session_id.localeCompare(b.session_id)
    ),
  };
}
