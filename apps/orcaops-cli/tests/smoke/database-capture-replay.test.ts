import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-capture';
import { openProjectDatabase } from '@orcaops/storage/history/database';

import { git } from '../helpers/database-history.js';

/**
 * The packaged surface the runtime gate exercises: a same-key rerun through
 * `bin/orcaops.js` must leave every authoritative row exactly as it found it.
 */
const execute = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

it(
  'replays a packaged capture without moving any authoritative row',
  { timeout: 240_000 },
  async () => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'replay-smoke-')));
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
        task: 'packaged replay writes nothing',
        label: 'Packaged replay',
        plan_steps: [{ text: 'do it', label: 'Do it' }],
        touched_scope: [],
        non_goals: [],
      }),
      'utf8'
    );
    const capture = () =>
      execute(
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
            CODEX_SESSION_ID: 'packaged-replay',
          },
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        }
      );
    const first = JSON.parse((await capture()).stdout);
    expect(first.ok).toBe(true);

    const [projectId] = (await readdir(path.join(root, 'projects'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'catalog')
      .map((entry) => entry.name);
    expect(
      JSON.parse(
        await readFile(path.join(root, 'projects', 'catalog', `${projectId}.json`), 'utf8')
      ).project_id
    ).toBe(projectId);
    // The registered context resolves the authority the packaged run wrote.
    const registered = await requireDatabaseExecutionContext({ cwd: main, root });
    const inventory = async () => {
      const handle = await openProjectDatabase({ authority: registered.authority, mode: 'reader' });
      try {
        return handle.read((view) => ({
          operations: view.all(
            'SELECT operation_id, operation_kind, committed_write_sequence, committed_intent_counter FROM operations ORDER BY operation_id'
          ),
          counters: view.all('SELECT * FROM project_counters'),
          focusCurrent: view.all(
            'SELECT scope_json, operation_id, version FROM execution_focus_current ORDER BY scope_json'
          ),
          focusRecords: view.all(
            'SELECT operation_id, scope_json, pin_hash FROM execution_focus_records ORDER BY operation_id'
          ),
          artifacts: view.all('SELECT artifact_id FROM artifacts ORDER BY artifact_id'),
          events: view.all('SELECT event_id, artifact_id FROM artifact_events ORDER BY event_id'),
        })).value;
      } finally {
        handle.close();
      }
    };
    const before = await inventory();
    const replay = JSON.parse((await capture()).stdout);
    expect(replay).toMatchObject({
      ok: true,
      artifact_id: first.artifact_id,
      idempotency_status: 'replay',
    });
    expect(await inventory()).toEqual(before);
  }
);
