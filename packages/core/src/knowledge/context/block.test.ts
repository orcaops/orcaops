import { describe, expect, it } from 'vitest';

import type { RevisionStanding } from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
} from '@orcaops/storage/history/database';

import { knowledgeBlock } from './block.js';
import {
  existingKnowledge,
  KNOWLEDGE_BOUNDARY,
  PROJECT,
} from '../interpretation/evaluation/knowledge.js';

const ENTITY = 'requirement-offline';
const FIRST = 'requirement-offline-r1';
const SECOND = 'requirement-offline-r2';
const OLD_WORDING = 'The app keeps working with no network.';
const NEW_WORDING = 'The app keeps working with no network, and says so.';

/**
 * One identity that moved: the first revision superseded, the second adopted. Hand-built so the
 * block is tested against a resolver answer whose shape is fixed, not against whatever a store
 * happens to hold.
 */
function movedIdentity(): ProjectKnowledgeContextEntry {
  const first = existingKnowledge({
    kind: 'requirement',
    entity_id: ENTITY,
    revision_id: FIRST,
    text: OLD_WORDING,
  });
  const second = existingKnowledge({
    kind: 'requirement',
    entity_id: ENTITY,
    revision_id: SECOND,
    text: NEW_WORDING,
  });
  const superseded: RevisionStanding = {
    ...first.resolved.revisions[0]!,
    standing: 'stopped',
  };
  return {
    target: second.resolved.target,
    routes: ['requested'],
    resolved: {
      ...second.resolved,
      revisions: [superseded, second.resolved.revisions[0]!],
    },
    revisions: [
      { revisionId: FIRST, previousRevisionId: null, writeSequence: 1, operationId: 'operation-1' },
      {
        revisionId: SECOND,
        previousRevisionId: FIRST,
        writeSequence: 2,
        operationId: 'operation-2',
      },
    ],
    tips: [],
    statements: [...first.statements, ...second.statements],
    selectedWithPlan: [],
    connectedLater: [],
    references: [],
    criterion: null,
  };
}

function backgroundEntry(entityId: string, text: string): ProjectKnowledgeContextEntry {
  const knowledge = existingKnowledge({
    kind: 'requirement',
    entity_id: entityId,
    revision_id: `${entityId}-r1`,
    text,
    designation: 'background',
  });
  return {
    target: knowledge.resolved.target,
    routes: ['requested'],
    resolved: knowledge.resolved,
    revisions: [
      {
        revisionId: `${entityId}-r1`,
        previousRevisionId: null,
        writeSequence: 1,
        operationId: 'operation-1',
      },
    ],
    tips: [],
    statements: knowledge.statements,
    selectedWithPlan: [],
    connectedLater: [],
    references: [],
    criterion: null,
  };
}

function contextOf(entries: readonly ProjectKnowledgeContextEntry[]): ProjectKnowledgeContext {
  return {
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
  };
}

describe('the block a read surface renders', () => {
  it('preserves the selected wording reason including an explicit unknown reason', () => {
    const identity = movedIdentity();
    const block = knowledgeBlock(
      contextOf([
        {
          ...identity,
          statements: identity.statements.map((statement) => ({
            ...statement,
            rationale: statement.revision.revision_id === SECOND ? null : 'Earlier explanation.',
          })),
        },
      ])
    );
    expect(block.entries[0]!.rationale).toBeNull();
    expect(block.entries[0]!.revisions.map((revision) => revision.rationale)).toEqual([
      'Earlier explanation.',
      null,
    ]);
  });
  it('names the revision that governs and keeps the one it replaced with its standing', () => {
    const block = knowledgeBlock(contextOf([movedIdentity()]));

    const entry = block.entries[0]!;
    expect(entry.governing_revision_ids).toEqual([SECOND]);
    expect(entry.statement).toBe(NEW_WORDING);
    expect(entry.revisions.map((revision) => [revision.revision_id, revision.standing])).toEqual([
      [FIRST, 'not_standing'],
      [SECOND, 'adopted'],
    ]);
    expect(block.basis.knowledge_boundary).toBe(KNOWLEDGE_BOUNDARY);
  });

  it('names no governing revision for one recorded as background', () => {
    const block = knowledgeBlock(
      contextOf([backgroundEntry('requirement-notes', 'Imported notes carry their origin.')])
    );

    expect(block.entries[0]!.governing_revision_ids).toEqual([]);
    expect(block.background).toEqual(['requirement:requirement-notes']);
    expect(block.applicable_not_selected.entries).toEqual([]);
  });

  it('says in words that no plan is in view rather than returning an empty diff', () => {
    const block = knowledgeBlock(contextOf([movedIdentity()]));

    expect(block.applicable_not_selected.plan_event_id).toBeNull();
    expect(block.applicable_not_selected.entries.map((entry) => entry.key)).toEqual([
      `requirement:${ENTITY}`,
    ]);
    expect(block.applicable_not_selected.statement).toContain('No plan is in view');
  });

  it('claims no completeness when no processing state was read', () => {
    const block = knowledgeBlock(contextOf([movedIdentity()]));

    expect(block.coverage.processing).toBeNull();
    expect(block.coverage.statement).toContain('claims no completeness');
  });

  it('leaves background out before an adopted rule that applies, and names what it left out', () => {
    const block = knowledgeBlock(
      contextOf([
        backgroundEntry('requirement-notes', 'Imported notes carry their origin.'),
        movedIdentity(),
      ]),
      { bounds: { maxEntries: 1 } }
    );

    expect(block.entries.map((entry) => entry.key)).toEqual([`requirement:${ENTITY}`]);
    expect(block.limits.map((limit) => limit.kind)).toEqual(['identity_count']);
    expect(block.limits[0]!.detail).toContain('requirement:requirement-notes');
  });

  it('renders no background once the byte budget has left an adopted rule out', () => {
    const block = knowledgeBlock(
      contextOf([
        backgroundEntry('requirement-notes', 'Imported notes carry their origin.'),
        movedIdentity(),
      ]),
      { bounds: { maxStatementBytes: 50 } }
    );

    expect(block.entries).toEqual([]);
    expect(block.background).toEqual([]);
    expect(block.limits.map((limit) => limit.kind)).toEqual(['statement_bytes']);
    expect(block.limits[0]!.detail).toContain('requirement:requirement-notes');
    expect(block.limits[0]!.detail).toContain(`requirement:${ENTITY}`);
  });
});
