import { describe, expect, it } from 'vitest';

import type { Applicability, RevisionStanding } from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
  ProjectKnowledgeContextUse,
} from '@orcaops/storage/history/database';

import { knowledgeContextAnswer, type KnowledgeContextBounds } from './answer.js';
import { applicableNotSelected } from './selection.js';
import {
  existingKnowledge,
  type ExistingRevision,
  KNOWLEDGE_BOUNDARY,
  PROJECT,
} from '../interpretation/evaluation/knowledge.js';

const PLAN = { artifactId: 'artifact-1', planEventId: 'plan-event-1' };

const OFFLINE: ExistingRevision = {
  kind: 'requirement',
  entity_id: 'requirement-offline',
  revision_id: 'requirement-offline-r2',
  text: 'The app keeps working with no network.',
};

function useOf(input: {
  revisionId: string;
  planEventId: string;
  selection: 'selected_with_plan' | 'connected_later';
}): ProjectKnowledgeContextUse {
  return {
    use: {
      artifactId: PLAN.artifactId,
      planEventId: input.planEventId,
      target: { kind: 'requirement', entityId: OFFLINE.entity_id, revisionId: input.revisionId },
      role: 'implement',
      stepId: null,
      criterionId: null,
      exceptionId: null,
      selectionKind: input.selection,
      discoveredAt: input.selection === 'connected_later' ? '2026-09-01T00:00:00.000Z' : null,
      discoveredBy:
        input.selection === 'connected_later'
          ? { kind: 'actor', name: 'owner', basis: 'other_assertion' }
          : null,
      recordHex: '00',
      recordSha256: 'a'.repeat(64),
      operationId: 'operation-1',
    },
    writeSequence: 1,
  };
}

function entryFor(
  input: ExistingRevision & {
    applicability?: Applicability;
    selectedWithPlan?: readonly ProjectKnowledgeContextUse[];
    connectedLater?: readonly ProjectKnowledgeContextUse[];
  }
): ProjectKnowledgeContextEntry {
  const knowledge = existingKnowledge(input);
  return {
    target: knowledge.resolved.target,
    routes: ['requested'],
    resolved: {
      ...knowledge.resolved,
      revisions: knowledge.resolved.revisions.map(
        (revision): RevisionStanding => ({
          ...revision,
          applicability: input.applicability ?? revision.applicability,
        })
      ),
    },
    revisions: [
      {
        revisionId: input.revision_id,
        previousRevisionId: null,
        writeSequence: 1,
        operationId: 'operation-1',
      },
    ],
    tips: [],
    statements: knowledge.statements,
    selectedWithPlan: input.selectedWithPlan ?? [],
    connectedLater: input.connectedLater ?? [],
    references: [],
    criterion: null,
  };
}

const answerOf = (
  entries: readonly ProjectKnowledgeContextEntry[],
  bounds: KnowledgeContextBounds = {}
) =>
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
    null,
    bounds
  );

describe('what applies here that the plan records no use of', () => {
  it('lists an adopted rule the plan never selected', () => {
    const missed = applicableNotSelected(answerOf([entryFor(OFFLINE)]), PLAN);

    expect(missed.entries).toEqual([
      expect.objectContaining({
        key: 'requirement:requirement-offline',
        revision_ids: [OFFLINE.revision_id],
        selected_revision_ids: [],
        statement: OFFLINE.text,
      }),
    ]);
    expect(missed.entries[0]!.reason).toContain('records no use of it');
    expect(missed.plan_event_id).toBe(PLAN.planEventId);
  });

  it('leaves out a rule the plan selected at the revision that governs', () => {
    const missed = applicableNotSelected(
      answerOf([
        entryFor({
          ...OFFLINE,
          selectedWithPlan: [
            useOf({
              revisionId: OFFLINE.revision_id,
              planEventId: PLAN.planEventId,
              selection: 'selected_with_plan',
            }),
          ],
        }),
      ]),
      PLAN
    );

    expect(missed.entries).toEqual([]);
    expect(missed.statement).toContain('selected every one');
  });

  it('names the older revision a plan selected instead of the one that governs', () => {
    const missed = applicableNotSelected(
      answerOf([
        entryFor({
          ...OFFLINE,
          selectedWithPlan: [
            useOf({
              revisionId: 'requirement-offline-r1',
              planEventId: PLAN.planEventId,
              selection: 'selected_with_plan',
            }),
          ],
        }),
      ]),
      PLAN
    );

    expect(missed.entries[0]).toMatchObject({
      revision_ids: [OFFLINE.revision_id],
      selected_revision_ids: ['requirement-offline-r1'],
    });
    expect(missed.entries[0]!.reason).toContain('another revision of it');
  });

  it('counts a use another plan event selected, and one connected later, as not selected here', () => {
    const answer = answerOf([
      entryFor({
        ...OFFLINE,
        selectedWithPlan: [
          useOf({
            revisionId: OFFLINE.revision_id,
            planEventId: 'plan-event-other',
            selection: 'selected_with_plan',
          }),
        ],
        connectedLater: [
          useOf({
            revisionId: OFFLINE.revision_id,
            planEventId: PLAN.planEventId,
            selection: 'connected_later',
          }),
        ],
      }),
    ]);

    expect(applicableNotSelected(answer, PLAN).entries.map((entry) => entry.key)).toEqual([
      'requirement:requirement-offline',
    ]);
  });

  it('counts a capped answer as a floor and carries the bound that capped it', () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      entryFor({
        kind: 'requirement',
        entity_id: `requirement-${String(index).padStart(2, '0')}`,
        revision_id: `requirement-${String(index).padStart(2, '0')}-r1`,
        text: `Rule number ${index}.`,
      })
    );

    const missed = applicableNotSelected(answerOf(many, { maxEntries: 50 }), PLAN);

    expect(missed.entries).toHaveLength(50);
    expect(missed.statement).toContain('50 of at least 50 applicable');
    expect(missed.statement).toContain('capped at 50');
    expect(missed.limits.map((limit) => limit.kind)).toEqual(['identity_count']);
  });

  it('names no cap when the answer carried everything it found', () => {
    const missed = applicableNotSelected(answerOf([entryFor(OFFLINE)], { maxEntries: 50 }), PLAN);

    expect(missed.statement).toContain('1 of 1 applicable');
    expect(missed.statement).not.toContain('capped');
    expect(missed.limits).toEqual([]);
  });

  it('does not claim a plan missed nothing when statement bytes omitted an adopted rule', () => {
    const missed = applicableNotSelected(
      answerOf([entryFor(OFFLINE)], { maxStatementBytes: 1 }),
      PLAN
    );

    expect(missed.entries).toEqual([]);
    expect(missed.limits.map((limit) => limit.kind)).toEqual(['statement_bytes']);
    expect(missed.statement).toContain('incomplete');
    expect(missed.statement).not.toContain('nothing this plan could miss');
    expect(missed.statement).not.toContain('selected every one');
  });

  it('lists every applicable entry and says so when no plan is in view', () => {
    const missed = applicableNotSelected(answerOf([entryFor(OFFLINE)]), null);

    expect(missed.plan_event_id).toBeNull();
    expect(missed.entries.map((entry) => entry.key)).toEqual(['requirement:requirement-offline']);
    expect(missed.statement).toContain('No plan is in view');
  });
});
