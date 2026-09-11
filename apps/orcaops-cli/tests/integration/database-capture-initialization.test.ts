import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `capture plan` is the only verb that can start history from nothing. A repository with
 * no registration, no project database and no legacy presence is FRESH and must be
 * initialized through the accepted setup path — after the authored payload is refused, so
 * a refused capture leaves no project behind. A REGISTERED project whose database is gone
 * is a different case entirely: its history is missing, and reinitializing would replace
 * what was lost, so it stays refused.
 */
const execute = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshRepository() {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'fresh-capture-')));
  scratch.push(temporary);
  const main = path.join(temporary, 'main');
  const root = path.join(temporary, 'data');
  await execute('mkdir', ['-p', main]);
  await git(main, ['init', '-qb', 'main']);
  await git(main, ['commit', '--allow-empty', '-qm', 'Initial']);
  return { temporary, main, root };
}
function agent(repository: { main: string; root: string; temporary: string }) {
  return makeAgent({
    cwd: repository.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: repository.main,
      ORCAOPS_DATA_DIR: repository.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'fresh-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: `${repository.temporary}/state`,
    },
  });
}
function planPayload(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Start history on a repository that has none',
    label: 'First capture',
    plan_steps: [{ text: 'do the thing', label: 'Do it' }],
    touched_scope: [],
    non_goals: [],
    ...extra,
  });
}
async function projectDirectories(root: string) {
  const entries = await readdir(path.join(root, 'projects'), { withFileTypes: true }).catch(
    () => []
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
async function catalogEntries(root: string) {
  return (await readdir(path.join(root, 'projects', 'catalog')).catch(() => [])).filter((name) =>
    name.endsWith('.json')
  );
}

describe('registered database capture initialization', { timeout: 180_000 }, () => {
  it('starts history on a fresh repository once and reuses it on the next capture', async () => {
    const repository = await freshRepository();
    const first = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload()),
    ]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const created = JSON.parse(first.stdout);
    expect(created.ok).toBe(true);
    const projects = await projectDirectories(repository.root);
    expect(projects.filter((name) => name !== 'catalog')).toHaveLength(1);
    expect(await catalogEntries(repository.root)).toHaveLength(1);
    const registration = await readdir(path.join(repository.main, '.git', 'orcaops')).catch(
      () => []
    );
    expect(registration.length).toBeGreaterThan(0);

    const second = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload()),
    ]);
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).artifact_id).not.toBe(created.artifact_id);
    // The second capture reuses the project the first one started.
    expect(await projectDirectories(repository.root)).toEqual(projects);
    expect(await catalogEntries(repository.root)).toHaveLength(1);
  });

  it('refuses a credential on a fresh repository before anything is initialized', async () => {
    const repository = await freshRepository();
    const before = await inventory(repository.temporary);
    const refused = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload({ task: `deploy with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8` })),
    ]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code: 'SECRET_IN_PAYLOAD',
      path: 'task',
    });
    // No project, catalog entry, registration or anything else was created for a payload
    // that was never going to be accepted.
    expect(await inventory(repository.temporary)).toEqual(before);
    expect(await projectDirectories(repository.root)).toEqual([]);
  });

  it('refuses a registered project whose database is gone instead of replacing it', async () => {
    const repository = await freshRepository();
    const started = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload()),
    ]);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    const [project] = (await projectDirectories(repository.root)).filter(
      (name) => name !== 'catalog'
    );
    await rm(path.join(repository.root, 'projects', project), { recursive: true, force: true });
    const before = await inventory(repository.temporary);
    const refused = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload()),
    ]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(repository.temporary)).toEqual(before);
    expect(await projectDirectories(repository.root)).toEqual(['catalog']);
  });

  it('retries an interrupted first capture without a second project', async () => {
    const repository = await freshRepository();
    const key = `plan-${randomUUID()}`;
    const payload = planPayload({ idempotency_key: key });
    const first = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(payload),
    ]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const created = JSON.parse(first.stdout);
    const projects = await projectDirectories(repository.root);
    // The same key after the project exists is the retry an interrupted first capture makes.
    const retry = await agent(repository).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(payload),
    ]);
    expect(retry.exitCode, retry.stdout + retry.stderr).toBe(0);
    const replayed = JSON.parse(retry.stdout);
    expect(replayed).toMatchObject({
      artifact_id: created.artifact_id,
      idempotency_status: 'replay',
    });
    expect(await projectDirectories(repository.root)).toEqual(projects);
    expect(await catalogEntries(repository.root)).toHaveLength(1);
  });

  it('refuses every other capture verb on a repository with no history', async () => {
    const repository = await freshRepository();
    const before = await inventory(repository.temporary);
    const refused = await agent(repository).runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          declared_step_ids: ['01a07d37-945a-7397-a57b-12395dd15b24'],
        })
      ),
    ]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(repository.temporary)).toEqual(before);
  });
});
