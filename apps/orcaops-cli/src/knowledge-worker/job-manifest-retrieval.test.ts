import { expect, it } from 'vitest';

import { relatedKnowledgeBounds } from '@orcaops/core';
import type { EventWithPayload } from '@orcaops/storage';
import type { RelatedKnowledgeRetrieval } from '@orcaops/storage/history/database';

import { buildJobManifest } from './attempt-plan.js';
import { authoredFieldInventory, type RetainedJobSource } from './job-source.js';
import { planSourceSchedule } from './schedule.js';

const BOUNDARY = 41;
const PROJECT_ID = 'project-inspection-app';
const ARTIFACT_ID = '01a0b100-0000-7000-8000-000000000001';
const EVENT_ID = '01a0b100-0000-7000-8000-000000000002';

function sourceOf(): RetainedJobSource {
  const event = {
    record: { event_id: EVENT_ID, type: 'plan_captured' },
    payload: {
      task: 'Notes are flushed to disk before the screen reports them saved.',
      label: 'Durable notes',
    },
  } as unknown as EventWithPayload;
  const inventory = authoredFieldInventory(event);
  return {
    artifactId: ARTIFACT_ID,
    eventId: EVENT_ID,
    eventType: 'plan_captured',
    recordedAt: '2026-09-01T00:00:00.000Z',
    originKind: 'captured',
    fields: inventory.fields,
    omissions: inventory.omissions,
    sourceAuthor: { identity: 'claude-code', basis: 'source_attributed' },
    recordedBy: { identity: 'claude-code', basis: 'source_attributed' },
    planEventId: EVENT_ID,
    planAnchorLimit: null,
    knowledgeBoundary: BOUNDARY,
  };
}

const OFFLINE = {
  kind: 'requirement' as const,
  entity_id: 'requirement-offline',
  revision_id: 'requirement-offline-r1',
};
const PROJECT = { kind: 'project', project_id: PROJECT_ID } as const;
const RESOLVED = {
  target: { kind: OFFLINE.kind, entity_id: OFFLINE.entity_id },
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
      revision: OFFLINE,
      standing: 'stands',
      scope: PROJECT,
      designation: 'adopted',
      applicability: 'applies',
      source_standing: 'explicit_instruction',
      attributed_to: { kind: 'actor', actor: { identity: 'owner', basis: 'authenticated' } },
      challenged_by: [],
      account_corrected_by: [],
      corrected_basis: [],
      authority_revoked_by: [],
      departed_in_scope: [],
      in_replacement_cycle: false,
      stood_by: ['selection-offline'],
      because: [],
    },
  ],
  governing_state: { selection_ids: ['selection-offline'], correction_action_ids: [] },
  conflicts: [],
  proposals: [],
  relationships: [],
  recorded_choices: [],
  exceptions: [],
  branch_scoped: [],
  later_annotations: [],
  omissions: [],
  unresolved: [],
  evidence: { kind: 'not_attached' },
} as unknown as RelatedKnowledgeRetrieval['entries'][number]['resolved'];

const retrievalOf = (
  change: Partial<RelatedKnowledgeRetrieval> = {}
): RelatedKnowledgeRetrieval => ({
  boundary: BOUNDARY,
  scope: PROJECT,
  bounds: relatedKnowledgeBounds({ max_input_bytes: 80_000 }),
  coverage: {
    scope: PROJECT,
    mode: 'current',
    boundary: BOUNDARY,
    omitted: [],
    unresolved: [],
    later: [],
    branchScoped: [],
  },
  entries: [
    {
      target: { kind: OFFLINE.kind, entity_id: OFFLINE.entity_id },
      routes: ['task_use'],
      resolved: RESOLVED,
      statements: [{ revision: OFFLINE, text: 'The app keeps working with no network.' }],
      statementBytes: 37,
      sharesWording: false,
    },
  ],
  omissions: [{ kind: 'identity_count', detail: 'two identities were left out' }],
  counts: {
    candidates: 3,
    included: 1,
    omitted: 2,
    searchTerms: 5,
    searchHits: 4,
    statementBytes: 37,
  },
  ...change,
});

function manifestOf(retrieval = retrievalOf()) {
  const source = sourceOf();
  const planned = planSourceSchedule({
    source,
    projectId: PROJECT_ID,
    provider: 'claude',
    maxInputBytes: 80_000,
  });
  if (planned.outcome !== 'scheduled') throw new Error('fixture did not schedule');
  return buildJobManifest(source, PROJECT_ID, planned.schedule, 0, retrieval);
}

it('carries what retrieval found and says what was looked for', () => {
  const manifest = manifestOf();

  expect(manifest.related_knowledge).toHaveLength(1);
  expect(manifest.revisions.map((entry) => entry.statement)).toEqual([
    'The app keeps working with no network.',
  ]);
  expect(manifest.coverage_limits.map((limit) => limit.kind)).toEqual([
    'retrieval_limit',
    'related_knowledge_truncated',
  ]);
  expect(manifest.coverage_limits[0]!.detail).toContain('1 of them are carried');
});

it('says retrieval found nothing rather than implying nothing was looked for', () => {
  const manifest = manifestOf(
    retrievalOf({
      entries: [],
      omissions: [],
      counts: {
        candidates: 0,
        included: 0,
        omitted: 0,
        searchTerms: 5,
        searchHits: 0,
        statementBytes: 0,
      },
    })
  );

  expect(manifest.related_knowledge).toEqual([]);
  expect(manifest.coverage_limits[0]).toEqual({
    kind: 'retrieval_limit',
    detail: expect.stringContaining(`read related knowledge at write sequence ${BOUNDARY}`),
  });
});

it('refuses retrieval read at a boundary other than the source boundary', () => {
  expect(() => manifestOf(retrievalOf({ boundary: BOUNDARY + 1 }))).toThrow(
    /one manifest names one boundary/u
  );
});
