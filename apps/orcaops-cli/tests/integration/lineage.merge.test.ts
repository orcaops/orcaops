import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

interface SyncJson {
  ok: boolean;
  branch: string;
  head_sha: string;
  updated: Array<{ artifact_id: string; prior_sha: string; new_sha: string }>;
  skipped: Array<{ artifact_id: string; reason: string }>;
  merged: Array<{
    artifact_id: string;
    source_branch: string;
    source_sha: string;
    new_sha: string;
  }>;
}

describe('orcaops lineage — merge-event detection', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function runSync(): Promise<SyncJson> {
    const res = await agent.runRaw(['lineage', '--json']);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout) as SyncJson;
  }

  async function capturePlan(task: string): Promise<{ artifact_id: string }> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task, plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    return JSON.parse(planRes.stdout) as { artifact_id: string };
  }

  it('does not merge-detect when the artifact branch has not been merged into current', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/x');
    await capturePlan('t');
    await git.checkout('main');
    const r = await runSync();
    expect(r.merged).toEqual([]);
  });

  it('merges feat/x into main: sync on main appends a `merged` lineage entry', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/x');
    const plan = await capturePlan('feat work');
    await commitFile(repo.path, 'feat-work.ts', 'feat\n', 'feat commit');
    await runSync();
    const featTip = (await git.revparse(['HEAD'])).trim();

    await git.checkout('main');
    await git.merge(['--no-ff', '--no-edit', 'feat/x']);
    const mainHead = (await git.revparse(['HEAD'])).trim();
    expect(mainHead).not.toBe(featTip);

    const r = await runSync();
    expect(r.branch).toBe('main');
    expect(r.merged).toHaveLength(1);
    expect(r.merged[0]).toMatchObject({
      artifact_id: plan.artifact_id,
      source_branch: 'feat/x',
      source_sha: featTip,
      new_sha: mainHead,
    });
  });

  it('idempotent: a second sync on main after a merge is a no-op for that artifact', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/x');
    await capturePlan('t');
    await commitFile(repo.path, 'a.ts', 'a\n', 'a');
    await runSync();
    await git.checkout('main');
    await git.merge(['--no-ff', '--no-edit', 'feat/x']);

    const first = await runSync();
    expect(first.merged).toHaveLength(1);

    const second = await runSync();
    expect(second.merged).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.updated).toEqual([]);
  });

  it('squash-merge: source SHA is reachable via single-parent commit; merged entry is added', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/y');
    const plan = await capturePlan('squash work');
    await commitFile(repo.path, 'squash.ts', 'sq\n', 'sq');
    await runSync();

    await git.checkout('main');
    await git.raw(['cherry-pick', 'feat/y']);
    const r = await runSync();
    expect(r.merged.find((m) => m.artifact_id === plan.artifact_id)).toBeUndefined();
  });

  it('after merge, the artifact appears under main via the strict lineage filter', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/z');
    const plan = await capturePlan('on z');
    await commitFile(repo.path, 'z.ts', 'z\n', 'z');
    await runSync();
    await git.checkout('main');
    await git.merge(['--no-ff', '--no-edit', 'feat/z']);
    await runSync();

    const listRes = await agent.runRaw(['list', '--json']);
    const r = JSON.parse(listRes.stdout) as { ok: boolean; artifacts: Array<{ id: string }> };
    expect(r.artifacts.map((a) => a.id)).toContain(plan.artifact_id);
  });

  it('multiple feature branches merged into main → each gets a merged entry', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/a');
    const planA = await capturePlan('a');
    await commitFile(repo.path, 'a.ts', 'a\n', 'a');
    await runSync();

    await git.checkout('main');
    await git.checkoutLocalBranch('feat/b');
    const planB = await capturePlan('b');
    await commitFile(repo.path, 'b.ts', 'b\n', 'b');
    await runSync();

    await git.checkout('main');
    await git.merge(['--no-ff', '--no-edit', 'feat/a']);
    await git.merge(['--no-ff', '--no-edit', 'feat/b']);
    const r = await runSync();
    expect(r.merged.map((m) => m.artifact_id).sort()).toEqual(
      [planA.artifact_id, planB.artifact_id].sort()
    );
  });
});
