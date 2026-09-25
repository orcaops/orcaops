// What governs one target identity at a knowledge boundary: the shared resolver's answer, and the
// boundary and mode it was answered at.
//
// **The boundary filters the resolver's input, never its answer.** Replacement, withdrawal,
// acknowledgment and revocation are rules that have to run over what stood then. Filtering the
// result instead would keep a later act's effect while hiding the act: a revocation published after
// the boundary would already have ended an authorization, a withdrawal would already have stopped a
// revision, and the answer would say a rule stopped standing with nothing in it that says why.
// `resolveKnowledge` applies exactly that filter, over every list `knowledgeRecordsOf` builds —
// revisions, selections, corrections, relationships, exceptions, revocations, conflict answers and
// branch-scoped rows — and returns each later record as an annotation instead of leaving it
// silently missing. So this reader supplies the boundary and filters nothing a second time: a
// second filter would empty `later_annotations`, which is where "a later correction annotates an
// historical answer separately and never enters its original basis" actually lives.
import { type ProjectReadView } from './connection.js';
import { type KnowledgeReadCoverage, knowledgeReadCoverage } from './knowledge-read-boundary.js';
import { knowledgeRecordsOf, type KnowledgeRecordsOptions } from './knowledge-standing.js';
import {
  type KnowledgeReadRequest,
  type KnowledgeTarget,
  type ResolvedKnowledge,
  resolveKnowledge,
} from '../../schema/knowledge-resolution.js';

export interface ProjectGoverningState {
  readonly target: KnowledgeTarget;
  readonly coverage: KnowledgeReadCoverage;
  /** The resolver's whole answer, whose `basis` echoes the same boundary, mode and inputs. */
  readonly resolved: ResolvedKnowledge;
}

export function readProjectGoverningState(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest
): ProjectGoverningState {
  const resolved = resolveKnowledge(knowledgeRecordsOf(view, target, projectId, request), request);
  return { target, coverage: knowledgeReadCoverage(request, [resolved]), resolved };
}

const identityKey = (target: KnowledgeTarget) => JSON.stringify([target.kind, target.entity_id]);

export interface GoverningStateReader {
  /** What governs that identity at this read's boundary. */
  at(target: KnowledgeTarget): ResolvedKnowledge;
  /** Every answer this reader gave, which is what a coverage statement is built from. */
  answers(): readonly ResolvedKnowledge[];
}

/**
 * One governing-state read per identity, for the readers that ask about several. Each identity
 * costs a resolution, so a reader that asks about the same one twice pays once, and every answer in
 * one of these readers comes from the same snapshot and the same boundary.
 */
export function governingStateReader(
  view: ProjectReadView,
  projectId: string,
  request: KnowledgeReadRequest,
  options: KnowledgeRecordsOptions = {}
): GoverningStateReader {
  const answered = new Map<string, ResolvedKnowledge>();
  return {
    at(target) {
      const key = identityKey(target);
      const held = answered.get(key);
      if (held !== undefined) return held;
      const resolved = resolveKnowledge(
        knowledgeRecordsOf(view, target, projectId, request, options),
        request
      );
      answered.set(key, resolved);
      return resolved;
    },
    answers: () => [...answered.values()],
  };
}
