import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { knowledgeBlock, knowledgeContextEntry } from '@orcaops/core';
import type {
  Designation,
  ResolvedKnowledge,
  StandingEffect,
  StandingReason,
} from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
} from '@orcaops/storage/history/database';

import {
  SEARCH_KNOWLEDGE_BYTES_PER_ENTRY,
  searchKnowledgeBudget,
  searchKnowledgeGroup,
  type SearchKnowledgeRevision,
  searchKnowledgeWording,
} from './knowledge-search-context.js';

const source = fileURLToPath(new URL('./knowledge-search-context.ts', import.meta.url));

const PROJECT = { kind: 'project', project_id: 'project-1' } as const;
const BOUNDARY = 42;

/** One identity as the composer hands it over, with the standing the resolver already decided. */
function contextEntry(input: {
  entityId: string;
  text: string;
  standing?: 'stands' | 'stopped' | 'unadopted';
  designation?: Designation | null;
  because?: readonly StandingReason[];
}): ProjectKnowledgeContextEntry {
  const revisionId = `${input.entityId}-r1`;
  const revision = {
    kind: 'requirement',
    entity_id: input.entityId,
    revision_id: revisionId,
  } as const;
  const resolved: ResolvedKnowledge = {
    target: { kind: 'requirement', entity_id: input.entityId },
    basis: {
      scope: PROJECT,
      mode: 'current',
      knowledge_boundary: BOUNDARY,
      implementation: { kind: 'none_selected' },
      applicability: {},
      exceptions_judged_at: null,
    },
    revisions: [
      {
        revision,
        standing: input.standing ?? 'stands',
        scope: PROJECT,
        designation: input.designation === undefined ? 'adopted' : input.designation,
        applicability: 'applies',
        source_standing: 'explicit_instruction',
        attributed_to: { kind: 'actor', actor: { identity: 'owner', basis: 'authenticated' } },
        challenged_by: [],
        account_corrected_by: [],
        corrected_basis: [],
        authority_revoked_by: [],
        departed_in_scope: [],
        in_replacement_cycle: false,
        stood_by: [],
        because: [...(input.because ?? [])],
      },
    ],
    governing_state: { selection_ids: [], correction_action_ids: [] },
    conflicts: [],
    proposals: [],
    selection_effects: [],
    correction_effects: [],
    relationships: [],
    recorded_choices: [],
    exceptions: [],
    branch_scoped: [],
    later_annotations: [],
    omissions: [],
    unresolved: [],
    evidence: { kind: 'not_attached' },
  };
  return {
    target: resolved.target,
    routes: ['requested'],
    resolved,
    revisions: [
      { revisionId, previousRevisionId: null, writeSequence: 1, operationId: 'operation-1' },
    ],
    tips: [],
    statements: [{ revision, text: input.text }],
    selectedWithPlan: [],
    connectedLater: [],
    references: [],
    criterion: null,
  };
}

const contextOf = (entries: readonly ProjectKnowledgeContextEntry[]): ProjectKnowledgeContext => ({
  request: {
    scope: PROJECT,
    mode: 'current',
    knowledge_boundary: BOUNDARY,
    implementation: { kind: 'none_selected' },
    applicability: {},
    exceptions_judged_at: null,
    exception_conditions: {},
  },
  coverage: {
    scope: PROJECT,
    mode: 'current',
    boundary: BOUNDARY,
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

const reasons = (...effects: StandingEffect[]): StandingReason[] =>
  effects.map((effect, index) => ({
    record: 'correction',
    record_id: `action-${index}`,
    effect,
  }));

const wordingFor = (input: Parameters<typeof contextEntry>[0]) => {
  const group = searchKnowledgeGroup(
    knowledgeContextEntry(contextEntry(input)),
    PROJECT.project_id,
    BOUNDARY
  );
  return searchKnowledgeWording(group.revisions[0]);
};

/** The readers that answer what stands. A surface that imports one has begun deciding it itself. */
const RESOLVERS = [
  'knowledge-read-governing',
  'knowledge-read-lineage',
  'knowledge-read-boundary',
  'knowledge-resolution',
  'knowledge-standing',
  'knowledge-retrieval',
  'knowledge-corrections',
];

describe('the knowledge a search hit carries', () => {
  it('asks the composer for standing and resolves none of its own', async () => {
    const text = await readFile(source, 'utf8');
    const imported = [...text.matchAll(/^import[\s\S]*?from '([^']+)';$/gmu)].map(
      (match) => match[1]!
    );

    expect(imported).toContain('@orcaops/storage/history/database');
    expect(
      imported.filter((module) => RESOLVERS.some((reader) => module.includes(reader)))
    ).toEqual([]);
  });

  it('gives every result of a page the same fixed allowance of knowledge bytes', () => {
    expect(searchKnowledgeBudget(25)).toBe(25 * SEARCH_KNOWLEDGE_BYTES_PER_ENTRY);
    expect(searchKnowledgeBudget(1)).toBe(SEARCH_KNOWLEDGE_BYTES_PER_ENTRY);
  });

  it('says what governs and how its wording reads exactly as the block does', () => {
    const entry = contextEntry({
      entityId: 'decision-queue',
      text: 'Queue notes in one file per device.',
      designation: 'background',
    });

    const group = searchKnowledgeGroup(knowledgeContextEntry(entry), PROJECT.project_id, BOUNDARY);
    const block = knowledgeBlock(contextOf([entry]));

    expect(group.governing).toEqual(block.entries[0]!.governing_revision_ids);
    expect(group.governing).toEqual([]);
    expect(group.placement).toBe('background');
    expect(searchKnowledgeWording(group.revisions[0])).toBe('background');
  });

  it('reads a background designation as background rather than as something that stands', () => {
    expect(
      wordingFor({ entityId: 'decision-queue', text: 'Queue notes.', designation: 'background' })
    ).toBe('background');
  });

  it('reads an adopted revision as standing', () => {
    expect(wordingFor({ entityId: 'requirement-offline', text: 'Works offline.' })).toBe('stands');
  });

  it('reads each act that stopped a wording in the word that names it', () => {
    const stopped = (...effects: StandingEffect[]) =>
      wordingFor({
        entityId: 'requirement-offline',
        text: 'Works offline.',
        standing: 'stopped',
        because: reasons(...effects),
      });

    expect(stopped('adopted', 'replaced')).toBe('superseded');
    expect(stopped('adopted', 'superseded_by_relationship')).toBe('superseded');
    expect(stopped('adopted', 'withdrawn')).toBe('withdrawn');
    // A correction that follows a withdrawal corrects the record of it; the wording is still gone.
    expect(stopped('adopted', 'withdrawn', 'corrected')).toBe('withdrawn');
    // A reversed adoption is not a withdrawal: nothing ever adopted it, so nothing was taken away.
    expect(stopped('adopted', 'reversed')).toBe('background');
    expect(stopped('designation_changed')).toBe('background');
    expect(stopped()).toBe('unknown');
  });

  it('lets an act that makes a revision stand say nothing about why another one stopped', () => {
    expect(
      wordingFor({
        entityId: 'requirement-offline',
        text: 'Works offline.',
        standing: 'stopped',
        because: reasons('withdrawn', 'restored', 'stands_as_replacement', 'adopted'),
      })
    ).toBe('withdrawn');
  });

  it('answers a revision no lookup column ties to the hit with unknown', () => {
    expect(searchKnowledgeWording(undefined satisfies SearchKnowledgeRevision | undefined)).toBe(
      'unknown'
    );
  });
});
