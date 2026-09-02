import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface InitOk {
  ok: true;
  dry_run: boolean;
  created: string[];
  agent_skills_installed: string[];
  git_hooks: Array<{ path: string; action: string }>;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe('orcaops init --dry-run', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('plans the full change set but writes NOTHING to disk', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--dry-run',
      '--no-llm',
      '--with-hooks',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;

    // The plan reports exactly what a real init would do...
    expect(r.dry_run).toBe(true);
    expect(r.created).toContain('.orcaops/config.json');
    expect(r.agent_skills_installed.length).toBeGreaterThan(0);
    expect(r.git_hooks.map((h) => h.action)).toEqual(['created', 'created']);

    // ...but the worktree is untouched.
    expect(await exists(path.join(repo.path, '.orcaops'))).toBe(false);
    expect(await exists(path.join(repo.path, '.claude', 'skills'))).toBe(false);
    expect(await exists(path.join(repo.path, 'AGENTS.md'))).toBe(false);
    expect(await exists(path.join(repo.path, '.git', 'hooks', 'post-merge'))).toBe(false);
    expect(await exists(path.join(repo.path, '.git', 'orcaops', 'locks'))).toBe(false);
  });

  it('a real init after a dry-run actually writes the files', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--dry-run', '--no-llm', '--json']);
    expect(await exists(path.join(repo.path, '.orcaops', 'config.json'))).toBe(false);

    const res = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.dry_run).toBe(false);
    expect(await exists(path.join(repo.path, '.orcaops', 'config.json'))).toBe(true);
    expect(await exists(path.join(repo.path, '.claude', 'skills'))).toBe(true);
  });
});
