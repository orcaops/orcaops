import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `scratch-checkouts` doctor check: scratch checkouts are
 * detached worktrees under the disposable checkouts cache root; deleting one
 * with `rm -rf` (as the checkout output explicitly allows) leaves a stale
 * registration in the repo's common dir until `git worktree prune`. The check
 * warns on exactly those — scoped to paths under checkoutsRoot so the user's
 * own worktrees are never flagged.
 */

interface DoctorReport {
  ok: true;
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; details?: string[] }>;
}

describe('orcaops doctor — scratch-checkouts', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let cacheHome: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    cacheHome = await mkdtemp(path.join(tmpdir(), 'orcaops-scratch-doctor-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', XDG_CACHE_HOME: cacheHome },
    });
    await agent.runRaw(['init', '--json', '--no-llm']);
    await commitFile(repo.path, 'a.ts', 'export const a = 1;\n', 'seed');
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(cacheHome, { recursive: true, force: true });
  });

  async function doctorCheck(name: string): Promise<DoctorReport['checks'][number]> {
    const res = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(res.stdout) as DoctorReport;
    const check = report.checks.find((c) => c.name === name);
    if (!check) throw new Error(`no "${name}" check in doctor report`);
    return check;
  }

  it('passes on a repo with no scratch checkouts', async () => {
    const check = await doctorCheck('scratch-checkouts');
    expect(check.status).toBe('pass');
  });

  it('warns on a registration whose checkout dir was rm -rf-ed, with the prune hint', async () => {
    // Materialize a worktree exactly where `snapshots checkout` would put one,
    // then delete the dir the way the checkout output says is fine.
    const checkoutDir = path.join(cacheHome, 'orcaops', 'checkouts', 'fixture-cp1-close-0001');
    execFileSync('git', ['worktree', 'add', '--detach', checkoutDir, 'HEAD'], { cwd: repo.path });
    await rm(checkoutDir, { recursive: true, force: true });

    const check = await doctorCheck('scratch-checkouts');
    expect(check.status).toBe('warn');
    expect(check.details?.join('\n')).toContain(checkoutDir);
    expect(check.details?.join('\n')).toContain('git worktree prune');

    // A live (registered, present) checkout is normal — after pruning the
    // stale one, the check passes again.
    execFileSync('git', ['worktree', 'prune'], { cwd: repo.path });
    const after = await doctorCheck('scratch-checkouts');
    expect(after.status).toBe('pass');
  });
});
