import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultConfig, uuidv7 } from '@orcaops/storage';
import { inputFile } from '@orcaops/test-harness';

import { git } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * The conversion gate protects legacy HISTORY. A repository that only carries orcaops
 * CONFIGURATION — the config file, the exclude block, the git-config project identity, an
 * install ownership manifest that claims no artifacts, an empty locks directory — is fresh
 * and may start capturing. A repository that carries a legacy artifact store, or a mirrored
 * archive project with content, still refuses and must go through the documented conversion.
 */
const execute = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repository() {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'gate-')));
  scratch.push(temporary);
  const main = path.join(temporary, 'main');
  await mkdir(path.join(temporary, 'home'), { recursive: true });
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-qb', 'main']);
  await git(main, ['commit', '--allow-empty', '-qm', 'Initial']);
  return { temporary, main, root: path.join(temporary, 'data') };
}
type Repository = Awaited<ReturnType<typeof repository>>;
function environment(r: Repository) {
  return {
    ORCAOPS_ROOT: r.main,
    ORCAOPS_DATA_DIR: r.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    XDG_CACHE_HOME: path.join(r.temporary, 'cache'),
    XDG_STATE_HOME: path.join(r.temporary, 'state'),
    HOME: path.join(r.temporary, 'home'),
    CODEX_SESSION_ID: 'gate-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
  };
}
function agent(r: Repository) {
  return makeAgent({ cwd: r.main, timeoutMs: 120_000, env: environment(r) });
}
function planPayload() {
  return JSON.stringify({
    idempotency_key: `plan-${randomUUID()}`,
    task: 'capture after the gate decides',
    label: 'Gate capture',
    plan_steps: [{ text: 'do it', label: 'Do it' }],
    touched_scope: [],
    non_goals: [],
  });
}
const capture = (r: Repository) =>
  agent(r).runRaw(['capture', 'plan', '--no-llm', '--input', inputFile(planPayload())]);
async function runInit(r: Repository, extra: string[] = []) {
  const raw = await agent(r).runRaw([
    'init',
    '--yes',
    '--scope',
    'personal',
    '--no-session-hooks',
    '--json',
    ...extra,
  ]);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout);
}
async function listing(directory: string) {
  return (await readdir(directory).catch(() => [])).sort();
}

describe('registered database conversion gate', { timeout: 240_000 }, () => {
  it('lets an initialized repository start capturing and creates only its project', async () => {
    const r = await repository();
    await runInit(r);
    expect(await listing(r.root)).toEqual(['projects']);
    const initializedProjects = await listing(path.join(r.root, 'projects'));
    expect(await listing(path.join(r.temporary, 'cache'))).toEqual([]);

    const captured = await capture(r);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
    expect(JSON.parse(captured.stdout).ok).toBe(true);
    expect(await listing(r.root)).toEqual(['projects']);
    const projects = await listing(path.join(r.root, 'projects'));
    expect(projects).toEqual(initializedProjects);
    expect(projects).toHaveLength(2);
    expect(projects).toContain('catalog');
    const [projectId] = projects.filter((name) => name !== 'catalog');
    expect(await listing(path.join(r.root, 'projects', projectId))).toContain('history.sqlite3');
    expect(await listing(path.join(r.root, 'projects', 'catalog'))).toEqual([`${projectId}.json`]);
    expect(await listing(path.join(r.temporary, 'cache'))).toEqual([]);
  });

  it('treats configuration-only evidence as fresh', async () => {
    const r = await repository();
    const config = getDefaultConfig();
    config.install.scope = 'personal';
    const common = path.join(r.main, '.git', 'orcaops');
    await mkdir(common);
    await writeFile(path.join(common, 'config.json'), JSON.stringify(config));
    await writeFile(path.join(r.main, '.git', 'info', 'exclude'), '\n.orcaops/\n');
    await git(r.main, ['config', '--local', 'orcaops.projectid', uuidv7()]);
    expect(await listing(common)).toEqual(['config.json']);
    expect(await listing(r.root)).toEqual([]);
    const captured = await capture(r);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
    expect(JSON.parse(captured.stdout).ok).toBe(true);
  });

  it('still refuses a legacy artifact store, and a mirrored archive project by another code', async () => {
    const legacy = await repository();
    const artifactId = randomUUID();
    await mkdir(path.join(legacy.main, '.orcaops', 'artifacts', artifactId), { recursive: true });
    await writeFile(
      path.join(legacy.main, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      `${JSON.stringify({ type: 'plan_captured', artifact_id: artifactId })}\n`,
      'utf8'
    );
    const refusedStore = await capture(legacy);
    expect(refusedStore.exitCode).toBe(1);
    expect(JSON.parse(refusedStore.stdout).error.code).toBe('CONVERSION_REQUIRED');

    const mirrored = await repository();
    const projectId = uuidv7();
    await mkdir(path.join(mirrored.root, 'projects', projectId, 'artifacts', artifactId), {
      recursive: true,
    });
    await writeFile(
      path.join(mirrored.root, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'),
      `${JSON.stringify({ type: 'plan_captured', artifact_id: artifactId })}\n`,
      'utf8'
    );
    await writeFile(
      path.join(mirrored.root, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: { [projectId]: { last_seen_paths: [mirrored.main] } },
      }),
      'utf8'
    );
    const refusedMirror = await capture(mirrored);
    expect(refusedMirror.exitCode).toBe(1);
    // A mirrored project directory sits under the same `projects/` parent the SQLite root
    // uses, so the scope reads it as a registered project whose database is missing and
    // refuses there, BEFORE the conversion gate is consulted. Either way it refuses and
    // initializes nothing; the code differs from the legacy-store case.
    expect(JSON.parse(refusedMirror.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await listing(path.join(mirrored.root, 'projects'))).toEqual([projectId]);
  });

  it('re-runs init over an existing project database without touching it', async () => {
    const r = await repository();
    await runInit(r);
    const captured = await capture(r);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
    const before = await listing(path.join(r.root, 'projects'));
    const [projectId] = before.filter((name) => name !== 'catalog');
    const database = path.join(r.root, 'projects', projectId, 'history.sqlite3');
    const stamp = await execute('shasum', ['-a', '256', database]);
    const registration = await execute('cat', [
      path.join(r.root, 'projects', 'catalog', `${projectId}.json`),
    ]);
    await runInit(r, ['--force']);
    expect(await listing(path.join(r.root, 'projects'))).toEqual(before);
    expect((await execute('shasum', ['-a', '256', database])).stdout).toBe(stamp.stdout);
    expect(
      (await execute('cat', [path.join(r.root, 'projects', 'catalog', `${projectId}.json`)])).stdout
    ).toBe(registration.stdout);
  });

  it('leaves doctor reporting rather than crashing on an init-only repository', async () => {
    const r = await repository();
    await runInit(r);
    const raw = await agent(r).runRaw(['doctor', '--json']);
    // Recorded behaviour: doctor still emits its typed envelope; it does not throw.
    const envelope = JSON.parse(raw.stdout);
    expect(typeof envelope.ok).toBe('boolean');
    expect(Array.isArray(envelope.checks)).toBe(true);
    expect(['pass', 'warn', 'fail']).toContain(envelope.overall);
  });
});
