import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import { createExecutionPin } from '@orcaops/storage/history/execution-focus';
import { createTempRepo } from '@orcaops/test-harness';

import { publishProjectExecutionFocus } from '../../../../packages/storage/dist/history/database/execution-focus.js';
import type { readDatabaseStatus } from '../../src/lib/database-task-context.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

async function status(f: { main: string; root: string }, flags: string[] = []) {
  const result = await makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'task-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
    },
  }).runRaw(['status', '--json', ...flags]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<typeof readDatabaseStatus>;
}
describe('registered passive task status', { timeout: 30_000 }, () => {
  it('separates current branch tasks from explicit project and worktree scope', async () => {
    const f = await fixture();
    const main = await f.capture();
    const linked = await f.capture(undefined, { cwd: f.linked });
    const before = await inventory(f.temporary);
    const bare = await status(f);
    expect(bare.schema_version).toBe(3);
    expect(bare.artifacts.map((artifact) => artifact.id)).toEqual([main]);
    expect(bare.eligible_tasks.map((task) => task.artifact_id)).toEqual([main]);
    expect(bare.artifacts[0]).toMatchObject({
      thread: { plan: { status: 'done' }, summary: { status: 'ready' } },
      source_plan: null,
      state: 'planned',
    });
    expect(bare.artifacts[0].next_actions[0].verb).toBe('checkpoint-open');
    const project = await status(f, ['--project', f.authority.projectId]);
    expect(new Set(project.artifacts.map((artifact) => artifact.id))).toEqual(
      new Set([main, linked])
    );
    expect(project.eligible_tasks.map((task) => task.artifact_id)).toEqual([main]);
    expect(
      (await status(f, ['--scope', 'worktree'])).artifacts.map((artifact) => artifact.id)
    ).toEqual([main]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports completed focus and imported evidence without implicit task authority', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { reason: 'completed' });
    await f.capture(undefined, { reason: 'imported' });
    const state = readProjectExecution(f.writer, id)!;
    const shellKey = { kind: 'codex_session' as const, value: 'task-session' };
    const pin = createExecutionPin({
      authority: { ...f.authority, formatVersion: 1 },
      gitContext: f.context,
      shellKey,
      state: state.state,
      pinnedAt: '2026-09-01T00:00:00.000Z',
    });
    await publishProjectExecutionFocus(f.writer, {
      action: 'set',
      operationId: uuidv7(),
      expectedSelection: null,
      scope: {
        rootKey: f.authority.rootKey,
        projectId: f.authority.projectId,
        storeInstanceId: f.authority.storeInstanceId,
        repositoryInstanceId: f.authority.repositoryInstanceId,
        worktreeId: f.context.worktreeId!,
        shellKey,
      },
      pinBytes: Buffer.from(JSON.stringify(pin)),
      expectedArtifactRevision: readProjectArtifact(f.writer, id)!.revision,
      expectedExecutionVersion: state.version,
      secretAllow: [],
    });
    const before = await inventory(f.temporary);
    const result = await status(f);
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([id]);
    expect(result.imported_artifacts.count).toBe(1);
    expect(result.focus[0]).toMatchObject({
      status: 'present',
      pin: { artifact_id: id },
      assessment: { valid: true },
      eligibility: { valid: false },
    });
    expect(result.eligible_tasks).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('succeeds with explicit missing-history diagnostics and never initializes replacement', async () => {
    const f = await fixture();
    await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await status(f);
    expect(result.history.complete).toBe(false);
    expect(result.history.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HISTORY_MISSING' })])
    );
    expect(result.artifacts).toEqual([]);
    expect(result.cloud_sync.pending_count).toBeNull();
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('succeeds outside a repository without inventing project or focus identity', async () => {
    const f = await fixture();
    const before = await inventory(f.temporary);
    const result = await status({ main: f.temporary, root: f.root });
    expect(result.history.complete).toBe(false);
    expect(result.context.git).toBeNull();
    expect(result.cloud_sync).toEqual({
      state: 'unavailable',
      pending_count: null,
      stuck_count: null,
      reason: 'not_connected',
    });
    expect(result.focus).toEqual([]);
    expect(result.eligible_tasks).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('discloses detached current-branch selection without treating it as complete empty history', async () => {
    const f = await fixture();
    const id = await f.capture();
    await git(f.main, ['checkout', '--detach']);
    const before = await inventory(f.temporary);
    const result = await status(f);
    expect(result.history.complete).toBe(false);
    expect(result.history.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CURRENT_BRANCH_UNAVAILABLE' })])
    );
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([id]);
    expect(result.eligible_tasks).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports damaged derived history without substituting a healthy-looking row or repairing it', async () => {
    const f = await fixture();
    await f.capture();
    const raw = new Database(projectDatabasePath(f.authority));
    raw.exec('DELETE FROM artifact_query_metadata');
    raw.close();
    const before = await inventory(f.temporary);
    const result = await status(f);
    expect(result.history.complete).toBe(false);
    expect(result.history.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })])
    );
    expect(result.artifacts).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('neutralizes carriage returns in retained prose before human output', async () => {
    const f = await fixture();
    await f.capture(undefined, { task: 'visible task\rspoofed artifact id' });
    const before = await inventory(f.temporary);
    const result = await makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    }).runRaw(['status']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('\r');
    expect(result.stdout).toContain('visible taskspoofed artifact id');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});

describe('install drift advice without an orcaops config', { timeout: 60_000 }, () => {
  async function statusWithoutConfig(cwd: string) {
    const agent = makeAgent({ cwd, env: { CLAUDE_SESSION_ID: 'drift-advice' } });
    const json = await agent.runRaw(['status', '--json']);
    expect(json.exitCode, json.stderr || json.stdout).toBe(0);
    const text = await agent.runRaw(['status']);
    expect(text.exitCode, text.stderr || text.stdout).toBe(0);
    return {
      json: JSON.parse(json.stdout) as { drift?: unknown },
      text: text.stdout + text.stderr,
    };
  }

  it('does not recommend update in a repository that was never initialized', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const { json, text } = await statusWithoutConfig(repo.path);
      expect(json.drift).toBeUndefined();
      expect(text).not.toMatch(/orcaops update/);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not recommend update after uninstall purges the orcaops data', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'drift-advice' } });
      expect((await agent.runRaw(['init', '--scope', 'project', '--no-llm'])).exitCode).toBe(0);
      const purge = await agent.runRaw(['uninstall', '--purge-data', '--json']);
      expect(purge.exitCode, purge.stderr || purge.stdout).toBe(0);
      const { json, text } = await statusWithoutConfig(repo.path);
      expect(json.drift).toBeUndefined();
      expect(text).not.toMatch(/orcaops update/);
    } finally {
      await repo.cleanup();
    }
  });
});
