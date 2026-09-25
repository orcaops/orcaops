import type { ProjectReadView } from './connection.js';
import { knowledgeRecordsOf, type UnreadableKnowledgeRecord } from './knowledge-standing.js';
import type { AuthorityScope, RecordRevisionRef } from '../../schema/knowledge-contract.js';
import {
  type KnowledgeReadRequest,
  type KnowledgeRecords,
  type KnowledgeTarget,
  type ResolvedKnowledge,
  resolveKnowledge,
} from '../../schema/knowledge-resolution.js';

export interface ProjectKnowledgeAct {
  kind: 'selection' | 'relationship' | 'exception' | 'correction';
  id: string;
  projectId: string;
  scope: AuthorityScope;
  judgedAt: string | null;
}

interface TargetRow {
  kind: RecordRevisionRef['kind'];
  entity_id: string;
}

interface SelectionTargetRow extends TargetRow {
  scope_kind: string;
}

const targetKey = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

const currentRequest = (input: ProjectKnowledgeAct): KnowledgeReadRequest => ({
  scope: input.scope,
  mode: 'current',
  knowledge_boundary: Number.MAX_SAFE_INTEGER,
  implementation: { kind: 'none_selected' },
  applicability: {},
  exceptions_judged_at: input.judgedAt,
  exception_conditions: {},
});

function currentRecords(
  view: ProjectReadView,
  target: KnowledgeTarget,
  input: ProjectKnowledgeAct
): KnowledgeRecords | null {
  const unreadable: UnreadableKnowledgeRecord[] = [];
  const records = knowledgeRecordsOf(view, target, input.projectId, currentRequest(input), {
    unreadable,
  });
  if (unreadable.length > 0) return null;
  return records;
}

function resolveCurrent(records: KnowledgeRecords, input: ProjectKnowledgeAct): ResolvedKnowledge {
  return resolveKnowledge(records, currentRequest(input));
}

function currentResolution(
  view: ProjectReadView,
  target: KnowledgeTarget,
  input: ProjectKnowledgeAct
): ResolvedKnowledge | null {
  const records = currentRecords(view, target, input);
  return records === null ? null : resolveCurrent(records, input);
}

function selectionCurrentlyEffective(view: ProjectReadView, input: ProjectKnowledgeAct): boolean {
  const target = view.get<SelectionTargetRow>(
    `SELECT target_kind AS kind, target_id AS entity_id, scope_kind
     FROM adoptions WHERE adoption_id=?`,
    input.id
  );
  if (target === null || target.scope_kind === 'branch') return true;
  const resolved = currentResolution(view, target, input);
  if (resolved === null) return true;
  const effect = resolved.selection_effects.find((entry) => entry.selection_id === input.id);
  return effect === undefined || effect.standing !== 'ended';
}

function relationshipCurrentlyEffective(
  view: ProjectReadView,
  input: ProjectKnowledgeAct
): boolean {
  const held = view.get<{ relationship_id: string }>(
    'SELECT relationship_id FROM record_relationships WHERE relationship_id=?',
    input.id
  );
  if (held === null) return true;
  const resolved = currentResolution(view, { kind: 'relationship', entity_id: input.id }, input);
  if (resolved === null) return true;
  const relationship = resolved.relationships.find((entry) => entry.relationship_id === input.id);
  return relationship === undefined || relationship.standing !== 'withdrawn';
}

function exceptionCurrentlyEffective(view: ProjectReadView, input: ProjectKnowledgeAct): boolean {
  const target = view.get<TargetRow>(
    `SELECT expectation_kind AS kind, expectation_id AS entity_id
     FROM knowledge_exceptions WHERE exception_id=?`,
    input.id
  );
  if (target === null) return true;
  const resolved = currentResolution(view, target, input);
  if (resolved === null) return true;
  const exception = resolved.exceptions.find((entry) => entry.exception_id === input.id);
  return exception === undefined || exception.standing !== 'ended';
}

function correctionTargets(view: ProjectReadView, actionId: string): KnowledgeTarget[] | null {
  const held = view.get<{ action_id: string }>(
    'SELECT action_id FROM correction_actions WHERE action_id=?',
    actionId
  );
  if (held === null) return null;
  const targets = view.all<TargetRow>(
    `WITH RECURSIVE chain(action_id) AS (
       VALUES (?)
       UNION
       SELECT actions.follows_action_id
       FROM correction_actions actions JOIN chain ON actions.action_id=chain.action_id
       WHERE actions.follows_action_id IS NOT NULL
     )
     SELECT target_kind AS kind, target_id AS entity_id
     FROM correction_targets WHERE action_id IN (SELECT action_id FROM chain)
     UNION
     SELECT adopted_kind AS kind, adopted_id AS entity_id
     FROM correction_actions
     WHERE action_id IN (SELECT action_id FROM chain) AND adopted_kind IS NOT NULL`,
    actionId
  );
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
}

function correctionCurrentlyEffective(view: ProjectReadView, input: ProjectKnowledgeAct): boolean {
  const targets = correctionTargets(view, input.id);
  if (targets === null || targets.length === 0) return true;
  const records = targets.map((target) => currentRecords(view, target, input));
  if (records.some((entry) => entry === null)) return true;
  const readable = records as KnowledgeRecords[];
  const corrections = [
    ...new Map(
      readable.flatMap((entry) => entry.corrections).map((entry) => [entry.record.action_id, entry])
    ).values(),
  ];
  for (const recordsForTarget of readable) {
    const resolved = resolveCurrent({ ...recordsForTarget, corrections }, input);
    const effect = resolved.correction_effects.find((entry) => entry.action_id === input.id);
    if (effect === undefined || effect.standing !== 'ended') return true;
  }
  return false;
}

/**
 * Whether an act must still pass integration authority checks. It says no only when a complete
 * shared resolution proves the act's own effect ended; absent or unreadable history stays checked.
 */
export function projectActCurrentlyEffective(
  view: ProjectReadView,
  input: ProjectKnowledgeAct
): boolean {
  if (input.kind === 'selection') return selectionCurrentlyEffective(view, input);
  if (input.kind === 'relationship') return relationshipCurrentlyEffective(view, input);
  if (input.kind === 'exception') return exceptionCurrentlyEffective(view, input);
  return correctionCurrentlyEffective(view, input);
}
