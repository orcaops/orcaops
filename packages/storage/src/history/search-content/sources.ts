import type { ArtifactThread } from '../../events/artifact-thread.js';
import type { EventWithPayload } from '../../events/rebuilders.js';
import {
  type ArtifactSourceTimeMember,
  ArtifactSourceTimeMemberSchema,
  resolveSourceEvidenceTime,
} from '../source-time.js';
import {
  derivedDigestFields,
  SEARCH_SOURCE_FIELD_MAP,
  type SearchFields,
  searchFieldsForEvent,
  type SearchSourceKind,
} from './fields.js';
import type { SearchOrigin } from './matching.js';

export interface SearchSource extends SearchFields {
  project_id: string;
  artifact_id: string;
  source_id: string;
  source_event_id: string | null;
  content_event_id: string | null;
  source_kind: SearchSourceKind;
  source_locator: string;
  source_ownership: 'authored_event' | 'derived_retained_content';
  decision_provenance: Array<{
    field_path: string;
    revision_n: number | null;
    source_event_id: string | null;
    evidence_commit_oid: string | null;
  }>;
  origin: SearchOrigin;
  evidence_time: string | null;
  evidence_time_basis: 'captured_event' | 'commit' | 'commit_set_latest' | 'unknown';
  evidence_time_unknown_reason?: string;
  recorded_at: string | null;
  imported_at: string | null;
  enriched_at: string | null;
  branch_membership: string[];
  touched_files: string[];
  artifact_commit_generation: number;
}

export interface ArtifactSearchSourceInput {
  projectId: string;
  thread: ArtifactThread;
  artifactGeneration: number;
  /** Only facts retained under this artifact's verified generation may be supplied. */
  sourceTimeEvidence?: ReadonlyMap<string, unknown>;
  /** The owner supplies this validated member from the same retained artifact revision. */
  sourceTimeMember?: ArtifactSourceTimeMember | null;
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function capturedTime(ts: string | undefined): string | null {
  if (ts === undefined) return null;
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Reconstruction supplies enrichment semantics; source identity stays with the original authored row.
function effectivePayload(
  thread: ArtifactThread,
  event: EventWithPayload,
  latestPlan: EventWithPayload | undefined,
  latestSummary: EventWithPayload | undefined
): { payload: unknown; contentEventId: string } {
  const own = { payload: event.payload, contentEventId: event.record.event_id };
  if (event === latestPlan && thread.plan !== null)
    return { payload: thread.plan, contentEventId: thread.plan.source_event_id };
  if (event === latestSummary && thread.summary !== null)
    return { payload: thread.summary, contentEventId: thread.summary.source_event_id };
  if (event.record.type === 'checkpoint_closed') {
    const checkpoint = thread.checkpoints.find(
      (value) => value.n === payloadObject(event.payload).n
    );
    if (checkpoint?.status === 'closed')
      return {
        payload: { ...payloadObject(event.payload), summary: checkpoint.summary },
        contentEventId: checkpoint.source_event_id,
      };
  }
  return own;
}

export function projectArtifactSearchSources(input: ArtifactSearchSourceInput): SearchSource[] {
  const { thread } = input;
  if (thread.plan === null || thread.artifactJson === null)
    throw new Error('Search source requires a complete verified artifact thread');
  const origin = thread.plan.origin;
  const imported = origin?.kind === 'git-import';
  const suppliedMember = input.sourceTimeMember !== null && input.sourceTimeMember !== undefined;
  const parsedMember = ArtifactSourceTimeMemberSchema.safeParse(input.sourceTimeMember);
  const member =
    parsedMember.success && parsedMember.data.artifact_id === thread.artifactId
      ? parsedMember.data
      : null;
  const sourceTimeEvidence = suppliedMember
    ? new Map(member?.sources.map((source) => [source.source_id, source]))
    : input.sourceTimeEvidence;
  const memberCommits = suppliedMember ? member?.member_commits : origin?.member_shas;
  const events = new Map(thread.events.map((event) => [event.record.event_id, event]));
  const latestPlan = thread.events
    .filter(
      (event) => event.record.type === 'plan_captured' || event.record.type === 'plan_revised'
    )
    .at(-1);
  const latestSummary = thread.events
    .filter((event) => event.record.type === 'summary_captured')
    .at(-1);
  const branchMembership = [
    ...new Set(thread.artifactJson.branch_lineage.map((entry) => entry.branch)),
  ].sort();
  const touchedFiles = [
    ...new Set([
      ...thread.checkpoints.flatMap((checkpoint) =>
        checkpoint.status === 'closed' ? checkpoint.files_changed : []
      ),
    ]),
  ].sort();
  const rows: SearchSource[] = [];

  const create = (options: {
    event: EventWithPayload | null;
    sourceId: string;
    contentEventId: string | null;
    kind: SearchSourceKind;
    locator: string;
    fields: SearchFields;
  }): SearchSource => {
    const { event, sourceId, contentEventId } = options;
    const contentEvent = contentEventId === null ? undefined : events.get(contentEventId);
    const recordedAt = capturedTime(contentEvent?.record.ts);
    const importedTime = resolveSourceEvidenceTime({
      artifactId: thread.artifactId,
      sourceId,
      evidence: sourceTimeEvidence?.get(sourceId),
      ...(['plan', 'summary', 'digest'].includes(options.kind) && memberCommits !== undefined
        ? { attributedCommits: memberCommits }
        : {}),
    });
    const derived = event === null;
    const time = imported ? importedTime.evidence_time : derived ? null : recordedAt;
    const basis = imported
      ? importedTime.evidence_time_basis
      : derived || time === null
        ? 'unknown'
        : 'captured_event';
    const missingMemberSet =
      imported &&
      ['plan', 'summary', 'digest'].includes(options.kind) &&
      memberCommits === undefined;
    return {
      ...options.fields,
      project_id: input.projectId,
      artifact_id: thread.artifactId,
      source_id: sourceId,
      source_event_id: event?.record.event_id ?? null,
      content_event_id: contentEventId,
      source_kind: options.kind,
      source_locator: options.locator,
      source_ownership: derived ? 'derived_retained_content' : 'authored_event',
      decision_provenance: [],
      origin: imported ? 'imported' : 'captured',
      evidence_time: missingMemberSet ? null : time,
      evidence_time_basis: missingMemberSet
        ? 'unknown'
        : imported && time !== null && ['plan', 'summary', 'digest'].includes(options.kind)
          ? 'commit_set_latest'
          : basis,
      ...(missingMemberSet
        ? {
            evidence_time_unknown_reason: suppliedMember
              ? 'invalid_member_set'
              : 'missing_member_set',
          }
        : basis === 'unknown'
          ? {
              evidence_time_unknown_reason:
                importedTime.evidence_time_basis === 'unknown' && imported
                  ? importedTime.reason
                  : derived
                    ? 'derived_without_recording_event'
                    : 'invalid_recording_time',
            }
          : {}),
      recorded_at: derived ? null : recordedAt,
      imported_at: origin?.imported_at ?? null,
      enriched_at:
        contentEvent?.record.type === 'git_import_enriched'
          ? String(payloadObject(contentEvent.payload).enriched_at)
          : null,
      branch_membership: [...branchMembership],
      touched_files: [...touchedFiles],
      artifact_commit_generation: input.artifactGeneration,
    };
  };

  for (const event of thread.events) {
    const map = SEARCH_SOURCE_FIELD_MAP[event.record.type];
    if (map.kind === null) continue;
    const effective = effectivePayload(thread, event, latestPlan, latestSummary);
    const payload = payloadObject(effective.payload);
    const suffix =
      map.kind === 'plan'
        ? `:${String(payload.revision_n)}`
        : map.kind === 'checkpoint'
          ? `:${String(payload.n)}`
          : '';
    const row = create({
      event,
      sourceId: event.record.event_id,
      contentEventId: effective.contentEventId,
      kind: map.kind,
      locator: `${event.record.type}${suffix}`,
      fields: searchFieldsForEvent(event.record.type, payload),
    });
    if (Array.isArray(payload.decisions)) {
      row.decision_provenance = payload.decisions.map((value: unknown, index) => {
        const decision = payloadObject(value);
        const revision = typeof decision.revision_n === 'number' ? decision.revision_n : null;
        const originalEvent =
          revision === null
            ? event
            : thread.events.find(
                (candidate) =>
                  (candidate.record.type === 'plan_captured' ||
                    candidate.record.type === 'plan_revised') &&
                  payloadObject(candidate.payload).revision_n === revision
              );
        const commit = payloadObject(decision.evidence).commit_sha;
        return {
          field_path: `decisions.${index}`,
          revision_n: revision,
          source_event_id: originalEvent?.record.event_id ?? null,
          evidence_commit_oid: typeof commit === 'string' ? commit : null,
        };
      });
    }
    rows.push(row);
    if (event.record.type === 'checkpoint_opened') {
      const audit = payloadObject(payload.gate_audit);
      for (const [key, type] of [
        ['runs', 'evaluator_run_recorded'],
        ['dispositions', 'evaluator_disposition_recorded'],
      ] as const) {
        const entries = audit[key];
        if (!Array.isArray(entries)) continue;
        for (const [index, value] of entries.entries()) {
          const id = `${event.record.event_id}:${key}:${index}`;
          rows.push(
            create({
              event,
              sourceId: id,
              contentEventId: event.record.event_id,
              kind: key === 'runs' ? 'evaluator' : 'block-resolution',
              locator: `gate_audit.${key}.${index}`,
              fields: searchFieldsForEvent(type, value),
            })
          );
        }
      }
    }
  }
  const digestSources = rows.filter(
    (row) =>
      (row.source_kind !== 'plan' || row.source_event_id === latestPlan?.record.event_id) &&
      (row.source_kind !== 'summary' || row.source_event_id === latestSummary?.record.event_id)
  );
  rows.push(
    create({
      event: null,
      sourceId: 'digest',
      contentEventId: null,
      kind: 'digest',
      locator: 'derived:retained-source-fields:v1',
      fields: derivedDigestFields(
        digestSources.map((row) => ({ sourceId: row.source_id, fields: row }))
      ),
    })
  );
  return rows;
}
