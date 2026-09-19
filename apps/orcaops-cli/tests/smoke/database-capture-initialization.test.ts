import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { git } from '../helpers/database-history.js';

/**
 * The packaged executable is the surface the runtime gate exercises: a repository with no
 * history must be able to start capturing through `bin/orcaops.js`, not only through the
 * in-process command tree.
 */
const execute = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

it(
  'starts history on a fresh repository through the executable',
  { timeout: 180_000 },
  async () => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'fresh-smoke-')));
    scratch.push(temporary);
    const main = path.join(temporary, 'main');
    const root = path.join(temporary, 'data');
    await execute('mkdir', ['-p', main]);
    await git(main, ['init', '-qb', 'main']);
    await git(main, ['commit', '--allow-empty', '-qm', 'Initial']);
    const payload = path.join(temporary, 'plan.json');
    await writeFile(
      payload,
      JSON.stringify({
        idempotency_key: `plan-${randomUUID()}`,
        task: 'Start history through the packaged executable',
        label: 'Packaged first capture',
        plan_steps: [
          {
            text: 'do the thing',
            label: 'Do it',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
        ],
        touched_scope: [],
        non_goals: [],
      }),
      'utf8'
    );
    const run = await execute(
      process.execPath,
      [
        fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)),
        'capture',
        'plan',
        '--no-llm',
        '--input',
        payload,
      ],
      {
        cwd: main,
        env: {
          ...process.env,
          ORCAOPS_ROOT: main,
          ORCAOPS_DATA_DIR: root,
          ORCAOPS_DISABLE_DRAIN: '1',
          NODE_DISABLE_COMPILE_CACHE: '1',
        },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      }
    );
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, revision_n: 0 });
    const projects = (await readdir(path.join(root, 'projects'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'catalog')
      .map((entry) => entry.name);
    expect(projects).toHaveLength(1);
    expect(await readdir(path.join(root, 'projects', projects[0]))).toContain('history.sqlite3');
    expect(await readdir(path.join(root, 'projects', 'catalog'))).toContain(`${projects[0]}.json`);
  }
);
