import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { resolveDatabaseCaptureContext } from '../../src/lib/database-capture-context.js';
import { registerMissingDatabaseWorktree } from '../../src/lib/database-worktree-registration.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, git } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

async function worktree(scope: 'personal' | 'project') {
  const f = await fixture();
  await git(f.main, ['worktree', 'remove', f.linked]);
  await git(f.main, ['worktree', 'add', f.linked, 'linked']);
  const config = JSON.stringify({
    schema_version: CONFIG_SCHEMA_VERSION,
    install: { scope, agents: [] },
    llm: { tool: 'none' },
  });
  const common = path.join(f.main, '.git');
  const configPath =
    scope === 'personal'
      ? path.join(common, 'orcaops/config.json')
      : path.join(f.linked, '.orcaops/config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, config);
  const gitDir = (await git(f.linked, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const binding = path.join(gitDir, 'orcaops/worktree.json');
  const env = {
    ORCAOPS_ROOT: f.linked,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'worktree-registration',
  };
  return {
    ...f,
    configPath,
    config,
    common,
    gitDir,
    binding,
    env,
    agent: makeAgent({ cwd: f.linked, env }),
  };
}
const plan = () =>
  inputFile(
    JSON.stringify({
      task: 'Capture in a linked worktree',
      label: 'Linked capture',
      plan_steps: [
        {
          text: 'Verify linked capture',
          label: 'Verify capture',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      touched_scope: [],
      non_goals: [],
    })
  );

for (const scope of ['personal', 'project'] as const)
  describe(scope, () => {
    it('registers on plan capture without changing shared identity or installation', async () => {
      const f = await worktree(scope);
      const shared = path.join(f.common, 'orcaops/registration.json');
      const mainBinding = path.join(f.common, 'orcaops/worktree.json');
      const before = await Promise.all([readFile(shared, 'utf8'), readFile(mainBinding, 'utf8')]);
      const result = await f.agent.runRaw(['capture', 'plan', '--no-llm', '--input', plan()]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(await readFile(f.configPath, 'utf8')).toBe(f.config);
      expect(await Promise.all([readFile(shared, 'utf8'), readFile(mainBinding, 'utf8')])).toEqual(
        before
      );
      expect(JSON.parse(await readFile(f.binding, 'utf8')).worktree_id).not.toBe(
        JSON.parse(before[1]!).worktree_id
      );
    });
    it('registers ordinary init without installation changes and previews without writes', async () => {
      const f = await worktree(scope);
      const preview = await f.agent.runRaw(['init', '--dry-run', '--json']);
      expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        registration_only: true,
        dry_run: true,
        project_id: f.authority.projectId,
      });
      await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await f.agent.runRaw(['init', '--json']);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        registration_only: true,
        project_id_minted: false,
      });
      expect(await readFile(f.configPath, 'utf8')).toBe(f.config);
      if (scope === 'project')
        await expect(readFile(path.join(f.common, 'orcaops/config.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    });
  });
it('ordinary init registers a worktree with no project configuration without inventing personal scope', async () => {
  const f = await worktree('project');
  await rm(f.configPath);
  const result = await f.agent.runRaw(['init', '--json']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).registration_only).toBe(true);
  await expect(readFile(path.join(f.common, 'orcaops/config.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('keeps passive capture resolution read-only and adopts one concurrent registration', async () => {
  const f = await worktree('personal');
  await expect(
    runInInvocationContext({ cwd: f.linked, env: f.env }, () => resolveDatabaseCaptureContext())
  ).rejects.toMatchObject({ code: 'IDENTITY_RECOVERY_REQUIRED' });
  await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' });
  const input = { cwd: f.linked, root: f.root, projectId: f.authority.projectId, secretAllow: [] };
  await Promise.all([
    registerMissingDatabaseWorktree(input),
    registerMissingDatabaseWorktree(input),
  ]);
  const before = await readFile(f.binding, 'utf8');
  expect(await registerMissingDatabaseWorktree(input)).toBe(null);
  expect(await readFile(f.binding, 'utf8')).toBe(before);
});
it('registers for checkout but preserves explicit ownership handoff after binding loss', async () => {
  const f = await worktree('personal');
  const captured = await f.agent.runRaw(['capture', 'plan', '--no-llm', '--input', plan()]);
  expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
  const id = JSON.parse(captured.stdout).artifact_id;
  await rm(f.binding);
  const refused = await f.agent.runRaw(['checkout', id, '--json']);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).error.code).toBe('EXECUTION_BOUND_ELSEWHERE');
  const handoff = await f.agent.runRaw(['checkout', id, '--handoff', '--json']);
  expect(handoff.exitCode, handoff.stdout + handoff.stderr).toBe(0);
  const stepId = readProjectArtifact(f.writer, id)!.thread.plan!.plan_steps[0]!.step_id;
  const opened = await f.agent.runRaw([
    'capture',
    'checkpoint',
    'open',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify({ artifact_id: id, declared_step_ids: [stepId] })),
  ]);
  expect(opened.exitCode, opened.stdout + opened.stderr).toBe(0);
  const abandoned = await f.agent.runRaw([
    'capture',
    'checkpoint',
    'abandon',
    '--input',
    inputFile(
      JSON.stringify({
        artifact_id: id,
        n: JSON.parse(opened.stdout).n,
        reason: 'Registration workflow verified',
      })
    ),
  ]);
  expect(abandoned.exitCode, abandoned.stdout + abandoned.stderr).toBe(0);
  const summary = await f.agent.runRaw([
    'capture',
    'summary',
    '--input',
    inputFile(JSON.stringify({ artifact_id: id, outcome: 'Verified registration and handoff' })),
  ]);
  expect(summary.exitCode, summary.stdout + summary.stderr).toBe(0);
});
it('doctor names registration repair and only publishes it on apply', async () => {
  const f = await worktree('personal');
  for (const args of [
    ['doctor', '--json'],
    ['doctor', '--fix', '--dry-run', '--json'],
  ]) {
    const result = await f.agent.runRaw(args);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'worktree-registration',
        details: expect.arrayContaining([expect.stringContaining('orcaops doctor --fix')]),
      })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'worktree-registration',
        details: expect.arrayContaining([
          expect.stringContaining('further history checks are skipped'),
        ]),
      })
    );
    await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const result = await f.agent.runRaw(['doctor', '--fix', '--json']);
  expect(JSON.parse(result.stdout).checks).toContainEqual(
    expect.objectContaining({ name: 'worktree-registration', status: 'pass' })
  );
  expect(JSON.parse(await readFile(f.binding, 'utf8')).worktree_id).toBeTruthy();
});

it('refuses malformed bindings and mismatched project authority without replacing them', async () => {
  const f = await worktree('personal');
  await mkdir(path.dirname(f.binding), { recursive: true });
  await writeFile(f.binding, 'invalid registration');
  const input = { cwd: f.linked, root: f.root, projectId: f.authority.projectId, secretAllow: [] };
  await expect(registerMissingDatabaseWorktree(input)).rejects.toBeTruthy();
  expect(await readFile(f.binding, 'utf8')).toBe('invalid registration');
  await rm(f.binding);
  await expect(
    registerMissingDatabaseWorktree({
      ...input,
      expectedAuthority: {
        ...f.authority,
        storeInstanceId: '019f338d-4911-7fba-a93f-8cfd7e70193e',
      },
    })
  ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('non-plan capture registers the worktree before enforcing existing artifact ownership', async () => {
  const f = await worktree('personal');
  const id = await f.capture();
  const stepId = readProjectArtifact(f.writer, id)!.thread.plan!.plan_steps[0]!.step_id;
  const result = await f.agent.runRaw([
    'capture',
    'checkpoint',
    'open',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify({ artifact_id: id, declared_step_ids: [stepId] })),
  ]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe('EXECUTION_BOUND_ELSEWHERE');
  expect(JSON.parse(await readFile(f.binding, 'utf8')).worktree_id).toBeTruthy();
});

it('explains missing registration without ignoring an explicit installation request', async () => {
  const f = await worktree('personal');
  for (const json of [false, true]) {
    const result = await f.agent.runRaw(['init', '--with-hooks', ...(json ? ['--json'] : [])]);
    expect(result.exitCode).toBe(1);
    const message = json ? JSON.parse(result.stdout).error.message : result.stderr;
    expect(message).toContain('without installation flags');
    expect(message).toContain('orcaops doctor --fix');
    if (json) expect(JSON.parse(result.stdout).error.code).toBe('ALREADY_INITIALIZED');
    expect(await readFile(f.configPath, 'utf8')).toBe(f.config);
    await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(f.common, 'hooks/post-merge'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
});
