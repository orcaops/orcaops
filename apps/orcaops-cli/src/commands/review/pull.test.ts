import { describe, expect, it } from 'vitest';

import type { OssReviewFeedbackTranscript } from '@orcaops/sdk';

import { renderTranscriptMarkdown, runReviewFeedbackPull } from './pull.js';

// Explicitly typed (not `as const`) so the literals check against the wire
// union types and the fixture satisfies the injectable client interface.
const TRANSCRIPT: OssReviewFeedbackTranscript = {
  subject: {
    task_number: 1,
    pull_request_id: 'pr_1',
    pull_request_number: 7,
    pull_request_title: 'Demo PR',
    pull_request_url: 'https://github.com/acme/demo/pull/7',
    current_snapshot_id: 'snap_1',
  },
  submissions: [
    {
      id: 'sub_1',
      created_at: '2026-07-02T10:00:00.000Z',
      note: 'overall solid',
      reviewed_version_key: 'snap_0',
      published_comment_ids: ['c1'],
      is_current_snapshot: false,
    },
  ],
  threads: [
    {
      root: {
        id: 'c1',
        body: 'why this retry window?',
        author_name: 'Peer',
        author_id: 'usr_peer',
        author_actor_type: 'USER',
        status: 'OPEN',
        created_at: '2026-07-02T09:59:00.000Z',
        anchor_type: 'REVIEW_FINDING',
        anchor_key: 'fk_abc123',
      },
      replies: [],
      anchor_state: 'CURRENT',
      anchor_context: { label: 'Untested retry path', excerpt: 'No test covers the retry branch.' },
    },
  ],
  dispositions: {
    open_thread_count: 1,
    resolved_thread_count: 0,
    finding_states: [
      { finding_key: 'fk_abc123', state: 'UNREVIEWED' },
      { finding_key: 'fk_def456', state: 'DISMISSED' },
    ],
  },
  activity: {
    last_human_activity_at: '2026-07-02T10:00:00.000Z',
    last_agent_activity_at: null,
    has_new_human_activity: true,
    open_thread_count: 1,
    latest_submission: {
      id: 'sub_1',
      created_at: '2026-07-02T10:00:00.000Z',
      note: 'overall solid',
      reviewed_version_key: 'snap_0',
    },
  },
};

describe('renderTranscriptMarkdown', () => {
  it('renders the agent-readable markdown (sample in → out)', () => {
    const md = renderTranscriptMarkdown(TRANSCRIPT);
    expect(md).toContain('# Review feedback — PR #7: Demo PR');
    expect(md).toContain(
      'activity cursor (echo as --pass-token on replies): 2026-07-02T10:00:00.000Z'
    );
    expect(md).toContain('### [OPEN] Untested retry path');
    expect(md).toContain('> No test covers the retry branch.');
    expect(md).toContain('comment_id: c1');
    expect(md).toContain('STALE (reviewed snap_0)');
    expect(md).not.toContain('[DETACHED anchor]'); // CURRENT thread carries no detach marker
    expect(md).toContain('## Finding dispositions');
    expect(md).toContain('- fk_abc123: UNREVIEWED');
    expect(md).toContain('- fk_def456: DISMISSED');
  });

  it('omits the dispositions section when finding_states is empty', () => {
    const md = renderTranscriptMarkdown({
      ...TRANSCRIPT,
      dispositions: { ...TRANSCRIPT.dispositions, finding_states: [] },
    });
    expect(md).not.toContain('## Finding dispositions');
  });

  it('marks detached anchors and falls back to anchor_key when context is null', () => {
    const md = renderTranscriptMarkdown({
      ...TRANSCRIPT,
      threads: [
        {
          ...TRANSCRIPT.threads[0],
          anchor_state: 'DETACHED',
          anchor_context: null,
        },
      ],
    });
    expect(md).toContain('### [OPEN] fk_abc123 [DETACHED anchor]');
  });

  it('marks an OUTDATED diff-line anchor distinctly and keeps its captured excerpt', () => {
    const md = renderTranscriptMarkdown({
      ...TRANSCRIPT,
      threads: [
        {
          ...TRANSCRIPT.threads[0],
          anchor_state: 'OUTDATED',
          anchor_context: { label: 'src/a.ts:42', excerpt: 'return x;' },
        },
      ],
    });
    expect(md).toContain(
      '### [OPEN] src/a.ts:42 [OUTDATED anchor — line moved out of the current diff]'
    );
    expect(md).toContain('> return x;');
    expect(md).not.toContain('[DETACHED anchor]');
  });

  it('refuses an anchor state outside the current closed enum', () => {
    const transcript = {
      ...TRANSCRIPT,
      threads: [{ ...TRANSCRIPT.threads[0], anchor_state: 'FUTURE_STATE' }],
    } as unknown as OssReviewFeedbackTranscript;
    expect(() => renderTranscriptMarkdown(transcript)).toThrow(/Unsupported review anchor state/);
  });

  it('strips control characters from server-supplied free text before it reaches the TTY', () => {
    const ESC = '\u001b';
    const BEL = '\u0007';
    const NUL = '\u0000';
    const md = renderTranscriptMarkdown({
      ...TRANSCRIPT,
      subject: { ...TRANSCRIPT.subject, pull_request_title: `Demo${ESC}[2J PR` },
      threads: [
        {
          ...TRANSCRIPT.threads[0]!,
          root: {
            ...TRANSCRIPT.threads[0]!.root,
            body: `why${ESC}]0;evil${BEL} this retry window?`,
            author_name: `Pe${NUL}er`,
          },
          anchor_context: { label: 'src/a.ts:42', excerpt: `return${ESC}[31m x;` },
        },
      ],
    });
    expect(md).not.toContain(ESC);
    expect(md).not.toContain(BEL);
    expect(md).not.toContain(NUL);
    expect(md).toContain('Demo[2J PR');
    expect(md).toContain('why]0;evil this retry window?');
    expect(md).toContain('Peer');
    expect(md).toContain('> return[31m x;');
  });
});

describe('runReviewFeedbackPull', () => {
  it('sends exactly one selector and returns the transcript', async () => {
    const calls: unknown[] = [];
    const client = {
      review: {
        pull: async (input: unknown) => {
          calls.push(input);
          return TRANSCRIPT;
        },
      },
    };
    const result = await runReviewFeedbackPull({ client, taskNumber: 1, pullRequestId: null });
    expect(calls).toEqual([{ schema_version: 1, task_number: 1, pull_request_id: null }]);
    expect(result.subject.pull_request_id).toBe('pr_1');
    // The `--json` path (`emitOk(transcript)`) emits this same object untouched,
    // so dispositions surviving the pass-through here covers that path too.
    expect(result.dispositions.finding_states).toEqual(TRANSCRIPT.dispositions.finding_states);
  });

  it('rejects both/neither selector locally (no wire round-trip)', async () => {
    const client = { review: { pull: async () => TRANSCRIPT } };
    await expect(
      runReviewFeedbackPull({ client, taskNumber: null, pullRequestId: null })
    ).rejects.toThrow(/exactly one/i);
    await expect(
      runReviewFeedbackPull({ client, taskNumber: 1, pullRequestId: 'pr_1' })
    ).rejects.toThrow(/exactly one/i);
  });
});
