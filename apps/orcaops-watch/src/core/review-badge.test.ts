import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { countOpenReviewComments } from './review-badge';

const anchor = { kind: 'DIFF_LINE', file: 'a.ts', side: 'add', line: 1, lineHash: 'h' };

describe('countOpenReviewComments', () => {
  it('replays add/status into the open count, slug-safe, skipping garbage lines', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-badge-test-'));
    const dir = path.join(root, '.orcaops', 'reviews', 'demo%2Fx');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'comments.ndjson');
    const ev = (o: object) => `${JSON.stringify(o)}\n`;
    await appendFile(
      file,
      ev({
        type: 'add',
        comment_id: 'c1',
        ts: '2026-07-09T00:00:00Z',
        author: 'reviewer',
        body: 'a',
        anchor,
      }) +
        ev({
          type: 'add',
          comment_id: 'c2',
          ts: '2026-07-09T00:00:01Z',
          author: 'agent',
          body: 'b',
          anchor,
        }) +
        'GARBAGE{{{\n' +
        ev({
          type: 'status',
          comment_id: 'c2',
          ts: '2026-07-09T00:00:02Z',
          author: 'agent',
          status: 'resolved',
        })
    );
    await expect(countOpenReviewComments(root, 'demo/x')).resolves.toBe(1);
  });

  it('a branch with no comments file reads zero', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-badge-test-'));
    await expect(countOpenReviewComments(root, 'demo')).resolves.toBe(0);
  });
});
