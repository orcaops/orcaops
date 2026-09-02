import { expect, it } from 'vitest';

import type { OssReviewFeedbackStatusResponse } from '@orcaops/sdk';

import { formatHumanReviewFeedbackStatus, runReviewFeedbackStatus } from './status.js';

const ITEM: OssReviewFeedbackStatusResponse['items'][number] = {
  subject: {
    task_number: 1,
    pull_request_id: 'pr_1',
    pull_request_number: 7,
    pull_request_title: 'Demo PR',
    pull_request_url: 'https://github.com/acme/demo/pull/7',
    current_snapshot_id: 'snap_1',
  },
  activity: {
    last_human_activity_at: '2026-07-02T10:00:00.000Z',
    last_agent_activity_at: '2026-07-02T09:00:00.000Z',
    has_new_human_activity: true,
    open_thread_count: 2,
    latest_submission: {
      id: 'sub_1',
      created_at: '2026-07-02T10:00:00.000Z',
      note: 'overall solid',
      reviewed_version_key: 'snap_1',
    },
  },
};

it('fetches and renders per-PR state with the NEW flag + next action', async () => {
  const client = { review: { status: async () => ({ items: [ITEM] }) } };
  const result = await runReviewFeedbackStatus({ client });
  const text = formatHumanReviewFeedbackStatus(result);
  expect(text).toContain('PR #7  Demo PR');
  expect(text).toContain('NEW human activity');
  expect(text).toContain('2 open thread(s)');
  expect(text).toContain('Next: orcaops review pull --pr pr_1');
});

it('renders the quiet state without a pull hint', async () => {
  const quiet = {
    ...ITEM,
    activity: { ...ITEM.activity, has_new_human_activity: false, open_thread_count: 0 },
  };
  const client = { review: { status: async () => ({ items: [quiet] }) } };
  const text = formatHumanReviewFeedbackStatus(await runReviewFeedbackStatus({ client }));
  expect(text).toContain('quiet');
  expect(text).not.toContain('Next: orcaops review pull');
});
