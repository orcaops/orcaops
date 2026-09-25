import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type KnowledgeContextSubject,
  type ProjectKnowledgeContext,
  projectKnowledgeContext,
} from './knowledge-context.js';
import {
  type KnowledgeBoundary,
  knowledgeBoundaryAt,
  knowledgeReadCoverage,
} from './knowledge-read-boundary.js';
import { readProjectKnowledgeInterpretations } from './knowledge-read-interpretations.js';
import {
  type RationaleAccount,
  rationaleAccounts,
  rationaleAccountText,
  rationaleTerms,
} from './rationale-accounts.js';
import { readableRationaleCorrection } from './rationale-correction.js';
import { discoverRationaleAccounts } from './rationale-index.js';
import {
  rationaleSourcePath,
  rationaleTargetMatch,
  rationaleTargetRank,
} from './rationale-relevance.js';
import { rationaleSelector } from './rationale-selector.js';
import type { EventType } from '../../events/event-log.js';
import type { KnowledgeInterpretation } from '../../schema/knowledge-contract.js';

export const RATIONALE_READ_BOUNDS = {
  artifacts: 16,
  events: 32,
  interpretationsPerEvent: 16,
  interpretationBytesPerEvent: 131_072,
  eventBytes: 262_144,
  sourceBytes: 4_194_304,
} as const;

export interface RationaleCandidate {
  artifactId: string;
  eventId: string;
  planEventId?: string | null;
}
export interface RationaleDiscovery {
  origin: 'candidate_event' | 'candidate_plan' | 'lexical_overlap';
  event_id: string;
  via: 'source_reference';
}
export interface RationaleItem {
  id: string;
  form: 'recorded_capture' | 'unapproved_interpretation';
  account: RationaleAccount;
  source_account?: RationaleAccount & { reference: string };
  source: { artifact_id: string; event_id: string; field_path: string | null };
  relevance: 'candidate_event' | 'candidate_plan' | 'lexical_overlap';
  temporal: 'historical_body' | 'later_annotation';
  matched_terms?: string[];
  reference: string;
  interpretation?: KnowledgeInterpretation;
  knowledge_keys?: string[];
  target_match?: ReturnType<typeof rationaleTargetMatch>;
}

export interface RationaleEvent {
  event_id: string;
  artifact_id: string;
  event_type: EventType;
  bytes: number;
  sequence: number;
}
const EVENT_METADATA = `SELECT e.event_id, e.artifact_id, e.event_type,
  length(e.record_bytes)+coalesce(length(e.sidecar_payload_bytes),0) AS bytes,
  o.committed_write_sequence AS sequence FROM artifact_events e
  JOIN artifact_revisions r ON r.artifact_id=e.artifact_id AND r.generation=(
    SELECT generation FROM artifact_revisions WHERE artifact_id=e.artifact_id AND event_count>=e.ordinal ORDER BY generation LIMIT 1)
  JOIN operations o ON o.operation_id=r.operation_id`;

export function rationaleEvent(view: ProjectReadView, id: string): RationaleEvent | null {
  return view.get<RationaleEvent>(`${EVENT_METADATA} WHERE e.event_id=?`, id);
}

export function readRationaleEvent(
  view: ProjectReadView,
  row: RationaleEvent,
  maxBytes: number = RATIONALE_READ_BOUNDS.eventBytes
): { accounts: RationaleAccount[]; unavailable: string | null } {
  if (row.bytes > maxBytes) return { accounts: [], unavailable: 'source_bytes' };
  if (
    view.get(
      'SELECT source_id FROM knowledge_sources WHERE event_id=? AND access_restriction IS NOT NULL LIMIT 1',
      row.event_id
    )
  )
    return { accounts: [], unavailable: 'restricted_source' };
  const data = view.get<{ record: string; sidecar: string | null }>(
    'SELECT CAST(record_bytes AS TEXT) AS record, CAST(sidecar_payload_bytes AS TEXT) AS sidecar FROM artifact_events WHERE event_id=?',
    row.event_id
  );
  if (!data) return { accounts: [], unavailable: 'missing_source' };
  try {
    const record = JSON.parse(data.record);
    const payload = data.sidecar === null ? record.payload : JSON.parse(data.sidecar);
    return { accounts: rationaleAccounts(row.event_type, payload), unavailable: null };
  } catch {
    return { accounts: [], unavailable: 'unreadable_source' };
  }
}

export function rationaleKnowledgeContext(
  view: ProjectReadView,
  projectId: string,
  boundary: KnowledgeBoundary,
  subject: KnowledgeContextSubject,
  artifactId?: string
): ProjectKnowledgeContext {
  return projectKnowledgeContext(view, {
    projectId,
    boundary,
    subject,
    scope: artifactId
      ? { kind: 'artifact', artifact_id: artifactId }
      : { kind: 'project', project_id: projectId },
    mode: boundary === 'now' ? 'current' : 'historical',
    interpretations: false,
    maxResolvedIdentities: 64,
    bounds: {
      maxIdentities: 64,
      maxStatementBytes: 262_144,
      maxSearchTerms: 0,
      maxSearchHits: 0,
      maxSourcesFollowed: 64,
    },
  });
}

export function readProjectRationale(
  database: ProjectDatabase,
  input: {
    candidates: readonly RationaleCandidate[];
    boundary: KnowledgeBoundary;
    observation: number;
    authorityArtifactId?: string;
    target?: { file: string };
  }
) {
  return database.read((view) => {
    const observation = knowledgeBoundaryAt(view);
    if (input.observation !== observation)
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'History changed during rationale selection; repeat the query'
      );
    const grouped = new Map<string, RationaleCandidate[]>();
    for (const candidate of input.candidates) {
      const group = grouped.get(candidate.artifactId) ?? [];
      if (!group.some((held) => held.eventId === candidate.eventId)) group.push(candidate);
      grouped.set(candidate.artifactId, group);
    }
    const artifacts = [...grouped.keys()].slice(0, RATIONALE_READ_BOUNDS.artifacts);
    const obligations = rationaleKnowledgeContext(
      view,
      database.authority.projectId,
      input.boundary,
      { kind: 'task', artifactIds: artifacts },
      input.authorityArtifactId
    );
    const boundary = obligations.request.knowledge_boundary;
    const contexts = [obligations];
    const discoveries = new Map<string, RationaleDiscovery[]>();
    const exact: Array<{ id: string; relevance: 'candidate_event' | 'candidate_plan' }> = [];
    const add = (
      id: string | null | undefined,
      relevance: 'candidate_event' | 'candidate_plan'
    ) => {
      if (id && !exact.some((event) => event.id === id)) exact.push({ id, relevance });
    };
    for (let position = 0; position < RATIONALE_READ_BOUNDS.events; position++)
      for (const id of artifacts) add(grouped.get(id)![position]?.eventId, 'candidate_event');
    for (const id of artifacts)
      for (const candidate of grouped.get(id)!) add(candidate.planEventId, 'candidate_plan');
    const chosen = exact.slice(0, RATIONALE_READ_BOUNDS.events);
    const candidateEventCount = new Set(
      artifacts.flatMap((id) =>
        grouped
          .get(id)!
          .flatMap((candidate) =>
            [candidate.eventId, candidate.planEventId].filter((event): event is string => !!event)
          )
      )
    ).size;
    const limits: Array<{ kind: string; detail: string }> = [];
    const items: RationaleItem[] = [];
    let sourceBytes = 0;
    let unavailableEvents = 0;
    const resolvedEvents = new Set<string>();
    const resolveEvent = (
      row: RationaleEvent,
      accounts: RationaleAccount[],
      origin: RationaleItem['relevance']
    ) => {
      if (row.sequence > boundary || resolvedEvents.has(row.event_id)) return;
      resolvedEvents.add(row.event_id);
      const context = rationaleKnowledgeContext(
        view,
        database.authority.projectId,
        input.boundary,
        {
          kind: 'captured_event',
          eventId: row.event_id,
          preferredFieldPaths: accounts
            .filter(
              (account) =>
                rationaleTargetRank(
                  rationaleTargetMatch(rationaleAccountText(account), input.target?.file)
                ) < 2
            )
            .slice(0, 128)
            .map((account) => account.path),
        },
        input.authorityArtifactId
      );
      contexts.push(context);
      for (const entry of context.entries) {
        const key = `${entry.target.kind}:${entry.target.entity_id}`;
        const paths = discoveries.get(key) ?? [];
        paths.push({ origin, event_id: row.event_id, via: 'source_reference' });
        discoveries.set(key, paths);
      }
    };
    const eventCache = new Map<string, { row: RationaleEvent; accounts: RationaleAccount[] }>();
    const load = (id: string) => {
      const cached = eventCache.get(id);
      if (cached) return cached;
      const row = rationaleEvent(view, id);
      if (!row || row.sequence > observation) return null;
      if (sourceBytes + row.bytes > RATIONALE_READ_BOUNDS.sourceBytes) {
        unavailableEvents++;
        limits.push({ kind: 'source_bytes', detail: 'The total source allowance was exhausted.' });
        return null;
      }
      const read = readRationaleEvent(view, row);
      if (read.unavailable) {
        unavailableEvents++;
        limits.push({
          kind: read.unavailable,
          detail: 'A candidate source could not be read within access and size limits.',
        });
        return null;
      }
      sourceBytes += row.bytes;
      const value = { row, accounts: read.accounts };
      value.accounts.sort(
        (a, b) =>
          rationaleTargetRank(rationaleTargetMatch(rationaleAccountText(a), input.target?.file)) -
          rationaleTargetRank(rationaleTargetMatch(rationaleAccountText(b), input.target?.file))
      );
      eventCache.set(id, value);
      return value;
    };
    const reference = (event: string, account: RationaleAccount) =>
      rationaleSelector({
        kind: 'capture',
        id: event,
        path: account.path,
      });
    const addAccount = (
      row: RationaleEvent,
      account: RationaleAccount,
      relevance: RationaleItem['relevance'],
      terms?: string[]
    ) => {
      const id = `${row.event_id}:${account.path}`;
      if (items.some((item) => item.id === id)) return;
      items.push({
        id,
        form: 'recorded_capture',
        account,
        source: { artifact_id: row.artifact_id, event_id: row.event_id, field_path: account.path },
        relevance,
        temporal: row.sequence <= boundary ? 'historical_body' : 'later_annotation',
        ...(terms ? { matched_terms: terms } : {}),
        reference: reference(row.event_id, account),
        target_match: rationaleTargetMatch(rationaleAccountText(account), input.target?.file),
      });
    };
    for (const event of chosen) {
      const raw = load(event.id);
      if (!raw) continue;
      resolveEvent(raw.row, raw.accounts, event.relevance);
      const directTerms = new Set(
        items
          .filter((item) => item.relevance === 'candidate_event' && item.account.kind !== 'context')
          .flatMap((item) => rationaleTerms(rationaleAccountText(item.account)))
      );
      const relevant = (account: RationaleAccount) =>
        event.relevance === 'candidate_event' ||
        (directTerms.size === 0 && account.kind !== 'context') ||
        rationaleTerms(rationaleAccountText(account)).filter((term) => directTerms.has(term))
          .length >= 2;
      for (const account of raw.accounts)
        if (relevant(account)) addAccount(raw.row, account, event.relevance);
      const interpretations = readProjectKnowledgeInterpretations(view, {
        projectId: database.authority.projectId,
        boundary: observation,
        artifactIds: [],
        eventIds: [event.id],
        targets: [],
        projectFallback: false,
        maxEntries: RATIONALE_READ_BOUNDS.interpretationsPerEvent,
        maxBytes: RATIONALE_READ_BOUNDS.interpretationBytesPerEvent,
        preferredFieldPaths: input.target
          ? raw.accounts.slice(0, 128).map((account) => account.path)
          : [],
      });
      limits.push(...interpretations.limits);
      for (const retained of interpretations.interpretations) {
        const interpretation = retained.interpretation;
        if (items.some((item) => item.id === interpretation.interpretation_id)) continue;
        const source = view.get<{ field_path: string | null; event_id: string | null }>(
          'SELECT field_path, event_id FROM knowledge_sources WHERE source_id=?',
          interpretation.source_origin.source_id
        );
        const path = source?.field_path?.replace(/\[(\d+)\]/g, '.$1') ?? null;
        const sourceAccount =
          source?.event_id === event.id
            ? raw.accounts.find((account) => account.path === path)
            : undefined;
        if (event.relevance === 'candidate_plan' && (!sourceAccount || !relevant(sourceAccount)))
          continue;
        items.push({
          id: interpretation.interpretation_id,
          form: 'unapproved_interpretation',
          account: {
            path: path ?? '',
            kind: interpretation.proposed_record === 'decision' ? 'decision' : 'context',
            wording: interpretation.wording,
            reason:
              interpretation.rationale.kind === 'stated' ? interpretation.rationale.wording : null,
            alternatives: [],
          },
          ...(sourceAccount
            ? {
                source_account: { ...sourceAccount, reference: reference(event.id, sourceAccount) },
              }
            : {}),
          source: { artifact_id: raw.row.artifact_id, event_id: event.id, field_path: path },
          relevance: event.relevance,
          temporal: retained.writeSequence <= boundary ? 'historical_body' : 'later_annotation',
          interpretation,
          target_match: rationaleTargetMatch(interpretation.wording, input.target?.file),
          reference: rationaleSelector({
            kind: 'interpretation',
            id: interpretation.interpretation_id,
          }),
        });
      }
    }
    const direct = [...items];
    const discovery = discoverRationaleAccounts(
      view,
      direct
        .filter((item) => item.temporal === 'historical_body' && item.account.kind !== 'context')
        .map((item) => rationaleAccountText(item.source_account ?? item.account)),
      chosen.map((event) => event.id)
    );
    for (const match of discovery.matches) {
      const raw = load(match.eventId);
      const account = raw?.accounts.find((account) => account.path === match.path);
      if (raw && account) {
        resolveEvent(raw.row, raw.accounts, 'lexical_overlap');
        addAccount(raw.row, account, 'lexical_overlap', match.terms);
      }
    }
    const entries = [
      ...new Map(
        contexts
          .flatMap((context) => context.entries)
          .map((entry) => [`${entry.target.kind}:${entry.target.entity_id}`, entry])
      ).values(),
    ];
    const context: ProjectKnowledgeContext = {
      ...obligations,
      entries,
      coverage: knowledgeReadCoverage(
        obligations.request,
        entries.map((entry) => entry.resolved),
        contexts.flatMap((context) => context.coverage.unresolved)
      ),
      omissions: contexts.flatMap((context) => context.omissions),
    };
    const sourceIds = [
      ...new Set(
        entries.flatMap((entry) => entry.references.map((reference) => reference.sourceId))
      ),
    ];
    const paths = new Map(
      view
        .all<{
          source_id: string;
          field_path: string | null;
        }>(
          'SELECT source_id, field_path FROM knowledge_sources WHERE source_id IN (SELECT value FROM json_each(?))',
          JSON.stringify(sourceIds)
        )
        .map((row) => [row.source_id, row.field_path])
    );
    for (const item of items)
      item.knowledge_keys = entries
        .filter((entry) =>
          entry.references.some((reference) => {
            if (reference.eventId !== item.source.event_id) return false;
            const path = paths.get(reference.sourceId);
            return (
              !path ||
              !item.source.field_path ||
              rationaleSourcePath(path) === rationaleSourcePath(item.source.field_path)
            );
          })
        )
        .map((entry) => `${entry.target.kind}:${entry.target.entity_id}`);
    const records = entries.map((entry) => {
      const resolved = entry.resolved;
      const ids = [
        ...new Set([
          ...resolved.correction_effects.map((effect) => effect.action_id),
          ...resolved.proposals.map((proposal) => proposal.action_id),
          ...resolved.later_annotations
            .filter((item) => item.record === 'correction')
            .map((item) => item.record_id),
        ]),
      ];
      const corrections = ids.slice(0, 32).map((id) => {
        const retained = readableRationaleCorrection(view, id);
        const action = retained?.action;
        return {
          action_id: id,
          status:
            resolved.correction_effects.find((effect) => effect.action_id === id)?.standing ??
            (resolved.later_annotations.some((item) => item.record_id === id)
              ? 'later_annotation'
              : 'proposed'),
          kind: action?.kind ?? null,
          wording: action
            ? 'corrected_account' in action
              ? action.corrected_account
              : 'explanation' in action
                ? action.explanation
                : 'intended_interpretation' in action
                  ? action.intended_interpretation
                  : null
            : null,
          source_id: action?.source_id ?? null,
          reference: action
            ? rationaleSelector({
                kind: 'correction',
                id,
              })
            : null,
          unavailable: action === undefined,
        };
      });
      return {
        key: `${entry.target.kind}:${entry.target.entity_id}`,
        discovery: discoveries.get(`${entry.target.kind}:${entry.target.entity_id}`) ?? [],
        reference: rationaleSelector({
          kind: 'identity',
          id: entry.target.entity_id,
          identity_kind: entry.target.kind,
        }),
        corrections,
        omitted_corrections: Math.max(0, ids.length - corrections.length),
        relationships: resolved.relationships,
      };
    });
    return {
      context,
      records,
      items,
      boundary,
      observation,
      diagnostics: {
        authority_scope: obligations.request.scope,
        candidate_artifacts: artifacts.length,
        omitted_candidate_artifacts: grouped.size - artifacts.length,
        direct_events: chosen.length,
        omitted_direct_events: Math.max(0, candidateEventCount - chosen.length),
        source_bytes: sourceBytes,
        unavailable_events: unavailableEvents,
        discovery: discovery.diagnostics,
        limits,
      },
    };
  });
}
