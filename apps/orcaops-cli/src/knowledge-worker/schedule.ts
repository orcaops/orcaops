import {
  buildInterpretationManifest,
  buildInterpretationRequest,
  INTERPRETATION_DETECTOR,
  relatedKnowledgeCeilingBytes,
} from '@orcaops/core';
import { type LlmProvider, measurePreparedInputRequest } from '@orcaops/llm';
import {
  type InterpretationProcessingSchedule,
  InterpretationProcessingScheduleSchema,
  interpretationScheduleId,
  interpretationSegmentId,
  interpretationUnitId,
  type ScheduledInterpretationSegment,
} from '@orcaops/storage';

import {
  FIELD_INVENTORY_VERSION,
  type JobSourceField,
  type RetainedJobSource,
} from './job-source.js';

const MAX_UNITS = 64;
const MAX_SEGMENTS = 256;
const MAX_OMISSIONS = 256;
const PLACEHOLDER_ID = '0'.repeat(64);

export type SchedulePlan =
  | { outcome: 'scheduled'; schedule: InterpretationProcessingSchedule }
  | { outcome: 'source_schedule_limit'; detail: string };

interface FieldBundle {
  fields: JobSourceField[];
}

const sourceIdOf = (source: RetainedJobSource, field: JobSourceField): string =>
  `${source.eventId}#${field.fieldPath}#${field.position}`;

function segmentOf(
  source: RetainedJobSource,
  field: JobSourceField,
  preparedRange: { start: number; end: number }
): ScheduledInterpretationSegment {
  const identity = {
    source_id: sourceIdOf(source, field),
    occurrence: {
      kind: 'capture_field' as const,
      artifact_id: source.artifactId,
      event_id: source.eventId,
      field_path: field.fieldPath,
      position: field.position,
    },
    role: field.role,
    purpose: field.purpose,
    original_sha256: field.originalSha256,
    prepared_sha256: field.preparedSha256,
    mapping_version: field.mappingVersion,
    mapping_sha256: field.mappingSha256,
    prepared_range: preparedRange,
    mapping: [...field.mapping],
  };
  return { segment_id: interpretationSegmentId(identity), ...identity };
}

function bundleKey(field: JobSourceField): string {
  const path = field.fieldPath;
  if (path === 'task' || path === 'label' || path === 'rationale') return 'task';
  const step = /^plan_steps\.(\d+)\.(?:label|text)$/u.exec(path);
  if (step !== null) return `step.${step[1]}`;
  const decision = /^decisions\.(\d+)\.(?:decision|reason)$/u.exec(path);
  if (decision !== null) return `decision.${decision[1]}`;
  const alternative =
    /^decisions\.(\d+)\.alternatives_considered\.(\d+)\.(?:option|rejected_because)$/u.exec(path);
  if (alternative !== null) return `decision.${alternative[1]}.alternative.${alternative[2]}`;
  const nonGoal = /^non_goals\.(\d+)\.(?:text|rationale)$/u.exec(path);
  if (nonGoal !== null) return `non_goal.${nonGoal[1]}`;
  return path;
}

function fieldBundles(fields: readonly JobSourceField[]): FieldBundle[] {
  const bundles = new Map<string, JobSourceField[]>();
  for (const field of fields) {
    const key = bundleKey(field);
    const bundle = bundles.get(key) ?? [];
    bundle.push(field);
    bundles.set(key, bundle);
  }
  return [...bundles.values()]
    .map((fields) => ({
      fields: [...fields].sort((left, right) =>
        left.purpose === right.purpose ? 0 : left.purpose === 'primary' ? -1 : 1
      ),
    }))
    .filter((bundle) => bundle.fields.some((field) => field.purpose === 'primary'));
}

function utf8Boundaries(text: string): number[] {
  const boundaries = [0];
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character, 'utf8');
    boundaries.push(bytes);
  }
  return boundaries;
}

function unitFits(input: {
  source: RetainedJobSource;
  projectId: string;
  segments: readonly ScheduledInterpretationSegment[];
  provider: LlmProvider;
  maxInputBytes: number;
}): boolean {
  const sources = [...new Set(input.segments.map((segment) => segment.source_id))].map(
    (sourceId) => {
      const field = input.source.fields.find(
        (candidate) => sourceIdOf(input.source, candidate) === sourceId
      );
      if (field === undefined) throw new TypeError(`Scheduled source ${sourceId} is not retained.`);
      return { source_id: sourceId, text: field.originalText };
    }
  );
  const manifest = buildInterpretationManifest({
    schedule_id: PLACEHOLDER_ID,
    unit_id: interpretationUnitId(input.segments),
    project_id: input.projectId,
    source_event_id: input.source.eventId,
    task_context:
      input.source.planEventId === null
        ? null
        : { artifact_id: input.source.artifactId, plan_event_id: input.source.planEventId },
    sources,
    segments: input.segments,
    attributed_to: { kind: 'detector', detector: INTERPRETATION_DETECTOR },
    knowledge_boundary: input.source.knowledgeBoundary,
    related_knowledge: [],
    coverage_limits: [],
  });
  const request = buildInterpretationRequest(manifest, {
    provider: input.provider,
    measure: { measurePreparedInputRequest },
  });
  return (
    request.bytes + relatedKnowledgeCeilingBytes({ max_input_bytes: input.maxInputBytes }) <=
    input.maxInputBytes
  );
}

function splitField(input: {
  source: RetainedJobSource;
  projectId: string;
  field: JobSourceField;
  provider: LlmProvider;
  maxInputBytes: number;
}): ScheduledInterpretationSegment[] | null {
  const boundaries = utf8Boundaries(input.field.preparedText);
  const segments: ScheduledInterpretationSegment[] = [];
  let boundaryIndex = 0;
  while (boundaryIndex < boundaries.length - 1) {
    let low = boundaryIndex + 1;
    let high = boundaries.length - 1;
    let accepted = boundaryIndex;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = segmentOf(input.source, input.field, {
        start: boundaries[boundaryIndex]!,
        end: boundaries[middle]!,
      });
      if (unitFits({ ...input, segments: [candidate] })) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (accepted === boundaryIndex) return null;
    segments.push(
      segmentOf(input.source, input.field, {
        start: boundaries[boundaryIndex]!,
        end: boundaries[accepted]!,
      })
    );
    boundaryIndex = accepted;
  }
  return segments;
}

export function planSourceSchedule(input: {
  source: RetainedJobSource;
  projectId: string;
  provider: LlmProvider;
  maxInputBytes: number;
}): SchedulePlan {
  const units: { unit_id: string; segments: ScheduledInterpretationSegment[] }[] = [];
  const omissions = new Map(input.source.omissions.map((entry) => [entry.fieldPath, entry.reason]));
  let pending: ScheduledInterpretationSegment[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    units.push({ unit_id: interpretationUnitId(pending), segments: pending });
    pending = [];
  };

  for (const bundle of fieldBundles(input.source.fields)) {
    const whole = bundle.fields.map((field) =>
      segmentOf(input.source, field, {
        start: 0,
        end: Buffer.byteLength(field.preparedText, 'utf8'),
      })
    );
    if (unitFits({ ...input, segments: [...pending, ...whole] })) {
      pending.push(...whole);
      continue;
    }
    flush();
    if (unitFits({ ...input, segments: whole })) {
      pending = whole;
      continue;
    }

    for (const field of bundle.fields) {
      if (field.purpose === 'context') {
        omissions.set(
          field.fieldPath,
          'The related authored context does not fit with its primary field under the input limit.'
        );
        continue;
      }
      const split = splitField({ ...input, field });
      if (split === null) {
        return {
          outcome: 'source_schedule_limit',
          detail:
            `Authored field ${field.fieldPath} cannot fit even one prepared character under the ` +
            `input limit of ${input.maxInputBytes} bytes. Nothing was sent.`,
        };
      }
      for (const segment of split) {
        if (unitFits({ ...input, segments: [...pending, segment] })) pending.push(segment);
        else {
          flush();
          pending = [segment];
        }
      }
    }
  }
  flush();

  const segmentCount = units.reduce((total, unit) => total + unit.segments.length, 0);
  if (units.length > MAX_UNITS || segmentCount > MAX_SEGMENTS || omissions.size > MAX_OMISSIONS) {
    return {
      outcome: 'source_schedule_limit',
      detail:
        `The authored event requires ${units.length} units, ${segmentCount} segment occurrences ` +
        `and ${omissions.size} omission descriptors; limits are ${MAX_UNITS}, ${MAX_SEGMENTS} ` +
        `and ${MAX_OMISSIONS}. Nothing was sent.`,
    };
  }

  const identity = {
    schema: 'orcaops.processing_schedule/v1' as const,
    source_event_id: input.source.eventId,
    field_inventory_version: FIELD_INVENTORY_VERSION,
    units,
    omissions: [...omissions].map(([field_path, reason]) => ({ field_path, reason })),
    omissions_total: omissions.size,
  };
  const parsed = InterpretationProcessingScheduleSchema.safeParse({
    ...identity,
    schedule_id: interpretationScheduleId(identity),
  });
  if (!parsed.success) {
    return {
      outcome: 'source_schedule_limit',
      detail:
        `The authored event cannot retain a valid bounded schedule: ` +
        parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { outcome: 'scheduled', schedule: parsed.data };
}
