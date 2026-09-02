// The sampler's accept/discard/fail decision is a pure policy, so controlled
// preemption shapes need no host load. The benchmark is a top-level-await
// executable, so a source contract separately pins its use of this policy.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  collectCpuAttributedWallSamples,
  externallyDescheduled,
  judgePreemptedSample,
} from './perfSamplePolicy';

const SCRIPTS = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts');
const perfScript = readFileSync(path.join(SCRIPTS, 'review-performance.ts'), 'utf8');
const budgetMs = 100;
const activeRatio = 0.8;

describe('externallyDescheduled under controlled preemption shapes', () => {
  it('classifies an over-budget sample whose CPU time is consistent with descheduling', () => {
    expect(externallyDescheduled({ wallMs: 150, activeCpuMs: 40, budgetMs, activeRatio })).toBe(
      true
    );
  });

  it('does not flag an over-budget sample that was genuinely busy', () => {
    expect(externallyDescheduled({ wallMs: 150, activeCpuMs: 140, budgetMs, activeRatio })).toBe(
      false
    );
  });

  it('never flags a within-budget sample', () => {
    expect(externallyDescheduled({ wallMs: 90, activeCpuMs: 5, budgetMs, activeRatio })).toBe(
      false
    );
  });
});

describe('judgePreemptedSample bounded retry-then-fail policy', () => {
  const discardBudget = 3;

  it('accepts clean samples regardless of the discard count', () => {
    for (const discardedSoFar of [0, discardBudget, discardBudget + 5]) {
      expect(judgePreemptedSample({ preempted: false, discardedSoFar, discardBudget })).toBe(
        'accept'
      );
    }
  });

  it('discards preempted samples while the budget lasts, then fails explicitly', () => {
    let discardedSoFar = 0;
    for (; discardedSoFar < discardBudget; discardedSoFar += 1) {
      expect(judgePreemptedSample({ preempted: true, discardedSoFar, discardBudget })).toBe(
        'discard'
      );
    }
    // Budget exhausted: a preempted sample must FAIL the run, never pollute it.
    expect(judgePreemptedSample({ preempted: true, discardedSoFar, discardBudget })).toBe('fail');
  });
});

describe('collectCpuAttributedWallSamples', () => {
  it('discards only over-budget samples whose CPU attribution marks them preempted', () => {
    const measurements = [
      { wallMs: 200, activeCpuMs: 20 },
      { wallMs: 80, activeCpuMs: 5 },
      { wallMs: 200, activeCpuMs: 190 },
    ];
    let index = 0;

    expect(
      collectCpuAttributedWallSamples({
        sampleCount: 2,
        discardBudget: 2,
        budgetMs,
        activeRatio,
        label: 'controlled',
        measure: () => measurements[index++]!,
      })
    ).toEqual({
      wallSamples: [80, 200],
      schedulerDiscardedSamples: 1,
    });
  });

  it('fails after the bounded discard allowance instead of accepting another preempted sample', () => {
    let calls = 0;
    expect(() =>
      collectCpuAttributedWallSamples({
        sampleCount: 1,
        discardBudget: 2,
        budgetMs,
        activeRatio,
        label: 'controlled',
        measure: () => {
          calls += 1;
          return { wallMs: 200, activeCpuMs: 20 };
        },
      })
    ).toThrow(/discarded 2 .* next sample was still classified as preempted/);
    expect(calls).toBe(3);
  });
});

describe('review-performance wiring contract', () => {
  it('reader-build sampling uses the tested collector with the production policy inputs', () => {
    const start = perfScript.indexOf('const { wallSamples: watchSamples');
    const end = perfScript.indexOf('const activePartSamples', start);
    const block = perfScript.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('collectCpuAttributedWallSamples({');
    expect(block).toContain('sampleCount: STORY_READER_ITERATIONS');
    expect(block).toContain('budgetMs: STORY_READER_BUILD_P95_BUDGET_MS');
    expect(block).toContain('discardBudget: STORY_READER_ITERATIONS');
    expect(block).toContain('activeRatio: STORY_SCHEDULER_ACTIVE_RATIO');
    expect(block).toContain('schedulerDiscardedSamples: watchSchedulerDiscardedSamples');
  });

  it('publishes the reader-build scheduler discard count', () => {
    const start = perfScript.indexOf('watchProjection: {');
    const end = perfScript.indexOf('storyReview: {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(perfScript.slice(start, end)).toContain(
      'schedulerDiscardedSamples: watchSchedulerDiscardedSamples'
    );
  });

  it('cold-Brief sampling consumes the bounded retry-then-fail policy', () => {
    expect(perfScript).toContain('judgePreemptedSample(');
    // A combined preemption-and-budget guard would fall through to acceptance
    // when the budget is exhausted instead of taking the explicit fail branch.
    expect(perfScript).not.toContain(
      'preempted && schedulerDiscardedSamples < STORY_COLD_BRIEF_SAMPLES'
    );
  });
});
