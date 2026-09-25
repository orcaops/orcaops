import { afterEach, expect, it } from 'vitest';

import type { ProjectReadView } from './connection.js';
import { projectKnowledgeContext } from './knowledge-context.js';
import { publishInterpretedKnowledge } from './knowledge-interpretation.js';
import { rejectProjectKnowledgeEquivalence } from './knowledge-interpretations.js';
import { readProjectKnowledgeInterpretations } from './knowledge-read-interpretations.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import { retainedIntendedScope } from './knowledge-wording.js';
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
import { uuidv7 } from '../../ids/uuidv7.js';
import {
  knowledgeEquivalenceDispositionId,
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
} from '../../schema/knowledge-contract.js';
import { interpretationSegmentId } from '../../schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../text/interpretation-preparation.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const CONTRACT = 'knowledge-interpretation@2';
type Store = Awaited<ReturnType<typeof authorityStore>>;

function interpreted(
  store: Store,
  scope: KnowledgeInterpretation['intended_scope'] = { kind: 'project' },
  wording = 'Capturing work does not require a connection.',
  taskOrigin = true,
  targeted = true
) {
  const text = 'Keep local capture working offline';
  const prepared = prepareInterpretationText(text);
  const sourceId = `${store.plan.planEventId}#task#0`;
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: store.plan.artifactId,
    event_id: store.plan.planEventId,
    field_path: 'task',
    position: 0,
  };
  const segmentIdentity = {
    source_id: sourceId,
    occurrence,
    role: 'task' as const,
    purpose: 'primary' as const,
    original_sha256: prepared.originalSha256,
    prepared_sha256: prepared.preparedSha256,
    mapping_version: prepared.mappingVersion,
    mapping_sha256: prepared.mappingSha256,
    prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
    mapping: [...prepared.mapping],
  };
  const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: {
      source_id: sourceId,
      task: taskOrigin
        ? { artifact_id: store.plan.artifactId, plan_event_id: store.plan.planEventId }
        : null,
    },
    wording,
    source_form: 'stated_obligation',
    proposed_record: 'requirement',
    intended_scope: scope,
    rationale: { kind: 'unknown' },
    uncertainties: [
      {
        about: 'equivalence',
        note: 'Check whether the connection requirement has the same scope.',
      },
    ],
    evidence: [
      {
        source_id: sourceId,
        segment_id: segment.segment_id,
        mapping_version: prepared.mappingVersion,
        mapping_sha256: prepared.mappingSha256,
        prepared_sha256: prepared.preparedSha256,
        prepared_start_utf8: 0,
        prepared_end_utf8: Buffer.byteLength(text),
        original_ranges: [{ start: 0, end: Buffer.byteLength(text) }],
        quote: text,
        passage_sha256: digest(Buffer.from(text)),
      },
    ],
    canonical_outcome: targeted
      ? { kind: 'proposed_equivalence', target: store.target }
      : { kind: 'none', target: null },
    attributed_to: DETECTOR,
  };
  const record = {
    ...identity,
    interpretation_id: knowledgeInterpretationId(CONTRACT, identity),
    recorded_at: AT,
  };
  const { attributed_to: _attributedTo, ...authored } = record;
  const publication = {
    sources: [
      {
        source_id: sourceId,
        occurrence,
        source_author: OWNER,
        interpreted_by: DETECTOR,
        access_restriction: null,
      },
    ],
    segments: [segment],
    processorContract: CONTRACT,
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [{ kind: 'interpretation' as const, interpretation: authored, restsOn: [] }],
    secretAllow: [],
  };
  return { record, publication };
}

function read(
  store: Store,
  change: Partial<Parameters<typeof readProjectKnowledgeInterpretations>[1]> = {}
) {
  const boundary = counters(store.handle).writeSequence;
  return store.handle.read((view) =>
    readProjectKnowledgeInterpretations(view, {
      projectId: store.authority.projectId,
      boundary,
      artifactIds: [store.plan.artifactId],
      eventIds: [],
      targets: [],
      projectFallback: true,
      ...change,
    })
  ).value;
}

it('does not follow a later revision when reading an exact proposed match', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, { operationId: uuidv7(), ...input.publication });
  const laterRevision = uuidv7();
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: requirementRevision(store.requirementId, store.sourceId, {
      revisionId: laterRevision,
      previousRevisionId: store.revisionId,
      statement: 'Captures require a working local database.',
    }),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const exact = { artifactIds: [], projectFallback: false };
  expect(
    read(store, { ...exact, targets: [{ ...store.target, revision_id: laterRevision }] })
      .interpretations
  ).toEqual([]);
  expect(
    read(store, { ...exact, targets: [store.target] }).interpretations[0]!.interpretation
  ).toEqual(input.record);
});

it('withholds an interpretation whose evidence source is restricted', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
    sources: input.publication.sources.map((source) => ({
      ...source,
      access_restriction: 'private',
    })),
  });
  const answer = read(store);
  expect(answer.interpretations).toEqual([]);
  expect(answer.limits[0]!.detail).toContain('1 restricted');
});

it('keeps a rejected match independently readable without rewriting either record or granting authority', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  const before = counters(store.handle);
  await publishInterpretedKnowledge(store.handle, { operationId: uuidv7(), ...input.publication });
  const published = counters(store.handle);
  expect(read(store, { boundary: before.writeSequence }).interpretations).toEqual([]);
  expect(read(store).interpretations[0]).toMatchObject({
    interpretation: input.record,
    equivalenceStatus: 'proposed',
  });
  const identity = {
    interpretation_id: input.record.interpretation_id,
    disposition: 'rejected' as const,
    reason: 'It concerns another scope.',
    decided_by: OWNER,
  };
  const { decided_by: _decidedBy, ...authored } = identity;
  await rejectProjectKnowledgeEquivalence(store.handle, {
    operationId: uuidv7(),
    decidedBy: OWNER,
    secretAllow: [],
    disposition: {
      ...authored,
      disposition_id: knowledgeEquivalenceDispositionId(identity),
      recorded_at: AT,
    },
  });
  expect(read(store).interpretations[0]).toMatchObject({
    interpretation: input.record,
    equivalenceStatus: 'rejected',
    rejection: { reason: 'It concerns another scope.' },
  });
  expect(
    read(store, { boundary: published.writeSequence }).interpretations[0]?.equivalenceStatus
  ).toBe('proposed');
  expect(counters(store.handle).intentChangeCounter).toBe(before.intentChangeCounter);
  const context = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.artifact,
      boundary: 'now',
      mode: 'current',
      subject: { kind: 'task', artifactIds: [store.plan.artifactId] },
    })
  ).value;
  expect(context.interpretationRead?.interpretations[0]?.interpretation.wording).toBe(
    input.record.wording
  );
  expect(
    context.entries.flatMap((entry) => [...entry.selectedWithPlan, ...entry.connectedLater])
  ).toEqual([]);
});

it('routes project-intended interpretations across tasks without widening task-only or unknown scope', async () => {
  const store = await authorityStore();
  const project = interpreted(store);
  const local = interpreted(store, { kind: 'artifact', artifact_id: store.plan.artifactId });
  const unknown = interpreted(store, { kind: 'unknown' });
  for (const input of [project, local, unknown])
    await publishInterpretedKnowledge(store.handle, {
      operationId: uuidv7(),
      ...input.publication,
    });
  expect(read(store).interpretations.map((entry) => entry.route)).toEqual([
    'origin_task',
    'origin_task',
    'origin_task',
  ]);
  expect(
    read(store, { artifactIds: ['other-task'] }).interpretations.map(
      (entry) => entry.interpretation.interpretation_id
    )
  ).toEqual([project.record.interpretation_id]);
  expect(
    read(store, { artifactIds: [], projectFallback: false, targets: [store.target] })
      .interpretations
  ).toHaveLength(3);
});

it('falls through a null task origin to source and project routes', async () => {
  const store = await authorityStore();
  const input = interpreted(
    store,
    { kind: 'project' },
    'Source-only observations remain visible to their project.',
    false,
    false
  );
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });
  expect(read(store, { eventIds: [store.plan.planEventId] }).interpretations[0]?.route).toBe(
    'source'
  );
  expect(read(store, { eventIds: [] }).interpretations[0]?.route).toBe('project');
});

it('reads an exact match when the caller names more than 256 retained revisions', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });
  const targets = [store.target];
  let previousRevisionId = store.revisionId;
  for (let index = 0; index < 256; index += 1) {
    const revision = requirementRevision(store.requirementId, store.sourceId, {
      previousRevisionId,
      statement: `Captures remain available after retained revision ${index}.`,
    });
    await publishProjectRequirementRevision(store.handle, {
      operationId: uuidv7(),
      revision,
      attributedTo: BY_OWNER,
      secretAllow: [],
    });
    targets.push({
      kind: 'requirement',
      entity_id: store.requirementId,
      revision_id: revision.revision_id,
    });
    previousRevisionId = revision.revision_id;
  }
  const result = read(store, {
    artifactIds: [],
    eventIds: [],
    targets,
    projectFallback: false,
  });
  expect(result.interpretations).toMatchObject([
    { route: 'exact_target', interpretation: input.record },
  ]);
  const context = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary: 'now',
      mode: 'current',
      subject: {
        kind: 'identities',
        targets: [{ kind: 'requirement', entity_id: store.requirementId }],
      },
    })
  ).value;
  expect(context.entries[0]?.revisions).toHaveLength(257);
  expect(context.interpretationRead?.interpretations).toMatchObject([
    { route: 'exact_target', interpretation: input.record },
  ]);
});

it('reports bounded omissions and rejects a different project', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, { operationId: uuidv7(), ...input.publication });
  const limited = read(store, { maxEntries: 0 });
  expect(limited.interpretations).toEqual([]);
  expect(limited.limits).toEqual([
    expect.objectContaining({
      kind: 'interpretations_omitted',
      detail: expect.stringContaining('1 interpretation(s) on route origin_task'),
    }),
  ]);
  expect(read(store, { maxBytes: 0 }).interpretations).toEqual([]);
  expect(() => read(store, { projectId: 'another-project' })).toThrow('named project');
});

it('replays a published interpretation without adding another visible copy', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, { operationId: uuidv7(), ...input.publication });
  const before = counters(store.handle);
  await publishInterpretedKnowledge(store.handle, { operationId: uuidv7(), ...input.publication });
  expect(read(store).interpretations).toHaveLength(1);
  expect(counters(store.handle)).toEqual(before);
});

it('does not let an oversized interpretation consume a slot needed by a later small one', async () => {
  const store = await authorityStore();
  const large = interpreted(store, { kind: 'project' }, 'Long wording. '.repeat(1000));
  const small = interpreted(store);
  for (const input of [large, small])
    await publishInterpretedKnowledge(store.handle, {
      operationId: uuidv7(),
      ...input.publication,
    });
  const result = read(store, {
    maxEntries: 1,
    maxBytes: Buffer.byteLength(JSON.stringify(small.record)),
  });
  expect(result.interpretations.map((row) => row.interpretation.interpretation_id)).toEqual([
    small.record.interpretation_id,
  ]);
  expect(result.limits[0]!.detail).toContain('1 outside the byte bounds');
});

it('skips an unreadable interpretation without consuming the returned entry allowance', async () => {
  const store = await authorityStore();
  const first = interpreted(store);
  const second = interpreted(store, { kind: 'unknown' });
  for (const input of [first, second])
    await publishInterpretedKnowledge(store.handle, {
      operationId: uuidv7(),
      ...input.publication,
    });
  const boundary = counters(store.handle).writeSequence;
  const result = store.handle.read((view) =>
    readProjectKnowledgeInterpretations(
      {
        all: view.all.bind(view),
        get<T>(sql: string, ...parameters: unknown[]): T | null {
          if (
            sql.startsWith('SELECT CAST(record_bytes') &&
            parameters[0] === first.record.interpretation_id
          )
            return { payload: '{}' } as T;
          return view.get<T>(sql, ...parameters);
        },
      },
      {
        projectId: store.authority.projectId,
        boundary,
        artifactIds: [store.plan.artifactId],
        eventIds: [],
        targets: [],
        projectFallback: true,
        maxEntries: 1,
      }
    )
  ).value;
  expect(result.interpretations.map((row) => row.interpretation.interpretation_id)).toEqual([
    second.record.interpretation_id,
  ]);
  expect(result.limits[0]!.detail).toContain('1 unreadable');
});

it('withholds a current target missing source metadata without miscounting it', async () => {
  const store = await authorityStore();
  const input = interpreted(store);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    ...input.publication,
  });
  const boundary = counters(store.handle).writeSequence;
  const result = store.handle.read((view) =>
    readProjectKnowledgeInterpretations(
      {
        get: view.get.bind(view),
        all<T>(sql: string, ...parameters: unknown[]): T[] {
          const rows = view.all<Record<string, unknown>>(sql, ...parameters);
          if (!sql.includes('CASE WHEN length(record_bytes)<=4194304')) return rows as T[];
          return rows.map((row) => ({
            ...row,
            payload: JSON.stringify({ statement: 'Missing retained source metadata.' }),
          })) as T[];
        },
      },
      {
        projectId: store.authority.projectId,
        boundary,
        artifactIds: [store.plan.artifactId],
        eventIds: [],
        targets: [],
        projectFallback: true,
      }
    )
  ).value;
  expect(result.interpretations).toEqual([]);
  expect(result.limits[0]?.detail).toContain(
    '1 interpretation(s) on route origin_task omitted: 0 restricted, 1 unreadable, 0 outside the byte bounds, 0 not examined within the read bounds.'
  );
});

it('distinguishes absent legacy scope from invalid interpretation provenance', async () => {
  const store = await authorityStore();
  const record = {
    ...interpreted(store).record,
    canonical_outcome: { kind: 'candidate_revision', target: store.target },
  };
  let held: unknown = record;
  let knownCandidate = false;
  const view: ProjectReadView = {
    all: () => [],
    get<T>(sql: string): T | null {
      if (sql.includes('CAST(i.record_bytes'))
        return held === null ? null : ({ payload: JSON.stringify(held) } as T);
      return knownCandidate ? ({ interpretation_id: record.interpretation_id } as T) : null;
    },
  };
  const support = { interpretation_id: record.interpretation_id, evidence_relation: 'supports' };
  const readScope = (interpretation: unknown) =>
    retainedIntendedScope(view, JSON.stringify({ interpretation }), store.target, 4);
  expect(readScope(undefined)).toEqual({ intended_scope_status: 'legacy_absent' });
  expect(readScope(support)).toEqual({
    intended_scope_status: 'verified',
    intended_scope: { kind: 'project' },
  });
  expect(readScope({ ...support, evidence_relation: 'contradicts' })).toEqual({
    intended_scope_status: 'invalid',
  });
  held = {
    ...record,
    canonical_outcome: {
      kind: 'candidate_revision',
      target: { ...store.target, revision_id: 'different' },
    },
  };
  expect(readScope(support)).toEqual({ intended_scope_status: 'invalid' });
  held = null;
  expect(readScope(support)).toEqual({ intended_scope_status: 'invalid' });
  knownCandidate = true;
  expect(readScope(undefined)).toEqual({ intended_scope_status: 'invalid' });
  held = { ...record, intended_scope: { kind: 'unknown' } };
  expect(readScope(support)).toEqual({
    intended_scope_status: 'verified',
    intended_scope: { kind: 'unknown' },
  });
});

it('checks a rejection size before materializing its text and preserves room for later entries', async () => {
  const store = await authorityStore();
  const first = interpreted(store);
  const second = interpreted(store, { kind: 'unknown' });
  for (const input of [first, second])
    await publishInterpretedKnowledge(store.handle, {
      operationId: uuidv7(),
      ...input.publication,
    });
  const boundary = counters(store.handle).writeSequence;
  const result = store.handle.read((view) =>
    readProjectKnowledgeInterpretations(
      {
        all: view.all.bind(view),
        get<T>(sql: string, ...parameters: unknown[]): T | null {
          if (
            sql.includes('knowledge_equivalence_dispositions') &&
            parameters[0] === first.record.interpretation_id
          ) {
            if (sql.includes('AS byte_length')) return { byte_length: 4_194_305 } as T;
            throw new Error('An oversized rejection must not be materialized');
          }
          return view.get<T>(sql, ...parameters);
        },
      },
      {
        projectId: store.authority.projectId,
        boundary,
        artifactIds: [store.plan.artifactId],
        eventIds: [],
        targets: [],
        projectFallback: false,
        maxEntries: 1,
      }
    )
  ).value;
  expect(result.interpretations.map((row) => row.interpretation.interpretation_id)).toEqual([
    second.record.interpretation_id,
  ]);
  expect(result.limits[0]!.detail).toContain('1 outside the byte bounds');
});
