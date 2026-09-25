// What else a change reaches, from the record and nothing else.
//
// A pure traversal over the shared context answer and the rows the consequence readers return. It
// starts where the record actually connects a change to other work — the exact task uses of the
// revision that moved, the plan events and artifacts those uses belong to, the assessments that
// weighed it, and the code those artifacts recorded a touch of — and then follows typed
// dependencies, recorded assumptions and shared subjects to a configured depth and count.
//
// What it must keep apart, because conflating any pair of them is how a suggestion becomes a
// verdict:
//
// - a link somebody recorded from one this traversal inferred;
// - a relationship an actor established from one a detector only suggested;
// - a mapping this store cannot make from an answer that nothing is affected;
// - reaching an item from that item being wrong.
//
// It writes nothing, reads nothing and calls no model: every fact it uses was handed to it, and
// the same facts always give the same answer.
import type { Attribution, KnowledgeTarget, RecordRevisionRef } from '@orcaops/storage';

import type { KnowledgeContextAnswer } from '../context/answer.js';

/** Recorded by somebody, or worked out here from something that is not a link. */
export type ConsequenceLinkBasis = 'explicit' | 'inferred';

/** How the change the traversal starts from moved, where the caller knows. */
export type RevisionMovement = 'adopted' | 'replaced' | 'withdrawn' | 'corrected' | 'unstated';

export type ConsequenceChange =
  /**
   * An expectation or finding whose standing moved. `revision_id` is the exact revision that
   * moved, or null where the caller named the identity and not one of its revisions; either way
   * every recorded use of the identity is reached, and each path says which revision it names.
   */
  | {
      readonly kind: 'revision';
      readonly identity: KnowledgeTarget;
      readonly revision_id: string | null;
      readonly moved: RevisionMovement;
    }
  /** A decision whose recorded assumption or reconsideration condition is named as changed. */
  | {
      readonly kind: 'assumption';
      readonly identity: KnowledgeTarget;
      readonly revision_id: string | null;
      readonly named: string;
    }
  /** An implementation, named by the code it changed. */
  | { readonly kind: 'implementation'; readonly paths: readonly string[] };

export type ConsequenceItem =
  | {
      readonly kind: 'identity';
      readonly target: KnowledgeTarget;
      /** The exact revision the link named, where one did. */
      readonly revision_id: string | null;
    }
  | { readonly kind: 'plan_event'; readonly artifact_id: string; readonly plan_event_id: string }
  | { readonly kind: 'artifact'; readonly artifact_id: string }
  | { readonly kind: 'assessment'; readonly assessment_id: string }
  | { readonly kind: 'code_path'; readonly path: string };

export type ConsequenceRelation =
  | 'task_use'
  | 'plan_event_of'
  | 'recorded_touch'
  | 'assessed_expectation'
  | 'assessed_input'
  | 'depends_on'
  | 'motivates'
  | 'recorded_assumption'
  | 'shared_subject';

/** Every relation this traversal knows how to follow, which is what its coverage names. */
export const CONSEQUENCE_RELATIONS: readonly ConsequenceRelation[] = [
  'task_use',
  'plan_event_of',
  'recorded_touch',
  'assessed_expectation',
  'assessed_input',
  'depends_on',
  'motivates',
  'recorded_assumption',
  'shared_subject',
];

export interface ConsequenceStep {
  readonly from: ConsequenceItem;
  readonly to: ConsequenceItem;
  readonly relation: ConsequenceRelation;
  readonly basis: ConsequenceLinkBasis;
  /** `established` or `suggested` for a typed relationship; null for every other link. */
  readonly standing: string | null;
  /** Why this link is here, in one line a reader can check against the record it names. */
  readonly reason: string;
  /** The record the link is read from, so a reader can drill into it. */
  readonly record_id: string | null;
}

export interface ConsequenceOwner {
  readonly name: string;
  readonly basis: string;
  /** Which record names them, because an owner nobody can trace is an assertion. */
  readonly from: string;
}

export interface AffectedConsequence {
  readonly key: string;
  readonly item: ConsequenceItem;
  /** How many links from the change the shortest kept path is. */
  readonly depth: number;
  /** `explicit` only when some kept path is recorded end to end. */
  readonly basis: ConsequenceLinkBasis;
  /** The link that reached it, which is never absent. */
  readonly reason: string;
  /** The full path from the change, shortest first. Never empty. */
  readonly paths: readonly (readonly ConsequenceStep[])[];
  readonly paths_omitted: number;
  readonly owner: ConsequenceOwner | null;
  /** False when no answer this traversal was given holds a record of it at the boundary. */
  readonly read_at_boundary: boolean;
}

export interface ConsequenceLimit {
  readonly kind: string;
  readonly detail: string;
}

export interface ConsequenceBounds {
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxPathsPerItem: number;
}

export interface ConsequenceCoverage {
  readonly statement: string;
  readonly relations_followed: readonly ConsequenceRelation[];
  readonly items_reached: number;
  /** Items with a route at the depth bound that was not followed farther. */
  readonly items_not_expanded: number;
  readonly deepest_reached: number;
}

export interface ConsequenceAnswer {
  readonly change: ConsequenceChange;
  readonly basis: {
    readonly knowledge_boundary: number;
    readonly bounds: ConsequenceBounds;
  };
  readonly start: readonly ConsequenceItem[];
  readonly affected: readonly AffectedConsequence[];
  readonly limits: readonly ConsequenceLimit[];
  readonly coverage: ConsequenceCoverage;
}

// ── the facts a traversal is given ───────────────────────────────────────────

export interface ConsequenceActor {
  readonly kind: string;
  readonly name: string | null;
  readonly basis: string | null;
}

export interface ConsequenceRelationshipFact {
  readonly relationship_id: string;
  readonly relation: string;
  readonly standing: string;
  readonly from: RecordRevisionRef;
  readonly to: RecordRevisionRef;
  readonly explanation: string | null;
  readonly attributed_to: ConsequenceActor;
}

export interface ConsequenceAssumptionFact {
  readonly decision: RecordRevisionRef;
  readonly where: 'assumption' | 'reconsideration_condition';
  readonly text: string;
  /** The identity the wording names, which is the end this link is followed from. */
  readonly names: KnowledgeTarget;
  readonly authored_by: ConsequenceActor;
}

export interface ConsequenceAssessmentFact {
  readonly assessment_id: string;
  readonly assessed_by: ConsequenceActor;
  /** The expectation revision it concluded about, where that is how it was reached. */
  readonly expectation: RecordRevisionRef | null;
  readonly conclusion: string | null;
  /** The software it identified, which is what an implementation change is looked for in. */
  readonly selected_inputs: readonly { readonly kind: string; readonly identity: string }[];
}

export interface ConsequenceCodeAssociationFact {
  readonly artifact_id: string;
  /** The path the artifact recorded a touch of. */
  readonly file_path: string;
  /** The path a caller named, which is the one an answer reaches this association under. */
  readonly asked: string;
  /** True when the artifact recorded a touch of the path asked about, false for a pattern match. */
  readonly recorded_touch: boolean;
}

export interface ConsequenceSubjectFact {
  readonly subject_id: string;
  readonly of: RecordRevisionRef;
  readonly identity: KnowledgeTarget;
}

export interface ConsequencePlanEventFact {
  readonly artifact_id: string;
  readonly plan_event_id: string;
}

export interface ConsequenceFacts {
  readonly boundary: number;
  /** The shared answers the identities were read under, all at the same boundary. */
  readonly answers: readonly KnowledgeContextAnswer[];
  readonly relationships: readonly ConsequenceRelationshipFact[];
  readonly assumptions: readonly ConsequenceAssumptionFact[];
  readonly assessments: readonly ConsequenceAssessmentFact[];
  readonly code_associations: readonly ConsequenceCodeAssociationFact[];
  readonly subjects: readonly ConsequenceSubjectFact[];
  /** The plan events of the artifacts this read reached, so an artifact is not a dead end. */
  readonly plan_events: readonly ConsequencePlanEventFact[];
  /** What the readers could not reach, in their own words. */
  readonly limits: readonly ConsequenceLimit[];
}

// ── keys and ordering ────────────────────────────────────────────────────────

/** Deduplication is by identity, so a revision is never part of an item's key. */
export function consequenceItemKey(item: ConsequenceItem): string {
  switch (item.kind) {
    case 'identity':
      return `${item.target.kind}:${item.target.entity_id}`;
    case 'plan_event':
      return `plan_event:${item.plan_event_id}`;
    case 'artifact':
      return `artifact:${item.artifact_id}`;
    case 'assessment':
      return `assessment:${item.assessment_id}`;
    case 'code_path':
      return `code_path:${item.path}`;
  }
}

const identityKeyOf = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const pathKey = (path: readonly ConsequenceStep[]) =>
  path
    .map((step) => `${step.relation}\0${step.record_id ?? ''}\0${consequenceItemKey(step.to)}`)
    .join('\x01');

/** How many keys a limit names before it stops counting them out loud. */
const NAMED_IN_A_LIMIT = 5;

const namedKeys = (keys: readonly string[]): string => {
  const sorted = [...new Set(keys)].sort(byText);
  return sorted.length <= NAMED_IN_A_LIMIT
    ? sorted.join(', ')
    : `${sorted.slice(0, NAMED_IN_A_LIMIT).join(', ')} and ${sorted.length - NAMED_IN_A_LIMIT} more`;
};

const actorOwner = (actor: ConsequenceActor | null, from: string): ConsequenceOwner | null =>
  actor === null || actor.kind !== 'actor' || actor.name === null
    ? null
    : { name: actor.name, basis: actor.basis ?? 'unknown', from };

const attributionActor = (attribution: Attribution | null): ConsequenceActor | null =>
  attribution === null
    ? null
    : attribution.kind === 'actor'
      ? { kind: 'actor', name: attribution.actor.identity, basis: attribution.actor.basis }
      : { kind: 'detector', name: attribution.detector, basis: null };

// ── the graph the facts describe ─────────────────────────────────────────────

interface TaskUseFact {
  readonly identity: KnowledgeTarget;
  readonly revision_id: string;
  readonly artifact_id: string;
  readonly plan_event_id: string;
  readonly role: string;
  readonly selected_with_plan: boolean;
  readonly discovered_by: ConsequenceActor | null;
}

const push = <T>(index: Map<string, T[]>, key: string, value: T) => {
  const held = index.get(key);
  if (held === undefined) index.set(key, [value]);
  else held.push(value);
};

/**
 * The task uses the shared answers already carry, in one list. Which of the answer's two lists a
 * use came from is kept on the fact, so a connection somebody found after the task never reads as
 * the task's own selection in a reason line.
 */
function taskUsesOf(answers: readonly KnowledgeContextAnswer[]): TaskUseFact[] {
  const uses: TaskUseFact[] = [];
  for (const answer of answers)
    for (const entry of answer.entries)
      for (const [list, selected] of [
        [entry.selected_with_plan, true],
        [entry.connected_later, false],
      ] as const)
        for (const use of list)
          uses.push({
            identity: entry.target,
            revision_id: use.revision_id,
            artifact_id: use.artifact_id,
            plan_event_id: use.plan_event_id,
            role: use.role,
            selected_with_plan: selected,
            discovered_by:
              use.discovered_by === null
                ? null
                : {
                    kind: use.discovered_by.kind,
                    name: use.discovered_by.name,
                    basis: use.discovered_by.basis,
                  },
          });
  return uses;
}

interface Graph {
  readonly edgesFrom: (item: ConsequenceItem) => ConsequenceStep[];
  readonly owners: ReadonlyMap<string, ConsequenceOwner>;
  readonly known: ReadonlySet<string>;
}

const FOLLOWED_RELATIONS = new Set(['depends_on', 'motivates']);

function buildGraph(facts: ConsequenceFacts): Graph {
  const usesByIdentity = new Map<string, TaskUseFact[]>();
  const usesByPlanEvent = new Map<string, TaskUseFact[]>();
  for (const use of taskUsesOf(facts.answers)) {
    push(usesByIdentity, identityKeyOf(use.identity), use);
    push(usesByPlanEvent, use.plan_event_id, use);
  }

  // Both directions of "this plan event belongs to this artifact", from the events the read
  // reached and from the events its uses name, so an artifact a code association found leads on
  // to the work it was planned for instead of ending the walk.
  const planEventsByArtifact = new Map<string, Set<string>>();
  for (const { artifact_id, plan_event_id } of [
    ...facts.plan_events,
    ...[...usesByPlanEvent.values()].flat(),
  ]) {
    const held = planEventsByArtifact.get(artifact_id);
    if (held === undefined) planEventsByArtifact.set(artifact_id, new Set([plan_event_id]));
    else held.add(plan_event_id);
  }

  const assessmentsByExpectation = new Map<string, ConsequenceAssessmentFact[]>();
  const assessmentsByPath = new Map<string, ConsequenceAssessmentFact[]>();
  for (const assessment of facts.assessments) {
    if (assessment.expectation !== null)
      push(assessmentsByExpectation, identityKeyOf(assessment.expectation), assessment);
    for (const input of assessment.selected_inputs)
      if (input.kind === 'file') push(assessmentsByPath, input.identity, assessment);
  }

  const relationshipsByIdentity = new Map<string, ConsequenceRelationshipFact[]>();
  for (const relationship of facts.relationships) {
    if (!FOLLOWED_RELATIONS.has(relationship.relation)) continue;
    push(relationshipsByIdentity, identityKeyOf(relationship.from), relationship);
    push(relationshipsByIdentity, identityKeyOf(relationship.to), relationship);
  }

  const assumptionsByNamed = new Map<string, ConsequenceAssumptionFact[]>();
  for (const assumption of facts.assumptions)
    push(assumptionsByNamed, identityKeyOf(assumption.names), assumption);

  const subjectsByIdentity = new Map<string, ConsequenceSubjectFact[]>();
  for (const subject of facts.subjects)
    push(subjectsByIdentity, identityKeyOf(subject.of), subject);

  const codeByPath = new Map<string, ConsequenceCodeAssociationFact[]>();
  const codeByArtifact = new Map<string, ConsequenceCodeAssociationFact[]>();
  for (const association of facts.code_associations) {
    // Indexed by the path a caller asked about, which is the item a walk reaches it under: a
    // pattern match's recorded path is a different path, and looking it up under that one would
    // lose it.
    push(codeByPath, association.asked, association);
    push(codeByArtifact, association.artifact_id, association);
  }

  const owners = new Map<string, ConsequenceOwner>();
  const remember = (key: string, owner: ConsequenceOwner | null) => {
    if (owner !== null && !owners.has(key)) owners.set(key, owner);
  };
  const known = new Set<string>();
  for (const answer of facts.answers)
    for (const entry of answer.entries) {
      known.add(entry.key);
      // A standing assignment names who is responsible for this work; whoever happened to author a
      // revision of it, or to find a connection to it later, did not take that on.
      for (const assignment of entry.assignments ?? [])
        if (assignment.standing === 'valid')
          remember(
            entry.key,
            actorOwner(
              {
                kind: 'actor',
                name: assignment.responsible.identity,
                basis: assignment.responsible.basis,
              },
              `the party assignment ${assignment.assignment_id} makes responsible`
            )
          );
      for (const revision of entry.revisions)
        remember(
          entry.key,
          actorOwner(
            attributionActor(revision.attributed_to),
            `the actor revision ${revision.revision.revision_id} is attributed to`
          )
        );
    }
  for (const assessment of facts.assessments)
    remember(
      `assessment:${assessment.assessment_id}`,
      actorOwner(assessment.assessed_by, 'the assessor this assessment records')
    );
  for (const use of usesByIdentity.values())
    for (const entry of use)
      remember(
        `plan_event:${entry.plan_event_id}`,
        actorOwner(entry.discovered_by, 'the actor recorded as finding this connection')
      );

  const identityItem = (revision: RecordRevisionRef): ConsequenceItem => ({
    kind: 'identity',
    target: { kind: revision.kind, entity_id: revision.entity_id },
    revision_id: revision.revision_id,
  });

  const edgesFrom = (item: ConsequenceItem): ConsequenceStep[] => {
    const steps: ConsequenceStep[] = [];
    if (item.kind === 'identity') {
      const key = identityKeyOf(item.target);
      for (const use of usesByIdentity.get(key) ?? [])
        steps.push({
          from: item,
          to: {
            kind: 'plan_event',
            artifact_id: use.artifact_id,
            plan_event_id: use.plan_event_id,
          },
          relation: 'task_use',
          basis: 'explicit',
          standing: null,
          reason:
            `Plan event ${use.plan_event_id} of artifact ${use.artifact_id} records a ` +
            `${use.role} use of revision ${use.revision_id}, ` +
            `${use.selected_with_plan ? 'selected with the plan' : 'connected later'}.`,
          record_id: use.plan_event_id,
        });
      for (const assessment of assessmentsByExpectation.get(key) ?? [])
        steps.push({
          from: item,
          to: { kind: 'assessment', assessment_id: assessment.assessment_id },
          relation: 'assessed_expectation',
          basis: 'explicit',
          standing: null,
          reason:
            `Assessment ${assessment.assessment_id} concluded ` +
            `${assessment.conclusion ?? 'about'} for revision ` +
            `${assessment.expectation?.revision_id ?? 'unknown'}.`,
          record_id: assessment.assessment_id,
        });
      for (const relationship of relationshipsByIdentity.get(key) ?? []) {
        const far = identityKeyOf(relationship.from) === key ? relationship.to : relationship.from;
        if (identityKeyOf(far) === key) continue;
        const established = relationship.standing === 'established';
        steps.push({
          from: item,
          to: identityItem(far),
          relation: relationship.relation as ConsequenceRelation,
          // An established link is one somebody made stand. A suggested one was proposed and
          // never established — all a detector can write — so it is this answer's inference and
          // never reads as a recorded dependency.
          basis: established ? 'explicit' : 'inferred',
          standing: relationship.standing,
          reason:
            `Relationship ${relationship.relationship_id}: ` +
            `${relationship.from.kind} ${relationship.from.entity_id} revision ` +
            `${relationship.from.revision_id} ${relationship.relation.replaceAll('_', ' ')} ` +
            `${relationship.to.kind} ${relationship.to.entity_id} revision ` +
            `${relationship.to.revision_id}, ${relationship.standing}` +
            `${relationship.explanation === null ? '' : ` — ${relationship.explanation}`}. ` +
            `Being linked is not being wrong.`,
          record_id: relationship.relationship_id,
        });
      }
      for (const assumption of assumptionsByNamed.get(key) ?? [])
        steps.push({
          from: item,
          to: identityItem(assumption.decision),
          relation: 'recorded_assumption',
          basis: 'explicit',
          standing: null,
          reason:
            `Decision ${assumption.decision.entity_id} revision ` +
            `${assumption.decision.revision_id} records the ` +
            `${assumption.where.replaceAll('_', ' ')} "${assumption.text}", which names this ` +
            `identity. A changed assumption suggests reconsideration and opens no defect.`,
          record_id: assumption.decision.revision_id,
        });
      for (const subject of subjectsByIdentity.get(key) ?? [])
        steps.push({
          from: item,
          to: { kind: 'identity', target: subject.identity, revision_id: null },
          relation: 'shared_subject',
          // Nobody recorded a link between the two: they name the same subject, which is this
          // answer's own inference about what they are both about.
          basis: 'inferred',
          standing: null,
          reason:
            `Revision ${subject.of.revision_id} names subject ${subject.subject_id}, and a ` +
            `revision of ${subject.identity.kind} ${subject.identity.entity_id} names it too. ` +
            `A shared subject is an area in common, not a recorded link.`,
          record_id: subject.subject_id,
        });
      return steps;
    }
    if (item.kind === 'plan_event') {
      steps.push({
        from: item,
        to: { kind: 'artifact', artifact_id: item.artifact_id },
        relation: 'plan_event_of',
        basis: 'explicit',
        standing: null,
        reason: `Plan event ${item.plan_event_id} belongs to artifact ${item.artifact_id}.`,
        record_id: item.artifact_id,
      });
      for (const use of usesByPlanEvent.get(item.plan_event_id) ?? [])
        steps.push({
          from: item,
          to: {
            kind: 'identity',
            target: use.identity,
            revision_id: use.revision_id,
          },
          relation: 'task_use',
          basis: 'explicit',
          standing: null,
          reason:
            `Plan event ${item.plan_event_id} records a ${use.role} use of ` +
            `${use.identity.kind} ${use.identity.entity_id} revision ${use.revision_id}, ` +
            `${use.selected_with_plan ? 'selected with the plan' : 'connected later'}.`,
          record_id: use.revision_id,
        });
      return steps;
    }
    if (item.kind === 'artifact') {
      for (const planEventId of [...(planEventsByArtifact.get(item.artifact_id) ?? [])].sort(
        byText
      ))
        steps.push({
          from: item,
          to: { kind: 'plan_event', artifact_id: item.artifact_id, plan_event_id: planEventId },
          relation: 'plan_event_of',
          basis: 'explicit',
          standing: null,
          reason: `Artifact ${item.artifact_id} captured plan event ${planEventId}.`,
          record_id: planEventId,
        });
      for (const association of codeByArtifact.get(item.artifact_id) ?? [])
        if (association.recorded_touch)
          steps.push({
            from: item,
            to: { kind: 'code_path', path: association.file_path },
            relation: 'recorded_touch',
            basis: 'explicit',
            standing: null,
            reason:
              `Artifact ${item.artifact_id} recorded a touch of ${association.file_path}. ` +
              `A recorded touch is not proof the code implements anything.`,
            record_id: association.file_path,
          });
      return steps;
    }
    if (item.kind === 'code_path') {
      for (const association of codeByPath.get(item.path) ?? [])
        steps.push({
          from: item,
          to: { kind: 'artifact', artifact_id: association.artifact_id },
          relation: 'recorded_touch',
          // An artifact that recorded a touch of this very path is a retained association; one
          // whose recorded path merely matched the pattern asked about is this answer's guess at
          // which paths the caller meant.
          basis: association.recorded_touch ? 'explicit' : 'inferred',
          standing: null,
          reason: association.recorded_touch
            ? `Artifact ${association.artifact_id} recorded a touch of ${item.path}.`
            : `Artifact ${association.artifact_id} recorded a touch of ` +
              `${association.file_path}, which matches ${item.path} as a pattern.`,
          record_id: association.artifact_id,
        });
      for (const assessment of assessmentsByPath.get(item.path) ?? [])
        steps.push({
          from: item,
          to: { kind: 'assessment', assessment_id: assessment.assessment_id },
          relation: 'assessed_input',
          basis: 'explicit',
          standing: null,
          reason:
            `Assessment ${assessment.assessment_id} selected file ${item.path} as one of the ` +
            `inputs it judged.`,
          record_id: assessment.assessment_id,
        });
      return steps;
    }
    // An assessment is where a path ends. Its other conclusions are about other expectations and
    // say nothing about this change, and fanning out through them would turn one changed rule
    // into every rule the same run happened to look at.
    return [];
  };

  return { edgesFrom, owners, known };
}

// ── the traversal ────────────────────────────────────────────────────────────

interface Reached {
  readonly item: ConsequenceItem;
  depth: number;
  paths: ConsequenceStep[][];
  pathsOmitted: number;
}

const startItemsOf = (change: ConsequenceChange): ConsequenceItem[] => {
  if (change.kind === 'implementation')
    return [...new Set(change.paths)].sort(byText).map((path) => ({ kind: 'code_path', path }));
  return [{ kind: 'identity', target: change.identity, revision_id: change.revision_id }];
};

/**
 * What the record reaches from one change, bounded and deduplicated.
 *
 * Every kept path is expanded once, in order of depth, so a path discovered after its item still
 * reaches downstream work. A cycle ends that path rather than repeating it, and many copies of one
 * identity remain one item with every path that found it. A route stopped at the depth bound, a
 * link that closed a loop, a path beyond the per-item cap and an item beyond the count are each
 * named in `limits`: a bound may shorten an answer, and it may never turn what was not looked at
 * into nothing to look at.
 */
export function traceConsequences(
  change: ConsequenceChange,
  facts: ConsequenceFacts,
  bounds: ConsequenceBounds
): ConsequenceAnswer {
  const graph = buildGraph(facts);
  const start = startItemsOf(change);
  const startKeys = new Set(start.map(consequenceItemKey));
  const reached = new Map<string, Reached>();
  for (const item of start)
    reached.set(consequenceItemKey(item), {
      item,
      depth: 0,
      paths: [[]],
      pathsOmitted: 0,
    });

  const cycles: string[] = [];
  const beyondCount = new Set<string>();
  const notExpanded: string[] = [];
  let deepest = 0;

  const addPath = (held: Reached, path: ConsequenceStep[]): boolean => {
    if (held.paths.some((kept) => pathKey(kept) === pathKey(path))) return false;
    if (held.paths.length >= bounds.maxPathsPerItem) {
      held.pathsOmitted += 1;
      return false;
    }
    held.paths.push(path);
    return true;
  };

  let frontier = [...startKeys].map((key) => ({ key, path: [] as ConsequenceStep[] }));
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= bounds.maxDepth) {
      notExpanded.push(...new Set(frontier.map(({ key }) => key)));
      break;
    }
    const next: { key: string; path: ConsequenceStep[] }[] = [];
    for (const { key, path } of frontier) {
      const held = reached.get(key);
      if (held === undefined) continue;
      const steps = graph.edgesFrom(held.item);
      if (steps.length === 0) continue;
      const onPath = new Set([key, ...path.map((step) => consequenceItemKey(step.from))]);
      for (const step of steps) {
        const toKey = consequenceItemKey(step.to);
        // A link back onto this very path ends it here: following it would walk the same items
        // again, and imported history is allowed to be cyclic.
        if (onPath.has(toKey)) {
          cycles.push(toKey);
          continue;
        }
        const candidate = [...path, step];
        let target = reached.get(toKey);
        if (target === undefined) {
          if (reached.size >= bounds.maxItems) {
            beyondCount.add(toKey);
            continue;
          }
          target = { item: step.to, depth: candidate.length, paths: [], pathsOmitted: 0 };
          reached.set(toKey, target);
        }
        if (addPath(target, candidate)) {
          deepest = Math.max(deepest, candidate.length);
          next.push({ key: toKey, path: candidate });
        }
      }
    }
    frontier = next;
  }

  const affected = [...reached.entries()]
    .filter(([key]) => !startKeys.has(key))
    .sort(
      ([leftKey, left], [rightKey, right]) => left.depth - right.depth || byText(leftKey, rightKey)
    )
    .map(([key, held]) => {
      const paths = [...held.paths].sort((left, right) => left.length - right.length);
      const first = paths[0]!;
      return {
        key,
        item: held.item,
        depth: held.depth,
        basis: paths.some((path) => path.every((step) => step.basis === 'explicit'))
          ? ('explicit' as const)
          : ('inferred' as const),
        reason: first[first.length - 1]!.reason,
        paths,
        paths_omitted: held.pathsOmitted,
        owner: graph.owners.get(key) ?? null,
        read_at_boundary: held.item.kind !== 'identity' || graph.known.has(key),
      } satisfies AffectedConsequence;
    });

  return {
    change,
    basis: { knowledge_boundary: facts.boundary, bounds },
    start,
    affected,
    limits: [
      ...facts.limits,
      ...traversalLimits({ affected, cycles, beyondCount, notExpanded, bounds }),
    ],
    coverage: {
      statement:
        `This answer followed the recorded task uses, code associations, assessment inputs, ` +
        `typed dependencies, recorded assumptions and shared subjects it could reach from the ` +
        `change, at write sequence ${facts.boundary}, to at most ${bounds.maxDepth} link(s) and ` +
        `${bounds.maxItems} item(s). It is what this history records reaching, and it is not ` +
        `complete impact coverage: a dependency nobody recorded, a capture nothing interpreted ` +
        `and a mapping this store cannot make are not here. Reaching an item is not a finding ` +
        `that the item is wrong.`,
      relations_followed: CONSEQUENCE_RELATIONS,
      items_reached: affected.length,
      items_not_expanded: notExpanded.filter((key) => !startKeys.has(key)).length,
      deepest_reached: deepest,
    },
  };
}

function traversalLimits(input: {
  affected: readonly AffectedConsequence[];
  cycles: readonly string[];
  beyondCount: ReadonlySet<string>;
  notExpanded: readonly string[];
  bounds: ConsequenceBounds;
}): ConsequenceLimit[] {
  const limits: ConsequenceLimit[] = [];
  const unread = input.affected
    .filter((entry) => !entry.read_at_boundary)
    .map((entry) => entry.key);
  if (unread.length > 0)
    limits.push({
      kind: 'missing_endpoint',
      detail:
        `${unread.length} link(s) name an identity this read holds no record of at the ` +
        `boundary, so what it says and whether it stands could not be read: ` +
        `${namedKeys(unread)}. The link is reported; the endpoint is not resolved.`,
    });
  if (input.cycles.length > 0)
    limits.push({
      kind: 'cycle',
      detail:
        `${input.cycles.length} link(s) pointed back at an item already on the path they were ` +
        `found from and were not followed: ${namedKeys(input.cycles)}. The walk ends there ` +
        `rather than repeating those items.`,
    });
  if (input.beyondCount.size > 0)
    limits.push({
      kind: 'item_count',
      detail:
        `${input.beyondCount.size} item(s) were not reached: this answer carries at most ` +
        `${input.bounds.maxItems}. Left out: ${namedKeys([...input.beyondCount])}.`,
    });
  if (input.notExpanded.length > 0)
    limits.push({
      kind: 'depth_bound',
      detail:
        `${input.notExpanded.length} item(s) had a route reach ${input.bounds.maxDepth} link(s) ` +
        `from the change and that route was not followed farther: ` +
        `${namedKeys(input.notExpanded)}. What lies past them was not looked at.`,
    });
  const omitted = input.affected.filter((entry) => entry.paths_omitted > 0);
  if (omitted.length > 0)
    limits.push({
      kind: 'path_count',
      detail:
        `${omitted.reduce((total, entry) => total + entry.paths_omitted, 0)} further path(s) to ` +
        `${omitted.length} item(s) were not kept: this answer keeps at most ` +
        `${input.bounds.maxPathsPerItem} per item. Affected: ${namedKeys(omitted.map((entry) => entry.key))}.`,
    });
  return limits;
}
