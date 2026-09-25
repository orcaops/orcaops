import { afterEach, expect, it } from 'vitest';

import type { ProjectReadView } from './connection.js';
import { projectKnowledgeContext } from './knowledge-context.js';
import { publishInterpretedKnowledge } from './knowledge-interpretation.js';
import { readProjectKnowledgeInterpretations } from './knowledge-read-interpretations.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import {
  identitiesCitingSources,
  interpretationCandidateSourceState,
  retrieveRelatedKnowledge,
} from './knowledge-retrieval.js';
import { revisionSourceState } from './knowledge-revision-sources.js';
import { publishProjectKnowledgeSource } from './knowledge-sources.js';
import { recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  AT,
  authorityStore,
  BY_OWNER,
  requirementRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
} from '../../../tests/knowledge-store.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import {
  type InterpretationTarget,
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
} from '../../schema/knowledge-contract.js';
import { interpretationSegmentId } from '../../schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../text/interpretation-preparation.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const CONTRACT = 'knowledge-interpretation@2';
type Store = Awaited<ReturnType<typeof authorityStore>>;

it('reads released claim source metadata that predates current arrays', () => {
  const sourceEventId = uuidv7();
  const claimId = uuidv7();
  const revisionId = uuidv7();
  const view: ProjectReadView = {
    get: () => null,
    all<T>(sql: string): T[] {
      if (!sql.includes('FROM claim_revisions')) return [];
      return [
        {
          revision_id: revisionId,
          source_event_id: sourceEventId,
          source_standing: null,
          byte_length: 24,
          payload: JSON.stringify({ claim: 'Released claim' }),
        } as T,
      ];
    },
  };
  expect(revisionSourceState(view, { kind: 'claim', entity_id: claimId }, [revisionId])).toEqual({
    readable: true,
    sourceIds: [sourceEventId],
  });
});

function capturedSource(
  store: Store,
  input: { path: string; position: number; text: string; restricted: boolean }
) {
  const sourceId = `${store.plan.planEventId}#${input.path}#${input.position}`;
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: store.plan.artifactId,
    event_id: store.plan.planEventId,
    field_path: input.path,
    position: input.position,
  };
  const prepared = prepareInterpretationText(input.text);
  const segmentIdentity = {
    source_id: sourceId,
    occurrence,
    role: (input.path === 'task' ? 'task' : 'criterion') as 'task' | 'criterion',
    purpose: 'primary' as const,
    original_sha256: prepared.originalSha256,
    prepared_sha256: prepared.preparedSha256,
    mapping_version: prepared.mappingVersion,
    mapping_sha256: prepared.mappingSha256,
    prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
    mapping: [...prepared.mapping],
  };
  const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
  return {
    sourceId,
    segment,
    source: {
      source_id: sourceId,
      occurrence,
      source_author: OWNER,
      interpreted_by: DETECTOR,
      access_restriction: input.restricted ? 'private' : null,
    },
    evidence: {
      source_id: sourceId,
      segment_id: segment.segment_id,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_sha256: prepared.preparedSha256,
      prepared_start_utf8: 0,
      prepared_end_utf8: Buffer.byteLength(prepared.prepared),
      original_ranges: [{ start: 0, end: Buffer.byteLength(input.text) }],
      quote: input.text,
      passage_sha256: digest(Buffer.from(input.text)),
    },
  };
}

function interpretationPublication(
  store: Store,
  target: InterpretationTarget,
  sources: readonly ReturnType<typeof capturedSource>[],
  outcome: 'proposed_equivalence' | 'candidate_revision' = 'proposed_equivalence'
) {
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: {
      source_id: sources[0]!.sourceId,
      task: { artifact_id: store.plan.artifactId, plan_event_id: store.plan.planEventId },
    },
    wording: 'Capturing work remains available without a network connection.',
    source_form: 'stated_obligation',
    proposed_record: 'requirement',
    intended_scope: { kind: 'project' },
    rationale: { kind: 'unknown' },
    uncertainties: [],
    evidence: sources
      .map(({ evidence }) => evidence)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    canonical_outcome: { kind: outcome, target },
    attributed_to: DETECTOR,
  };
  const record = {
    ...identity,
    interpretation_id: knowledgeInterpretationId(CONTRACT, identity),
    recorded_at: AT,
  };
  const { attributed_to: _attributedTo, ...authored } = record;
  return {
    record,
    publication: {
      sources: sources.map(({ source }) => source),
      segments: sources.map(({ segment }) => segment),
      processorContract: CONTRACT,
      recordedBy: OWNER,
      attributedTo: DETECTOR,
      scope: store.artifact,
      records: [{ kind: 'interpretation' as const, interpretation: authored, restsOn: [] }],
      secretAllow: [],
    },
  };
}

function read(
  store: Store,
  input: Partial<Parameters<typeof readProjectKnowledgeInterpretations>[1]>
) {
  const boundary = counters(store.handle).writeSequence;
  return store.handle.read((view) =>
    readProjectKnowledgeInterpretations(view, {
      projectId: store.authority.projectId,
      boundary,
      artifactIds: [],
      eventIds: [],
      targets: [],
      projectFallback: false,
      ...input,
    })
  ).value;
}

it('withholds mixed-source interpretations and their candidates through every route', async () => {
  const store = await authorityStore();
  const open = capturedSource(store, {
    path: 'task',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: false,
  });
  const restricted = capturedSource(store, {
    path: 'label',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: true,
  });
  const input = interpretationPublication(
    store,
    store.target,
    [open, restricted],
    'candidate_revision'
  );
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });

  const boundary = counters(store.handle).writeSequence;
  const sourceState = store.handle.read((view) =>
    interpretationCandidateSourceState(
      {
        get: view.get.bind(view),
        all<T>(sql: string, ...parameters: unknown[]): T[] {
          const rows = view.all<Record<string, unknown>>(sql, ...parameters);
          if (!sql.includes('CASE WHEN length(record_bytes)<=4194304')) return rows as T[];
          return rows.map((row) => ({ ...row, payload: null })) as T[];
        },
      },
      { kind: store.target.kind, entity_id: store.target.entity_id },
      [store.target.revision_id],
      boundary
    )
  ).value;
  expect(sourceState).toMatchObject({ readable: false, restrictions: ['private'] });
  expect(sourceState.sourceIds).toContain(restricted.sourceId);

  expect(read(store, { artifactIds: [store.plan.artifactId] }).interpretations).toEqual([]);
  expect(read(store, { eventIds: [store.plan.planEventId] }).interpretations).toEqual([]);
  expect(read(store, { targets: [store.target] }).interpretations).toEqual([]);
  expect(
    read(store, { artifactIds: ['another-task'], projectFallback: true }).interpretations
  ).toEqual([]);
  expect(
    store.handle.read((view) => identitiesCitingSources(view, [open.sourceId], boundary)).value.rows
  ).not.toContainEqual({ kind: store.target.kind, entity_id: store.target.entity_id });
});

it('withholds a restricted interpretation-backed candidate reached through a task use', async () => {
  const store = await authorityStore();
  const open = capturedSource(store, {
    path: 'task',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: false,
  });
  const restricted = capturedSource(store, {
    path: 'label',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: true,
  });
  await recordProjectTaskUses(store.handle, {
    operationId: uuidv7(),
    uses: [
      {
        artifact_id: store.plan.artifactId,
        plan_event_id: store.plan.planEventId,
        target: store.target,
        role: 'background',
        local: null,
        exception_id: null,
      },
    ],
    discovery: { discovered_at: AT, discovered_by: { kind: 'actor', actor: OWNER } },
    secretAllow: [],
  });
  const earlierBoundary = counters(store.handle).writeSequence;
  const input = interpretationPublication(
    store,
    store.target,
    [open, restricted],
    'candidate_revision'
  );
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });
  const boundary = counters(store.handle).writeSequence;
  const related = (at: number) =>
    store.handle.read((view) =>
      retrieveRelatedKnowledge(view, {
        source: {
          artifactId: store.plan.artifactId,
          eventId: store.plan.planEventId,
          planEventId: store.plan.planEventId,
          text: 'unrelated words',
        },
        projectId: store.authority.projectId,
        scope: store.artifact,
        boundary: at,
        bounds: {
          maxIdentities: 10,
          maxStatementBytes: 16_384,
          maxSearchTerms: 4,
          maxSearchHits: 10,
          maxSourcesFollowed: 10,
        },
      })
    ).value;
  const taskContext = (at: number) =>
    store.handle.read((view) =>
      projectKnowledgeContext(view, {
        projectId: store.authority.projectId,
        scope: store.artifact,
        boundary: at,
        mode: 'current',
        subject: { kind: 'task', artifactIds: [store.plan.artifactId] },
      })
    ).value;
  const retrieval = related(boundary);
  const context = taskContext(boundary);

  expect(related(earlierBoundary).entries).toHaveLength(1);
  expect(taskContext(earlierBoundary).entries).toHaveLength(1);
  expect(retrieval.entries).toEqual([]);
  expect(retrieval.omissions).toContainEqual(
    expect.objectContaining({ kind: 'access_restricted' })
  );
  expect(context.entries).toEqual([]);
  expect(context.interpretationRead?.interpretations).toEqual([]);
  expect(context.omissions).toContainEqual(expect.objectContaining({ kind: 'access_restricted' }));
  expect(JSON.stringify(context)).not.toContain(restricted.sourceId);
  expect(JSON.stringify(context)).not.toContain(input.record.interpretation_id);
});

it('withholds an interpretation whose exact target revision cites a restricted source', async () => {
  const store = await authorityStore();
  const retainedBytes = Buffer.from('Private requirement source');
  const restrictedSourceId = uuidv7();
  await publishProjectKnowledgeSource(store.handle, {
    operationId: uuidv7(),
    source: {
      source_id: restrictedSourceId,
      occurrence: {
        kind: 'user_instruction',
        retention: { kind: 'bytes', content_sha256: digest(retainedBytes) },
        location: 'private instruction',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: 'private',
    },
    recordedBy: OWNER,
    retainedBytes,
    secretAllow: [],
  });
  const revisionId = uuidv7();
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: {
      ...requirementRevision(store.requirementId, restrictedSourceId, {
        revisionId,
        previousRevisionId: store.revisionId,
      }),
      source_ids: [restrictedSourceId],
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const target = { ...store.target, revision_id: revisionId };
  const open = capturedSource(store, {
    path: 'task',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: false,
  });
  const input = interpretationPublication(store, target, [open]);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });

  expect(read(store, { artifactIds: [store.plan.artifactId] }).interpretations).toEqual([]);
  expect(read(store, { targets: [target] }).interpretations).toEqual([]);
  expect(
    read(store, { artifactIds: ['another-task'], projectFallback: true }).interpretations
  ).toEqual([]);
});

it('does not apply later restricted target evidence to an earlier boundary', async () => {
  const store = await authorityStore();
  const open = capturedSource(store, {
    path: 'task',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: false,
  });
  const proposed = interpretationPublication(store, store.target, [open]);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...proposed.publication,
  });
  const earlierBoundary = counters(store.handle).writeSequence;
  const restricted = capturedSource(store, {
    path: 'label',
    position: 0,
    text: 'Keep local capture working offline',
    restricted: true,
  });
  const later = interpretationPublication(store, store.target, [restricted], 'candidate_revision');
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...later.publication,
  });

  expect(
    read(store, { boundary: earlierBoundary, targets: [store.target] }).interpretations
  ).toHaveLength(1);
  expect(read(store, { targets: [store.target] }).interpretations).toEqual([]);
});
