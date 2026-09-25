// The open reconsideration items for the identities an answer already carries.
//
// It is put beside a composed answer rather than folded into it, the way the unselected-rules diff
// is: the answer says what applies, and this says what somebody has already noticed may be worth
// another look. It is a summary — a count and the first few with their reasons — because a full
// item belongs to `orcaops knowledge reconsider list`, which can be asked for one identity at a
// time and at a boundary.
//
// Nothing here is a defect: an open item says this history records a link from a change to the
// work, and the statement travels with every summary so no surface has to compose it.
import { RECONSIDERATION_STATEMENT } from '@orcaops/core';
import type {
  ProjectKnowledgeContext,
  ProjectReconsiderationItem,
} from '@orcaops/storage/history/database';

/** How many items a summary names before it stops naming them and only counts. */
const NAMED_IN_A_SUMMARY = 5;

export interface KnowledgeReconsiderationEntry {
  item_id: string;
  affected: { kind: string; id: string };
  cause_kind: string;
  /** The link that reached the work, in the traversal's own words. */
  reason: string;
  owner: { name: string; basis: string; from: string } | null;
  opened_at_boundary: number;
}

export interface KnowledgeReconsiderationSummary {
  /** How many items are open about the identities in this answer, before any cap. */
  open: number;
  items: KnowledgeReconsiderationEntry[];
  statement: string;
}

const reasonOf = (item: ProjectReconsiderationItem): string => {
  const source = item.source;
  if (source === null || typeof source !== 'object') return '';
  const reason = (source as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : '';
};

const entryOf = (item: ProjectReconsiderationItem): KnowledgeReconsiderationEntry => ({
  item_id: item.itemId,
  affected: { kind: item.affected.kind, id: item.affected.id },
  cause_kind: item.causeKind,
  reason: reasonOf(item),
  owner:
    item.owner === null
      ? null
      : { name: item.owner.name, basis: item.owner.basis, from: item.owner.from },
  opened_at_boundary: item.openedAtBoundary,
});

/**
 * The summary, or null when the composer read no items at all. Null is not "none open": a surface
 * that did not ask has nothing to say about what is open, and an empty summary would say the
 * opposite.
 */
export function knowledgeReconsiderationSummary(
  composed: ProjectKnowledgeContext
): KnowledgeReconsiderationSummary | null {
  const read = composed.entries.filter((entry) => entry.openReconsiderations !== undefined);
  if (read.length === 0) return null;
  const items = new Map<string, ProjectReconsiderationItem>();
  for (const entry of read)
    for (const item of entry.openReconsiderations ?? []) items.set(item.itemId, item);
  const sorted = [...items.values()].sort((left, right) =>
    left.openedAtBoundary === right.openedAtBoundary
      ? left.itemId.localeCompare(right.itemId)
      : left.openedAtBoundary - right.openedAtBoundary
  );
  return {
    open: sorted.length,
    items: sorted.slice(0, NAMED_IN_A_SUMMARY).map(entryOf),
    statement: RECONSIDERATION_STATEMENT,
  };
}
