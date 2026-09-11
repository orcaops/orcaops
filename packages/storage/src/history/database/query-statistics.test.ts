import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { decodeArtifactInput, reconstructDatabaseArtifact } from './artifact-events.js';
import { prepareArtifactStatistics } from './query-statistics.js';
import type { EventWithPayload } from '../../events/rebuilders.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { GitImportEnrichmentPayloadSchema } from '../../schema/git-import-enrichment.js';
import { PlanSchema } from '../../schema/plan.js';

const saved = JSON.parse(
  readFileSync(new URL('./fixtures/artifact-history.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, unknown>[]> };
const artifactId = saved.rows.execution_initializations[0].artifact_id as string;
const original = saved.rows.artifact_events.filter((row) => row.artifact_id === artifactId);
const blob = (value: unknown) => Buffer.from((value as { blobHex: string }).blobHex, 'hex');
const thread = reconstructDatabaseArtifact(
  artifactId,
  decodeArtifactInput(
    Buffer.concat(original.map((row) => blob(row.record_bytes))),
    original.flatMap((row) =>
      row.sidecar_payload_bytes
        ? [{ eventId: row.event_id as string, bytes: blob(row.sidecar_payload_bytes) }]
        : []
    ),
    [],
    false
  ),
  true
);
const base = thread.events.find((event) => event.record.type === 'plan_captured')!;
const plan = PlanSchema.parse({
  ...(base.payload as Record<string, unknown>),
  source_event_id: base.record.event_id,
});
const carried = plan.plan_steps[0].step_id;
const dropped = 'original retained step identifier';
const inserted = uuidv7();
function revision(n: number, ids: string[]): EventWithPayload {
  const type = n === 0 ? ('plan_captured' as const) : ('plan_revised' as const);
  const payload = PlanSchema.parse({
    ...plan,
    revision_n: n,
    plan_steps: ids.map((id) => ({
      ...plan.plan_steps[0],
      step_id: id,
      label: id === carried ? 'Retain identity' : id === dropped ? 'Retain old step' : 'Add check',
      acceptance_criteria: [],
    })),
  });
  return { record: { ...base.record, type, event_id: uuidv7() }, payload };
}
const closed = {
  status: 'closed' as const,
  n: 2,
  opened_at: '2026-01-02T10:00:00-08:00',
  closed_at: '2026-01-02T18:01:30Z',
  completed_step_ids: [] as string[],
  uncertainty: [] as string[],
  decisions: [] as { decision: string; reason: string }[],
  files_changed: [] as string[],
};
function input() {
  return {
    artifactId,
    events: [
      revision(0, [carried, dropped]),
      revision(1, [inserted, carried]),
      revision(2, [dropped, carried]),
    ],
    checkpoints: [
      { status: 'open' as const },
      closed,
      { status: 'abandoned' as const },
      {
        ...closed,
        n: 7,
        completed_step_ids: [carried],
        uncertainty: ['Original uncertainty'],
        decisions: [{ decision: 'Original decision', reason: 'Original reason' }],
        files_changed: ['original.ts'],
      },
    ],
  };
}

it('keeps dropped, carried and reintroduced step identities from all original revisions', () => {
  const result = prepareArtifactStatistics(input());
  expect(result.historicalPlanStepIds).toEqual([carried, dropped, inserted].sort());
  expect(result.statistics.maximumPlanRevision).toBe(2);
  expect(result.historicalPlanStepIds.filter((id) => id === carried)).toHaveLength(1);
});

it('separates abandoned and open checkpoints from exact closed intervals and hygiene', () => {
  const statistics = prepareArtifactStatistics(input()).statistics;
  expect(statistics).toEqual({
    maximumPlanRevision: 2,
    checkpointCounts: { open: 1, closed: 2, abandoned: 1 },
    closedIntervals: [2, 7].map((n) => ({
      n,
      openedAt: closed.opened_at,
      closedAt: closed.closed_at,
    })),
    closedWithoutCompletedSteps: 1,
    closedWithoutUncertainty: 1,
    closedWithoutDecisions: 1,
    closedWithoutFiles: 1,
  });
  const value = JSON.stringify(statistics);
  expect(value).not.toContain('Original uncertainty');
  expect(value).not.toContain('Original decision');
  expect(value).not.toContain('original.ts');
});

it('uses the current reconstructed checkpoint after reopen or abandonment', () => {
  for (const status of ['open', 'abandoned'] as const) {
    const source = input();
    source.checkpoints = [{ status }];
    const result = prepareArtifactStatistics(source).statistics;
    expect(result.checkpointCounts[status]).toBe(1);
    expect(result.closedIntervals).toEqual([]);
    expect(result.closedWithoutCompletedSteps).toBe(0);
  }
});

it('does not normalize original non-UUID step IDs or replace them during enrichment', () => {
  const source = input();
  source.events = [revision(0, [dropped])];
  const payload = GitImportEnrichmentPayloadSchema.parse({
    provenance_version: 1,
    artifact_id: artifactId,
    cluster_key: 'a'.repeat(64),
    member_shas_hash: 'b'.repeat(64),
    enriched_at: '2026-01-03T00:00:00.000Z',
    prior_enrichment_event_id: null,
    label: 'Enriched label',
    task: 'Enriched task',
    steps: [{ label: 'Enriched step', text: 'Enriched content' }],
    checkpoint_summaries: [{ n: 1, summary: 'Enriched summary' }],
    outcome: 'Enriched outcome',
    decisions: { mode: 'preserve' },
  });
  const before = prepareArtifactStatistics(source);
  source.events.push({
    record: { ...base.record, type: 'git_import_enriched', event_id: uuidv7() },
    payload,
  });
  expect(prepareArtifactStatistics(source)).toEqual(before);
  expect(before.historicalPlanStepIds).toEqual([dropped]);
});

it('detaches prepared values without changing original events or checkpoint inputs', () => {
  const source = input();
  const originalSource = structuredClone(source);
  const prepared = prepareArtifactStatistics(source);
  expect(source).toEqual(originalSource);
  source.events.length = 0;
  source.checkpoints.length = 0;
  expect(prepared).toEqual(prepareArtifactStatistics(originalSource));
});

it('rejects missing plans and foreign original plan ownership', () => {
  expect(() => prepareArtifactStatistics({ ...input(), events: [] })).toThrow('no original plan');
  expect(() => prepareArtifactStatistics({ ...input(), artifactId: uuidv7() })).toThrow(
    'another artifact'
  );
});

it('rejects invalid retained interval timestamps instead of inventing zero duration', () => {
  expect(() =>
    prepareArtifactStatistics({
      ...input(),
      checkpoints: [{ ...closed, closed_at: 'not a timestamp' }],
    })
  ).toThrow();
});
