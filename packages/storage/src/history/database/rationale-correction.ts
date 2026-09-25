import type { ProjectReadView } from './connection.js';
import { CorrectionActionSchema } from '../../schema/knowledge-contract.js';
import { redactSecretsInObject } from '../../secrets.js';

export const RATIONALE_EXPANSION_BYTES = 1_048_576;

export function readableRationaleCorrection(
  view: ProjectReadView,
  id: string,
  maxBytes = RATIONALE_EXPANSION_BYTES
) {
  const record = view.get<{ payload: string | null; sequence: number }>(
    `SELECT CASE WHEN length(a.record_bytes)<=? THEN CAST(a.record_bytes AS TEXT) END AS payload, o.committed_write_sequence AS sequence
    FROM correction_actions a JOIN operations o ON o.operation_id=a.operation_id
    WHERE a.action_id=?`,
    maxBytes,
    id
  );
  if (!record?.payload) return null;
  const action = CorrectionActionSchema.safeParse(JSON.parse(record.payload));
  const source = action.success
    ? view.get<{ access_restriction: string | null }>(
        'SELECT access_restriction FROM knowledge_sources WHERE source_id=?',
        action.data.source_id
      )
    : null;
  return action.success && source && source.access_restriction === null
    ? { action: redactSecretsInObject(action.data), sequence: record.sequence }
    : null;
}
