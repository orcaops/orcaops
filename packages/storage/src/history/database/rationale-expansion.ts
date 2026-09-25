import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { knowledgeBoundaryAt } from './knowledge-read-boundary.js';
import { RATIONALE_EXPANSION_BYTES, readableRationaleCorrection } from './rationale-correction.js';
import { rationaleEvent, rationaleKnowledgeContext, readRationaleEvent } from './rationale-read.js';
import { parseRationaleSelector, type RationaleSelector } from './rationale-selector.js';
import { KnowledgeInterpretationSchema } from '../../schema/knowledge-contract.js';
import { redactSecretsInObject } from '../../secrets.js';

export { RATIONALE_EXPANSION_BYTES } from './rationale-correction.js';

export const RATIONALE_EXPORT_SOURCE_BYTES = 16_777_216;

export function expandProjectRationale(
  database: ProjectDatabase,
  token: string,
  maxBytes = RATIONALE_EXPANSION_BYTES,
  artifact?: string
) {
  const reference = parseRationaleSelector(token);
  return database.read((view) =>
    expandRationaleRecord(view, reference, token, maxBytes, database.authority.projectId, artifact)
  );
}

export function expandRationaleRecord(
  view: ProjectReadView,
  reference: RationaleSelector,
  token: string,
  maxBytes: number,
  project: string,
  artifact?: string
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RATIONALE_EXPORT_SOURCE_BYTES)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Invalid retained-source byte allowance');
  const observation = knowledgeBoundaryAt(view);
  let content: unknown = null;
  if (reference.kind === 'capture') {
    const row = rationaleEvent(view, reference.id);
    if (row && row.sequence <= observation)
      content =
        readRationaleEvent(view, row, maxBytes).accounts.find(
          (account) => account.path === reference.path
        ) ?? null;
  } else if (reference.kind === 'identity') {
    const context = rationaleKnowledgeContext(
      view,
      project,
      'now',
      {
        kind: 'identities',
        targets: [{ kind: reference.identity_kind!, entity_id: reference.id }],
      },
      artifact
    );
    const entry = context.entries[0];
    if (entry) content = { resolved: entry.resolved, statements: entry.statements };
  } else if (reference.kind === 'correction') {
    content = readableRationaleCorrection(view, reference.id, maxBytes)?.action ?? null;
  } else {
    const row = view.get<{ payload: string | null }>(
      `SELECT CASE WHEN length(i.record_bytes)<=? THEN CAST(i.record_bytes AS TEXT) END AS payload
        FROM knowledge_interpretations i
        JOIN knowledge_sources origin ON origin.source_id=i.origin_source_id
        WHERE i.interpretation_id=? AND origin.access_restriction IS NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge_interpretation_evidence e
          JOIN knowledge_sources s ON s.source_id=e.source_id WHERE e.interpretation_id=i.interpretation_id AND s.access_restriction IS NOT NULL)`,
      maxBytes,
      reference.id
    );
    if (row?.payload) content = KnowledgeInterpretationSchema.parse(JSON.parse(row.payload));
  }
  if (content === null)
    return {
      status: 'unavailable' as const,
      reference: token,
      content: null,
      message:
        'The exact record is missing, restricted, unreadable, or exceeds the expansion allowance.',
    };
  const result = {
    status: 'available' as const,
    reference: token,
    mode: 'current' as const,
    observation_ceiling: observation,
    content: redactSecretsInObject(content),
  };
  if (Buffer.byteLength(JSON.stringify({ ok: true, ...result })) + 1 > maxBytes)
    return {
      status: 'too_large' as const,
      reference: token,
      content: null,
      message: 'The exact record exceeds the expansion allowance.',
    };
  return result;
}
