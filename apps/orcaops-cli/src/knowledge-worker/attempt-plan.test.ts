import { describe, expect, it } from 'vitest';

import { relatedKnowledgeBounds } from '@orcaops/core';
import type { EventWithPayload } from '@orcaops/storage';
import type {
  ProcessingAttempt,
  RelatedKnowledgeRetrieval,
} from '@orcaops/storage/history/database';

import { contiguousCompletedUnits, planJobAttempt, retainedSchedule } from './attempt-plan.js';
import { authoredFieldInventory, type RetainedJobSource } from './job-source.js';
import { planSourceSchedule } from './schedule.js';

const PROJECT_ID = 'project-a';

function sourceOf(text: string): RetainedJobSource {
  const event = {
    record: { event_id: '01a0b100-0000-7000-8000-000000000002', type: 'plan_captured' },
    payload: { task: text, label: 'Durability' },
  } as unknown as EventWithPayload;
  const inventory = authoredFieldInventory(event);
  return {
    artifactId: '01a0b100-0000-7000-8000-000000000001',
    eventId: event.record.event_id,
    eventType: event.record.type,
    recordedAt: '2026-09-01T00:00:00.000Z',
    originKind: 'captured',
    fields: inventory.fields,
    omissions: inventory.omissions,
    sourceAuthor: { identity: 'claude-code', basis: 'source_attributed' },
    recordedBy: { identity: 'claude-code', basis: 'source_attributed' },
    planEventId: event.record.event_id,
    planAnchorLimit: null,
    knowledgeBoundary: 41,
  };
}

const retrieval: RelatedKnowledgeRetrieval = {
  boundary: 41,
  scope: { kind: 'artifact', artifact_id: '01a0b100-0000-7000-8000-000000000001' },
  bounds: relatedKnowledgeBounds({ max_input_bytes: 80_000 }),
  coverage: {
    scope: { kind: 'artifact', artifact_id: '01a0b100-0000-7000-8000-000000000001' },
    mode: 'current',
    boundary: 41,
    omitted: [],
    unresolved: [],
    later: [],
    branchScoped: [],
  },
  entries: [],
  omissions: [],
  counts: {
    candidates: 0,
    included: 0,
    omitted: 0,
    searchTerms: 3,
    searchHits: 0,
    statementBytes: 0,
  },
};

const configuration = (maxInputBytes: number) => ({
  provider: { id: 'claude' as const },
  limits: { max_input_bytes: maxInputBytes },
});

function retainedAttempt(
  schedule: Exclude<
    ReturnType<typeof planSourceSchedule>,
    { outcome: 'source_schedule_limit' }
  >['schedule'],
  unitIndex = 0
): ProcessingAttempt {
  const attemptId = '01a0b100-0000-7000-8000-000000000010';
  return {
    attemptId,
    jobId: 'job-a',
    attemptNumber: 1,
    ownerGeneration: 1,
    configurationIdentity: 'a'.repeat(64),
    configuration: {
      schedule_binding: {
        schedule,
        schedule_attempt_id: attemptId,
        unit: {
          schedule_id: schedule.schedule_id,
          unit_id: schedule.units[unitIndex]!.unit_id,
          index: unitIndex,
          count: schedule.units.length,
        },
      },
    },
    grantId: 'grant-a',
    startedAt: '2026-09-01T00:00:00.000Z',
    outcome: 'failed',
    finishedAt: '2026-09-01T00:00:01.000Z',
    usage: null,
    detail: null,
    process: null,
    publishingOperationId: null,
  };
}

describe('retained processing schedules', () => {
  it('uses only the contiguous receipt prefix and ignores an exact duplicate', () => {
    const source = sourceOf('A durable queue records every accepted item. '.repeat(4_000));
    const planned = planSourceSchedule({
      source,
      projectId: PROJECT_ID,
      provider: 'claude',
      maxInputBytes: 60_000,
    });
    if (planned.outcome !== 'scheduled' || planned.schedule.units.length < 2)
      throw new Error('fixture did not produce multiple units');
    const first = planned.schedule.units[0]!.unit_id;

    expect(contiguousCompletedUnits(planned.schedule, [first, first])).toEqual({
      ok: true,
      nextIndex: 1,
    });
    expect(
      contiguousCompletedUnits(planned.schedule, [planned.schedule.units[1]!.unit_id])
    ).toMatchObject({ ok: false, detail: expect.stringContaining('hole') });
  });

  it('refuses a current-format attempt whose immutable schedule is missing', () => {
    const attempt = retainedAttempt(
      (() => {
        const planned = planSourceSchedule({
          source: sourceOf('Persist accepted writes.'),
          projectId: PROJECT_ID,
          provider: 'claude',
          maxInputBytes: 80_000,
        });
        if (planned.outcome !== 'scheduled') throw new Error('fixture did not schedule');
        return planned.schedule;
      })()
    );
    attempt.configuration = { provider: { id: 'claude' } };

    expect(retainedSchedule([attempt])).toMatchObject({
      ok: false,
      detail: expect.stringContaining('missing a valid current-format schedule'),
    });
  });

  it('reuses exact units under a larger allowance without repeating a completed receipt', () => {
    const source = sourceOf('A durable queue records every accepted item. '.repeat(4_000));
    const planned = planSourceSchedule({
      source,
      projectId: PROJECT_ID,
      provider: 'claude',
      maxInputBytes: 60_000,
    });
    if (planned.outcome !== 'scheduled' || planned.schedule.units.length < 2)
      throw new Error('fixture did not produce multiple units');

    const result = planJobAttempt({
      source,
      projectId: PROJECT_ID,
      configuration: configuration(80_000),
      attemptsRemaining: planned.schedule.units.length - 1,
      retained: [retainedAttempt(planned.schedule)],
      completedUnitIds: [planned.schedule.units[0]!.unit_id],
      retrieval,
    });

    expect(result.outcome).toBe('ready');
    if (result.outcome !== 'ready') return;
    expect(result.schedule.schedule_id).toBe(planned.schedule.schedule_id);
    expect(result.unitIndex).toBe(1);
    expect(result.request.manifest.unit_id).toBe(planned.schedule.units[1]!.unit_id);
  });

  it('reports a job with unsettled units and no attempt left as exhausted', () => {
    const source = sourceOf('A durable queue records every accepted item. '.repeat(4_000));
    const planned = planSourceSchedule({
      source,
      projectId: PROJECT_ID,
      provider: 'claude',
      maxInputBytes: 60_000,
    });
    if (planned.outcome !== 'scheduled' || planned.schedule.units.length < 3)
      throw new Error('fixture did not produce three units');
    const plan = (attemptsRemaining: number) =>
      planJobAttempt({
        source,
        projectId: PROJECT_ID,
        configuration: configuration(60_000),
        attemptsRemaining,
        retained: [retainedAttempt(planned.schedule)],
        completedUnitIds: [],
        retrieval,
      });

    expect(plan(0)).toMatchObject({ outcome: 'attempts_exhausted' });
    expect(plan(1)).toMatchObject({ outcome: 'source_schedule_limit' });
  });

  it('parks an exact retained unit that no longer fits a smaller allowance', () => {
    const source = sourceOf('Persist accepted writes and verify them after restart.');
    const planned = planSourceSchedule({
      source,
      projectId: PROJECT_ID,
      provider: 'claude',
      maxInputBytes: 80_000,
    });
    if (planned.outcome !== 'scheduled') throw new Error('fixture did not schedule');

    const result = planJobAttempt({
      source,
      projectId: PROJECT_ID,
      configuration: configuration(1),
      attemptsRemaining: 1,
      retained: [retainedAttempt(planned.schedule)],
      completedUnitIds: [],
      retrieval,
    });

    expect(result).toMatchObject({ outcome: 'retained_schedule_incompatible' });
  });
});
