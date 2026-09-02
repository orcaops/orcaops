import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  readReviewFeedbackPullRecord,
  type ReviewFeedbackPullRecord,
  writeReviewFeedbackPullRecord,
} from './pull-cache.js';
import { sha256Hex } from '../crypto.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rf-cache-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const transcriptJson = JSON.stringify({ subject: { pull_request_id: 'pr_1' } });
const record: ReviewFeedbackPullRecord = {
  schema_version: 1,
  pull_request_id: 'pr_1',
  task_number: 1,
  activity_cursor: '2026-07-02T10:00:00.000Z',
  transcript_json: transcriptJson,
  content_hash: sha256Hex(transcriptJson),
  base_url: 'http://localhost:3001',
  org_id: 'org_1',
  pulled_at: '2026-07-02T10:00:05.000Z',
};

it('writes then reads back by (base_url, org, subject); latest pull overwrites', async () => {
  await writeReviewFeedbackPullRecord(dir, record);
  const again = { ...record, activity_cursor: '2026-07-02T12:00:00.000Z' };
  await writeReviewFeedbackPullRecord(dir, again);
  const read = await readReviewFeedbackPullRecord(dir, 'http://localhost:3001/', 'org_1', 'pr_1');
  expect(read?.activity_cursor).toBe('2026-07-02T12:00:00.000Z'); // trailing-slash base_url keys same namespace
});

it('rejects a corrupted body (hash mismatch) and reads null for a missing record', async () => {
  await expect(
    writeReviewFeedbackPullRecord(dir, { ...record, content_hash: 'deadbeef' })
  ).rejects.toThrow(/integrity/);
  expect(
    await readReviewFeedbackPullRecord(dir, 'http://localhost:3001', 'org_1', 'pr_x')
  ).toBeNull();
});

it('refuses a final record symlink without reading or replacing its target', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'rf-cache-outside-'));
  try {
    const cacheDir = path.join(dir, '.orcaops', 'cache');
    await mkdir(cacheDir, { recursive: true });
    const { recordPath } = await writeReviewFeedbackPullRecord(cacheDir, record, dir);
    const external = path.join(outside, 'record.json');
    await writeFile(external, 'external sentinel', 'utf8');
    await unlink(recordPath);
    await symlink(external, recordPath);

    await expect(
      readReviewFeedbackPullRecord(
        cacheDir,
        record.base_url,
        record.org_id,
        record.pull_request_id,
        dir
      )
    ).rejects.toThrow(/must not contain symlinks/);
    await expect(writeReviewFeedbackPullRecord(cacheDir, record, dir)).rejects.toThrow(
      /must not contain symlinks/
    );
    expect(await readFile(external, 'utf8')).toBe('external sentinel');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
