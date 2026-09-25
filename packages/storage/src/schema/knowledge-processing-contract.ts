import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../events/canonical-json.js';
import { identifierText, proseText } from '../text/control-chars.js';

const identifier = () =>
  identifierText(z.string().regex(/^\S+$/u, 'must not be blank or contain whitespace'));
const label = () => identifierText(z.string().regex(/\S/u, 'must not be blank'));
const sha256 = () => identifierText(z.string().regex(/^[0-9a-f]{64}$/u));
const offset = () => z.number().int().nonnegative().safe();
const count = () => z.number().int().nonnegative().safe();
const identityHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const range = () =>
  z.strictObject({ start: offset(), end: offset() }).refine((value) => value.start <= value.end, {
    message: 'a byte range ends at or after it starts',
  });

export const InterpretationMappingRunSchema = z
  .strictObject({
    kind: z.enum(['copied', 'removed_control', 'redacted']),
    prepared: range(),
    original: range(),
  })
  .superRefine((run, ctx) => {
    if (run.original.start === run.original.end)
      ctx.addIssue({
        code: 'custom',
        path: ['original', 'end'],
        message: 'a mapping run consumes original bytes',
      });
    const preparedIsEmpty = run.prepared.start === run.prepared.end;
    if ((run.kind === 'removed_control') !== preparedIsEmpty)
      ctx.addIssue({
        code: 'custom',
        path: ['prepared'],
        message: 'only a removed-control run has an empty prepared range',
      });
  });
export type InterpretationMappingRun = z.infer<typeof InterpretationMappingRunSchema>;

export const interpretationSegmentId = (segment: {
  readonly source_id: string;
  readonly occurrence: unknown;
  readonly role: string;
  readonly purpose: string;
  readonly original_sha256: string;
  readonly prepared_sha256: string;
  readonly mapping_version: string;
  readonly mapping_sha256: string;
  readonly prepared_range: unknown;
  readonly mapping: readonly InterpretationMappingRun[];
}) => identityHash(['orcaops.processing_segment/v1', segment]);

export const ScheduledInterpretationSegmentSchema = z
  .strictObject({
    segment_id: sha256(),
    source_id: identifier(),
    occurrence: z.strictObject({
      kind: z.literal('capture_field'),
      artifact_id: identifier(),
      event_id: identifier(),
      field_path: label(),
      position: offset(),
    }),
    role: z.enum([
      'task',
      'step',
      'criterion',
      'decision',
      'reason',
      'rejected_alternative',
      'rejection_reason',
      'non_goal',
      'non_goal_reason',
      'checkpoint',
      'observation',
      'uncertainty',
      'outcome',
      'open_item',
      'deferred_decision',
    ]),
    purpose: z.enum(['primary', 'context']),
    original_sha256: sha256(),
    prepared_sha256: sha256(),
    mapping_version: label(),
    mapping_sha256: sha256(),
    prepared_range: range().refine((value) => value.start < value.end, {
      message: 'a scheduled segment contains prepared bytes',
    }),
    mapping: z.array(InterpretationMappingRunSchema).min(1),
  })
  .superRefine((segment, ctx) => {
    let originalEnd = -1;
    let preparedEnd = -1;
    segment.mapping.forEach((run, index) => {
      if (run.original.start < originalEnd)
        ctx.addIssue({
          code: 'custom',
          path: ['mapping', index, 'original', 'start'],
          message: 'mapping runs are ordered and do not overlap in original bytes',
        });
      if (run.prepared.start < preparedEnd)
        ctx.addIssue({
          code: 'custom',
          path: ['mapping', index, 'prepared', 'start'],
          message: 'mapping runs are ordered and do not overlap in prepared bytes',
        });
      originalEnd = run.original.end;
      preparedEnd = run.prepared.end;
    });
    const { segment_id: supplied, ...identity } = segment;
    if (supplied !== interpretationSegmentId(identity))
      ctx.addIssue({
        code: 'custom',
        path: ['segment_id'],
        message: 'the segment ID hashes its exact requested source, role, ranges and mapping',
      });
    if (segment.mapping_sha256 !== identityHash(segment.mapping))
      ctx.addIssue({
        code: 'custom',
        path: ['mapping_sha256'],
        message: 'the mapping hash covers the exact ordered mapping runs',
      });
  });
export type ScheduledInterpretationSegment = z.infer<typeof ScheduledInterpretationSegmentSchema>;

const ScheduledInterpretationUnitSchema = z.strictObject({
  unit_id: sha256(),
  segments: z.array(ScheduledInterpretationSegmentSchema).min(1),
});

export const interpretationUnitId = (segments: readonly ScheduledInterpretationSegment[]): string =>
  identityHash(['orcaops.processing_unit/v1', segments]);

export const interpretationScheduleId = (schedule: {
  readonly schema: 'orcaops.processing_schedule/v1';
  readonly source_event_id: string;
  readonly field_inventory_version: string;
  readonly units: readonly { readonly unit_id: string; readonly segments: readonly unknown[] }[];
  readonly omissions: readonly unknown[];
  readonly omissions_total: number;
}): string => identityHash(schedule);

export const InterpretationProcessingScheduleSchema = z
  .strictObject({
    schema: z.literal('orcaops.processing_schedule/v1'),
    schedule_id: sha256(),
    source_event_id: identifier(),
    field_inventory_version: label(),
    units: z.array(ScheduledInterpretationUnitSchema).max(64),
    omissions: z.array(z.strictObject({ field_path: label(), reason: proseText() })).max(256),
    omissions_total: count(),
  })
  .superRefine((schedule, ctx) => {
    const segmentCount = schedule.units.reduce((total, unit) => total + unit.segments.length, 0);
    if (segmentCount > 256)
      ctx.addIssue({
        code: 'custom',
        path: ['units'],
        message: 'a processing schedule retains at most 256 segment occurrences',
      });
    if (schedule.omissions_total < schedule.omissions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['omissions_total'],
        message: 'the total omission count includes every retained omission',
      });
    const unitIds = schedule.units.map((unit) => unit.unit_id);
    if (new Set(unitIds).size !== unitIds.length)
      ctx.addIssue({ code: 'custom', path: ['units'], message: 'schedule unit IDs are unique' });
    schedule.units.forEach((unit, index) => {
      if (unit.unit_id !== interpretationUnitId(unit.segments))
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'unit_id'],
          message: 'the unit ID hashes its exact ordered segments',
        });
    });
    const { schedule_id: supplied, ...identity } = schedule;
    if (supplied !== interpretationScheduleId(identity))
      ctx.addIssue({
        code: 'custom',
        path: ['schedule_id'],
        message: 'the schedule ID hashes its exact source, units and omissions',
      });
    if (Buffer.byteLength(canonicalJson(schedule), 'utf8') > 262_144)
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'a processing schedule retains at most 262144 canonical JSON bytes',
      });
  });
export type InterpretationProcessingSchedule = z.infer<
  typeof InterpretationProcessingScheduleSchema
>;

export const InterpretationAttemptScheduleBindingSchema = z
  .strictObject({
    schedule: InterpretationProcessingScheduleSchema.nullable(),
    schedule_attempt_id: identifier(),
    unit: z
      .strictObject({
        schedule_id: sha256(),
        unit_id: sha256(),
        index: offset(),
        count: z.number().int().positive().safe(),
      })
      .nullable(),
  })
  .superRefine((binding, ctx) => {
    if (binding.unit === null) {
      if (binding.schedule === null || binding.schedule.units.length !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['unit'],
          message: 'only a retained empty schedule has no selected unit',
        });
      return;
    }
    if (binding.unit.index >= binding.unit.count)
      ctx.addIssue({
        code: 'custom',
        path: ['unit', 'index'],
        message: 'the unit index is within the scheduled unit count',
      });
    if (binding.schedule !== null) {
      if (binding.schedule.schedule_id !== binding.unit.schedule_id)
        ctx.addIssue({
          code: 'custom',
          path: ['unit', 'schedule_id'],
          message: 'the unit belongs to the retained schedule',
        });
      if (
        binding.schedule.units.length !== binding.unit.count ||
        binding.schedule.units[binding.unit.index]?.unit_id !== binding.unit.unit_id
      )
        ctx.addIssue({
          code: 'custom',
          path: ['unit'],
          message: 'the unit names its exact position in the retained schedule',
        });
    }
  });
export type InterpretationAttemptScheduleBinding = z.infer<
  typeof InterpretationAttemptScheduleBindingSchema
>;

const InterpretationQualityCountsSchema = z.strictObject({
  statements: count(),
  corrections: count(),
  links: count(),
  uncertainties: count(),
  alternatives: count().optional(),
});

export const InterpretationQualitySchema = z
  .strictObject({
    schema: z.literal('orcaops.interpretation_quality/v1'),
    outcome: z.enum(['accepted', 'partial', 'all_rejected', 'empty']),
    proposed: InterpretationQualityCountsSchema,
    accepted: InterpretationQualityCountsSchema,
    held_back: InterpretationQualityCountsSchema,
    rejected: InterpretationQualityCountsSchema,
    diagnostics: z
      .array(
        z.strictObject({
          unit_id: sha256(),
          source_id: identifier(),
          field_path: label(),
          collection: z.enum([
            'statements',
            'corrections',
            'links',
            'uncertainties',
            'alternatives',
          ]),
          item_index: offset(),
          parent_index: offset().nullable(),
          rule: label(),
          detail: proseText(z.string().max(1_024)),
        })
      )
      .max(256),
    diagnostics_total: count(),
    diagnostics_omitted: count(),
  })
  .superRefine((quality, ctx) => {
    const keys = ['statements', 'corrections', 'links', 'uncertainties', 'alternatives'] as const;
    for (const key of keys)
      if (
        (quality.proposed[key] ?? 0) !==
        (quality.accepted[key] ?? 0) + (quality.held_back[key] ?? 0) + (quality.rejected[key] ?? 0)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['proposed', key],
          message: 'proposed equals accepted plus held back plus rejected',
        });
    if (quality.diagnostics_total !== quality.diagnostics.length + quality.diagnostics_omitted)
      ctx.addIssue({
        code: 'custom',
        path: ['diagnostics_total'],
        message: 'diagnostic totals include retained and omitted diagnostics',
      });
    const proposed = keys.reduce((total, key) => total + (quality.proposed[key] ?? 0), 0);
    const accepted = keys.reduce((total, key) => total + (quality.accepted[key] ?? 0), 0);
    const heldBack = keys.reduce((total, key) => total + (quality.held_back[key] ?? 0), 0);
    const rejected = keys.reduce((total, key) => total + (quality.rejected[key] ?? 0), 0);
    const expectedOutcome =
      proposed === 0
        ? 'empty'
        : rejected === proposed
          ? 'all_rejected'
          : rejected > 0 && accepted + heldBack > 0
            ? 'partial'
            : 'accepted';
    if (quality.outcome !== expectedOutcome)
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: `quality counts require outcome ${expectedOutcome}`,
      });
  });
export type InterpretationQuality = z.infer<typeof InterpretationQualitySchema>;

export const InterpretationUnitReceiptSchema = z
  .strictObject({
    schema: z.literal('orcaops.interpretation_unit_receipt/v1'),
    job_id: identifier(),
    schedule_id: sha256(),
    unit_id: sha256(),
    unit_index: offset(),
    unit_count: z.number().int().positive().safe(),
    manifest_sha256: sha256(),
    requested_source_ids: z.array(identifier()).min(1),
    canonical_source_ids: z.array(identifier()).min(1),
    primary_ranges: z.array(
      z
        .strictObject({
          segment_id: sha256(),
          source_id: identifier(),
          prepared_start_utf8: offset(),
          prepared_end_utf8: offset(),
        })
        .refine((value) => value.prepared_start_utf8 < value.prepared_end_utf8, {
          message: 'a completed primary range contains prepared bytes',
        })
    ),
    quality: InterpretationQualitySchema,
    completion_request_sha256: sha256(),
    publishing_operation_id: identifier().nullable(),
  })
  .superRefine((receipt, ctx) => {
    if (receipt.unit_index >= receipt.unit_count)
      ctx.addIssue({
        code: 'custom',
        path: ['unit_index'],
        message: 'the unit index is within the scheduled unit count',
      });
    if (receipt.requested_source_ids.length !== receipt.canonical_source_ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['canonical_source_ids'],
        message: 'every requested source has one canonical source identity',
      });
    if (new Set(receipt.requested_source_ids).size !== receipt.requested_source_ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['requested_source_ids'],
        message: 'requested source identities are unique',
      });
  });
export type InterpretationUnitReceipt = z.infer<typeof InterpretationUnitReceiptSchema>;
