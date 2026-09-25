import { describe, expect, it } from 'vitest';

import type { RevisionStanding, StandingEffect } from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
  ProjectKnowledgeContextUse,
} from '@orcaops/storage/history/database';

import {
  authorityAtBoundary,
  type IntegrationAuthorityFacts,
  type RecordedAct,
  retainedAuthorityFindings,
} from './authority-at-boundary.js';
import { knowledgeContextAnswer } from '../context/answer.js';
import {
  existingKnowledge,
  KNOWLEDGE_BOUNDARY,
  PROJECT,
} from '../interpretation/evaluation/knowledge.js';

const ARTIFACT_ID = 'artifact-offline-sync';
const OTHER_ARTIFACT_ID = 'artifact-billing';
const PLAN_EVENT = 'plan-event-1';
const EARLIER_PLAN_EVENT = 'plan-event-0';
const ENTITY = 'requirement-offline';
const SELECTED = 'requirement-offline-r1';
const SUCCESSOR = 'requirement-offline-r2';
const OLD_WORDING = 'The app keeps working with no network.';
const NEW_WORDING = 'The app keeps working with no network, and says so.';
const ACTING = 'owner';
const PLAN_SEQUENCE = 100;
const JUDGED_AT = '2026-09-18T10:00:00.000Z';

const at = (overrides: Partial<Parameters<typeof authorityAtBoundary>[1]> = {}) => ({
  artifactId: ARTIFACT_ID,
  planEventId: PLAN_EVENT,
  boundary: 'now' as const,
  judgedAt: JUDGED_AT,
  actingIdentity: ACTING,
  ...overrides,
});

function use(
  input: { revisionId: string; role?: string; planEventId?: string } = { revisionId: SELECTED }
): ProjectKnowledgeContextUse {
  return {
    use: {
      artifactId: ARTIFACT_ID,
      planEventId: input.planEventId ?? PLAN_EVENT,
      target: { kind: 'requirement', entityId: ENTITY, revisionId: input.revisionId },
      role: input.role ?? 'implement',
      stepId: 'step-1',
      criterionId: null,
      exceptionId: null,
      selectionKind: 'selected_with_plan',
      discoveredAt: null,
      discoveredBy: null,
      recordHex: '7b7d',
      recordSha256: 'a'.repeat(64),
      operationId: 'operation-use',
    },
    writeSequence: PLAN_SEQUENCE,
  };
}

/**
 * The identity the plan selected at `SELECTED`, with `SUCCESSOR` governing instead and the named
 * effect recorded as the reason. Hand-built so the comparison is tested against a resolver answer
 * of a fixed shape, as the block's own tests are.
 */
function movedIdentity(
  effect: StandingEffect,
  uses: readonly ProjectKnowledgeContextUse[] = [use()]
): ProjectKnowledgeContextEntry {
  const first = existingKnowledge({
    kind: 'requirement',
    entity_id: ENTITY,
    revision_id: SELECTED,
    text: OLD_WORDING,
  });
  const second = existingKnowledge({
    kind: 'requirement',
    entity_id: ENTITY,
    revision_id: SUCCESSOR,
    text: NEW_WORDING,
  });
  const stopped: RevisionStanding = {
    ...first.resolved.revisions[0]!,
    standing: 'stopped',
    because: [{ record: 'correction', record_id: 'correction-1', effect }],
  };
  return {
    target: second.resolved.target,
    routes: ['requested'],
    resolved: { ...second.resolved, revisions: [stopped, second.resolved.revisions[0]!] },
    revisions: [
      { revisionId: SELECTED, previousRevisionId: null, writeSequence: 1, operationId: 'op-1' },
      {
        revisionId: SUCCESSOR,
        previousRevisionId: SELECTED,
        writeSequence: 2,
        operationId: 'op-2',
      },
    ],
    tips: [],
    statements: [...first.statements, ...second.statements],
    selectedWithPlan: [...uses],
    connectedLater: [],
    references: [],
    criterion: null,
  };
}

/** The identity the plan selected, still governing: nothing moved. */
function standingIdentity(): ProjectKnowledgeContextEntry {
  const held = existingKnowledge({
    kind: 'requirement',
    entity_id: ENTITY,
    revision_id: SELECTED,
    text: OLD_WORDING,
  });
  return {
    target: held.resolved.target,
    routes: ['requested'],
    resolved: held.resolved,
    revisions: [
      { revisionId: SELECTED, previousRevisionId: null, writeSequence: 1, operationId: 'op-1' },
    ],
    tips: [],
    statements: held.statements,
    selectedWithPlan: [use()],
    connectedLater: [],
    references: [],
    criterion: null,
  };
}

const contextOf = (entries: readonly ProjectKnowledgeContextEntry[]): ProjectKnowledgeContext => ({
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
});

function act(overrides: Partial<RecordedAct> = {}): RecordedAct {
  return {
    kind: 'selection',
    id: 'adoption-1',
    scope: { kind: 'artifact', artifact_id: ARTIFACT_ID },
    attributed_to: ACTING,
    recorded_at: JUDGED_AT,
    write_sequence: PLAN_SEQUENCE + 5,
    authority: {
      kind: 'assignment',
      id: 'assignment-1',
      standing: 'valid',
      reason: 'No revocation names it and every rule it rests on stands.',
      revocations: [],
    },
    ...overrides,
  };
}

const factsOf = (
  entries: readonly ProjectKnowledgeContextEntry[],
  acts: readonly RecordedAct[] = []
): IntegrationAuthorityFacts => ({
  boundary: KNOWLEDGE_BOUNDARY,
  plan_write_sequence: PLAN_SEQUENCE,
  answer: knowledgeContextAnswer(contextOf(entries), null),
  acts,
});

describe('authority at an integration boundary', () => {
  it.each(['replaced', 'withdrawn', 'reversed'] as const)(
    'reports a selected revision that was %s, and what governs instead',
    (effect) => {
      const findings = authorityAtBoundary(factsOf([movedIdentity(effect)]), at());

      expect(findings.revoked).toEqual([]);
      expect(findings.moved).toHaveLength(1);
      const moved = findings.moved[0]!;
      expect(moved.key).toBe(`requirement:${ENTITY}`);
      expect(moved.selected_revision_id).toBe(SELECTED);
      expect(moved.governing_revision_ids).toEqual([SUCCESSOR]);
      expect(moved.moved_by).toEqual([{ record: 'correction', record_id: 'correction-1', effect }]);
      expect(moved.statement).toContain(effect);
      expect(moved.statement).toContain(SUCCESSOR);
    }
  );

  it('reports nothing for a selected revision that still governs', () => {
    const findings = authorityAtBoundary(factsOf([standingIdentity()]), at());

    expect(findings.moved).toEqual([]);
    expect(findings.revoked).toEqual([]);
  });

  it('leaves a background use and a proposed change out, and holds the three obliged roles', () => {
    for (const role of ['background', 'propose_change'])
      expect(
        authorityAtBoundary(
          factsOf([movedIdentity('replaced', [use({ revisionId: SELECTED, role })])]),
          at()
        ).moved
      ).toEqual([]);
    for (const role of ['implement', 'preserve', 'assess'])
      expect(
        authorityAtBoundary(
          factsOf([movedIdentity('replaced', [use({ revisionId: SELECTED, role })])]),
          at()
        ).moved
      ).toHaveLength(1);
  });

  it('compares the latest plan revision only, not what an earlier one selected', () => {
    const entry = movedIdentity('replaced', [
      use({ revisionId: SELECTED, planEventId: EARLIER_PLAN_EVENT }),
    ]);

    expect(authorityAtBoundary(factsOf([entry]), at()).moved).toEqual([]);
  });

  it('refuses an act whose assignment a revocation ended, naming who revoked it and when', () => {
    const revoked = act({
      authority: {
        kind: 'assignment',
        id: 'assignment-1',
        standing: 'revoked',
        reason: 'A revocation reaching its scope ended it.',
        revocations: [
          { revocation_id: 'revocation-1', revoked_by: 'owner', recorded_at: JUDGED_AT },
        ],
      },
    });

    const findings = authorityAtBoundary(factsOf([standingIdentity()], [revoked]), at());

    expect(findings.revoked).toHaveLength(1);
    expect(findings.revoked[0]!.act.id).toBe('adoption-1');
    expect(findings.revoked[0]!.rested_on.id).toBe('assignment-1');
    expect(findings.revoked[0]!.statement).toContain('revocation-1');
    expect(findings.revoked[0]!.statement).toContain('owner');
    expect(findings.revoked[0]!.lifts).toContain("End the old act's effect");
    expect(findings.revoked[0]!.lifts).toContain('A new assignment alone does not authorize');
  });

  it('refuses an act whose reused authorization a revocation ended', () => {
    const revoked = act({
      kind: 'correction',
      id: 'correction-2',
      authority: {
        kind: 'authorization',
        id: 'authorization-1',
        standing: 'revoked',
        reason: 'A revocation names the authorization this act rests on.',
        revocations: [{ revocation_id: 'revocation-2', revoked_by: null, recorded_at: JUDGED_AT }],
      },
    });

    const findings = authorityAtBoundary(factsOf([standingIdentity()], [revoked]), at());

    expect(findings.revoked[0]!.rested_on.kind).toBe('authorization');
    expect(findings.revoked[0]!.statement).toContain('an actor this history cannot name');
    expect(findings.revoked[0]!.lifts).toContain('acknowledging the same footprint');
  });

  it('refuses an act under an assignment whose validity no longer covers it', () => {
    const expired = act({
      authority: {
        kind: 'assignment',
        id: 'assignment-1',
        standing: 'expired',
        reason: 'Its validity ended before the time this read judged it at.',
        revocations: [],
      },
    });

    const findings = authorityAtBoundary(factsOf([standingIdentity()], [expired]), at());

    expect(findings.revoked).toHaveLength(1);
    expect(findings.revoked[0]!.lifts).toContain('delegation ended');
  });

  it('refuses nothing when the only thing that ended is a rule the act itself departed from', () => {
    const basisEnded = act({
      authority: {
        kind: 'authorization',
        id: 'authorization-1',
        standing: 'basis_ended',
        reason: 'A rule it departs from no longer stands.',
        revocations: [],
      },
    });

    expect(authorityAtBoundary(factsOf([standingIdentity()], [basisEnded]), at()).revoked).toEqual(
      []
    );
  });

  it('refuses an act in the project scope by the identity this pass acts as', () => {
    const projectScoped = act({
      scope: PROJECT,
      authority: {
        kind: 'assignment',
        id: 'assignment-1',
        standing: 'revoked',
        reason: 'A revocation reaching its scope ended it.',
        revocations: [
          { revocation_id: 'revocation-1', revoked_by: ACTING, recorded_at: JUDGED_AT },
        ],
      },
    });

    expect(
      authorityAtBoundary(factsOf([standingIdentity()], [projectScoped]), at()).revoked
    ).toHaveLength(1);
    expect(
      authorityAtBoundary(
        factsOf([standingIdentity()], [{ ...projectScoped, attributed_to: 'somebody-else' }]),
        at()
      ).revoked
    ).toEqual([]);
    expect(
      authorityAtBoundary(
        factsOf([standingIdentity()], [projectScoped]),
        at({ actingIdentity: null })
      ).revoked
    ).toEqual([]);
  });

  it('leaves another artifact’s act and an act older than this plan out', () => {
    const revoked = {
      kind: 'assignment' as const,
      id: 'assignment-1',
      standing: 'revoked' as const,
      reason: 'A revocation reaching its scope ended it.',
      revocations: [],
    };

    expect(
      authorityAtBoundary(
        factsOf(
          [standingIdentity()],
          [
            act({
              scope: { kind: 'artifact', artifact_id: OTHER_ARTIFACT_ID },
              authority: revoked,
            }),
            act({ id: 'adoption-before', write_sequence: PLAN_SEQUENCE - 1, authority: revoked }),
          ]
        ),
        at()
      ).revoked
    ).toEqual([]);
  });

  it('retains the identities and reasons for the marker, and none of the wording', () => {
    const retained = retainedAuthorityFindings(
      authorityAtBoundary(factsOf([movedIdentity('withdrawn')]), at())
    );

    expect(retained).toEqual({
      moved: [
        {
          key: `requirement:${ENTITY}`,
          selected_revision_id: SELECTED,
          governing_revision_ids: [SUCCESSOR],
          role: 'implement',
          effects: ['withdrawn'],
        },
      ],
      revoked: [],
    });
    expect(JSON.stringify(retained)).not.toContain(OLD_WORDING);
    expect(JSON.stringify(retained)).not.toContain(NEW_WORDING);
  });
});
