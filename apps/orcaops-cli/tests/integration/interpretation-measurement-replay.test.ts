import { expect, it, vi } from 'vitest';

import { INTERPRETATION_EVALUATION_SET } from '@orcaops/core/knowledge/interpretation/evaluation';
import { uuidv7 } from '@orcaops/storage';
import { publishProjectKnowledgeSource } from '@orcaops/storage/history/database';

import { runMeasuredCase } from './interpretation-measurement.test-support.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

it('replays each divided result with its actual invocation manifest after knowledge changes', async () => {
  const evaluated = INTERPRETATION_EVALUATION_SET.find(
    (entry) => entry.name === 'one observation stated twice in a source the input limit divides'
  )!;
  const run = await runMeasuredCase({
    evaluated,
    corpus: INTERPRETATION_EVALUATION_SET,
    proposer: 'scripted',
    beforeWork: async (fixture, manifest, source) => {
      await publishProjectKnowledgeSource(fixture.handle, {
        operationId: uuidv7(),
        source: {
          source_id: manifest.sources[0]!.source_id,
          occurrence: manifest.sources[0]!.occurrence,
          source_author: source.sourceAuthor,
          interpreted_by: null,
          access_restriction: null,
        },
        recordedBy: source.recordedBy,
        secretAllow: [],
      });
    },
  });
  try {
    expect(run.measured.jobState).toBe('completed');
    expect(run.measured.calls).toBe(2);
    // The second unit is all-rejected as an unclaimed exact duplicate, but still settles its
    // receipt under its own atomic operation.
    expect(run.measured.operationIds).toHaveLength(2);
    expect(run.measured.outcomes).toEqual(['failed', 'succeeded']);
    expect(run.scoredFromPlan).toEqual(run.measured.counts);
    expect(run.publications).toHaveLength(2);
    for (const entry of run.publications) {
      expect(entry.plan.manifest_sha256).toBe(entry.manifest.manifest_sha256);
      expect(entry.manifest.knowledge_boundary).toBeGreaterThan(run.manifest.knowledge_boundary);
      expect(entry.manifest.manifest_sha256).not.toBe(run.manifest.manifest_sha256);
    }
    expect(new Set(run.publications.map((entry) => entry.manifest.manifest_sha256)).size).toBe(2);
    expect(
      run.publications.map((entry) => entry.manifest.segments[0]!.prepared_range.start)
    ).toEqual([0, run.publications[0]!.manifest.segments[0]!.prepared_range.end]);
    const replay = await run.replay();
    expect(replay.operationIds).toEqual([]);
    expect(replay.rowsAdded).toBe(run.measured.rowsAdded);
    expect(replay.counts).toEqual(run.measured.counts);
  } finally {
    await run.fixture.cleanup();
  }
});
