// What applies here that a plan has not recorded a use of.
//
// The diff exists because the omission is invisible otherwise: a plan's own uses say what it
// selected and say nothing at all about what it missed, and an adopted rule that nobody selected
// reads exactly like a rule that does not exist. Nothing here asks a question and nothing here
// writes: it is the answer put beside the plan, in the answer's own ids.
//
// The comparison is by exact revision, because that is what a use names. A plan that selected a
// predecessor of the revision now adopted is not selected here — the revision that governs was
// never chosen — and the predecessor it did choose is named beside it, so drift reads as drift
// rather than as a rule nobody ever looked at.
import type { KnowledgeTarget } from '@orcaops/storage';

import {
  type KnowledgeContextAnswer,
  type KnowledgeContextBasis,
  type KnowledgeContextLimit,
  revisionGoverns,
} from './answer.js';

export interface ApplicableNotSelectedEntry {
  key: string;
  target: KnowledgeTarget;
  /** The adopted revisions that apply here and that this plan event names no use of. */
  revision_ids: readonly string[];
  /** Revisions of the same identity this plan event did select. Empty is the ordinary case. */
  selected_revision_ids: readonly string[];
  /** Null when this store holds no readable wording for the revisions above. */
  statement: string | null;
  reason: string;
}

export interface ApplicableNotSelected {
  basis: KnowledgeContextBasis;
  /** Both null when no plan is in view, which the statement says in words. */
  artifact_id: string | null;
  plan_event_id: string | null;
  entries: readonly ApplicableNotSelectedEntry[];
  /**
   * The bounds the answer this diff was taken from spent. Carried rather than dropped: a diff that
   * counted a bound's worth of entries and said nothing about the bound would report "50 of 50"
   * over an answer that stopped looking at 50.
   */
  limits: readonly KnowledgeContextLimit[];
  /** An empty list means two very different things, so the answer always says which. */
  statement: string;
}

export interface ApplicableNotSelectedPlan {
  artifactId: string;
  planEventId: string;
}

export function applicableNotSelected(
  answer: KnowledgeContextAnswer,
  plan: ApplicableNotSelectedPlan | null
): ApplicableNotSelected {
  const byKey = new Map(answer.entries.map((entry) => [entry.key, entry]));
  const entries: ApplicableNotSelectedEntry[] = [];
  for (const key of answer.applicable) {
    const entry = byKey.get(key);
    if (entry === undefined) continue;
    const governing = entry.revisions.filter(revisionGoverns);
    const selected =
      plan === null
        ? []
        : entry.selected_with_plan
            .filter((use) => use.plan_event_id === plan.planEventId)
            .map((use) => use.revision_id);
    const missed = governing.filter(
      (revision) => !selected.includes(revision.revision.revision_id)
    );
    if (missed.length === 0) continue;
    entries.push({
      key,
      target: entry.target,
      revision_ids: missed.map((revision) => revision.revision.revision_id),
      selected_revision_ids: [...new Set(selected)].sort(),
      statement: missed.map((revision) => revision.statement).find((text) => text !== null) ?? null,
      reason:
        selected.length === 0
          ? `${entry.reason} This plan records no use of it.`
          : `${entry.reason} This plan selected another revision of it, not the one that governs.`,
    });
  }
  // The identity bound stops the answer at exactly the entries it was allowed, so the count it
  // carries IS the cap whenever that limit fired. Every count below is a floor from there on.
  const capped = answer.limits.some((limit) => limit.kind === 'identity_count');
  const incomplete = answer.limits.length > 0;
  return {
    basis: answer.basis,
    artifact_id: plan?.artifactId ?? null,
    plan_event_id: plan?.planEventId ?? null,
    entries,
    limits: answer.limits,
    statement: statementFor(
      plan,
      answer.applicable.length,
      entries.length,
      capped ? answer.entries.length : null,
      incomplete
    ),
  };
}

const cappedAt = (cap: number | null): string =>
  cap === null
    ? ''
    : ` This read is capped at ${cap} identit(y/ies) and reached that bound, so more may apply ` +
      'than are counted here: `orcaops knowledge lookup --limit` asks for more.';

function statementFor(
  plan: ApplicableNotSelectedPlan | null,
  applicable: number,
  missed: number,
  cap: number | null,
  incomplete: boolean
): string {
  const total = cap === null ? `${applicable}` : `at least ${applicable}`;
  const bound = cappedAt(cap);
  const qualified = incomplete
    ? ' This read is incomplete, so omitted entries may also apply; inspect its limits.'
    : '';
  if (plan === null)
    return (
      `No plan is in view for this read, so all ${applicable} applicable entr(y/ies) are listed: ` +
      `nothing here records a use of any of them.${bound}${qualified}`
    );
  if (applicable === 0)
    return incomplete
      ? `This read carried no adopted rule that applies here, but it cannot establish that this plan missed nothing.${bound}${qualified}`
      : 'No adopted rule of this read applies here, so there is nothing this plan could miss.';
  return missed === 0
    ? incomplete
      ? `This plan selected every applicable entry this read carried.${bound}${qualified}`
      : `This plan selected every one of the ${total} applicable entr(y/ies) of this read.`
    : `${missed} of ${total} applicable entr(y/ies) are not selected by plan event ${plan.planEventId}.${bound}${qualified}`;
}
