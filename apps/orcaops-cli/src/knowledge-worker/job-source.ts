import {
  type Actor,
  type ArtifactThread,
  type EventType,
  type EventWithPayload,
  type InterpretationMappingRun,
  prepareInterpretationText,
  PROCESSING_ELIGIBLE_EVENT_TYPES,
} from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import type { ProjectDatabase } from '@orcaops/storage/history/database';
import { searchFieldsForEvent } from '@orcaops/storage/history/search-content';

/** The eligible authored fields and task origin retained by one processing job. */

export const FIELD_INVENTORY_VERSION = 'capture-authored-fields@1';

function isEligibleType(type: EventType): type is (typeof PROCESSING_ELIGIBLE_EVENT_TYPES)[number] {
  return (PROCESSING_ELIGIBLE_EVENT_TYPES as readonly EventType[]).includes(type);
}

export interface JobSourceField {
  fieldPath: string;
  position: number;
  role:
    | 'task'
    | 'step'
    | 'criterion'
    | 'decision'
    | 'reason'
    | 'rejected_alternative'
    | 'rejection_reason'
    | 'non_goal'
    | 'non_goal_reason'
    | 'checkpoint'
    | 'observation'
    | 'uncertainty'
    | 'outcome'
    | 'open_item'
    | 'deferred_decision';
  purpose: 'primary' | 'context';
  originalText: string;
  preparedText: string;
  originalSha256: string;
  preparedSha256: string;
  mappingVersion: string;
  mappingSha256: string;
  mapping: readonly InterpretationMappingRun[];
}

export interface JobSourceOmission {
  fieldPath: string;
  reason: string;
}

export interface RetainedJobSource {
  artifactId: string;
  eventId: string;
  eventType: EventType;
  /**
   * When the capture this source is a field of was recorded. Every time a published record keeps
   * is this one, so a source read again derives the same bytes as well as the same identity.
   */
  recordedAt: string;
  /** `git-import` origin is refused at dispatch, as it is at admission. */
  originKind: 'captured' | 'git-import';
  fields: readonly JobSourceField[];
  omissions: readonly JobSourceOmission[];
  sourceAuthor: Actor;
  recordedBy: Actor;
  /** The immutable plan event this source was captured against, when one can be established. */
  planEventId: string | null;
  /** Why this source has no immutable plan anchor, when one could not be retained or derived. */
  planAnchorLimit?: string | null;
  /** The write sequence the artifact was read at. */
  knowledgeBoundary: number;
}

export type JobSourceRead =
  | { ok: true; source: RetainedJobSource }
  | {
      ok: false;
      reason: 'artifact_missing' | 'event_missing' | 'event_not_eligible';
      detail: string;
    };

const UNKNOWN_ACTOR: Actor = { identity: null, basis: 'unknown' };

function actorFrom(payload: unknown, ...keys: readonly string[]): Actor {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return UNKNOWN_ACTOR;
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { identity: value, basis: 'source_attributed' };
    }
  }
  return UNKNOWN_ACTOR;
}

interface FieldClassification {
  role: JobSourceField['role'];
  purpose: JobSourceField['purpose'];
}

function classifyField(type: EventType, path: string): FieldClassification | null {
  if (type === 'plan_captured' || type === 'plan_revised') {
    if (path === 'task') return { role: 'task', purpose: 'primary' };
    if (path === 'label') return { role: 'task', purpose: 'context' };
    if (/^plan_steps\.\d+\.label$/u.test(path)) return { role: 'step', purpose: 'context' };
    if (/^plan_steps\.\d+\.text$/u.test(path)) return { role: 'step', purpose: 'primary' };
    if (/^plan_steps\.\d+\.acceptance_criteria\.\d+\.text$/u.test(path))
      return { role: 'criterion', purpose: 'primary' };
    if (/^decisions\.\d+\.decision$/u.test(path)) return { role: 'decision', purpose: 'primary' };
    if (/^decisions\.\d+\.reason$/u.test(path)) return { role: 'reason', purpose: 'primary' };
    if (/^decisions\.\d+\.alternatives_considered\.\d+\.option$/u.test(path))
      return { role: 'rejected_alternative', purpose: 'primary' };
    if (/^decisions\.\d+\.alternatives_considered\.\d+\.rejected_because$/u.test(path))
      return { role: 'rejection_reason', purpose: 'primary' };
    if (/^non_goals\.\d+\.text$/u.test(path)) return { role: 'non_goal', purpose: 'primary' };
    if (/^non_goals\.\d+\.rationale$/u.test(path))
      return { role: 'non_goal_reason', purpose: 'primary' };
    if (path === 'rationale') return { role: 'reason', purpose: 'context' };
    return null;
  }
  if (type === 'checkpoint_closed') {
    if (path === 'summary') return { role: 'checkpoint', purpose: 'primary' };
    if (/^decisions\.\d+\.decision$/u.test(path)) return { role: 'decision', purpose: 'primary' };
    if (/^decisions\.\d+\.reason$/u.test(path)) return { role: 'reason', purpose: 'primary' };
    if (/^decisions\.\d+\.alternatives_considered\.\d+\.option$/u.test(path))
      return { role: 'rejected_alternative', purpose: 'primary' };
    if (/^decisions\.\d+\.alternatives_considered\.\d+\.rejected_because$/u.test(path))
      return { role: 'rejection_reason', purpose: 'primary' };
    if (/^uncertainty\.\d+$/u.test(path)) return { role: 'uncertainty', purpose: 'primary' };
    if (/^done_criteria\.\d+\.evidence$/u.test(path))
      return { role: 'criterion', purpose: 'primary' };
    if (/^verification\.\d+\.(?:output_digest|note)$/u.test(path))
      return { role: 'observation', purpose: 'primary' };
    return null;
  }
  if (type === 'checkpoint_abandoned' && path === 'reason')
    return { role: 'checkpoint', purpose: 'primary' };
  if (type === 'summary_captured') {
    if (path === 'outcome') return { role: 'outcome', purpose: 'primary' };
    if (/^(?:tests_written|tests_run)\.\d+$/u.test(path))
      return { role: 'observation', purpose: 'primary' };
    if (/^open_items\.\d+$/u.test(path)) return { role: 'open_item', purpose: 'primary' };
    if (/^deferred_decisions\.\d+$/u.test(path))
      return { role: 'deferred_decision', purpose: 'primary' };
    if (/^accepted_warnings\.\d+\.reason$/u.test(path))
      return { role: 'reason', purpose: 'primary' };
  }
  return null;
}

export function prepareSourceField(originalText: string): {
  preparedText: string;
  mapping: InterpretationMappingRun[];
} {
  const prepared = prepareInterpretationText(originalText);
  return { preparedText: prepared.prepared, mapping: [...prepared.mapping] };
}

export function authoredFieldInventory(event: EventWithPayload): {
  fields: JobSourceField[];
  omissions: JobSourceOmission[];
} {
  const type = event.record.type;
  if (!isEligibleType(type)) return { fields: [], omissions: [] };
  const fields = searchFieldsForEvent(type, event.payload);
  const inventory: JobSourceField[] = [];
  const omissions: JobSourceOmission[] = [];
  for (const field of [...fields.intent, ...fields.body]) {
    const classification = classifyField(type, field.path);
    if (classification === null) continue;
    const originalText = originalFieldText(event.payload, field.path);
    if (originalText === null) continue;
    if (originalText.trim().length === 0) {
      omissions.push({ fieldPath: field.path, reason: 'The authored field is empty.' });
      continue;
    }
    const prepared = prepareInterpretationText(originalText);
    if (prepared.prepared.trim().length === 0) {
      omissions.push({
        fieldPath: field.path,
        reason: 'The authored field has no text after safe preparation.',
      });
      continue;
    }
    inventory.push({
      fieldPath: field.path,
      position: 0,
      ...classification,
      originalText,
      preparedText: prepared.prepared,
      originalSha256: prepared.originalSha256,
      preparedSha256: prepared.preparedSha256,
      mappingVersion: prepared.mappingVersion,
      mappingSha256: prepared.mappingSha256,
      mapping: prepared.mapping,
    });
  }
  return { fields: inventory, omissions };
}

function originalFieldText(payload: unknown, fieldPath: string): string | null {
  let value = payload;
  for (const part of fieldPath.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = Array.isArray(value) ? value[Number(part)] : (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : null;
}

function retainedString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function sourcePlanAnchor(
  thread: Pick<ArtifactThread, 'events' | 'checkpoints'>,
  source: EventWithPayload
): { planEventId: string | null; planAnchorLimit: string | null } {
  const sourceIndex = thread.events.findIndex(
    (candidate) => candidate.record.event_id === source.record.event_id
  );
  if (sourceIndex < 0)
    return {
      planEventId: null,
      planAnchorLimit: 'The retained source event is absent from its artifact event sequence.',
    };
  if (source.record.type === 'plan_captured' || source.record.type === 'plan_revised')
    return { planEventId: source.record.event_id, planAnchorLimit: null };
  if (source.record.type === 'checkpoint_closed' || source.record.type === 'checkpoint_abandoned') {
    const checkpoint =
      source.record.type === 'checkpoint_closed'
        ? thread.checkpoints.find(
            (candidate) =>
              candidate.status === 'closed' &&
              candidate.source_event_ids.closed === source.record.event_id
          )
        : thread.checkpoints.find(
            (candidate) =>
              candidate.status === 'abandoned' &&
              candidate.source_event_ids.abandoned === source.record.event_id
          );
    const planEventId =
      checkpoint === undefined ? null : retainedString(checkpoint, 'open_plan_revision_event_id');
    const openEventId =
      checkpoint === undefined || checkpoint.status === 'open'
        ? null
        : retainedString(checkpoint.source_event_ids, 'opened');
    const openIndex =
      openEventId === null
        ? -1
        : thread.events.findIndex(
            (candidate) =>
              candidate.record.event_id === openEventId &&
              candidate.record.type === 'checkpoint_opened'
          );
    const planIndex =
      planEventId === null
        ? -1
        : thread.events.findIndex(
            (candidate) =>
              candidate.record.event_id === planEventId &&
              (candidate.record.type === 'plan_captured' ||
                candidate.record.type === 'plan_revised')
          );
    return {
      planEventId:
        planIndex >= 0 && planIndex < openIndex && openIndex < sourceIndex ? planEventId : null,
      planAnchorLimit:
        planIndex < 0 || planIndex >= openIndex || openIndex < 0 || openIndex >= sourceIndex
          ? 'The checkpoint source retains no prior open plan revision, so its task context is unknown.'
          : null,
    };
  }
  const planEventId = thread.events
    .slice(0, sourceIndex)
    .filter(
      (candidate) =>
        candidate.record.type === 'plan_captured' || candidate.record.type === 'plan_revised'
    )
    .at(-1)?.record.event_id;
  return {
    planEventId: planEventId ?? null,
    planAnchorLimit:
      planEventId === undefined
        ? 'No plan was visible before this summary source, so its task context is unknown.'
        : null,
  };
}

/**
 * Read the source event out of the artifact that holds it. The whole thread is
 * reconstructed and its retained bytes verified on the way, which is what makes
 * this a read of the retained capture rather than of a projection of it.
 */
export function readRetainedJobSource(
  handle: ProjectDatabase,
  target: { artifactId: string; eventId: string }
): JobSourceRead {
  const snapshot = readProjectArtifact(handle, target.artifactId);
  if (snapshot === null) {
    return {
      ok: false,
      reason: 'artifact_missing',
      detail: `Artifact ${target.artifactId} holds no retained publication in this project.`,
    };
  }
  const event = snapshot.thread.events.find(
    (candidate) => candidate.record.event_id === target.eventId
  );
  if (event === undefined) {
    return {
      ok: false,
      reason: 'event_missing',
      detail: `Event ${target.eventId} is not retained in artifact ${target.artifactId}.`,
    };
  }
  if (!isEligibleType(event.record.type)) {
    return {
      ok: false,
      reason: 'event_not_eligible',
      detail: `A ${event.record.type} event is not one of the source kinds processing admits.`,
    };
  }
  const plan = sourcePlanAnchor(snapshot.thread, event);
  const inventory = authoredFieldInventory(event);
  return {
    ok: true,
    source: {
      artifactId: target.artifactId,
      eventId: target.eventId,
      eventType: event.record.type,
      recordedAt: event.record.ts,
      // Only an imported artifact carries an origin at all; its absence is what
      // `captured` means, which is how every other reader of this store reads it.
      originKind: snapshot.thread.plan?.origin?.kind ?? 'captured',
      fields: inventory.fields,
      omissions: inventory.omissions,
      sourceAuthor: actorFrom(event.payload, 'agent', 'closed_by_agent'),
      recordedBy: actorFrom(event.payload, 'closed_by_agent', 'agent'),
      ...plan,
      knowledgeBoundary: snapshot.counters.writeSequence,
    },
  };
}
