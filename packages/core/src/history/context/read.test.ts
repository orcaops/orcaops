import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import * as gitHead from './git-head.js';
import { readDatabaseHistoryContext } from './read.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(['abort', 'throw'] as const)(
  'propagates final HEAD cancellation through %s',
  async (mode) => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'history-read-context-')));
    roots.push(cwd);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ])
      delete env[key];
    await promisify(execFile)('git', ['-C', cwd, 'init', '-q', '-b', 'topic'], { env });
    const controller = new AbortController();
    const actual = gitHead.readDatabaseGitHead;
    let observations = 0;
    vi.spyOn(gitHead, 'readDatabaseGitHead').mockImplementation(async (...args) => {
      const result = await actual(...args);
      if (++observations === 2) {
        controller.abort();
        if (mode === 'throw') throw new ProjectDatabaseError('CANCELLED', 'History read cancelled');
      }
      return result;
    });
    await expect(
      readDatabaseHistoryContext({ cwd, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(observations).toBe(2);
  }
);

it.each([null, undefined, {}, { cwd: 3 }, { cwd: '' }, { cwd: '   ' }])(
  'rejects invalid context input before inspecting Git: %j',
  async (input) => {
    await expect(readDatabaseHistoryContext(input as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  }
);
