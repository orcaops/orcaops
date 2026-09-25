import { expect, it } from 'vitest';

import type { InterpretationProgress } from './knowledge-interpretation.js';
import { summarizeProcessingExtraction } from './processing-extraction.js';

function progress(fieldCount = 2): InterpretationProgress {
  const fields = Array.from({ length: fieldCount }, (_, index) => ({
    segment_id: `segment-${index}`,
    source_id: `source-${index}`,
    occurrence: {
      kind: 'capture_field' as const,
      artifact_id: 'task',
      event_id: 'event',
      field_path: `steps.${index}.description`,
      position: 0,
    },
    role: 'step' as const,
    purpose: 'primary' as const,
    original_sha256: 'a'.repeat(64),
    prepared_sha256: 'a'.repeat(64),
    mapping_version: 'mapping',
    mapping_sha256: 'b'.repeat(64),
    prepared_range: { start: 0, end: 20 },
    mapping: [],
  }));
  const zero = { statements: 0, corrections: 0, links: 0, uncertainties: 0 };
  return {
    schedule: {
      schema: 'orcaops.processing_schedule/v1',
      schedule_id: 'schedule',
      source_event_id: 'event',
      field_inventory_version: 'inventory',
      units: [
        { unit_id: 'finished', segments: fields },
        { unit_id: 'pending', segments: [{ ...fields[0]!, purpose: 'context' }] },
      ],
      omissions: [{ field_path: 'task', reason: 'Input does not fit.' }],
      omissions_total: 2,
    },
    receipts: [
      {
        schema: 'orcaops.interpretation_unit_receipt/v1',
        job_id: 'job',
        schedule_id: 'schedule',
        unit_id: 'finished',
        unit_index: 0,
        unit_count: 2,
        manifest_sha256: 'c'.repeat(64),
        requested_source_ids: [],
        canonical_source_ids: [],
        primary_ranges: [],
        completion_request_sha256: 'd'.repeat(64),
        publishing_operation_id: 'operation',
        quality: {
          schema: 'orcaops.interpretation_quality/v1',
          outcome: 'partial',
          proposed: { ...zero, statements: 3 },
          accepted: { ...zero, statements: 1 },
          held_back: { ...zero, statements: 1 },
          rejected: { ...zero, statements: 1 },
          diagnostics: [],
          diagnostics_total: 1,
          diagnostics_omitted: 1,
        },
      },
    ],
  };
}

it('reports partial quality independently from settled units and excludes context-only coverage', () => {
  const summary = summarizeProcessingExtraction(
    [
      { jobId: 'job', progress: progress(), unreadable: false },
      { jobId: 'waiting', progress: null, unreadable: false },
      { jobId: 'damaged', progress: null, unreadable: true },
    ],
    7
  );
  expect(summary).toMatchObject({
    sampledJobs: 3,
    omittedJobs: 7,
    notStartedJobs: 1,
    unreadableJobs: 1,
    scheduledUnits: 2,
    settledUnits: 1,
    outcomes: { partial: 1 },
    items: {
      proposed: { statements: 3, alternatives: 0 },
      accepted: { statements: 1, alternatives: 0 },
      heldBack: { statements: 1, alternatives: 0 },
      rejected: { statements: 1, alternatives: 0 },
    },
    scheduledFieldOmissions: 2,
    omittedOmissionDetails: 1,
    diagnosticsTotal: 1,
  });
  expect(summary.fields).toHaveLength(2);
  expect(summary.fields.every((field) => field.settled)).toBe(true);
  expect(summary.fields[1]).toMatchObject({
    fieldPath: 'steps.1.description',
    preparedRange: { start: 0, end: 20 },
  });
});

it('bounds field details without dropping omitted counts or pretending unfinished ranges settled', () => {
  const pending = progress(130);
  pending.receipts = [];
  const summary = summarizeProcessingExtraction(
    [{ jobId: 'job', progress: pending, unreadable: false }],
    0
  );
  expect(summary.fields).toHaveLength(128);
  expect(summary.omittedFieldDetails).toBe(2);
  expect(summary.fields.every((field) => !field.settled)).toBe(true);
  expect(summary.settledUnits).toBe(0);
});

it('bounds retained detail bytes even when field labels are large', () => {
  const pending = progress();
  pending.schedule.units[0]!.segments[0]!.occurrence.field_path = 'x'.repeat(65_536);
  const summary = summarizeProcessingExtraction(
    [{ jobId: 'job', progress: pending, unreadable: false }],
    0
  );
  expect(summary.omittedFieldDetails).toBe(1);
  expect(summary.fields).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(summary.fields))).toBeLessThan(65_536);
});
