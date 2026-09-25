import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('init human summary', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('describes llm.tool none as disabled rather than missing from PATH', async () => {
    const res = await agent.runRaw(['init', '--scope', 'project', '--yes', '--no-llm']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('found on PATH');
    expect(res.stdout).toContain('LLM tool: none');
    expect(res.stdout).toContain('deterministic-only');
  });

  it('names the skill directories with the configured prefix', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--prefix',
      'oo',
      '--yes',
      '--no-llm',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('.claude/skills/oo-*/SKILL.md');
    expect(res.stdout).not.toContain('orcaops-*');
  });

  it('does not report the config or bootstrap section as written when --force changes nothing', async () => {
    const first = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--no-llm',
      '--agents-md',
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('.orcaops/config.json');
    expect(first.stdout).toContain('Bootstrap section written to');
    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['commit', '-q', '-m', 'orcaops init'], { cwd: repo.path });

    const again = await agent.runRaw(['init', '--force', '--yes', '--no-llm', '--json']);
    expect(again.exitCode).toBe(0);
    const result = JSON.parse(again.stdout) as {
      created: string[];
      agents_md: { path: string; action: string }[];
    };
    expect(result.created).not.toContain('.orcaops/config.json');
    expect(result.agents_md.filter((m) => m.action !== 'unchanged')).toEqual([]);

    const human = await agent.runRaw(['init', '--force', '--yes', '--no-llm']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).not.toContain('Created:');
    expect(human.stdout).not.toContain('Bootstrap section written to');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo.path }).toString()).toBe('');
  });
});
