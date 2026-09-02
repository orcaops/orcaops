import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import { automatedConcerns, capturedTrailForCheckpoint } from './capturedTrail';

describe('captured trail fallback', () => {
  it('preserves full deterministic records without claiming semantic placement', () => {
    const fixture = buildReviewFloorFixture('clean');
    const floor = fixture.floor;
    const artifact = floor.scope.artifact_ids[0]!;
    const checkpoint = floor.outline.threads[0]!.checkpoints[0]!;
    floor.citations.push(
      {
        id: `cite:${artifact}:cp1:alternative:0`,
        kind: 'CHECKPOINT_ALTERNATIVE',
        artifact,
        cp: 1,
        parent: `cite:${artifact}:cp1:decision:0`,
        text: 'Rewrite the reader\n↳ duplicates the final v2 surface',
      },
      {
        id: `cite:${artifact}:cp1:uncertainty:0`,
        kind: 'CHECKPOINT_UNCERTAINTY',
        artifact,
        cp: 1,
        text: 'The exact terminal density still needs inspection.',
      },
      {
        id: `cite:${artifact}:summary:0`,
        kind: 'SUMMARY',
        artifact,
        text: 'Delivered the deterministic reader foundation.',
      },
      {
        id: `cite:${artifact}:evaluator_run:0`,
        kind: 'EVALUATOR_RUN',
        artifact,
        text: 'review-reader — violation: verify the fallback manually',
        evaluator: {
          evaluator_ref: 'review-reader',
          severity: 'warn',
          run_status: 'completed',
          verdict: 'violation',
          disposition: null,
          summary: 'verify the fallback manually',
        },
      }
    );
    checkpoint.citationIds.push(
      `cite:${artifact}:cp1:alternative:0`,
      `cite:${artifact}:cp1:uncertainty:0`
    );
    floor.plan_coverage.push({
      artifact,
      step_id: 'step-reader',
      label: 'Restore reader truth',
      text: 'Restore reader truth without invented placement.',
      order: 1,
      claimed_by: [{ artifact, cp: 1 }],
      declared_by: [{ artifact, cp: 1 }],
      unclaimed: false,
    });

    const view = capturedTrailForCheckpoint(floor, { artifact, cp: 1 });
    expect(view.provenance).toBe('asserted');
    expect(view.records.map((record) => [record.label, record.text])).toEqual(
      expect.arrayContaining([
        ['DECISION', 'Keep deterministic truth stable.'],
        ['RULED OUT', 'Rewrite the reader\n↳ duplicates the final v2 surface'],
        ['FLAGGED', 'The exact terminal density still needs inspection.'],
        ['SUMMARY', 'Delivered the deterministic reader foundation.'],
        ['EVALUATOR RUN', 'review-reader — violation: verify the fallback manually'],
      ])
    );
    expect(view.claimedWork).toEqual(['Restore reader truth']);
    expect(view.files).toEqual([{ file: 'src/fixture.ts', added: 1, removed: 0, hunkCount: 1 }]);
    expect(automatedConcerns(view.records)).toEqual([
      {
        id: `cite:${artifact}:evaluator_run:0`,
        evaluatorRef: 'review-reader',
        severity: 'warn',
        status: 'violation',
        text: 'verify the fallback manually',
      },
    ]);
  });

  it('keeps passing, informational, skipped, and dispositioned evaluator runs out of concerns', () => {
    const floor = buildReviewFloorFixture('clean').floor;
    const artifact = floor.scope.artifact_ids[0]!;
    const outcomes = [
      { suffix: 'pass', run_status: 'completed', verdict: 'pass', disposition: null },
      { suffix: 'info', run_status: 'completed', verdict: 'info', disposition: null },
      { suffix: 'skipped', run_status: 'skipped', verdict: null, disposition: null },
      {
        suffix: 'acknowledged',
        run_status: 'completed',
        verdict: 'violation',
        disposition: 'acknowledged',
      },
    ] as const;
    for (const [index, outcome] of outcomes.entries()) {
      floor.citations.push({
        id: `cite:${artifact}:evaluator_run:${index}`,
        kind: 'EVALUATOR_RUN',
        artifact,
        text: `evaluator-${outcome.suffix}`,
        evaluator: {
          evaluator_ref: `evaluator-${outcome.suffix}`,
          severity: outcome.suffix === 'acknowledged' ? 'block' : 'warn',
          run_status: outcome.run_status,
          verdict: outcome.verdict,
          disposition: outcome.disposition,
          summary: outcome.suffix,
        },
      });
    }

    const view = capturedTrailForCheckpoint(floor, { artifact, cp: 1 });
    expect(automatedConcerns(view.records)).toEqual([]);
  });

  it('does not scrape evaluator prose without structured metadata', () => {
    expect(
      automatedConcerns([
        {
          id: 'legacy-evaluator',
          kind: 'EVALUATOR_RUN',
          label: 'EVALUATOR RUN',
          text: 'review-reader — violation: this is prose, not metadata',
          artifact: 'artifact-fixture',
          cp: null,
          evaluator: null,
        },
      ])
    ).toEqual([]);
  });

  it('entered by CHECKPOINT, returns only that checkpoint — not every owner of a shared hunk', () => {
    // `hunk_shared` is touched by cp1 AND cp2 —
    // ordinary when two checkpoints edit the same function. Entering the trail from
    // that HUNK merges both checkpoints' reasoning into one undifferentiated wall,
    // and a reviewer standing on it cannot tell whose decision they are reading.
    // Entering from the PAGE cannot do that: a page is one captured checkpoint.
    const fixture = buildReviewFloorFixture('clean');
    const floor = fixture.floor;
    const artifact = floor.scope.artifact_ids[0]!;
    const thread = floor.outline.threads[0]!;
    const cp1 = thread.checkpoints[0]!;

    floor.citations.push(
      {
        id: `cite:${artifact}:cp1:decision:9`,
        kind: 'CHECKPOINT_DECISION',
        artifact,
        cp: 1,
        text: 'cp1 chose a lock.',
      },
      {
        id: `cite:${artifact}:cp2:decision:9`,
        kind: 'CHECKPOINT_DECISION',
        artifact,
        cp: 2,
        text: 'cp2 chose a queue.',
      }
    );
    cp1.citationIds.push(`cite:${artifact}:cp1:decision:9`);

    // A second checkpoint on the same thread, sharing cp1's hunk.
    const cp2 = {
      ...structuredClone(cp1),
      checkpointKey: 'cp_two',
      order: 2,
      checkpoint: { ...cp1.checkpoint, cp: 2, label: 'Second checkpoint' },
      citationIds: [`cite:${artifact}:cp2:decision:9`],
    };
    thread.checkpoints.push(cp2);

    const onlyCp1 = capturedTrailForCheckpoint(floor, { artifact, cp: 1 });
    const onlyCp2 = capturedTrailForCheckpoint(floor, { artifact, cp: 2 });

    const texts = (view: { records: { text: string }[] }) => view.records.map((r) => r.text);

    // Entering by page, each checkpoint owns its own reasoning and nothing else.
    expect(texts(onlyCp1)).toContain('cp1 chose a lock.');
    expect(texts(onlyCp1)).not.toContain('cp2 chose a queue.');
    expect(texts(onlyCp2)).toContain('cp2 chose a queue.');
    expect(texts(onlyCp2)).not.toContain('cp1 chose a lock.');

    // A page IS a captured checkpoint, so there is nothing to infer about ownership.
    expect(onlyCp1.provenance).toBe('asserted');
    expect(onlyCp1.checkpoints).toEqual([
      { artifact, cp: 1, label: cp1.checkpoint.label, candidateOnly: false },
    ]);
  });

  it('RULED OUT survives the page entry — it is the only thing that renders alternatives', () => {
    const fixture = buildReviewFloorFixture('clean');
    const floor = fixture.floor;
    const artifact = floor.scope.artifact_ids[0]!;
    const cp1 = floor.outline.threads[0]!.checkpoints[0]!;
    floor.citations.push({
      id: `cite:${artifact}:cp1:alternative:0`,
      kind: 'CHECKPOINT_ALTERNATIVE',
      artifact,
      cp: 1,
      parent: `cite:${artifact}:cp1:decision:0`,
      text: 'Rewrite the reader\n↳ duplicates the final v2 surface',
    });
    cp1.citationIds.push(`cite:${artifact}:cp1:alternative:0`);

    const view = capturedTrailForCheckpoint(floor, { artifact, cp: 1 });
    expect(view.records.map((r) => [r.label, r.text])).toEqual(
      expect.arrayContaining([
        ['RULED OUT', 'Rewrite the reader\n↳ duplicates the final v2 surface'],
      ])
    );
  });
});
