import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { knowledgeBoundaryAt } from './knowledge-read-boundary.js';
import { identitiesCitingSources } from './knowledge-retrieval.js';
import { readableRationaleCorrection } from './rationale-correction.js';
import { expandRationaleRecord, RATIONALE_EXPORT_SOURCE_BYTES } from './rationale-expansion.js';
import { rationaleKnowledgeContext } from './rationale-read.js';
import { rationaleSourcePath } from './rationale-relevance.js';
import { parseRationaleSelector, rationaleSelector } from './rationale-selector.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { CorrectionActionSchema } from '../../schema/knowledge-contract.js';
import type { KnowledgeTarget } from '../../schema/knowledge-resolution.js';
import { digest } from '../event-integrity.js';

const INDEX_LIMIT = 4096;
const CONTEXT_BYTES = 33_554_432;

export interface RationaleContextOptions {
  cursor?: string;
  limit?: number;
  export?: boolean;
  artifact?: string;
}

function rationaleContextOffset(key: string, cursor?: string): number {
  if (!cursor) return 0;
  const parsed = /^context\.([A-Za-z0-9_-]{43})\.(\d{1,4})$/.exec(cursor);
  if (!parsed || Number(parsed[2]) > INDEX_LIMIT)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Expected a qualifying-context cursor returned by knowledge show'
    );
  if (parsed[1] !== key)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The account, scope, or history changed. Inspect the account again without --cursor.'
    );
  return Number(parsed[2]);
}

function sourceTargets(
  view: ProjectReadView,
  eventId: string | null,
  field: string | null,
  sourceId: string | null,
  observation: number
) {
  const sources = view.all<{
    source_id: string;
    field_path: string | null;
    access_restriction: string | null;
  }>(
    `SELECT source_id, field_path, access_restriction FROM knowledge_sources
     WHERE (? IS NOT NULL AND event_id=?) OR source_id=? ORDER BY source_id LIMIT ?`,
    eventId,
    eventId,
    sourceId,
    INDEX_LIMIT + 1
  );
  const matching = sources
    .slice(0, INDEX_LIMIT)
    .filter(
      (source) =>
        !field ||
        !source.field_path ||
        rationaleSourcePath(source.field_path) === rationaleSourcePath(field)
    );
  const open = matching.filter((source) => source.access_restriction === null);
  const targets: KnowledgeTarget[] = [];
  let unavailable = 0;
  for (let offset = 0; offset < open.length; offset += 256) {
    const found = identitiesCitingSources(
      view,
      open.slice(offset, offset + 256).map((source) => source.source_id),
      observation
    );
    targets.push(...found.rows);
    unavailable += found.unavailable;
  }
  return {
    targets,
    limited: sources.length > INDEX_LIMIT,
    restricted: matching.length - open.length,
    unavailable,
  };
}

export function expandProjectRationaleContext(
  database: ProjectDatabase,
  token: string,
  options: RationaleContextOptions = {}
) {
  const reference = parseRationaleSelector(token);
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 8)
  )
    throw new ProjectDatabaseError('INVALID_INPUT', 'Context --limit must be between 1 and 8');
  return database.read((view) => {
    const observation = knowledgeBoundaryAt(view);
    const key = Buffer.from(
      digest(
        Buffer.from(
          canonicalJson([
            token,
            database.authority.projectId,
            database.authority.storeInstanceId,
            options.artifact ?? null,
            observation,
          ])
        )
      ),
      'hex'
    ).toString('base64url');
    const offset = rationaleContextOffset(key, options.cursor);
    const account = expandRationaleRecord(
      view,
      reference,
      token,
      RATIONALE_EXPORT_SOURCE_BYTES,
      database.authority.projectId,
      options.artifact
    );
    if (account.status !== 'available') return account;
    let found: ReturnType<typeof sourceTargets>;
    if (reference.kind === 'identity') {
      found = {
        targets: [{ kind: reference.identity_kind!, entity_id: reference.id }],
        limited: false,
        restricted: 0,
        unavailable: 0,
      };
    } else if (reference.kind === 'correction') {
      found = {
        targets: CorrectionActionSchema.parse(account.content).targets,
        limited: false,
        restricted: 0,
        unavailable: 0,
      };
    } else if (reference.kind === 'capture') {
      found = sourceTargets(view, reference.id, reference.path, null, observation);
    } else {
      const origin = view.get<{
        source_id: string;
        event_id: string | null;
        field_path: string | null;
      }>(
        `SELECT s.source_id, s.event_id, s.field_path FROM knowledge_interpretations i
         JOIN knowledge_sources s ON s.source_id=i.origin_source_id WHERE i.interpretation_id=?`,
        reference.id
      );
      found = sourceTargets(
        view,
        origin?.event_id ?? null,
        origin?.field_path ?? null,
        origin?.source_id ?? null,
        observation
      );
    }
    const targets = [
      ...new Map(
        found.targets.map((target) => [`${target.kind}:${target.entity_id}`, target])
      ).values(),
    ].sort((a, b) => `${a.kind}:${a.entity_id}`.localeCompare(`${b.kind}:${b.entity_id}`));
    const indexLimited = found.limited || targets.length > INDEX_LIMIT;
    const indexed = targets.slice(0, INDEX_LIMIT);
    if (offset > indexed.length)
      throw new ProjectDatabaseError('INVALID_INPUT', 'Context offset exceeds its entry count');
    const limit = options.limit ?? (options.export ? INDEX_LIMIT : 5);
    const selected = indexed.slice(offset, offset + limit);
    let bytes = Buffer.byteLength(JSON.stringify(account));
    const qualifications = selected.map((target) => {
      const context = rationaleKnowledgeContext(
        view,
        database.authority.projectId,
        'now',
        { kind: 'identities', targets: [target] },
        options.artifact
      );
      const entry = context.entries[0];
      const resolved = entry?.resolved;
      const correctionIds = [
        ...new Set([
          ...(resolved?.correction_effects.map((effect) => effect.action_id) ?? []),
          ...(resolved?.proposals.map((proposal) => proposal.action_id) ?? []),
          ...(resolved?.omissions
            .filter((item) => item.record === 'correction')
            .map((item) => item.record_id) ?? []),
          ...(resolved?.later_annotations
            .filter((item) => item.record === 'correction')
            .map((item) => item.record_id) ?? []),
        ]),
      ];
      const corrections = correctionIds.map((id) => {
        const action = readableRationaleCorrection(view, id, RATIONALE_EXPORT_SOURCE_BYTES)?.action;
        return {
          action_id: id,
          status: action ? ('available' as const) : ('unavailable' as const),
          action: action ?? null,
        };
      });
      const content = entry ? { resolved: entry.resolved, statements: entry.statements } : null;
      const result = {
        target,
        content,
        corrections,
        coverage: context.coverage,
        omissions: context.omissions,
        reference: content
          ? rationaleSelector({
              kind: 'identity',
              id: target.entity_id,
              identity_kind: target.kind,
            })
          : null,
      };
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > CONTEXT_BYTES)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Qualifying context exceeds the 32 MiB read allowance. Use --context --limit 1 and follow context cursors.'
        );
      return result;
    });
    const nextOffset = offset + selected.length;
    const next = nextOffset < indexed.length ? `context.${key}.${nextOffset}` : null;
    const reasons = [
      { code: 'qualification_index_limited', count: Number(indexLimited) },
      { code: 'restricted_sources', count: found.restricted },
      { code: 'unavailable_citations', count: found.unavailable },
      { code: 'qualifications_outside_page', count: indexed.length - selected.length },
      {
        code: 'unavailable_qualification_content',
        count: qualifications.filter((item) => !item.content).length,
      },
      {
        code: 'omitted_qualification_context',
        count: qualifications.reduce(
          (sum, item) => sum + item.coverage.omitted.length + item.omissions.length,
          0
        ),
      },
      {
        code: 'unresolved_qualification_evidence_or_authority',
        count: qualifications.reduce((sum, item) => sum + item.coverage.unresolved.length, 0),
      },
      {
        code: 'unavailable_corrections',
        count: qualifications.reduce(
          (sum, item) =>
            sum + item.corrections.filter((correction) => correction.status !== 'available').length,
          0
        ),
      },
    ].filter((reason) => reason.count > 0);
    return {
      ...account,
      selection: {
        project_id: database.authority.projectId,
        scope: options.artifact
          ? { kind: 'artifact' as const, artifact_id: options.artifact }
          : { kind: 'project' as const, project_id: database.authority.projectId },
        mode: 'current' as const,
        observation_ceiling: observation,
      },
      qualifications,
      pagination: { total: indexed.length, offset, returned: selected.length, next_cursor: next },
      completeness: {
        complete: reasons.length === 0,
        reasons,
        index_limited: indexLimited,
        restricted_sources: found.restricted,
        unavailable_citations: found.unavailable,
        unreturned_qualifications: indexed.length - selected.length,
        statement:
          'Current state of retained identities citing this account in the selected scope. Uncited or unread history is not exhaustive; pagination is separate from evidence completeness.',
      },
    };
  });
}
