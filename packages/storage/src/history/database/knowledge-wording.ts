import type { ProjectReadView } from './connection.js';
import {
  InterpretationSupportSchema,
  type KnowledgeInterpretation,
  KnowledgeInterpretationSchema,
  type RecordRevisionRef,
} from '../../schema/knowledge-contract.js';

export interface RetainedInterpretationScope {
  intended_scope_status: 'legacy_absent' | 'verified' | 'invalid';
  intended_scope?: KnowledgeInterpretation['intended_scope'];
}

export function retainedIntendedScope(
  view: ProjectReadView,
  payload: string,
  revision: RecordRevisionRef,
  boundary: number
): RetainedInterpretationScope {
  const invalid: RetainedInterpretationScope = { intended_scope_status: 'invalid' };
  try {
    const record: unknown = JSON.parse(payload);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return invalid;
    const support = 'interpretation' in record ? record.interpretation : undefined;
    if (support === undefined || support === null) {
      const interpreted = view.get(
        `SELECT interpretation_id FROM knowledge_interpretations i
         JOIN operations o ON o.operation_id=i.operation_id
         WHERE i.outcome_kind='candidate_revision' AND i.target_kind=? AND i.target_id=?
           AND i.target_revision_id=? AND o.committed_write_sequence<=? LIMIT 1`,
        revision.kind,
        revision.entity_id,
        revision.revision_id,
        boundary
      );
      const origin =
        revision.kind === 'requirement'
          ? view.get(
              `SELECT requirement_id FROM requirements WHERE requirement_id=?
         AND first_revision_id=? AND origin_kind='interpreted_source'`,
              revision.entity_id,
              revision.revision_id
            )
          : null;
      return interpreted !== null || origin !== null
        ? invalid
        : { intended_scope_status: 'legacy_absent' };
    }
    const parsedSupport = InterpretationSupportSchema.safeParse(support);
    if (!parsedSupport.success) return invalid;
    const held = view.get<{ payload: string }>(
      `SELECT CAST(i.record_bytes AS TEXT) AS payload FROM knowledge_interpretations i
       JOIN operations o ON o.operation_id=i.operation_id
       WHERE i.interpretation_id=? AND o.committed_write_sequence<=?`,
      parsedSupport.data.interpretation_id,
      boundary
    );
    if (held === null) return invalid;
    const parsed = KnowledgeInterpretationSchema.safeParse(JSON.parse(held.payload));
    if (!parsed.success || parsed.data.interpretation_id !== parsedSupport.data.interpretation_id)
      return invalid;
    const outcome = parsed.data.canonical_outcome;
    if (
      outcome.kind !== 'candidate_revision' ||
      outcome.target.kind !== revision.kind ||
      outcome.target.entity_id !== revision.entity_id ||
      outcome.target.revision_id !== revision.revision_id
    )
      return invalid;
    return { intended_scope_status: 'verified', intended_scope: parsed.data.intended_scope };
  } catch {
    return invalid;
  }
}

export function retainedRationale(payload: string, kind: string): string | null | undefined {
  try {
    const record: unknown = JSON.parse(payload);
    if (record === null || typeof record !== 'object' || !('rationale' in record)) return undefined;
    if (typeof record.rationale === 'string' && record.rationale.length > 0)
      return record.rationale;
    if (kind === 'decision' && record.rationale === null) return null;
  } catch {
    return undefined;
  }
  return undefined;
}
