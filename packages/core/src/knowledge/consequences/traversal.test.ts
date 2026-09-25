import { describe, expect, it } from 'vitest';

import type {
  AssignmentStandingEntry,
  ExpectationRevisionRef,
  KnowledgeTarget,
  RecordRevisionRef,
} from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
  ProjectKnowledgeContextUse,
} from '@orcaops/storage/history/database';

import {
  type ConsequenceAnswer,
  type ConsequenceBounds,
  type ConsequenceChange,
  type ConsequenceFacts,
  consequenceItemKey,
  traceConsequences,
} from './traversal.js';
import { knowledgeContextAnswer, type KnowledgeContextAnswer } from '../context/answer.js';
import {
  existingKnowledge,
  type ExistingRevision,
  KNOWLEDGE_BOUNDARY,
  PROJECT,
} from '../interpretation/evaluation/knowledge.js';

const ARTIFACT = 'artifact-sync';
const PLAN_EVENT = 'plan-event-sync';
const OTHER_ARTIFACT = 'artifact-reporting';
const OTHER_PLAN_EVENT = 'plan-event-reporting';

const OFFLINE: ExistingRevision = {
  kind: 'requirement',
  entity_id: 'requirement-offline',
  revision_id: 'requirement-offline-r2',
  text: 'The app keeps working with no network.',
};
const QUEUE: ExistingRevision = {
  kind: 'decision',
  entity_id: 'decision-queue',
  revision_id: 'decision-queue-r1',
  text: 'Hold unsent work in a local queue.',
};
const RETRY: ExistingRevision = {
  kind: 'decision',
  entity_id: 'decision-retry',
  revision_id: 'decision-retry-r1',
  text: 'Retry a failed send with bounded backoff.',
};
const EXPORT: ExistingRevision = {
  kind: 'requirement',
  entity_id: 'requirement-export',
  revision_id: 'requirement-export-r1',
  text: 'A report can be exported while offline.',
};
const CHANGE: ConsequenceChange = {
  kind: 'revision',
  identity: { kind: 'requirement', entity_id: OFFLINE.entity_id },
  revision_id: OFFLINE.revision_id,
  moved: 'replaced',
};
const BOUNDS: ConsequenceBounds = { maxDepth: 4, maxItems: 50, maxPathsPerItem: 3 };

const revisionOf = (record: ExistingRevision): RecordRevisionRef =>
  ({
    kind: record.kind,
    entity_id: record.entity_id,
    revision_id: record.revision_id,
  }) as RecordRevisionRef;

const identityOf = (record: ExistingRevision): KnowledgeTarget =>
  ({ kind: record.kind, entity_id: record.entity_id }) as KnowledgeTarget;

function useOf(
  record: ExistingRevision,
  where: { artifactId: string; planEventId: string }
): ProjectKnowledgeContextUse {
  return {
    use: {
      artifactId: where.artifactId,
      planEventId: where.planEventId,
      target: {
        kind: record.kind,
        entityId: record.entity_id,
        revisionId: record.revision_id,
      },
      role: 'implement',
      stepId: null,
      criterionId: null,
      exceptionId: null,
      selectionKind: 'selected_with_plan',
      discoveredAt: null,
      discoveredBy: null,
      recordHex: '00',
      recordSha256: 'a'.repeat(64),
      operationId: `operation-${where.planEventId}`,
    },
    writeSequence: 1,
  };
}

/** A standing delegation naming one identity, as the composer reads it back. */
const assignmentOver = (record: ExistingRevision): AssignmentStandingEntry => ({
  assignment_id: `assignment-${record.entity_id}`,
  objective: 'Keep the offline promise working.',
  responsible: { identity: 'the-retry-team', basis: 'other_assertion' },
  scope: PROJECT,
  inherits: [revisionOf(record) as ExpectationRevisionRef],
  delegates: { adopts: [], departs_from: [], restates: [] },
  escalation_conditions: [],
  valid_until: null,
  standing: 'valid',
  reason: 'It still stands.',
  revoked_by: [],
});

function entryFor(
  record: ExistingRevision,
  uses: readonly ProjectKnowledgeContextUse[] = [],
  assignments?: readonly AssignmentStandingEntry[]
): ProjectKnowledgeContextEntry {
  const knowledge = existingKnowledge(record);
  return {
    target: knowledge.resolved.target,
    routes: ['requested'],
    resolved: knowledge.resolved,
    revisions: [
      {
        revisionId: record.revision_id,
        previousRevisionId: null,
        writeSequence: 1,
        operationId: 'operation-1',
      },
    ],
    tips: [],
    statements: knowledge.statements,
    selectedWithPlan: uses,
    connectedLater: [],
    references: [],
    criterion: null,
    ...(assignments === undefined ? {} : { assignments }),
  };
}

const answerOf = (entries: readonly ProjectKnowledgeContextEntry[]): KnowledgeContextAnswer =>
  knowledgeContextAnswer(
    {
      request: {
        scope: PROJECT,
        mode: 'current',
        knowledge_boundary: KNOWLEDGE_BOUNDARY,
        implementation: { kind: 'none_selected' },
        applicability: {},
        exceptions_judged_at: null,
        exception_conditions: {},
      },
      coverage: {
        scope: PROJECT,
        mode: 'current',
        boundary: KNOWLEDGE_BOUNDARY,
        omitted: [],
        unresolved: [],
        later: [],
        branchScoped: [],
      },
      entries,
      absent: [],
      retrieval: null,
      omissions: [],
    } satisfies ProjectKnowledgeContext,
    null
  );

/**
 * One store's worth of links around a changed requirement: a plan that used it beside a decision,
 * an established dependency, a suggested one, a recorded assumption, a shared subject, an
 * assessment, code the plan's artifact touched, and a dependency whose far endpoint this read
 * holds no record of. The decision is reachable three ways on purpose.
 */
function facts(): ConsequenceFacts {
  return {
    boundary: KNOWLEDGE_BOUNDARY,
    answers: [
      answerOf([
        entryFor(OFFLINE, [useOf(OFFLINE, { artifactId: ARTIFACT, planEventId: PLAN_EVENT })]),
        entryFor(
          QUEUE,
          [useOf(QUEUE, { artifactId: ARTIFACT, planEventId: PLAN_EVENT })],
          [assignmentOver(QUEUE), { ...assignmentOver(RETRY), standing: 'revoked' }]
        ),
        entryFor(RETRY),
        entryFor(EXPORT),
      ]),
    ],
    relationships: [
      {
        relationship_id: 'relationship-queue',
        relation: 'depends_on',
        standing: 'established',
        from: revisionOf(QUEUE),
        to: revisionOf(OFFLINE),
        explanation: 'The queue exists because the app must work offline.',
        attributed_to: { kind: 'actor', name: 'owner', basis: 'authenticated' },
      },
      {
        relationship_id: 'relationship-retry',
        relation: 'depends_on',
        standing: 'suggested',
        from: revisionOf(RETRY),
        to: revisionOf(OFFLINE),
        explanation: 'Proposed by background processing.',
        attributed_to: { kind: 'detector', name: 'knowledge-processor', basis: null },
      },
      {
        relationship_id: 'relationship-absent',
        relation: 'motivates',
        standing: 'established',
        from: revisionOf(OFFLINE),
        to: {
          kind: 'requirement',
          entity_id: 'requirement-unknown',
          revision_id: 'requirement-unknown-r1',
        } as RecordRevisionRef,
        explanation: 'Names an endpoint this read holds no record of.',
        attributed_to: { kind: 'actor', name: 'owner', basis: 'authenticated' },
      },
    ],
    assumptions: [
      {
        decision: revisionOf(QUEUE),
        where: 'assumption',
        text: `Assumes requirement-offline still stands.`,
        names: identityOf(OFFLINE),
        authored_by: { kind: 'actor', name: 'owner', basis: 'authenticated' },
      },
    ],
    assessments: [
      {
        assessment_id: 'assessment-offline',
        assessed_by: { kind: 'actor', name: 'owner', basis: 'authenticated' },
        expectation: revisionOf(OFFLINE),
        conclusion: 'supported',
        selected_inputs: [{ kind: 'git_commit', identity: 'b'.repeat(40) }],
      },
    ],
    code_associations: [
      {
        artifact_id: ARTIFACT,
        file_path: 'src/sync.ts',
        asked: 'src/sync.ts',
        recorded_touch: true,
      },
    ],
    subjects: [
      {
        subject_id: 'subject-offline-behaviour',
        of: revisionOf(OFFLINE),
        identity: identityOf(EXPORT),
      },
    ],
    plan_events: [{ artifact_id: ARTIFACT, plan_event_id: PLAN_EVENT }],
    limits: [{ kind: 'assumptions_not_indexed', detail: 'Read only the revisions carried here.' }],
  };
}

const trace = (
  bounds: Partial<ConsequenceBounds> = {},
  change: ConsequenceChange = CHANGE
): ConsequenceAnswer => traceConsequences(change, facts(), { ...BOUNDS, ...bounds });

const limitKinds = (answer: ConsequenceAnswer) => answer.limits.map((limit) => limit.kind);
const affectedKeys = (answer: ConsequenceAnswer) => answer.affected.map((entry) => entry.key);
const find = (answer: ConsequenceAnswer, key: string) =>
  answer.affected.find((entry) => entry.key === key);

describe('what a changed expectation reaches', () => {
  it('propagates a later route through an already-reached item', () => {
    const revision = (entity_id: string) => ({
      kind: 'requirement' as const,
      entity_id,
      revision_id: `${entity_id}-r1`,
    });
    const relationship = (relationship_id: string, from: string, to: string) => ({
      relationship_id,
      relation: 'depends_on',
      standing: 'established',
      from: revision(from),
      to: revision(to),
      explanation: `${from} depends on ${to}`,
      attributed_to: { kind: 'actor', name: 'owner', basis: 'other_assertion' },
    });
    const answer = traceConsequences(
      {
        kind: 'revision',
        identity: { kind: 'requirement', entity_id: 'a' },
        revision_id: 'a-r1',
        moved: 'replaced',
      },
      {
        boundary: 12,
        answers: [],
        relationships: [
          relationship('a-b', 'a', 'b'),
          relationship('a-c', 'a', 'c'),
          relationship('c-b', 'c', 'b'),
          relationship('b-d', 'b', 'd'),
        ],
        assumptions: [],
        assessments: [],
        code_associations: [],
        subjects: [],
        plan_events: [],
        limits: [],
      },
      { maxDepth: 5, maxItems: 50, maxPathsPerItem: 10 }
    );

    expect(
      find(answer, 'requirement:d')?.paths.map((path) => path.map((step) => step.record_id))
    ).toEqual(
      expect.arrayContaining([
        ['a-b', 'b-d'],
        ['a-c', 'c-b', 'b-d'],
      ])
    );
  });

  it('gives every affected item a reason and a full path from the change', () => {
    const answer = trace();

    expect(answer.affected.length).toBeGreaterThan(0);
    for (const entry of answer.affected) {
      expect(entry.reason).not.toBe('');
      expect(entry.paths.length).toBeGreaterThan(0);
      for (const path of entry.paths) {
        expect(path.length).toBeGreaterThan(0);
        expect(consequenceItemKey(path[path.length - 1]!.to)).toBe(entry.key);
        for (const step of path) expect(step.reason).not.toBe('');
      }
    }
  });

  it('starts from the exact task uses, the plan event, its artifact and the code it touched', () => {
    const answer = trace();

    expect(affectedKeys(answer)).toEqual(
      expect.arrayContaining([
        `plan_event:${PLAN_EVENT}`,
        `artifact:${ARTIFACT}`,
        'code_path:src/sync.ts',
        'assessment:assessment-offline',
      ])
    );
    const use = find(answer, `plan_event:${PLAN_EVENT}`)!;
    expect(use.depth).toBe(1);
    expect(use.basis).toBe('explicit');
    expect(use.reason).toContain(OFFLINE.revision_id);
    expect(use.reason).toContain('selected with the plan');
  });

  it('marks an established dependency explicit and a suggested one inferred', () => {
    const answer = trace();

    const established = find(answer, `decision:${QUEUE.entity_id}`)!;
    expect(
      established.paths.some((path) =>
        path.some((step) => step.record_id === 'relationship-queue' && step.basis === 'explicit')
      )
    ).toBe(true);

    const suggested = find(answer, `decision:${RETRY.entity_id}`)!;
    expect(suggested.basis).toBe('inferred');
    const step = suggested.paths[0]![0]!;
    expect(step.basis).toBe('inferred');
    expect(step.standing).toBe('suggested');
    expect(step.reason).toContain('Being linked is not being wrong');
  });

  it('marks a shared subject inferred, because nobody recorded that link', () => {
    const answer = trace();

    const near = find(answer, `requirement:${EXPORT.entity_id}`)!;
    expect(near.basis).toBe('inferred');
    expect(near.paths[0]![0]!.relation).toBe('shared_subject');
    expect(near.paths[0]![0]!.reason).toContain('not a recorded link');
  });

  it('follows a recorded assumption that names the change, without opening a defect', () => {
    const answer = trace();

    const assumption = find(answer, `decision:${QUEUE.entity_id}`)!.paths.find((path) =>
      path.some((step) => step.relation === 'recorded_assumption')
    );

    expect(assumption).toBeDefined();
    expect(assumption![0]!.reason).toContain('suggests reconsideration and opens no defect');
  });

  it('keeps one item for an identity reached three ways, with every path', () => {
    const answer = trace();

    const queue = find(answer, `decision:${QUEUE.entity_id}`)!;
    expect(affectedKeys(answer).filter((key) => key === queue.key)).toHaveLength(1);
    expect(queue.paths).toHaveLength(3);
    expect(queue.paths.map((path) => path[path.length - 1]!.relation).sort()).toEqual([
      'depends_on',
      'recorded_assumption',
      'task_use',
    ]);
    expect(queue.paths_omitted).toBe(0);
  });

  it('keeps the paths the bound allows and names the ones it dropped', () => {
    const answer = trace({ maxPathsPerItem: 2 });

    const queue = find(answer, `decision:${QUEUE.entity_id}`)!;
    expect(queue.paths).toHaveLength(2);
    expect(queue.paths_omitted).toBe(1);
    const limit = answer.limits.find((entry) => entry.kind === 'path_count');
    expect(limit?.detail).toContain(queue.key);
    expect(limit?.detail).toContain('at most 2 per item');
  });

  it('ends a walk that loops back on itself and says where', () => {
    const answer = trace();

    const cycle = answer.limits.find((limit) => limit.kind === 'cycle');
    expect(cycle?.detail).toContain(`plan_event:${PLAN_EVENT}`);
    expect(cycle?.detail).toContain('rather than repeating those items');
    for (const entry of answer.affected)
      for (const path of entry.paths) {
        const walked = [
          consequenceItemKey(path[0]!.from),
          ...path.map((step) => consequenceItemKey(step.to)),
        ];
        expect(new Set(walked).size).toBe(walked.length);
      }
  });

  it('reports a dependency whose endpoint it holds no record of as a limit', () => {
    const answer = trace();

    const absent = find(answer, 'requirement:requirement-unknown')!;
    expect(absent.read_at_boundary).toBe(false);
    expect(absent.paths[0]![0]!.record_id).toBe('relationship-absent');
    const limit = answer.limits.find((entry) => entry.kind === 'missing_endpoint');
    expect(limit?.detail).toContain('requirement:requirement-unknown');
    expect(limit?.detail).toContain('The link is reported; the endpoint is not resolved.');
  });

  it('names an owner only where a record names one', () => {
    const answer = trace();

    expect(find(answer, `requirement:${EXPORT.entity_id}`)!.owner).toEqual({
      name: 'owner',
      basis: 'authenticated',
      from: `the actor revision ${EXPORT.revision_id} is attributed to`,
    });
    expect(find(answer, 'code_path:src/sync.ts')!.owner).toBeNull();
  });

  it('names the party a standing assignment made responsible, ahead of a revision’s author', () => {
    const answer = trace();

    expect(find(answer, `decision:${QUEUE.entity_id}`)!.owner).toEqual({
      name: 'the-retry-team',
      basis: 'other_assertion',
      from: `the party assignment assignment-${QUEUE.entity_id} makes responsible`,
    });
  });

  it('stops at the depth bound and says what it did not follow', () => {
    const answer = trace({ maxDepth: 1 });

    expect(answer.affected.every((entry) => entry.depth === 1)).toBe(true);
    expect(answer.coverage.items_not_expanded).toBeGreaterThan(0);
    const limit = answer.limits.find((entry) => entry.kind === 'depth_bound');
    expect(limit?.detail).toContain('that route was not followed farther');
    expect(affectedKeys(answer)).not.toContain(`artifact:${ARTIFACT}`);
  });

  it('stops at the item bound and names what it left out', () => {
    const answer = trace({ maxItems: 3 });

    expect(answer.affected.length).toBeLessThanOrEqual(3);
    const limit = answer.limits.find((entry) => entry.kind === 'item_count');
    expect(limit?.detail).toContain('this answer carries at most 3');
  });

  it('carries the readers’ own limits and claims no complete impact coverage', () => {
    const answer = trace();

    expect(limitKinds(answer)).toContain('assumptions_not_indexed');
    expect(answer.coverage.statement).toContain('it is not complete impact coverage');
    expect(answer.coverage.statement).toContain('Reaching an item is not a finding');
    expect(answer.coverage.relations_followed).toContain('depends_on');
  });

  it('does not merge two distinct decisions that both depend on the change', () => {
    const answer = trace();

    expect(affectedKeys(answer)).toContain(`decision:${QUEUE.entity_id}`);
    expect(affectedKeys(answer)).toContain(`decision:${RETRY.entity_id}`);
    expect(find(answer, `decision:${QUEUE.entity_id}`)!.item).not.toEqual(
      find(answer, `decision:${RETRY.entity_id}`)!.item
    );
  });
});

describe('what a changed implementation reaches', () => {
  const touched: ConsequenceChange = { kind: 'implementation', paths: ['src/sync.ts'] };

  it('reaches the plan that touched the code and the expectations it used', () => {
    const answer = trace({}, touched);

    expect(answer.start).toEqual([{ kind: 'code_path', path: 'src/sync.ts' }]);
    expect(affectedKeys(answer)).toEqual(
      expect.arrayContaining([
        `artifact:${ARTIFACT}`,
        `plan_event:${PLAN_EVENT}`,
        `requirement:${OFFLINE.entity_id}`,
      ])
    );
    expect(find(answer, `artifact:${ARTIFACT}`)!.basis).toBe('explicit');
  });

  it('marks a path that only matched a pattern inferred', () => {
    const matched = traceConsequences(
      { kind: 'implementation', paths: ['src/*.ts'] },
      {
        ...facts(),
        code_associations: [
          {
            artifact_id: OTHER_ARTIFACT,
            file_path: 'src/report.ts',
            asked: 'src/*.ts',
            recorded_touch: false,
          },
        ],
        plan_events: [{ artifact_id: OTHER_ARTIFACT, plan_event_id: OTHER_PLAN_EVENT }],
      },
      BOUNDS
    );

    const artifact = find(matched, `artifact:${OTHER_ARTIFACT}`)!;
    expect(artifact.basis).toBe('inferred');
    expect(artifact.paths[0]![0]!.reason).toContain('matches src/*.ts as a pattern');
  });
});

describe('what a changed assumption reaches', () => {
  it('starts from the decision the assumption belongs to', () => {
    const answer = trace(
      {},
      {
        kind: 'assumption',
        identity: identityOf(QUEUE),
        revision_id: QUEUE.revision_id,
        named: 'Assumes requirement-offline still stands.',
      }
    );

    expect(answer.start).toEqual([
      { kind: 'identity', target: identityOf(QUEUE), revision_id: QUEUE.revision_id },
    ]);
    expect(affectedKeys(answer)).toContain(`requirement:${OFFLINE.entity_id}`);
    expect(affectedKeys(answer)).not.toContain(`decision:${QUEUE.entity_id}`);
  });
});
