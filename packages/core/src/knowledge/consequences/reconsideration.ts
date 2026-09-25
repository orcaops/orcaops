// What a traversal answer offers to retain: one signal per affected item and cause.
//
// A signal is an offer, not a verdict. It says that this history records a link from a change to
// some work, and that somebody may want to look at that work again. It is not a defect, it revises
// no requirement and it assigns no remediation: §10 of the plan says an eligibility signal does not
// mean an item is wrong, and everything downstream of here — the record, the verbs, the surfaces —
// is built so that nothing can quietly turn one into a finding.
//
// The cause key is what makes a repeated signal the same item. It is a normalised projection of
// the change, so two runs over the same change agree whatever else moved in between, and how the
// standing moved is left out of it: an adoption and the replacement that follows are two accounts
// of one revision changing, not two different things to reconsider.
import { canonicalJson } from '@orcaops/storage';

import type {
  AffectedConsequence,
  ConsequenceAnswer,
  ConsequenceChange,
  ConsequenceItem,
  ConsequenceLinkBasis,
  ConsequenceOwner,
  ConsequenceStep,
} from './traversal.js';

/** Which of the three changes a traversal starts from opened the item. */
export type ReconsiderationCauseKind = ConsequenceChange['kind'];

/** The affected item as a record names it: the kind of thing, and its identity. */
export interface ReconsiderationAffected {
  readonly kind: string;
  readonly id: string;
}

export interface ReconsiderationCause {
  readonly kind: ReconsiderationCauseKind;
  /** The dedup key: the same change always produces this same string. */
  readonly key: string;
  /** The change as the traversal was asked about it, kept whole as a source fact. */
  readonly change: ConsequenceChange;
}

/** One item a signal would open, with the facts it is opened on and nothing else. */
export interface ReconsiderationSignal {
  readonly affected: ReconsiderationAffected;
  readonly item: ConsequenceItem;
  readonly cause: ReconsiderationCause;
  /** The link that reached the item, in the traversal's own words. */
  readonly reason: string;
  readonly basis: ConsequenceLinkBasis;
  /** An explicit supporting path when available, otherwise an inferred path. */
  readonly path: readonly ConsequenceStep[];
  readonly owner: ConsequenceOwner | null;
  /** The write sequence the traversal read at, so the facts below are dated. */
  readonly openedAtBoundary: number;
}

/**
 * What every surface says about an open item, so no reader has to compose it and none can soften
 * it. It is the plan's §10 sentence applied to one record.
 */
export const RECONSIDERATION_STATEMENT =
  'A reconsideration item says this history records a link from a change to this work. It is not ' +
  'a finding that the work is wrong: it opens no defect, revises no requirement and assigns no ' +
  'remediation. Someone decides what to do with it, and that decision is retained beside it.';

export function reconsiderationAffectedOf(item: ConsequenceItem): ReconsiderationAffected {
  switch (item.kind) {
    case 'identity':
      return { kind: item.target.kind, id: item.target.entity_id };
    case 'plan_event':
      return { kind: 'plan_event', id: item.plan_event_id };
    case 'artifact':
      return { kind: 'artifact', id: item.artifact_id };
    case 'assessment':
      return { kind: 'assessment', id: item.assessment_id };
    case 'code_path':
      return { kind: 'code_path', id: item.path };
  }
}

/**
 * The dedup key of a change.
 *
 * `moved` takes no part: an adoption and the replacement that follows it are the same revision
 * changing, and opening a second item for the second act would be the duplicate §10 forbids. The
 * revision a caller named does take part, because "this exact revision moved" and "something about
 * this identity moved" are different questions with different answers.
 */
export function reconsiderationCauseKey(change: ConsequenceChange): string {
  if (change.kind === 'implementation')
    return canonicalJson({ kind: 'implementation', paths: [...new Set(change.paths)].sort() });
  const identity = { kind: change.identity.kind, entity_id: change.identity.entity_id };
  return change.kind === 'assumption'
    ? canonicalJson({
        kind: 'assumption',
        identity,
        revision_id: change.revision_id,
        named: change.named,
      })
    : canonicalJson({ kind: 'revision', identity, revision_id: change.revision_id });
}

const signalOf = (
  answer: ConsequenceAnswer,
  cause: ReconsiderationCause,
  entry: AffectedConsequence
): ReconsiderationSignal => {
  const explicit = (path: readonly ConsequenceStep[]) =>
    path.length > 0 && path.every((step) => step.basis === 'explicit');
  const path =
    entry.paths
      .filter((candidate) => candidate.length > 0)
      .sort((left, right) => {
        const order =
          Number(explicit(right)) - Number(explicit(left)) || left.length - right.length;
        if (order !== 0) return order;
        const a = canonicalJson(left);
        const b = canonicalJson(right);
        return a < b ? -1 : a > b ? 1 : 0;
      })[0] ?? [];
  return {
    affected: reconsiderationAffectedOf(entry.item),
    item: entry.item,
    cause,
    reason: path.at(-1)?.reason ?? entry.reason,
    basis: path.length === 0 ? entry.basis : explicit(path) ? 'explicit' : 'inferred',
    path,
    owner: entry.owner,
    openedAtBoundary: answer.basis.knowledge_boundary,
  };
};

/**
 * One signal per affected item of one answer.
 *
 * The change itself is never a signal — the traversal already leaves the start items out of
 * `affected` — so a change never opens an item about itself.
 */
export function reconsiderationSignalsOf(answer: ConsequenceAnswer): ReconsiderationSignal[] {
  const cause: ReconsiderationCause = {
    kind: answer.change.kind,
    key: reconsiderationCauseKey(answer.change),
    change: answer.change,
  };
  return answer.affected.map((entry) => signalOf(answer, cause, entry));
}

/**
 * The signals of several answers, deduplicated by affected item and cause. A `--since` sweep
 * traverses one change per act, and two acts that moved one revision reach the same work under one
 * cause; the first signal wins, because an item's facts are the facts as of the signal that opened
 * it.
 */
export function reconsiderationSignalsOfAll(
  answers: readonly ConsequenceAnswer[]
): ReconsiderationSignal[] {
  const held = new Map<string, ReconsiderationSignal>();
  for (const answer of answers)
    for (const signal of reconsiderationSignalsOf(answer)) {
      const key = canonicalJson([
        signal.affected.kind,
        signal.affected.id,
        signal.cause.kind,
        signal.cause.key,
      ]);
      if (!held.has(key)) held.set(key, signal);
    }
  return [...held.values()];
}
