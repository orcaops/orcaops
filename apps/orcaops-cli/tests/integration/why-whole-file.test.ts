import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, gitClient, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface WholeFileMatch {
  artifact_id: string;
  branch: string;
  checkpoint_n: number;
  checkpoint_summary: string;
}

interface WholeFileJson {
  mode: 'whole-file';
  line: null;
  best: WholeFileMatch | null;
  all: WholeFileMatch[];
  hint?: string;
}

describe('orcaops why — whole-file history', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns every checkpoint by default and expands the same ordered history', async () => {
    const git = gitClient(repo.path);
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(
      path.join(repo.path, 'src', 'rollout-parser.ts'),
      'export function discover() {\n  return ["one", "two", "three"];\n}\n',
      'utf8'
    );
    await git.add('src/rollout-parser.ts');
    await git.commit('add rollout parser', { '--allow-empty': null });

    const plan = await agent.capturePlan(
      {
        task: 'evolve rollout parsing',
        label: 'evolve rollout parsing',
        plan_steps: [
          { text: 'extract rollout discovery', label: 'extract locator' },
          { text: 'rename parser identity', label: 'rename parser' },
        ],
        touched_scope: [],
      },
      { noLlm: true }
    );

    const first = await agent.captureCheckpointOpen(
      {
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    await writeFile(
      path.join(repo.path, 'src', 'rollout-parser.ts'),
      'export { locateRollouts as discover } from "./locator.js";\n',
      'utf8'
    );
    await writeFile(
      path.join(repo.path, 'src', 'locator.ts'),
      'export function locateRollouts() { return ["one", "two", "three"]; }\n',
      'utf8'
    );
    await git.add(['src/rollout-parser.ts', 'src/locator.ts']);
    await git.commit('extract rollout locator', { '--allow-empty': null });
    const firstClose = await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: first.n,
        summary: 'Extracted rollout discovery into the shared locator',
        files_changed: ['src/rollout-parser.ts', 'src/locator.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
        decisions: [
          {
            decision: 'share rollout location',
            reason: 'multiple consumers need the same bounded discovery',
            alternatives_considered: [
              { option: 'duplicate discovery', rejected_because: 'the implementations drift' },
            ],
          },
        ],
        verification: [{ command: 'test fixture', exit_code: 0 }],
      },
      { noLlm: true }
    );
    expect(firstClose.ok).toBe(true);

    const second = await agent.captureCheckpointOpen(
      {
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.plan_steps[1].step_id],
      },
      { noLlm: true }
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    await writeFile(
      path.join(repo.path, 'src', 'rollout-parser.ts'),
      'export { locateRollouts as parseRollouts } from "./locator.js";\n',
      'utf8'
    );
    await git.add('src/rollout-parser.ts');
    await git.commit('rename parser identity', { '--allow-empty': null });
    const secondClose = await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: second.n,
        summary: 'Renamed the parser identity',
        files_changed: ['src/rollout-parser.ts'],
        completed_step_ids: [plan.plan_steps[1].step_id],
        verification: [{ command: 'test fixture', exit_code: 0 }],
      },
      { noLlm: true }
    );
    expect(secondClose.ok).toBe(true);

    const defaultJsonResult = await agent.runRaw(['why', 'src/rollout-parser.ts', '--json']);
    expect(defaultJsonResult.exitCode).toBe(0);
    const defaultJson = JSON.parse(defaultJsonResult.stdout) as WholeFileJson;
    expect(defaultJson).toMatchObject({ mode: 'whole-file', line: null });
    expect(defaultJson.all.map((match) => match.checkpoint_n)).toEqual([2, 1]);
    expect(defaultJson.best).toEqual(defaultJson.all[0]);
    expect(defaultJson.all[1].checkpoint_summary).toContain('Extracted rollout discovery');

    const explicitAll = JSON.parse(
      (await agent.runRaw(['why', 'src/rollout-parser.ts', '--all', '--json'])).stdout
    ) as WholeFileJson;
    expect(explicitAll.all).toEqual(defaultJson.all);

    const compact = await agent.runRaw(['why', 'src/rollout-parser.ts']);
    expect(compact.exitCode).toBe(0);
    const compactRecords = compact.stdout.split('\n').filter((line) => line.includes(' artifact='));
    expect(compactRecords).toHaveLength(defaultJson.all.length);
    expect(compactRecords[0]).toContain('#2');
    expect(compactRecords[1]).toContain('#1');
    expect(compactRecords[1]).toContain('Extracted rollout discovery');
    for (const [index, match] of defaultJson.all.entries()) {
      expect(compactRecords[index]).toContain(`#${match.checkpoint_n} [${match.branch}]`);
      expect(compactRecords[index]).toContain(`artifact=${match.artifact_id}`);
    }
    expect(compact.stdout).not.toContain('more claiming checkpoints');
    expect(compact.stdout).not.toContain('** best match **');
    expect(compact.stdout).not.toContain('confidence:');

    const expanded = await agent.runRaw(['why', 'src/rollout-parser.ts', '--all']);
    expect(expanded.exitCode).toBe(0);
    expect(expanded.stdout.indexOf('checkpoint: #2')).toBeLessThan(
      expanded.stdout.indexOf('checkpoint: #1')
    );
    expect(expanded.stdout).toContain('decision (cp 1): share rollout location');
    expect(expanded.stdout).toContain(
      'considered duplicate discovery — rejected because the implementations drift'
    );
    expect(expanded.stdout).toContain('context:');
    expect(expanded.stdout).not.toContain('confidence:');
  });

  it('includes claiming checkpoints across branches unless --branch restricts them', async () => {
    const git = gitClient(repo.path);
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'shared.ts'), 'export const shared = 1;\n', 'utf8');
    await git.add('src/shared.ts');
    await git.commit('add shared module', { '--allow-empty': null });

    const mainPlan = await agent.capturePlan(
      {
        task: 'main branch work',
        label: 'main branch work',
        plan_steps: [{ text: 'touch shared on main', label: 'main touch' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: mainPlan.artifact_id,
        summary: 'main branch checkpoint',
        files_changed: ['src/shared.ts'],
        completed_step_ids: [mainPlan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );

    await git.checkoutBranch('feat/x', 'main');
    const featurePlan = await agent.capturePlan(
      {
        task: 'feature branch work',
        label: 'feature branch work',
        plan_steps: [{ text: 'touch shared on feature', label: 'feature touch' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: featurePlan.artifact_id,
        summary: 'feature branch checkpoint',
        files_changed: ['src/shared.ts'],
        completed_step_ids: [featurePlan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );

    const allBranches = JSON.parse(
      (await agent.runRaw(['why', 'src/shared.ts', '--json'])).stdout
    ) as WholeFileJson;
    expect(allBranches.all.map((match) => match.branch).sort()).toEqual(['feat/x', 'main']);

    const human = await agent.runRaw(['why', 'src/shared.ts']);
    expect(human.stdout).toContain('[feat/x]');
    expect(human.stdout).toContain('[main]');

    const mainOnly = JSON.parse(
      (await agent.runRaw(['why', 'src/shared.ts', '--branch', 'main', '--json'])).stdout
    ) as WholeFileJson;
    expect(mainOnly.all).toHaveLength(1);
    expect(mainOnly.all[0]).toMatchObject({
      artifact_id: mainPlan.artifact_id,
      branch: 'main',
    });
  });

  it('returns an empty complete history and the attribution hint on a miss', async () => {
    await writeFile(path.join(repo.path, 'orphan.ts'), 'export const orphan = 1;\n', 'utf8');
    const jsonResult = await agent.runRaw(['why', 'orphan.ts', '--json']);
    expect(jsonResult.exitCode).toBe(0);
    const json = JSON.parse(jsonResult.stdout) as WholeFileJson;
    expect(json).toMatchObject({ mode: 'whole-file', line: null, best: null, all: [] });
    expect(json.hint).toContain('segment-attributed');

    const human = await agent.runRaw(['why', 'orphan.ts']);
    expect(human.stdout).toContain('no checkpoint claimed this file');
    expect(human.stdout).toContain('segment-attributed');
  });
});
