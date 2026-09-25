import { expect, it } from 'vitest';

import {
  RECONSIDERATION_STATEMENT,
  reconsiderationAffectedOf,
  reconsiderationCauseKey,
  reconsiderationSignalsOf,
  reconsiderationSignalsOfAll,
} from './reconsideration.js';
import type {
  ConsequenceAnswer,
  ConsequenceChange,
  ConsequenceItem,
  ConsequenceStep,
} from './traversal.js';
import { traceConsequences } from './traversal.js';

const OFFLINE = { kind: 'requirement', entity_id: 'requirement-offline' } as const;
const PLAN_EVENT: ConsequenceItem = {
  kind: 'plan_event',
  artifact_id: 'artifact-sync',
  plan_event_id: 'plan-event-sync',
};

const step = (to: ConsequenceItem, reason: string): ConsequenceStep => ({
  from: { kind: 'identity', target: OFFLINE, revision_id: null },
  to,
  relation: 'task_use',
  basis: 'explicit',
  standing: null,
  reason,
  record_id: 'plan-event-sync',
});

const answerOf = (change: ConsequenceChange, boundary = 40): ConsequenceAnswer => ({
  change,
  basis: {
    knowledge_boundary: boundary,
    bounds: { maxDepth: 3, maxItems: 25, maxPathsPerItem: 3 },
  },
  start: [{ kind: 'identity', target: OFFLINE, revision_id: null }],
  affected: [
    {
      key: 'plan_event:plan-event-sync',
      item: PLAN_EVENT,
      depth: 1,
      basis: 'explicit',
      reason: 'Plan event plan-event-sync records a preserve use of revision r2.',
      paths: [
        [step(PLAN_EVENT, 'Plan event plan-event-sync records a preserve use of revision r2.')],
        [
          step(PLAN_EVENT, 'a second, longer way to the same plan event'),
          step(PLAN_EVENT, 'and its second link'),
        ],
      ],
      paths_omitted: 0,
      owner: { name: 'the-cto', basis: 'agent_reported_user_instruction', from: 'a task use' },
      read_at_boundary: true,
    },
  ],
  limits: [],
  coverage: {
    statement: 'what was followed',
    relations_followed: [],
    items_reached: 1,
    items_not_expanded: 0,
    deepest_reached: 1,
  },
});

const revisionChange = (
  revisionId: string | null,
  moved: 'adopted' | 'replaced'
): ConsequenceChange => ({
  kind: 'revision',
  identity: OFFLINE,
  revision_id: revisionId,
  moved,
});

it('offers one signal per affected item, on the shortest path that reached it', () => {
  const answer = answerOf(revisionChange('r2', 'replaced'));

  const signals = reconsiderationSignalsOf(answer);

  expect(signals).toHaveLength(1);
  expect(signals[0]!.affected).toEqual({ kind: 'plan_event', id: 'plan-event-sync' });
  expect(signals[0]!.reason).toBe(answer.affected[0]!.reason);
  expect(signals[0]!.path).toHaveLength(1);
  expect(signals[0]!.owner?.name).toBe('the-cto');
  expect(signals[0]!.openedAtBoundary).toBe(40);
});

it('retains the explicit path that supports a signal instead of a shorter inferred path', () => {
  const revision = (entity_id: string) => ({
    kind: 'requirement' as const,
    entity_id,
    revision_id: `${entity_id}-r1`,
  });
  const relation = (from: string, to: string) => ({
    relationship_id: `${from}-${to}`,
    relation: 'depends_on' as const,
    standing: 'established' as const,
    from: revision(from),
    to: revision(to),
    explanation: null,
    attributed_to: { kind: 'actor' as const, name: 'owner', basis: 'other_assertion' as const },
  });
  const answer = traceConsequences(
    {
      kind: 'revision',
      identity: { kind: 'requirement', entity_id: 'a' },
      revision_id: 'a-r1',
      moved: 'replaced',
    },
    {
      boundary: 40,
      answers: [],
      relationships: [relation('a', 'b'), relation('b', 'c')],
      assumptions: [],
      assessments: [],
      code_associations: [],
      subjects: [
        {
          subject_id: 'subject',
          of: revision('a'),
          identity: { kind: 'requirement', entity_id: 'c' },
        },
      ],
      plan_events: [],
      limits: [],
    },
    { maxDepth: 3, maxItems: 20, maxPathsPerItem: 5 }
  );
  const signal = reconsiderationSignalsOf(answer).find((entry) => entry.affected.id === 'c')!;
  expect(signal.basis).toBe('explicit');
  expect(signal.path).toHaveLength(2);
  expect(signal.path.every((entry) => entry.basis === 'explicit')).toBe(true);
  expect(signal.reason).toBe(signal.path.at(-1)!.reason);
});

it.each(['explicit', 'inferred'] as const)(
  'selects a stable shortest %s path with its own explanation',
  (basis) => {
    const answer = answerOf(revisionChange('r2', 'replaced'));
    const first = [{ ...step(PLAN_EVENT, 'a supporting account'), basis }];
    const second = [{ ...step(PLAN_EVENT, 'z supporting account'), basis }];
    const longer = [...first, ...second];
    const selected = (paths: ConsequenceStep[][]) =>
      reconsiderationSignalsOf({
        ...answer,
        affected: [
          {
            ...answer.affected[0]!,
            paths,
            reason: 'An aggregate reason that is not the selected account',
          },
        ],
      })[0]!;
    expect(selected([second, longer, first])).toMatchObject({
      path: first,
      basis,
      reason: first[0]!.reason,
    });
    expect(selected([first, second, longer])).toEqual(selected([second, longer, first]));
  }
);

it('gives one cause key however a revision’s standing moved', () => {
  expect(reconsiderationCauseKey(revisionChange('r2', 'adopted'))).toBe(
    reconsiderationCauseKey(revisionChange('r2', 'replaced'))
  );
});

it('tells a named revision apart from the identity it belongs to', () => {
  expect(reconsiderationCauseKey(revisionChange('r2', 'replaced'))).not.toBe(
    reconsiderationCauseKey(revisionChange(null, 'replaced'))
  );
});

it('gives one cause key for one set of paths, whatever order they arrive in', () => {
  const key = (paths: readonly string[]) =>
    reconsiderationCauseKey({ kind: 'implementation', paths });

  expect(key(['src/b.ts', 'src/a.ts'])).toBe(key(['src/a.ts', 'src/b.ts', 'src/a.ts']));
  expect(key(['src/a.ts'])).not.toBe(key(['src/b.ts']));
});

it('names the assumption a decision records as part of its cause', () => {
  const named = (text: string): ConsequenceChange => ({
    kind: 'assumption',
    identity: OFFLINE,
    revision_id: 'r2',
    named: text,
  });

  expect(reconsiderationCauseKey(named('the queue survives a restart'))).not.toBe(
    reconsiderationCauseKey(named('the queue is bounded'))
  );
});

it('leaves one signal when two acts on one revision reach the same work', () => {
  const adopted = answerOf(revisionChange('r2', 'adopted'), 40);
  const replaced = answerOf(revisionChange('r2', 'replaced'), 52);

  const signals = reconsiderationSignalsOfAll([adopted, replaced]);

  expect(signals).toHaveLength(1);
  // The facts are the facts as of the signal that opened it, so the first answer's boundary wins.
  expect(signals[0]!.openedAtBoundary).toBe(40);
});

it('keeps two signals when the same work is reached from two changes', () => {
  const signals = reconsiderationSignalsOfAll([
    answerOf(revisionChange('r2', 'replaced')),
    answerOf({ kind: 'implementation', paths: ['src/sync.ts'] }),
  ]);

  expect(signals.map((signal) => signal.cause.kind)).toEqual(['revision', 'implementation']);
});

it('names each kind of affected item by what it is', () => {
  expect([
    reconsiderationAffectedOf({ kind: 'identity', target: OFFLINE, revision_id: 'r2' }),
    reconsiderationAffectedOf(PLAN_EVENT),
    reconsiderationAffectedOf({ kind: 'artifact', artifact_id: 'artifact-sync' }),
    reconsiderationAffectedOf({ kind: 'assessment', assessment_id: 'assessment-1' }),
    reconsiderationAffectedOf({ kind: 'code_path', path: 'src/sync.ts' }),
  ]).toEqual([
    { kind: 'requirement', id: 'requirement-offline' },
    { kind: 'plan_event', id: 'plan-event-sync' },
    { kind: 'artifact', id: 'artifact-sync' },
    { kind: 'assessment', id: 'assessment-1' },
    { kind: 'code_path', id: 'src/sync.ts' },
  ]);
});

it('says in the statement that an item is not a finding', () => {
  expect(RECONSIDERATION_STATEMENT).toContain('not a finding that the work is wrong');
  expect(RECONSIDERATION_STATEMENT).toContain(
    'opens no defect, revises no requirement and assigns no remediation'
  );
});
