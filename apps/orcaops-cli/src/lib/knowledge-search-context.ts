// What continuing knowledge bears on a search hit, asked of the one shared composer.
//
// A hit is a captured event. The question this asks is the narrow one: which continuing identities
// cite THIS event, at the boundary the search read the project at. Nothing here decides which
// revision is current, whether a correction holds, or what applies — every one of those comes back
// from `projectKnowledgeContext` and core's answer builder, in their own words. Search is a
// consumer of that answer and never a second resolver, which is why this module imports no
// resolution or governing-state reader at all.
//
// The enrichment is bounded in bytes and spent on whole entries in hit order, so an entry either
// arrives complete or is reported as incomplete. A fragment of a rule is worse than none: it reads
// as guidance while leaving out the act that stopped it.
import {
  type KnowledgeContextEntry,
  knowledgeContextEntry,
  type KnowledgeContextLimit,
  type KnowledgeContextUse,
  revisionGoverns,
} from '@orcaops/core';
import type {
  Applicability,
  AuthorityScope,
  Designation,
  KnowledgeTarget,
  StandingEffect,
  StandingReason,
} from '@orcaops/storage';
import {
  type ProjectDatabase,
  projectKnowledgeContext,
  type RevisionGoverningStanding,
} from '@orcaops/storage/history/database';

/**
 * How the wording a hit actually holds stands now, in the four words a reader needs. `background`
 * is the one that is neither a rule nor a stopped wording: a revision recorded as background, or
 * departed from here, or whose adoption was reversed — visible, and adopting nothing.
 */
export type SearchKnowledgeWording =
  | 'stands'
  | 'background'
  | 'superseded'
  | 'withdrawn'
  | 'unknown';

export interface SearchKnowledgeRevision {
  revision_id: string;
  /** Null when this store holds no readable wording for the revision. */
  statement: string | null;
  standing: RevisionGoverningStanding;
  designation: Designation | null;
  /** Three-valued: an input nobody supplied leaves it unresolved, never waived. */
  applicability: Applicability;
  write_sequence: number | null;
  /** Why it stands or stopped standing, in the resolver's own words. */
  effects: StandingReason[];
}

export interface SearchKnowledgeGroup {
  /** `<kind>:<entity id>`, which is how a hit names its group without repeating it. */
  key: string;
  project_id: string;
  target: KnowledgeTarget;
  placement: 'applicable' | 'background';
  /** Why it is placed there: the scope, the selector and the adoption, in one line. */
  reason: string;
  knowledge_boundary: number;
  /** The revision ids that stand at that boundary. Empty where nothing stands any more. */
  governing: string[];
  revisions: SearchKnowledgeRevision[];
  /** The corrections in force over any revision of this identity. */
  corrections: Array<{ action_id: string; effect: StandingEffect }>;
  /** The revisions something later replaced, which is what an obsolete wording belongs to. */
  replaced: string[];
  uses: {
    selected_with_plan: KnowledgeContextUse[];
    connected_later: KnowledgeContextUse[];
  };
  drill_in: {
    sources: Array<{ source_id: string; artifact_id: string | null; event_id: string | null }>;
    criterion: { artifact_id: string; plan_event_id: string; criterion_id: string } | null;
  };
}

/** One identity a hit's event cites, and how the wording in that hit stands. */
export interface SearchKnowledgeRecord {
  group: string;
  /** The revision the hit's wording belongs to; null when no lookup column ties one to it. */
  revision_id: string | null;
  wording: SearchKnowledgeWording;
  standing: RevisionGoverningStanding | null;
}

/** An entry the byte budget could not carry whole. Never a truncated one. */
export interface SearchKnowledgeOmission {
  identity: string;
  reason: string;
}

export interface SearchKnowledgeForHit {
  records: SearchKnowledgeRecord[];
  incomplete: SearchKnowledgeOmission[];
}

export interface SearchKnowledgeResult {
  groups: SearchKnowledgeGroup[];
  /** The write sequence each project's entries were read at. Every answer names its boundary. */
  boundaries: Array<{ project_id: string; knowledge_boundary: number }>;
  /** One entry per hit index that carries knowledge; a hit absent here carries `knowledge: null`. */
  byHit: Map<number, SearchKnowledgeForHit>;
  omitted: SearchKnowledgeOmission[];
  /** What the composed reads did not reach, in bounded retrieval's own words. */
  limits: KnowledgeContextLimit[];
  spentBytes: number;
}

export interface SearchKnowledgeHit {
  readonly project_id: string;
  readonly source_event_id: string | null;
}

export interface SearchKnowledgeProject {
  readonly projectId: string;
  readonly database: ProjectDatabase;
}

export interface SearchKnowledgeRequest {
  readonly hits: readonly SearchKnowledgeHit[];
  readonly projects: readonly SearchKnowledgeProject[];
  /** The bytes the whole enrichment may take, spent on whole entries in hit order. */
  readonly budgetBytes: number;
  /** How many identities one hit's event may reach, so one event cannot fill the page. */
  readonly maxIdentitiesPerEvent: number;
}

/** How many identities one composed read carries when nothing narrower is asked for. */
export const SEARCH_KNOWLEDGE_IDENTITIES_PER_HIT = 8;

/**
 * The bytes one knowledge entry is allowed, before `--limit` multiplies it. Chosen so a page of
 * the default 25 hits can carry a rule, its revisions and its uses each; `--knowledge-bytes`
 * overrides the product for a caller that wants more or less.
 */
export const SEARCH_KNOWLEDGE_BYTES_PER_ENTRY = 2048;

export const searchKnowledgeBudget = (limit: number): number =>
  limit * SEARCH_KNOWLEDGE_BYTES_PER_ENTRY;

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

const SUPERSEDED: ReadonlySet<StandingEffect> = new Set(['replaced', 'superseded_by_relationship']);

/**
 * What each recorded act says about a wording the resolver reports as no longer standing. Total
 * over `StandingEffect`, so an effect added to the contract is a compile error here rather than a
 * silent `unknown` beside a search hit.
 *
 * The three acts that MAKE a revision stand are mapped to null rather than to `stands`: they are in
 * the history of a stopped revision too, and they say nothing about what stopped it. A reversed
 * adoption reads as `background`, not as a withdrawal — nothing ever adopted the revision, so there
 * was no standing to withdraw.
 */
const STOPPED_BY: Record<StandingEffect, SearchKnowledgeWording | null> = {
  adopted: null,
  stands_as_replacement: null,
  restored: null,
  designation_changed: 'background',
  reversed: 'background',
  withdrawn: 'withdrawn',
  corrected: 'withdrawn',
  replaced: 'superseded',
  superseded_by_relationship: 'superseded',
};

/**
 * The effects the resolver recorded for one revision, newest last, as it recorded them. Nothing
 * here recomputes standing: it reads the reasons the resolver already gave.
 */
function effectsOf(entry: KnowledgeContextEntry, revisionId: string): StandingReason[] {
  return entry.resolved.revisions
    .filter((held) => held.revision.revision_id === revisionId)
    .flatMap((held) => [...held.because]);
}

/**
 * How the wording a hit holds stands now.
 *
 * The RESOLVER'S standing decides; the recorded acts only label why a stopped wording stopped. A
 * revision's reasons are kept per scope, so the last reason in the list is the last scope's, not
 * the newest act, and deciding standing from it made a search hit disagree with the block about the
 * same revision. Search reads the answer here and derives none.
 */
export function searchKnowledgeWording(
  revision: SearchKnowledgeRevision | undefined
): SearchKnowledgeWording {
  if (revision === undefined) return 'unknown';
  if (revisionGoverns(revision)) return 'stands';
  // Adopted with a selector that rules this read out, recorded as background, or departed from
  // here: visible, and no rule this work has to meet.
  if (revision.standing !== 'not_standing') return 'background';
  let stopped: SearchKnowledgeWording = 'unknown';
  for (const reason of revision.effects) stopped = STOPPED_BY[reason.effect] ?? stopped;
  return stopped;
}

export function searchKnowledgeGroup(
  entry: KnowledgeContextEntry,
  projectId: string,
  boundary: number
): SearchKnowledgeGroup {
  const revisions = entry.revisions.map((revision) => ({
    revision_id: revision.revision.revision_id,
    statement: revision.statement,
    standing: revision.standing,
    designation: revision.designation,
    applicability: revision.applicability,
    write_sequence: revision.write_sequence,
    effects: effectsOf(entry, revision.revision.revision_id),
  }));
  const corrections = new Map<string, { action_id: string; effect: StandingEffect }>();
  for (const revision of revisions)
    for (const reason of revision.effects)
      if (reason.record === 'correction')
        corrections.set(reason.record_id, { action_id: reason.record_id, effect: reason.effect });
  return {
    key: entry.key,
    project_id: projectId,
    target: entry.target,
    placement: entry.placement,
    reason: entry.reason,
    knowledge_boundary: boundary,
    governing: revisions.filter(revisionGoverns).map((revision) => revision.revision_id),
    revisions,
    corrections: [...corrections.values()],
    replaced: revisions
      .filter((revision) => revision.effects.some((reason) => SUPERSEDED.has(reason.effect)))
      .map((revision) => revision.revision_id),
    uses: {
      selected_with_plan: [...entry.selected_with_plan],
      connected_later: [...entry.connected_later],
    },
    drill_in: {
      sources: entry.references.map((reference) => ({
        source_id: reference.sourceId,
        artifact_id: reference.artifactId,
        event_id: reference.eventId,
      })),
      criterion:
        entry.criterion === null
          ? null
          : {
              artifact_id: entry.criterion.artifactId,
              plan_event_id: entry.criterion.planEventId,
              criterion_id: entry.criterion.criterionId,
            },
    },
  };
}

/** The revision of this identity the hit's own event published, where a column names one. */
function revisionInEvent(entry: KnowledgeContextEntry, eventId: string): string | null {
  for (const reference of entry.references)
    if (reference.eventId === eventId && reference.revisionIds.length > 0)
      return reference.revisionIds[0]!;
  return null;
}

interface ComposedEvent {
  readonly eventId: string;
  readonly entries: readonly KnowledgeContextEntry[];
}

/**
 * The identities each distinct hit event cites, composed once per event inside one read view per
 * project, at the boundary that view's store is committed through. Every answer names that
 * boundary; nothing here defaults one on a store's behalf.
 */
function composeEvents(
  project: SearchKnowledgeProject,
  eventIds: readonly string[],
  maxIdentities: number
): {
  composed: ComposedEvent[];
  boundary: number | null;
  limits: KnowledgeContextLimit[];
} {
  if (eventIds.length === 0) return { composed: [], boundary: null, limits: [] };
  const scope: AuthorityScope = { kind: 'project', project_id: project.projectId };
  // A read hands back materialized JSON, so what it returns is arrays rather than the maps the
  // caller indexes by.
  return project.database.read((view) => {
    const composed: ComposedEvent[] = [];
    const limits: KnowledgeContextLimit[] = [];
    const named = new Set<string>();
    let boundary: number | null = null;
    for (const eventId of eventIds) {
      const context = projectKnowledgeContext(view, {
        projectId: project.projectId,
        scope,
        // `now` is this read asking for the store's committed sequence, which the answer names.
        boundary: 'now',
        mode: 'current',
        subject: { kind: 'captured_event', eventId },
        // Only the identity cap is spent for a captured event: it reaches no source to follow, no
        // search term and no statement bound of its own, and the byte budget below bounds the rest.
        bounds: {
          maxIdentities,
          maxStatementBytes: Number.MAX_SAFE_INTEGER,
          maxSearchTerms: 0,
          maxSearchHits: 0,
          maxSourcesFollowed: 0,
        },
      });
      boundary = context.request.knowledge_boundary;
      composed.push({
        eventId,
        entries: context.entries.map((entry) => knowledgeContextEntry(entry)),
      });
      for (const omission of context.omissions) {
        const key = `${omission.kind}\0${omission.detail}`;
        if (named.has(key)) continue;
        named.add(key);
        limits.push({ kind: omission.kind, detail: omission.detail });
      }
    }
    return { composed, boundary, limits };
  }).value;
}

/**
 * The knowledge that bears on a page of hits, grouped by identity so several hits of one record
 * share one entry and can never crowd out an unrelated result, and bounded so that an entry which
 * does not fit is reported rather than cut down to a misleading fragment.
 */
export function knowledgeForSearchHits(request: SearchKnowledgeRequest): SearchKnowledgeResult {
  const wanted = new Map<string, string[]>();
  for (const hit of request.hits) {
    if (hit.source_event_id === null) continue;
    const held = wanted.get(hit.project_id);
    if (held === undefined) wanted.set(hit.project_id, [hit.source_event_id]);
    else if (!held.includes(hit.source_event_id)) held.push(hit.source_event_id);
  }
  const composed = new Map<string, Map<string, ComposedEvent>>();
  const boundaries = new Map<string, number>();
  const limits = new Map<string, KnowledgeContextLimit>();
  for (const project of request.projects) {
    const eventIds = wanted.get(project.projectId) ?? [];
    const answered = composeEvents(project, eventIds, request.maxIdentitiesPerEvent);
    composed.set(
      project.projectId,
      new Map(answered.composed.map((event) => [event.eventId, event]))
    );
    if (answered.boundary !== null) boundaries.set(project.projectId, answered.boundary);
    for (const limit of answered.limits) limits.set(`${limit.kind}\0${limit.detail}`, limit);
  }

  const groups: SearchKnowledgeGroup[] = [];
  const included = new Map<string, SearchKnowledgeGroup>();
  const omitted = new Map<string, SearchKnowledgeOmission>();
  const byHit = new Map<number, SearchKnowledgeForHit>();
  let spentBytes = 0;

  request.hits.forEach((hit, index) => {
    const event = hit.source_event_id;
    if (event === null) return;
    const entries = composed.get(hit.project_id)?.get(event)?.entries ?? [];
    const boundary = boundaries.get(hit.project_id);
    if (entries.length === 0 || boundary === undefined) return;
    const carried: SearchKnowledgeForHit = { records: [], incomplete: [] };
    for (const entry of entries) {
      const key = `${hit.project_id}\0${entry.key}`;
      let group = included.get(key);
      if (group === undefined && !omitted.has(key)) {
        const candidate = searchKnowledgeGroup(entry, hit.project_id, boundary);
        const bytes = byteLength(candidate);
        if (spentBytes + bytes <= request.budgetBytes) {
          spentBytes += bytes;
          included.set(key, candidate);
          groups.push(candidate);
          group = candidate;
        } else
          omitted.set(key, {
            identity: entry.key,
            reason:
              `This record's standing needs ${bytes} more bytes than the ` +
              `${request.budgetBytes} this page gives knowledge. It is left out whole rather ` +
              `than cut down, because part of a rule reads as guidance while leaving out what ` +
              `stopped it. Raise --knowledge-bytes, or narrow --limit, to see it.`,
          });
      }
      const dropped = omitted.get(key);
      if (dropped !== undefined) {
        carried.incomplete.push(dropped);
        continue;
      }
      const revisionId = revisionInEvent(entry, event);
      const revision = group?.revisions.find((held) => held.revision_id === revisionId);
      carried.records.push({
        group: entry.key,
        revision_id: revisionId,
        wording: searchKnowledgeWording(revision),
        standing: revision?.standing ?? null,
      });
    }
    if (carried.records.length > 0 || carried.incomplete.length > 0) byHit.set(index, carried);
  });

  return {
    groups,
    boundaries: [...boundaries].map(([project_id, knowledge_boundary]) => ({
      project_id,
      knowledge_boundary,
    })),
    byHit,
    omitted: [...omitted.values()],
    limits: [...limits.values()],
    spentBytes,
  };
}
