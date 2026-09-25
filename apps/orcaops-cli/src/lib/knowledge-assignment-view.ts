// The assignments in view for the identities an answer already carries.
//
// It is put beside a composed answer rather than folded into it, the way the unselected-rules diff
// and the reconsideration summary are: the answer says what applies, and this says who may already
// decide what about it on somebody's behalf. Whether an act may actually rest on one is the
// writer's judgment inside its own transaction; this reports what the record says and nothing more.
import type { AssignmentStandingEntry } from '@orcaops/storage';
import type { ProjectKnowledgeContext } from '@orcaops/storage/history/database';

/** How many assignments a summary names before it stops naming them and only counts. */
const NAMED_IN_A_SUMMARY = 5;

/**
 * What every surface says about an assignment, so no reader has to compose it. Orcaops enforces
 * that an act under one CLAIMS the responsible identity; nothing here authenticates it.
 */
export const ASSIGNMENT_STATEMENT =
  'An assignment says who may decide what on somebody else’s behalf, and what it delegates is the ' +
  'whole of what an act under it may do. The responsible identity is the one an act must claim; ' +
  'locally that claim is an assertion, not an authenticated identity.';

export interface KnowledgeAssignmentEntry {
  assignment_id: string;
  /** The identity this entry is about, so a summary over several stays readable. */
  key: string;
  objective: string;
  responsible: { identity: string | null; basis: string };
  /** What it delegates about this identity: how many adoptions, departures and restatements. */
  delegates: { adopts: number; departs_from: number; restates: number };
  escalation_conditions: readonly string[];
  valid_until: string | null;
  standing: string;
  reason: string;
}

export interface KnowledgeAssignmentSummary {
  /** How many assignments name the identities in this answer, before any cap. */
  count: number;
  assignments: KnowledgeAssignmentEntry[];
  statement: string;
}

export const knowledgeAssignmentEntry = (
  key: string,
  assignment: AssignmentStandingEntry
): KnowledgeAssignmentEntry => ({
  assignment_id: assignment.assignment_id,
  key,
  objective: assignment.objective,
  responsible: {
    identity: assignment.responsible.identity,
    basis: assignment.responsible.basis,
  },
  delegates: {
    adopts: assignment.delegates.adopts.length,
    departs_from: assignment.delegates.departs_from.length,
    restates: assignment.delegates.restates.length,
  },
  escalation_conditions: assignment.escalation_conditions,
  valid_until: assignment.valid_until,
  standing: assignment.standing,
  reason: assignment.reason,
});

/**
 * The summary, or null when the composer read no assignments at all. Null is not "none": a surface
 * that did not ask has nothing to say about who is responsible, and an empty summary would say the
 * opposite.
 */
export function knowledgeAssignmentSummary(
  composed: ProjectKnowledgeContext
): KnowledgeAssignmentSummary | null {
  const read = composed.entries.filter((entry) => entry.assignments !== undefined);
  if (read.length === 0) return null;
  const entries: KnowledgeAssignmentEntry[] = [];
  for (const entry of read)
    for (const assignment of entry.assignments ?? [])
      entries.push(
        knowledgeAssignmentEntry(`${entry.target.kind}:${entry.target.entity_id}`, assignment)
      );
  entries.sort(
    (left, right) =>
      left.key.localeCompare(right.key) || left.assignment_id.localeCompare(right.assignment_id)
  );
  return {
    count: entries.length,
    assignments: entries.slice(0, NAMED_IN_A_SUMMARY),
    statement: ASSIGNMENT_STATEMENT,
  };
}
