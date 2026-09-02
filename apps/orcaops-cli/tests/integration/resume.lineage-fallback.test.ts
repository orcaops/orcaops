import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

describe('orcaops resume — SHA-reachability fallback', () => {
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

  it('strict match: lineage_stale is false, lineage_branches is null', async () => {
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(plan.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(false);
    expect(r.artifact?.lineage_branches).toBeNull();
  });

  it('fallback: artifact captured on main is reachable from a sibling branch with same HEAD', async () => {
    const plan = await agent.capturePlan(
      { task: 'on main', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/sibling');
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(plan.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(true);
    expect(r.artifact?.lineage_branches).toEqual(['main']);
  });

  it('fallback: artifact captured on main is reachable from a descendant branch (additional commits)', async () => {
    const plan = await agent.capturePlan(
      { task: 'on main', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/ahead');
    await commitFile(repo.path, 'extra.ts', 'x\n', 'extra');
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(plan.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(true);
    expect(r.artifact?.lineage_branches).toEqual(['main']);
  });

  it('no fallback when --artifact is explicit (the picker is bypassed entirely)', async () => {
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/y');
    const r = await agent.resume({ artifact: plan.artifact_id });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(plan.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(false);
  });

  it('strict match wins over the fallback even when both would succeed', async () => {
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/x');
    const onFeat = await agent.capturePlan(
      { task: 'on feat', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await git.checkout('main');
    await agent.capturePlan(
      { task: 'on main', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await git.checkout('feat/x');
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(onFeat.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(false);
  });

  it('fallback prefers the most recent in-flight artifact when multiple are reachable', async () => {
    const a1 = await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: a1.artifact_id, outcome: 'done' });
    const a2 = await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/q');
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(a2.artifact_id);
    expect(r.artifact?.lineage_stale).toBe(true);
    expect(r.artifact?.lineage_branches).toEqual(['main']);
  });

  it('fallback returns resolved-empty when no artifact is reachable from current HEAD', async () => {
    await agent.capturePlan(
      { task: 'on main', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.raw(['checkout', '--orphan', 'feat/orphan']);
    await git.raw(['rm', '-rf', '.']).catch(() => undefined);
    await commitFile(repo.path, 'orphan-readme.md', 'orphan\n', 'orphan root');
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.resolution_via).toBe('no-active-artifacts');
    expect(r.artifact).toBeNull();
  });

  it('human output prepends a stale-lineage note pointing at orcaops lineage', async () => {
    await agent.capturePlan(
      { task: 'on main', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat/sib');
    const res = await agent.runRaw(['resume']);
    expect(res.stdout).toMatch(/SHA reachability/);
    expect(res.stdout).toMatch(/orcaops lineage/);
    expect(res.stdout).toMatch(/Recorded on: main/);
  });
});
