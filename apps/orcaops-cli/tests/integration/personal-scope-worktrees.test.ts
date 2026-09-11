import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLinkedWorktree,
  createTempRepo,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath, TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/** Personal configuration and canonical history across linked worktrees. */
describe('personal scope across git worktrees', () => {
  let main: TempRepo;
  let before: TempRepo;
  let globalRoot: string;
  const env = (): Record<string, string> => ({
    ORCAOPS_DISABLE_DRAIN: '1',
    ORCAOPS_GLOBAL_ROOT: globalRoot,
  });
  const agentIn = (cwd: string) => makeAgent({ cwd, env: env() });
  const absent = async (p: string): Promise<boolean> =>
    access(p).then(
      () => false,
      () => true
    );
  const gitStatus = (cwd: string): string =>
    execFileSync('git', ['status', '--porcelain'], { cwd }).toString().trim();

  beforeEach(async () => {
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-scope-global-'));
    main = await createTempRepo({ initialBranch: 'main' });
    before = await createLinkedWorktree(main.path, { branch: 'existed-before-init' });
  });
  afterEach(async () => {
    await before.cleanup();
    await main.cleanup();
    await rm(globalRoot, { recursive: true, force: true });
  });

  const planFor = (task: string): string =>
    inputFile(
      JSON.stringify({
        task,
        label: task,
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
      })
    );

  it('one init enables sibling reads while a writing worktree registers itself', async () => {
    const init = await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    expect(init.exitCode).toBe(0);
    const after = await createLinkedWorktree(main.path, { branch: 'created-after-init' });
    try {
      for (const wt of [before.path, after.path]) {
        // Same source, same projection, from every worktree.
        expect(await effectiveConfigPath(wt)).toBe(await effectiveConfigPath(main.path));
        const status = await agentIn(wt).runRaw(['status', '--json']);
        expect(status.exitCode, wt).toBe(0);
        expect(await absent(path.join(wt, '.orcaops')), wt).toBe(true);
        expect(gitStatus(wt), wt).toBe('');
      }

      // A worktree created after init carries no execution registration; the
      // first capture registers it rather than refusing.
      const plan = await agentIn(after.path).runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        planFor('work in the newer worktree'),
      ]);
      expect(plan.exitCode, `${plan.stdout}\n${plan.stderr}`).toBe(0);
      const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;
      expect(await absent(path.join(after.path, '.orcaops'))).toBe(true);
      expect(await absent(path.join(before.path, '.orcaops'))).toBe(true);
      expect(await absent(path.join(main.path, '.orcaops'))).toBe(true);
      const unresolvedList = await agentIn(before.path).runRaw([
        'list',
        '--scope',
        'worktree',
        '--json',
      ]);
      expect(JSON.parse(unresolvedList.stdout)).toMatchObject({
        error: { code: 'WORKTREE_SCOPE_UNAVAILABLE' },
      });
      const setupBefore = await agentIn(before.path).runRaw([
        'init',
        '--personal',
        '--force',
        '--no-llm',
        '--json',
      ]);
      expect(setupBefore.exitCode).toBe(0);
      const listBefore = JSON.parse(
        (await agentIn(before.path).runRaw(['list', '--scope', 'worktree', '--json'])).stdout
      ) as { results: unknown[] };
      expect(listBefore.results).toEqual([]);
      const listAfter = JSON.parse(
        (await agentIn(after.path).runRaw(['list', '--scope', 'worktree', '--json'])).stdout
      ) as { results: Array<{ id: string }> };
      expect(listAfter.results.map((row) => row.id)).toContain(artifactId);

      // One repository identity, so the global skills carry one ref.
      const manifest = JSON.parse(
        await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
      ) as { entries: Array<{ refs: string[] }> };
      for (const entry of manifest.entries) expect(entry.refs).toHaveLength(1);
    } finally {
      await after.cleanup();
    }
  });

  it('shares supported capture and redaction settings across worktrees', async () => {
    await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    const configPath = await effectiveConfigPath(main.path);
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...raw,
          capture: { exclude: ['vendor/**'] },
          redact: { allow: ['ghp_EXAMPLEnotasecret000000000000000000'] },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const setup = await agentIn(before.path).runRaw([
      'init',
      '--personal',
      '--force',
      '--no-llm',
      '--json',
    ]);
    expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);

    const plan = await agentIn(before.path).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      planFor('uses the shared custom paths'),
    ]);
    expect(plan.exitCode, `${plan.stdout}\n${plan.stderr}`).toBe(0);
    expect(await effectiveConfigPath(before.path)).toBe(configPath);
    const inherited = JSON.parse(
      await readFile(await effectiveConfigPath(before.path), 'utf8')
    ) as {
      capture: { exclude: string[] };
      redact: { allow: string[] };
    };
    expect(inherited.capture.exclude).toEqual(['vendor/**']);
    expect(inherited.redact.allow).toEqual(['ghp_EXAMPLEnotasecret000000000000000000']);
    expect(await absent(path.join(before.path, '.orcaops'))).toBe(true);
  });

  it('lets a branch with a project config win, and falls back when it is gone', async () => {
    await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    // A project config appears in the sibling (a branch checkout carrying one).
    await mkdir(path.join(before.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(before.path, '.orcaops', 'config.json'),
      JSON.stringify({
        schema_version: 6,
        install: { agents: ['codex'], scope: 'project' },
        naming: { prefix: 'proj' },
      }),
      'utf8'
    );
    expect(await effectiveConfigPath(before.path)).toBe(
      path.join(before.path, '.orcaops', 'config.json')
    );
    const doctor = JSON.parse((await agentIn(before.path).runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; summary: string; details?: string[] }>;
    };
    expect(doctor.checks.find((c) => c.name === 'init')?.summary).toContain('worktree config');
    const personalScope = doctor.checks.find((c) => c.name === 'personal-scope');
    expect(personalScope?.details?.join('\n')).toContain('live shared personal config remains');
    expect(personalScope?.details?.join('\n')).not.toContain('uninstalled personal residue');
    // Main still runs on the shared config.
    expect(await effectiveConfigPath(main.path)).toContain(path.join('.git', 'orcaops'));

    await rm(path.join(before.path, '.orcaops'), { recursive: true, force: true });
    expect(await effectiveConfigPath(before.path)).toBe(await effectiveConfigPath(main.path));
  });

  it('does not select personal history for an unrelated repository or fresh clone', async () => {
    await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    const unrelated = await createTempRepo({ initialBranch: 'main' });
    const cloneParent = await mkdtemp(path.join(tmpdir(), 'orcaops-scope-clone-'));
    try {
      const status = await agentIn(unrelated.path).runRaw(['status', '--json']);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        context: { issues: [] },
        history: { state: 'unavailable', projects: [] },
      });

      const clone = path.join(cloneParent, 'clone');
      execFileSync('git', ['clone', '-q', main.path, clone]);
      const cloned = await agentIn(clone).runRaw(['status', '--json']);
      expect(cloned.exitCode).toBe(0);
      expect(JSON.parse(cloned.stdout)).toMatchObject({
        context: { issues: [] },
        history: { state: 'unavailable', projects: [] },
      });
      expect(await absent(path.join(clone, '.git', 'orcaops', 'config.json'))).toBe(true);
    } finally {
      await unrelated.cleanup();
      await rm(cloneParent, { recursive: true, force: true });
    }
  });

  it('registers evaluator packs once for the repository and resolves relative packs per worktree', async () => {
    await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    const add = await agentIn(main.path).runRaw([
      'eval',
      'add-pack',
      TEST_PACK_ABS_PATH,
      '--yes',
      '--json',
    ]);
    expect(add.exitCode).toBe(0);
    const commonEvaluators = path.join(main.path, '.git', 'orcaops', 'evaluators.yaml');
    expect(await absent(commonEvaluators)).toBe(false);
    expect(await absent(path.join(main.path, '.orcaops', 'evaluators.yaml'))).toBe(true);

    // The sibling sees the registration without any setup of its own.
    const listed = JSON.parse(
      (await agentIn(before.path).runRaw(['eval', 'list', '--json'])).stdout
    ) as { evaluators?: Array<{ ref?: string; evaluator_ref?: string }>; ok: boolean };
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).toContain('test-pack/');

    // A RELATIVE pack is code in a checkout: present in main, absent in the
    // sibling, it must fail clearly there rather than resolve into `.git`.
    await cp(TEST_PACK_ABS_PATH, path.join(main.path, 'local-pack'), { recursive: true });
    await agentIn(main.path).runRaw(['eval', 'remove-pack', 'test-pack', '--json']);
    const addRelative = await agentIn(main.path).runRaw([
      'eval',
      'add-pack',
      './local-pack',
      '--yes',
      '--json',
    ]);
    expect(addRelative.exitCode).toBe(0);
    // Registered once, in the shared file, by its relative path.
    expect(await readFile(commonEvaluators, 'utf8')).toContain('local-pack');
    const mainList = JSON.parse(
      (await agentIn(main.path).runRaw(['eval', 'list', '--json'])).stdout
    ) as { evaluators: unknown[] };
    expect(mainList.evaluators.length).toBeGreaterThan(0);
    // In the sibling the path resolves from ITS root, where the pack is absent.
    const siblingList = await agentIn(before.path).runRaw(['eval', 'list', '--json']);
    expect(siblingList.stdout).toContain('local-pack');
    const siblingOut = JSON.parse(siblingList.stdout) as { evaluators?: unknown[] };
    expect(siblingOut.evaluators ?? []).toEqual([]);
  });

  it('uninstalling from any worktree silences hooks and retains canonical history', async () => {
    await agentIn(main.path).runRaw([
      'init',
      '--personal',
      '--session-hooks',
      '--no-llm',
      '--json',
    ]);
    const hook = (cwd: string) =>
      agentIn(cwd).runRaw(['hook', 'session-start', '--agent', 'claude-code', '--user']);
    expect((await hook(main.path)).stdout).not.toBe('');

    const uninstall = await agentIn(before.path).runRaw(['uninstall', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((await hook(main.path)).stdout).toBe('');
    expect((await hook(before.path)).stdout).toBe('');
    const status = await agentIn(main.path).runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      history: { state: 'available', complete: true },
    });
    const exclude = await readFile(path.join(main.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.orcaops/');
    expect(await absent(path.join(main.path, '.git', 'orcaops', 'personal-manifest.json'))).toBe(
      false
    );
    expect(await absent(path.join(main.path, '.git', 'orcaops', 'config.json'))).toBe(true);
    // Re-init is a fresh install and recovers the retained manifest.
    const again = await agentIn(before.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    expect(again.exitCode).toBe(0);
    expect((await hook(main.path)).stdout).toBe('');
  });

  it('a project sibling purge keeps personal data in another worktree hidden', async () => {
    await agentIn(main.path).runRaw(['init', '--personal', '--no-llm', '--json']);
    await mkdir(path.join(main.path, '.orcaops', 'local'), { recursive: true });
    await writeFile(path.join(main.path, '.orcaops', 'local', 'retained.txt'), 'retained\n');
    await mkdir(path.join(before.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(before.path, '.orcaops', 'config.json'),
      JSON.stringify({
        schema_version: 6,
        install: { agents: ['claude-code'], scope: 'project' },
      }),
      'utf8'
    );

    const uninstall = await agentIn(before.path).runRaw(['uninstall', '--purge-data', '--json']);

    expect(uninstall.exitCode).toBe(0);
    expect(await absent(path.join(main.path, '.orcaops', 'local', 'retained.txt'))).toBe(false);
    const exclude = await readFile(path.join(main.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.orcaops/');
    expect(gitStatus(main.path)).toBe('');
  });
});
