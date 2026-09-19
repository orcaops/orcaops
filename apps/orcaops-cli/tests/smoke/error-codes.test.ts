import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';

const execute = promisify(execFile);

it('reports an unsupported database version without replacing or changing history', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  const raw = new Database(f.writer.databasePath, { fileMustExist: true });
  try {
    raw.pragma('user_version = 999');
    const snapshot = async () => {
      const files: Record<string, string> = {};
      for (const entry of await readdir(f.temporary, { recursive: true, withFileTypes: true })) {
        const file = path.join(entry.parentPath, entry.name);
        if (
          [
            f.writer.databasePath,
            f.writer.databasePath + '-wal',
            f.writer.databasePath + '-shm',
          ].includes(file)
        )
          continue;
        files[path.relative(f.temporary, file)] = entry.isFile()
          ? createHash('sha256')
              .update(await readFile(file))
              .digest('hex')
          : entry.isDirectory()
            ? 'directory'
            : 'other';
      }
      return { files, database: createHash('sha256').update(raw.serialize()).digest('hex') };
    };
    const before = await snapshot();
    const run = (args: string[]) =>
      execute(
        process.execPath,
        [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
        {
          cwd: f.main,
          timeout: 30_000,
          env: {
            ...process.env,
            ORCAOPS_ROOT: f.main,
            ORCAOPS_DATA_DIR: f.root,
            ORCAOPS_DISABLE_DRAIN: '1',
            NODE_DISABLE_COMPILE_CACHE: '1',
            CLAUDE_SESSION_ID: '',
            CLAUDE_CODE_SESSION_ID: '',
            CODEX_SESSION_ID: 'unsupported-history-session',
            XDG_STATE_HOME: f.temporary + '/state',
          },
        }
      );
    for (const args of [
      ['show', artifactId, '--json'],
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: 'unsupported-history-plan',
            task: 'Preserve existing history',
            plan_steps: [
              {
                text: 'Inspect the history',
                label: 'Inspect',
                acceptance_criteria: [{ text: 'the step is delivered' }],
              },
            ],
          })
        ),
      ],
    ]) {
      await expect(run(args)).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"code":"HISTORY_FORMAT_UNSUPPORTED"'),
      });
      expect(await snapshot()).toEqual(before);
      expect(raw.pragma('user_version', { simple: true })).toBe(999);
    }
    const listed = await run(['list', '--json']);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      ok: true,
      completeness: {
        complete: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'HISTORY_FORMAT_UNSUPPORTED' }),
        ]),
      },
    });
    expect(await snapshot()).toEqual(before);
    expect(raw.pragma('user_version', { simple: true })).toBe(999);
  } finally {
    raw.close();
  }
}, 90_000);
