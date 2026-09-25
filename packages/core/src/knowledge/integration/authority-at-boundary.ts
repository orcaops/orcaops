// What a task selected and acted on, compared with what governs and what authority stands now.
//
// The plan §10 asks for a comparison at integration: the original context and authorization of
// every recorded use and act, against the applicability and authority at the boundary the check is
// made at. Two things can have changed since the plan was captured, and they are never confused:
//
// - **the obligation moved** — the revision a plan selected no longer governs, because something
//   replaced, withdrew, reversed or corrected it. The work may still be right; nobody has looked.
//   This reports.
// - **the authority was revoked** — an act published during this task rested on an authorization or
//   an assignment a revocation has since ended, or a delegation whose validity no longer covers it.
//   This refuses, and the pass that refuses writes nothing to the act, to what it rested on, or to
//   the revocation.
//
// Pure over facts a caller read in one snapshot, the way `traceConsequences` is pure over the rows
// behind a consequence explanation. It resolves nothing, reads nothing and writes nothing: whether
// a revision governs and whether an assignment stands were both decided by the store's own readers
// before the facts reached here, so this and the writers can never disagree about one record.
import type { AuthorityScope, KnowledgeTarget } from '@orcaops/storage';

import {
  type KnowledgeContextAnswer,
  type KnowledgeContextEntry,
  knowledgeContextKey,
  type KnowledgeContextUse,
  revisionGoverns,
} from '../context/answer.js';

/** The roles that claim a task meant to meet a rule. Background and a proposal claim nothing. */
const OBLIGED_ROLES: readonly string[] = ['implement', 'preserve', 'assess'];

/**
 * The resolver's effects that make a revision stand. Everything else on its reasons is why one
 * stopped — replaced, withdrawn, reversed, corrected, superseded by an established relationship.
 * Named this way round on purpose: an allow-list of "why it moved" would report no reason at all
 * for an effect a later resolver adds, which reads as an obligation that moved for no reason.
 */
const STANDING_EFFECTS: readonly string[] = [
  'adopted',
  'designation_changed',
  'stands_as_replacement',
  'restored',
];

/** How the thing an act rested on stood at the boundary, as the store's readers judged it. */
export type ActAuthorityStanding =
  | 'valid'
  | 'revoked'
  | 'basis_ended'
  | 'expired'
  | 'not_judgeable';

/**
 * The standings that refuse an integration, and the one that does not.
 *
 * `basis_ended` is deliberately absent. An authorization or an assignment stops being valid once a
 * rule it departs from no longer stands — and the act published under it is usually what stopped
 * that rule, because departing from a rule is what replacing or withdrawing it IS. Refusing on that
 * ground would make every correct replacement refuse the integration of its own publication, which
 * is a gate nobody could pass and everybody would learn to route around. The genuine case, where
 * somebody else moved a rule this task relied on, is reported as a moved obligation instead.
 */
const REFUSING_STANDINGS = [
  'revoked',
  'expired',
  'not_judgeable',
] as const satisfies readonly ActAuthorityStanding[];

type RefusingStanding = (typeof REFUSING_STANDINGS)[number];

const refusingStanding = (standing: ActAuthorityStanding): standing is RefusingStanding =>
  (REFUSING_STANDINGS as readonly ActAuthorityStanding[]).includes(standing);

export interface ActAuthorityRevocation {
  revocation_id: string;
  /** The identity the revocation claims. Null for an actor this history cannot name. */
  revoked_by: string | null;
  recorded_at: string | null;
}

/** What one act cited, and how that stood at the boundary. */
export interface ActAuthority {
  kind: 'authorization' | 'assignment';
  id: string;
  standing: ActAuthorityStanding;
  /** The reader's own one line, so a refusal never invents a second wording for one judgment. */
  reason: string;
  revocations: readonly ActAuthorityRevocation[];
}

export type RecordedActKind = 'selection' | 'relationship' | 'exception' | 'correction';

/** One act this task published that rests on something a revocation can end. */
export interface RecordedAct {
  kind: RecordedActKind;
  id: string;
  scope: AuthorityScope;
  /** The identity the act claims. Claimed and not authenticated; no local act authenticates one. */
  attributed_to: string | null;
  recorded_at: string | null;
  write_sequence: number;
  authority: ActAuthority;
}

/**
 * The facts one snapshot read, for one artifact at one boundary. The answer is the shared one —
 * `projectKnowledgeContext` with the `task` subject — carried whole, because the reasons a
 * revision stopped governing live on the resolver's answer and nowhere else.
 *
 * `acts` keeps currently effective or unresolved acts resting on an authorization or assignment.
 * Ended effects are omitted by the shared resolver, not inferred from historical reasons.
 * Which of the retained acts belong to this task is decided below,
 * where it can be read and tested as one rule rather than spread across a query.
 */
export interface IntegrationAuthorityFacts {
  boundary: number;
  /** The first plan's write sequence: later revisions do not discard this task's acts. */
  plan_write_sequence: number;
  answer: KnowledgeContextAnswer;
  acts: readonly RecordedAct[];
}

export interface MovedObligation {
  /** `<kind>:<entity id>`, as every other knowledge surface names an identity. */
  key: string;
  target: KnowledgeTarget;
  artifact_id: string;
  plan_event_id: string;
  role: string;
  selection: 'selected_with_plan' | 'connected_later';
  step_id: string | null;
  criterion_id: string | null;
  selected_revision_id: string;
  /** What governs instead. Empty says nothing governs this identity at the boundary. */
  governing_revision_ids: readonly string[];
  /** Why it moved, from the resolver's reasons for the selected revision. */
  moved_by: readonly { record: string; record_id: string; effect: string }[];
  /** One line for a person, naming the identity, the revision and what happened to it. */
  statement: string;
}

export interface RevokedActAuthority {
  act: RecordedAct;
  /** What the act rested on, repeated beside the act so a reader needs no second lookup. */
  rested_on: ActAuthority;
  /** What to do about it, in the verbs this product has. */
  lifts: string;
  statement: string;
}

export interface AuthorityAtBoundary {
  boundary: number;
  artifact_id: string;
  plan_event_id: string;
  /** Obligations that moved. The pass reports these and completes needing attention. */
  moved: readonly MovedObligation[];
  /** Acts whose authority no longer stands. The pass refuses while any of these is here. */
  revoked: readonly RevokedActAuthority[];
}

export interface AuthorityBoundaryAt {
  artifactId: string;
  planEventId: string;
  /** Echoed onto the answer, so a finding always says which boundary judged it. */
  boundary: 'now' | number;
  /** The instant an assignment's validity window was judged at. */
  judgedAt: string;
  /**
   * The identity this pass acts as, which is what a project-scoped act is matched against.
   *
   * A captured plan records the agent that captured it and no actor, so there is no "the plan's
   * actor" in this store to ask for; the identity the invocation claims is the nearest true thing,
   * and it is claimed rather than authenticated, as every identity in a local record is. Null
   * leaves every project-scoped act out rather than matching one on nothing.
   */
  actingIdentity: string | null;
}

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The revisions of an entry that govern at the boundary — adopted in a scope this read reaches and
 * not ruled out by applicability. `revisionGoverns` is the one rule every surface says this with,
 * and it is what `knowledgeBlock` puts in `governing_revision_ids`: an obligation moved exactly
 * when the revision a plan selected is not among them.
 */
const governingOf = (entry: KnowledgeContextEntry): string[] =>
  entry.revisions.filter(revisionGoverns).map((revision) => revision.revision.revision_id);

function movedBy(
  entry: KnowledgeContextEntry,
  revisionId: string
): { record: string; record_id: string; effect: string }[] {
  const standing = entry.resolved.revisions.filter(
    (held) => held.revision.revision_id === revisionId
  );
  const reasons = standing.flatMap((held) => [
    ...held.because.filter((reason) => !STANDING_EFFECTS.includes(reason.effect)),
    ...held.departed_in_scope.map((departure) => ({
      record: 'correction' as const,
      record_id: departure.record_id,
      effect: departure.effect,
    })),
  ]);
  const seen = new Set<string>();
  return reasons
    .filter((reason) => {
      const key = `${reason.record}:${reason.record_id}:${reason.effect}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((reason) => ({
      record: reason.record,
      record_id: reason.record_id,
      effect: reason.effect,
    }));
}

const movedStatement = (
  key: string,
  revisionId: string,
  governing: readonly string[],
  reasons: readonly { effect: string }[]
): string => {
  const why =
    reasons.length === 0
      ? 'and this history records no act that moved it'
      : `because it was ${[...new Set(reasons.map((reason) => reason.effect))].sort(byText).join(' and ')}`;
  const instead =
    governing.length === 0
      ? 'Nothing governs it at this boundary'
      : `What governs now: ${governing.join(', ')}`;
  return `The plan selected ${key}@${revisionId}, which no longer governs ${why}. ${instead}.`;
};

function movedFor(
  entry: KnowledgeContextEntry,
  use: KnowledgeContextUse,
  selection: 'selected_with_plan' | 'connected_later',
  governing: readonly string[]
): MovedObligation {
  const reasons = movedBy(entry, use.revision_id);
  const key = knowledgeContextKey(entry.target);
  return {
    key,
    target: entry.target,
    artifact_id: use.artifact_id,
    plan_event_id: use.plan_event_id,
    role: use.role,
    selection,
    step_id: use.step_id,
    criterion_id: use.criterion_id,
    selected_revision_id: use.revision_id,
    governing_revision_ids: governing,
    moved_by: reasons,
    statement: movedStatement(key, use.revision_id, governing, reasons),
  };
}

const ACT_NAMES: Record<RecordedActKind, string> = {
  selection: 'adoption',
  relationship: 'relationship',
  exception: 'exception',
  correction: 'correction',
};

const STANDING_LIFT: Record<RefusingStanding, string> = {
  revoked:
    "End the old act's effect through the supported correction or revocation, then record any " +
    'replacement under a valid instruction or assignment acknowledging the same footprint. ' +
    'A new assignment alone does not authorize the old act.',
  expired:
    "The delegation ended. End the old act's effect, then record any replacement under a valid " +
    'instruction or assignment. A new assignment alone does not authorize the old act.',
  not_judgeable:
    "Establish whether the delegation still covers this act. If it does not, end the old act's " +
    'effect and record any replacement under valid authority; a new assignment alone is not enough.',
};

function revokedFor(act: RecordedAct): RevokedActAuthority {
  const standing = act.authority.standing as RefusingStanding;
  const who = act.authority.revocations
    .map(
      (revocation) =>
        `${revocation.revocation_id} by ${revocation.revoked_by ?? 'an actor this history cannot name'}` +
        `${revocation.recorded_at === null ? '' : ` at ${revocation.recorded_at}`}`
    )
    .join('; ');
  return {
    act,
    rested_on: act.authority,
    lifts: STANDING_LIFT[standing],
    statement:
      `The ${ACT_NAMES[act.kind]} ${act.id} rests on ${act.authority.kind} ${act.authority.id}, ` +
      `which is ${standing} at this boundary: ${act.authority.reason}` +
      `${who === '' ? '' : ` Revoked by ${who}.`}`,
  };
}

/**
 * The acts of this task: published at or after its plan, in the artifact's own scope, or in the
 * project scope by the identity this pass acts as.
 *
 * A project-scoped act by somebody else is the project's and not this task's. Refusing an
 * integration over it would stop work nobody here did, on authority nobody here relied on, which
 * is a refusal a reader cannot act on and would learn to route around.
 */
const actsOfThisTask = (facts: IntegrationAuthorityFacts, at: AuthorityBoundaryAt): RecordedAct[] =>
  facts.acts.filter((act) => {
    if (act.write_sequence < facts.plan_write_sequence) return false;
    if (act.scope.kind === 'artifact') return act.scope.artifact_id === at.artifactId;
    return at.actingIdentity !== null && act.attributed_to === at.actingIdentity;
  });

/**
 * The findings for one artifact's latest plan revision at one boundary.
 *
 * Only the uses of THAT plan event are compared: an earlier revision of the plan is what the task
 * used to say it would do, and holding the work to a selection it has since replaced would report
 * a move nobody made. Roles are the three that claim the task meant to meet the rule — a
 * background use and a proposed change claim nothing about intent, so neither can move.
 */
export function authorityAtBoundary(
  facts: IntegrationAuthorityFacts,
  at: AuthorityBoundaryAt
): AuthorityAtBoundary {
  const moved: MovedObligation[] = [];
  for (const entry of facts.answer.entries) {
    const governing = governingOf(entry);
    const lists = [
      ['selected_with_plan', entry.selected_with_plan],
      ['connected_later', entry.connected_later],
    ] as const;
    for (const [selection, uses] of lists)
      for (const use of uses) {
        if (use.plan_event_id !== at.planEventId) continue;
        if (!OBLIGED_ROLES.includes(use.role)) continue;
        if (governing.includes(use.revision_id)) continue;
        moved.push(movedFor(entry, use, selection, governing));
      }
  }
  return {
    boundary: facts.boundary,
    artifact_id: at.artifactId,
    plan_event_id: at.planEventId,
    moved: moved.sort(
      (left, right) =>
        byText(left.key, right.key) ||
        byText(left.selected_revision_id, right.selected_revision_id) ||
        byText(left.role, right.role)
    ),
    revoked: actsOfThisTask(facts, at)
      .filter((act) => refusingStanding(act.authority.standing))
      .sort(
        (left, right) => left.write_sequence - right.write_sequence || byText(left.id, right.id)
      )
      .map(revokedFor),
  };
}

/**
 * What the marker payload carries: the identities and the reasons, never the wording.
 *
 * A rule's statement is captured prose, and the marker is an authored event that the secret gate
 * reads before it is written; a statement carried here would let a rule whose words look like a
 * credential refuse the pre-PR pass outright. The wording is in the response, which is read from
 * the same store the reader can already ask.
 */
export interface RetainedAuthorityFindings {
  moved: {
    key: string;
    selected_revision_id: string;
    governing_revision_ids: string[];
    role: string;
    effects: string[];
  }[];
  /** Always empty on a marker: a pass with revoked authority refuses and mints none. */
  revoked: string[];
}

export function retainedAuthorityFindings(
  findings: AuthorityAtBoundary
): RetainedAuthorityFindings {
  return {
    moved: findings.moved.map((entry) => ({
      key: entry.key,
      selected_revision_id: entry.selected_revision_id,
      governing_revision_ids: [...entry.governing_revision_ids],
      role: entry.role,
      effects: [...new Set(entry.moved_by.map((reason) => reason.effect))].sort(byText),
    })),
    revoked: findings.revoked.map((entry) => entry.act.id),
  };
}
