import { describe, expect, it } from 'vitest';

import { smallestProcessableInputBytes } from '@orcaops/core';
import { type LlmProvider, measurePreparedInputRequest } from '@orcaops/llm';
import type { EventWithPayload } from '@orcaops/storage';

import { authoredFieldInventory, type RetainedJobSource } from './job-source.js';
import { planSourceSchedule } from './schedule.js';

function sourceOf(payload: Record<string, unknown>): RetainedJobSource {
  const event = {
    record: { event_id: '01a0b100-0000-7000-8000-000000000002', type: 'plan_captured' },
    payload,
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

const scheduleOf = (
  payload: Record<string, unknown>,
  maxInputBytes = 80_000,
  provider: LlmProvider = 'claude'
) =>
  planSourceSchedule({
    source: sourceOf(payload),
    projectId: '01a0b100-0000-7000-8000-000000000003',
    provider,
    maxInputBytes,
  });

describe('authored event schedules', () => {
  it('keeps related decision fields in one deterministic unit', () => {
    const result = scheduleOf({
      task: 'Choose the durable store.',
      label: 'Durable store',
      plan_steps: [],
      non_goals: [],
      decisions: [
        {
          decision: 'Use SQLite.',
          reason: 'It must work offline.',
          alternatives_considered: [],
        },
      ],
      rationale: 'The choice closes the storage question.',
    });

    expect(result.outcome).toBe('scheduled');
    if (result.outcome !== 'scheduled') return;
    expect(result.schedule.units).toHaveLength(1);
    expect(
      result.schedule.units.map((unit) =>
        unit.segments.map((segment) => [segment.occurrence.field_path, segment.purpose])
      )
    ).toEqual([
      [
        ['task', 'primary'],
        ['label', 'context'],
        ['rationale', 'context'],
        ['decisions.0.decision', 'primary'],
        ['decisions.0.reason', 'primary'],
      ],
    ]);
  });

  it('packs an ordinary task, step and criterion into one authorized call', () => {
    const payload = {
      task: 'Implement durable capture processing.',
      label: 'Durable processing',
      plan_steps: [
        {
          label: 'Persist results',
          text: 'Publish interpretation and progress atomically.',
          acceptance_criteria: [{ text: 'A restart does not repeat a settled unit.' }],
        },
      ],
      decisions: [],
      non_goals: [],
    };
    const result = scheduleOf(payload, 131_072);

    expect(result.outcome).toBe('scheduled');
    if (result.outcome !== 'scheduled') return;
    expect(result.schedule.units).toHaveLength(1);
    expect(result.schedule.units[0]!.segments.map((segment) => segment.prepared_range)).toEqual(
      result.schedule.units[0]!.segments.map((segment) => ({
        start: 0,
        end: Buffer.byteLength(
          sourceOf(payload).fields.find(
            (field) => field.fieldPath === segment.occurrence.field_path
          )!.preparedText
        ),
      }))
    );
    expect(scheduleOf(payload, 131_072)).toEqual(result);
  });

  it.each(['claude', 'codex'] as const)(
    'schedules a small primary at the public %s input floor',
    (provider) => {
      const floor = smallestProcessableInputBytes({
        provider,
        measure: { measurePreparedInputRequest },
      });
      const result = scheduleOf(
        { task: 'Flush notes before reporting them saved.', label: '' },
        floor,
        provider
      );

      expect(result.outcome).toBe('scheduled');
      if (result.outcome !== 'scheduled') return;
      expect(result.schedule.units).toHaveLength(1);
      expect(result.schedule.units[0]!.segments).toHaveLength(1);
      expect(result.schedule.units[0]!.segments[0]!.occurrence.field_path).toBe('task');
    }
  );

  it('changes schedule and unit identities when exact authored bytes change', () => {
    const first = scheduleOf({ task: 'Retain two decimals.', label: 'Precision' });
    const second = scheduleOf({ task: 'Retain two digits after the decimal.', label: 'Precision' });
    if (first.outcome !== 'scheduled' || second.outcome !== 'scheduled')
      throw new Error('the fixtures did not schedule');

    expect(second.schedule.schedule_id).not.toBe(first.schedule.schedule_id);
    expect(second.schedule.units[0]!.unit_id).not.toBe(first.schedule.units[0]!.unit_id);
    expect(second.schedule.units).toHaveLength(first.schedule.units.length);
  });

  it('retains empty authored fields as explicit omissions without inventing work', () => {
    const result = scheduleOf({ task: '', label: '' });

    expect(result.outcome).toBe('scheduled');
    if (result.outcome !== 'scheduled') return;
    expect(result.schedule.units).toEqual([]);
    expect(result.schedule.omissions).toEqual([
      { field_path: 'task', reason: 'The authored field is empty.' },
      { field_path: 'label', reason: 'The authored field is empty.' },
    ]);
    expect(result.schedule.omissions_total).toBe(2);
  });

  it('splits an oversized primary field into exact contiguous prepared ranges', () => {
    const result = scheduleOf(
      { task: 'A durable queue records every accepted item. '.repeat(4_000), label: 'Queue' },
      60_000
    );

    expect(result.outcome).toBe('scheduled');
    if (result.outcome !== 'scheduled') return;
    expect(result.schedule.units.length).toBeGreaterThan(1);
    const ranges = result.schedule.units.flatMap((unit) =>
      unit.segments
        .filter((segment) => segment.occurrence.field_path === 'task')
        .map((segment) => segment.prepared_range)
    );
    expect(ranges[0]!.start).toBe(0);
    for (let index = 1; index < ranges.length; index += 1)
      expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
    expect(ranges.at(-1)!.end).toBe(
      Buffer.byteLength(
        sourceOf({ task: 'A durable queue records every accepted item. '.repeat(4_000) }).fields[0]!
          .preparedText
      )
    );
    expect(result.schedule.omissions).toContainEqual({
      field_path: 'label',
      reason:
        'The related authored context does not fit with its primary field under the input limit.',
    });
  });
});
