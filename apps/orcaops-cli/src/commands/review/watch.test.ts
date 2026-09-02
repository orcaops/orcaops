import { describe, expect, it } from 'vitest';

import type { OssReviewFeedbackStatusResponse } from '@orcaops/sdk';

import { REVIEW_WATCH_POLL_INTERVAL_MS, runReviewFeedbackWatch } from './watch.js';

type StatusItem = OssReviewFeedbackStatusResponse['items'][number];

function itemWith(lastHuman: string | null, hasNew = false): StatusItem {
  return {
    subject: {
      task_number: 1,
      pull_request_id: 'pr_1',
      pull_request_number: 7,
      pull_request_title: 'Demo PR',
      pull_request_url: 'https://github.com/acme/demo/pull/7',
      current_snapshot_id: 'snap_1',
    },
    activity: {
      last_human_activity_at: lastHuman,
      last_agent_activity_at: '2026-07-02T09:00:00.000Z',
      has_new_human_activity: hasNew,
      open_thread_count: 1,
      latest_submission: null,
    },
  };
}

/** A client whose status() pops queued responses; clock advances via deps. */
function harness(responses: { items: StatusItem[] }[]) {
  let clock = 0;
  const sleeps: number[] = [];
  const client = {
    review: {
      status: async () => responses[Math.min(sleeps.length, responses.length - 1)],
    },
  };
  const deps = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { client, deps, sleeps };
}

describe('runReviewFeedbackWatch', () => {
  it('exit-0 path: fires when human activity moves past the baseline cursor', async () => {
    const { client, deps, sleeps } = harness([
      { items: [itemWith('2026-07-02T10:00:00.000Z')] }, // arm poll — matches baseline
      { items: [itemWith('2026-07-02T10:05:00.000Z', true)] }, // new human pass
    ]);
    const result = await runReviewFeedbackWatch({
      client,
      taskNumber: null,
      pullRequestId: 'pr_1',
      baselineCursor: '2026-07-02T10:00:00.000Z',
      timeoutMs: 600_000,
      deps,
    });
    expect(result.status).toBe('NEW_ACTIVITY');
    if (result.status === 'NEW_ACTIVITY') {
      expect(result.cursor).toBe('2026-07-02T10:05:00.000Z');
    }
    expect(sleeps).toEqual([REVIEW_WATCH_POLL_INTERVAL_MS]);
  });

  it('fresh clone (null baseline) baselines at arm and does NOT fire on old activity', async () => {
    const { client, deps } = harness([{ items: [itemWith('2026-07-02T10:00:00.000Z')] }]);
    const result = await runReviewFeedbackWatch({
      client,
      taskNumber: null,
      pullRequestId: 'pr_1',
      baselineCursor: null,
      timeoutMs: 10_000,
      deps,
    });
    expect(result.status).toBe('TIMEOUT'); // pre-arm activity never trips a fresh watcher
  });

  it('times out with the distinct non-failure result', async () => {
    const { client, deps } = harness([{ items: [itemWith('2026-07-02T10:00:00.000Z')] }]);
    const result = await runReviewFeedbackWatch({
      client,
      taskNumber: null,
      pullRequestId: 'pr_1',
      baselineCursor: '2026-07-02T10:00:00.000Z',
      timeoutMs: 9_000, // < 3 polls
      deps,
    });
    expect(result.status).toBe('TIMEOUT');
  });

  it('resolves a single --task to its PR and watches it', async () => {
    // The successful half: exactly one open reviewed PR matches the task.
    const { client, deps, sleeps } = harness([
      { items: [itemWith('2026-07-02T10:00:00.000Z')] }, // arm poll — resolves + baselines
      { items: [itemWith('2026-07-02T10:05:00.000Z', true)] }, // new human pass
    ]);
    const result = await runReviewFeedbackWatch({
      client,
      taskNumber: 1,
      pullRequestId: null,
      baselineCursor: '2026-07-02T10:00:00.000Z',
      timeoutMs: 600_000,
      deps,
    });
    expect(result.status).toBe('NEW_ACTIVITY');
    if (result.status === 'NEW_ACTIVITY') {
      // PR identity: the task resolved to pr_1, and post-resolution polling
      // keyed off that PR id (a wrong id here fails — verified by mutation).
      expect(result.item.subject.pull_request_id).toBe('pr_1');
      expect(result.item.subject.pull_request_number).toBe(7);
      expect(result.cursor).toBe('2026-07-02T10:05:00.000Z');
    }
    // Polling behavior: exactly one inter-poll sleep at the fixed cadence.
    expect(sleeps).toEqual([REVIEW_WATCH_POLL_INTERVAL_MS]);
  });

  it('errors on task ambiguity (multiple open reviewed PRs match)', async () => {
    const twin = itemWith('2026-07-02T10:00:00.000Z');
    const { client, deps } = harness([
      { items: [twin, { ...twin, subject: { ...twin.subject, pull_request_id: 'pr_2' } }] },
    ]);
    await expect(
      runReviewFeedbackWatch({
        client,
        taskNumber: 1,
        pullRequestId: null,
        baselineCursor: null,
        timeoutMs: 10_000,
        deps,
      })
    ).rejects.toThrow(/multiple open reviewed PRs/i);
  });
});
