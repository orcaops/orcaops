// What the account lane's own byte budget carries when it cannot carry everything.
//
// The projection's allowance is far smaller than a read surface's, so it is the budget most likely
// to be spent, and the one where an adopted rule dropped while background survived would first be
// seen by a reviewer.
import { describe, expect, it } from 'vitest';

import { knowledgeBlock, knowledgeProcessingCoverage } from '@orcaops/core';
import type { Designation, ResolvedKnowledge, RevisionStanding } from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
} from '@orcaops/storage/history/database';

import { DOSSIER_KNOWLEDGE_BOUNDS, dossierKnowledge } from './dossier.js';

const PROJECT = { kind: 'project', project_id: 'project-1' } as const;
const BOUNDARY = 42;

const COVERAGE = knowledgeProcessingCoverage({
  enabled: false,
  configuration_source: { kind: 'none', path: '' },
  pause_reasons: [],
  consent: null,
  project_paused: false,
  history_problem: null,
  jobs: { open: 0, waiting: 0, awaiting_model_resume: 0, completed: 0, gave_up: 0 },
  latest_admitted_sequence: null,
  eligible_sources: 0,
  missing_eligible_sources: 0,
  latest_eligible_sequence: null,
  boundary: BOUNDARY,
});

function entryFor(input: {
  kind: 'requirement' | 'decision';
  entityId: string;
  text: string;
  designation?: Designation;
}): ProjectKnowledgeContextEntry {
  const revisionId = `${input.entityId}-r1`;
  const revision = {
    kind: input.kind,
    entity_id: input.entityId,
    revision_id: revisionId,
  } as const;
  const standing: RevisionStanding = {
    revision,
    standing: 'stands',
    scope: PROJECT,
    designation: input.designation ?? 'adopted',
    applicability: 'applies',
    source_standing: 'explicit_instruction',
    attributed_to: { kind: 'actor', actor: { identity: 'owner', basis: 'authenticated' } },
    challenged_by: [],
    account_corrected_by: [],
    corrected_basis: [],
    authority_revoked_by: [],
    departed_in_scope: [],
    in_replacement_cycle: false,
    stood_by: [`selection-${revisionId}`],
    because: [],
  };
  const resolved: ResolvedKnowledge = {
    target: { kind: input.kind, entity_id: input.entityId },
    basis: {
      scope: PROJECT,
      mode: 'current',
      knowledge_boundary: BOUNDARY,
      implementation: { kind: 'none_selected' },
      applicability: {},
      exceptions_judged_at: null,
    },
    revisions: [standing],
    governing_state: { selection_ids: [`selection-${revisionId}`], correction_action_ids: [] },
    conflicts: [],
    proposals: [],
    selection_effects: [{ selection_id: `selection-${revisionId}`, standing: 'effective' }],
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

function contextOf(entries: readonly ProjectKnowledgeContextEntry[]): ProjectKnowledgeContext {
  return {
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
  };
}

describe("the account lane's knowledge budget", () => {
  it('carries no background once the budget has left an adopted rule out', () => {
    const projection = dossierKnowledge(
      knowledgeBlock(
        contextOf([
          entryFor({
            kind: 'requirement',
            entityId: 'requirement-offline',
            text: `The app keeps working with no network. ${'x'.repeat(
              DOSSIER_KNOWLEDGE_BOUNDS.maxStatementBytes ?? 0
            )}`,
          }),
          entryFor({
            kind: 'decision',
            entityId: 'decision-queue',
            text: 'Queue notes per device.',
            designation: 'background',
          }),
        ]),
        { bounds: DOSSIER_KNOWLEDGE_BOUNDS }
      )
    );

    expect(projection.entries).toEqual([]);
    expect(projection.limits).toHaveLength(1);
    expect(projection.limits[0]).toContain('requirement:requirement-offline');
    expect(projection.limits[0]).toContain('decision:decision-queue');
  });

  it('keeps an adopted rule that fits and drops the background that does not', () => {
    const projection = dossierKnowledge(
      knowledgeBlock(
        contextOf([
          entryFor({
            kind: 'requirement',
            entityId: 'requirement-offline',
            text: 'The app keeps working with no network.',
          }),
          entryFor({
            kind: 'decision',
            entityId: 'decision-queue',
            text: 'x'.repeat(DOSSIER_KNOWLEDGE_BOUNDS.maxStatementBytes ?? 0),
            designation: 'background',
          }),
        ]),
        { bounds: DOSSIER_KNOWLEDGE_BOUNDS }
      )
    );

    expect(projection.entries.map((entry) => entry.key)).toEqual([
      'requirement:requirement-offline',
    ]);
    expect(projection.limits[0]).toContain('decision:decision-queue');
  });

  it('carries the coverage claim beside its words, so no lane reads the prose for it', () => {
    const projection = dossierKnowledge(
      knowledgeBlock(contextOf([]), { processing: COVERAGE, bounds: DOSSIER_KNOWLEDGE_BOUNDS })
    );

    expect(projection.coverage.claim).toBe('not_processed');
    expect(projection.coverage.completedThrough).toBeNull();
    expect(projection.coverage.statement).toContain('claims no completeness');
  });

  it('claims nothing when no processing state was read', () => {
    const projection = dossierKnowledge(
      knowledgeBlock(contextOf([]), { bounds: DOSSIER_KNOWLEDGE_BOUNDS })
    );

    expect(projection.coverage.claim).toBeNull();
    expect(projection.coverage.completedThrough).toBeNull();
    expect(projection.coverage.statement).toContain('claims no completeness');
  });
});
