import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';

import {
  publishInterpretedKnowledge,
  publishInterpretedKnowledgeAndSettleAttempt,
  readInterpretationProgress,
  resolveProjectInterpretationSources,
} from './knowledge-interpretation.js';
import { readProjectCandidateRevisionCompatibility } from './knowledge-interpretations.js';
import { publishProjectKnowledgeSource } from './knowledge-sources.js';
import { takeProcessingLease } from './processing-lease.js';
import { readProcessingQueue } from './processing-reader.js';
import { claimProcessingJob, startProcessingAttempt } from './processing-schedule.js';
import { AT, authorityStore } from '../../../tests/knowledge-authority-store.js';
import { DETECTOR, discardKnowledgeStores, OWNER } from '../../../tests/knowledge-store.js';
import {
  later,
  NOW,
  processingAttemptConfiguration,
  processingFixture,
  PROCESSOR_CONTRACT,
} from '../../../tests/processing-fixture.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import {
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
  RequirementRevisionSchema,
} from '../../schema/knowledge-contract.js';
import {
  interpretationScheduleId,
  interpretationSegmentId,
  interpretationUnitId,
} from '../../schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../text/interpretation-preparation.js';

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  await discardKnowledgeStores();
});

const digestText = (text: string) => createHash('sha256').update(text).digest('hex');

it('canonicalizes source identities and verifies normalized evidence before replay', async () => {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  const capture = await fixture.capture();
  const fields = [
    { path: 'task', text: 'Interpret the captured plan', role: 'task' as const },
    { path: 'rationale', text: 'Restate the plan', role: 'reason' as const },
  ];
  const requestedSources = fields.map((field, position) => ({
    source_id: `${capture.eventId}#${field.path}#${position}`,
    occurrence: {
      kind: 'capture_field' as const,
      artifact_id: fixture.artifactId,
      event_id: capture.eventId,
      field_path: field.path,
      position,
    },
    source_author: OWNER,
    interpreted_by: DETECTOR,
    access_restriction: null,
  }));
  const retainedSourceId = uuidv7();
  await publishProjectKnowledgeSource(fixture.handle, {
    operationId: uuidv7(),
    source: { ...requestedSources[0]!, source_id: retainedSourceId },
    recordedBy: OWNER,
    secretAllow: [],
  });
  const resolved = resolveProjectInterpretationSources(fixture.handle, {
    sources: requestedSources,
    recordedBy: OWNER,
    secretAllow: [],
  });
  expect(resolved.map(({ sourceId }) => sourceId)).toEqual([
    retainedSourceId,
    requestedSources[1]!.source_id,
  ]);
  const segments = fields.map((field, position) => {
    const prepared = prepareInterpretationText(field.text);
    const identity = {
      source_id: requestedSources[position]!.source_id,
      occurrence: requestedSources[position]!.occurrence,
      role: field.role,
      purpose: (position === 0 ? 'primary' : 'context') as 'primary' | 'context',
      original_sha256: prepared.originalSha256,
      prepared_sha256: prepared.preparedSha256,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
      mapping: [...prepared.mapping],
    };
    return { segment_id: interpretationSegmentId(identity), ...identity };
  });
  const evidence = fields
    .map((field, position) => ({
      source_id: resolved[position]!.sourceId,
      segment_id: segments[position]!.segment_id,
      mapping_version: segments[position]!.mapping_version,
      mapping_sha256: segments[position]!.mapping_sha256,
      prepared_sha256: segments[position]!.prepared_sha256,
      prepared_start_utf8: 0,
      prepared_end_utf8: Buffer.byteLength(field.text),
      original_ranges: [{ start: 0, end: Buffer.byteLength(field.text) }],
      quote: field.text,
      passage_sha256: digestText(field.text),
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const reasonPosition = evidence.findIndex((item) => item.segment_id === segments[1]!.segment_id);
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: {
      source_id: retainedSourceId,
      task: { artifact_id: fixture.artifactId, plan_event_id: capture.eventId },
    },
    wording: fields[0]!.text,
    source_form: 'stated_decision',
    proposed_record: 'none',
    intended_scope: { kind: 'project' },
    rationale: {
      kind: 'stated',
      wording: fields[1]!.text,
      evidence_positions: [reasonPosition],
    },
    uncertainties: [],
    evidence,
    canonical_outcome: { kind: 'none', target: null },
    attributed_to: DETECTOR,
  };
  const authored = {
    ...identity,
    interpretation_id: knowledgeInterpretationId(PROCESSOR_CONTRACT, identity),
    recorded_at: AT,
  };
  const { attributed_to: _attribution, ...record } = authored;
  const operationId = uuidv7();
  const publication = {
    operationId,
    sources: requestedSources,
    segments,
    processorContract: PROCESSOR_CONTRACT,
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: { kind: 'project' as const, project_id: fixture.authority.projectId },
    records: [{ kind: 'interpretation' as const, record, rests_on: [] }],
    secretAllow: [],
  };

  const first = await publishInterpretedKnowledge(fixture.handle, publication);
  expect(first.value.sources).toEqual([
    { requestedSourceId: requestedSources[0]!.source_id, sourceId: retainedSourceId, replay: true },
    {
      requestedSourceId: requestedSources[1]!.source_id,
      sourceId: requestedSources[1]!.source_id,
      replay: false,
    },
  ]);
  await expect(publishInterpretedKnowledge(fixture.handle, publication)).resolves.toEqual({
    ...first,
    replayed: true,
  });

  const corrupted = fixture.driver();
  try {
    corrupted.exec('DROP TRIGGER knowledge_interpretation_evidence_no_delete');
    corrupted
      .prepare('DELETE FROM knowledge_interpretation_evidence WHERE interpretation_id=?')
      .run(authored.interpretation_id);
  } finally {
    corrupted.close();
  }
  await expect(
    publishInterpretedKnowledge(fixture.handle, { ...publication, operationId: uuidv7() })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});

it('distinguishes compatible candidate semantics from deterministic collisions', async () => {
  const store = await authorityStore();
  const bytes = store.handle.read((view) =>
    view.get<{ value: string }>(
      'SELECT CAST(record_bytes AS TEXT) AS value FROM requirement_revisions WHERE revision_id=?',
      store.revisionId
    )
  ).value?.value;
  if (bytes === undefined) throw new Error('fixture requirement revision is missing');
  const revision = RequirementRevisionSchema.parse(JSON.parse(bytes));
  expect(
    readProjectCandidateRevisionCompatibility(store.handle, {
      kind: 'requirement',
      identity: null,
      record: revision,
    })
  ).toMatchObject({ target: store.target, status: 'compatible' });
  expect(
    readProjectCandidateRevisionCompatibility(store.handle, {
      kind: 'requirement',
      identity: null,
      record: { ...revision, statement: `${revision.statement} Changed.` },
    })
  ).toMatchObject({ target: store.target, status: 'collision' });
});

it('atomically retains progress and refuses inconsistent receipt metadata', async () => {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  const capture = await fixture.capture();
  const text = 'Interpret the captured plan';
  const prepared = prepareInterpretationText(text);
  const sourceId = `${capture.eventId}#task#0`;
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: fixture.artifactId,
    event_id: capture.eventId,
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
  const unit = { unit_id: interpretationUnitId([segment]), segments: [segment] };
  const scheduleIdentity = {
    schema: 'orcaops.processing_schedule/v1' as const,
    source_event_id: capture.eventId,
    field_inventory_version: 'authored-fields/v1',
    units: [unit],
    omissions: [],
    omissions_total: 0,
  };
  const schedule = {
    ...scheduleIdentity,
    schedule_id: interpretationScheduleId(scheduleIdentity),
  };
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: 60_000,
    ownerId: 'worker',
    now: NOW,
    expiresAt: later(NOW, 60_000),
  });
  const claimed = await claimProcessingJob(fixture.handle, {
    generation: lease.ownerGeneration,
    now: NOW,
  });
  if (claimed.outcome !== 'claimed') throw new Error('fixture job was not claimed');
  const attemptId = uuidv7();
  const manifestSha256 = 'b'.repeat(64);
  const configuration = processingAttemptConfiguration(fixture.handle, capture.jobId, {
    processor_contract: PROCESSOR_CONTRACT,
    manifest_sha256: manifestSha256,
    schedule_binding: {
      schedule,
      schedule_attempt_id: attemptId,
      unit: {
        schedule_id: schedule.schedule_id,
        unit_id: unit.unit_id,
        index: 0,
        count: 1,
      },
    },
  });
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: null,
    generation: lease.ownerGeneration,
    jobId: capture.jobId,
    attemptId,
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: 'a'.repeat(64),
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started_without_call') throw new Error('fixture attempt did not start');
  const quality = {
    schema: 'orcaops.interpretation_quality/v1' as const,
    outcome: 'all_rejected' as const,
    proposed: { statements: 1, corrections: 0, links: 0, uncertainties: 0 },
    accepted: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
    held_back: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
    rejected: { statements: 1, corrections: 0, links: 0, uncertainties: 0 },
    diagnostics: [
      {
        unit_id: unit.unit_id,
        source_id: sourceId,
        field_path: 'task',
        collection: 'statements' as const,
        item_index: 0,
        parent_index: null,
        rule: 'invalid_candidate',
        detail: 'The candidate was rejected without discarding the settled source range.',
      },
    ],
    diagnostics_total: 1,
    diagnostics_omitted: 0,
  };

  const settled = await publishInterpretedKnowledgeAndSettleAttempt(fixture.handle, {
    operationId: attemptId,
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
    processorContract: PROCESSOR_CONTRACT,
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: { kind: 'project', project_id: fixture.authority.projectId },
    records: [],
    secretAllow: [],
    processing: {
      generation: lease.ownerGeneration,
      jobId: capture.jobId,
      attemptId,
      finishedAt: later(NOW, 1_000),
      usage: null,
      manifestSha256,
      unit: { scheduleId: schedule.schedule_id, unitId: unit.unit_id, index: 0, count: 1 },
      quality,
      outcome: { kind: 'completed', result: { quality }, detail: {} },
    },
  });

  expect(settled.value.receipt).toMatchObject({
    requested_source_ids: [sourceId],
    canonical_source_ids: [sourceId],
    primary_ranges: [
      {
        segment_id: segment.segment_id,
        source_id: sourceId,
        prepared_start_utf8: 0,
        prepared_end_utf8: Buffer.byteLength(prepared.prepared),
      },
    ],
    quality: { outcome: 'all_rejected' },
  });
  expect(readInterpretationProgress(fixture.handle, capture.jobId)?.receipts).toEqual([
    settled.value.receipt,
  ]);
  expect(readProcessingQueue(fixture.handle).extraction).toMatchObject({
    scheduledUnits: 1,
    settledUnits: 1,
    outcomes: { all_rejected: 1 },
    items: { rejected: { statements: 1 } },
    fields: [
      {
        jobId: capture.jobId,
        fieldPath: 'task',
        preparedRange: { start: 0, end: Buffer.byteLength(prepared.prepared) },
        settled: true,
      },
    ],
  });

  const corrupted = fixture.driver();
  try {
    const row = corrupted
      .prepare('SELECT detail_json AS detailJson FROM processing_attempts WHERE attempt_id=?')
      .get(attemptId) as { detailJson: string };
    const detail = JSON.parse(row.detailJson) as Record<string, unknown>;
    corrupted.exec('DROP TRIGGER processing_attempts_settled');
    corrupted.prepare('UPDATE processing_attempts SET detail_json=? WHERE attempt_id=?').run(
      JSON.stringify({
        ...detail,
        published: [{ kind: 'interpretation', id: uuidv7(), revision_id: null, replay: true }],
      }),
      attemptId
    );
    expect(() => readInterpretationProgress(fixture.handle, capture.jobId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );

    const publication = detail.completion_publication as {
      sources: Array<{ replay: boolean }>;
      sourceReplay: boolean;
    };
    corrupted.prepare('UPDATE processing_attempts SET detail_json=? WHERE attempt_id=?').run(
      JSON.stringify({
        ...detail,
        completion_publication: {
          ...publication,
          sources: publication.sources.map((source) => ({ ...source, replay: true })),
          sourceReplay: true,
        },
      }),
      attemptId
    );
    expect(() => readInterpretationProgress(fixture.handle, capture.jobId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  } finally {
    corrupted.close();
  }
});
