import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The install set vs. the active capture agent split.
 *
 * The flag surface is covered in `init-agents.test.ts`; here the
 * install set is written to config.json directly (detection consts are frozen at
 * module load, so a test can't steer them via env), which is exactly how the swept
 * install pipeline reads the set.
 */
describe('multi-agent install (config.install.agents)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const setInstallAgents = async (agents: string[]): Promise<void> => {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      install: { agents: string[] };
    };
    cfg.install = { agents };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  };

  it('installs skills for EVERY install agent and injects the block ONCE into the union', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json', '--agents-md']);
    await setInstallAgents(['claude-code', 'codex']);

    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(0);

    // Both agents' skill trees are materialized (claude-code → .claude/skills,
    // codex → .agents/skills).
    expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    expect(await exists(path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );

    // The managed block is injected ONCE into the deduped union — claude-code and
    // codex both target AGENTS.md, so a per-agent loop would double-inject.
    const agentsMd = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(agentsMd.match(/<!-- orcaops:start/g) ?? []).toHaveLength(1);

    // The committed manifest records the canonical install set.
    const install = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
    ) as { install_agents: string[] };
    expect(install.install_agents).toEqual(['claude-code', 'codex']);

    // doctor reports health for BOTH agents (not just one).
    const doc = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(doc.stdout) as {
      checks: { name: string; status: string; summary: string }[];
    };
    const skillsCheck = report.checks.find((c) => c.name === 'agent-skills');
    expect(skillsCheck?.status).toBe('pass');
    expect(skillsCheck?.summary).toContain('claude-code');
    expect(skillsCheck?.summary).toContain('codex');
  });

  it('per-agent frontmatter is preserved: codex omits the tags line claude-code carries', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    await setInstallAgents(['claude-code', 'codex']);
    await agent.runRaw(['update', '--json']);

    const claudeSkill = await readFile(
      path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    const codexSkill = await readFile(
      path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    // claude-code renders a `tags:` frontmatter line; codex (skillFrontmatterTags:false)
    // does not. Each adapter rendered with its own renderer in the per-agent loop.
    expect(claudeSkill).toMatch(/^tags:/m);
    expect(codexSkill).not.toMatch(/^tags:/m);
  });

  it('universal-dir sharing: five agents write .agents/skills once, byte-equal to codex-only', async () => {
    // Baseline: codex-only render of the shared tree.
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'codex', '--no-llm', '--json']);
    const soloBytes = await readFile(
      path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );

    // Widen to every supported universal-dir agent and re-generate.
    await setInstallAgents(['codex', 'cursor', 'opencode', 'github-copilot', 'antigravity-cli']);
    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(0);

    // The shared tree is byte-identical regardless of how many agents share it
    // (first-wins dedupe + the adapters shared-dir parity invariant).
    const sharedBytes = await readFile(
      path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    expect(sharedBytes).toBe(soloBytes);

    // install.json: each shared path appears ONCE while install_agents lists all five.
    const install = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
    ) as { install_agents: string[]; entries: Array<{ path: string }> };
    expect(install.install_agents).toEqual([
      'codex',
      'cursor',
      'opencode',
      'github-copilot',
      'antigravity-cli',
    ]);
    const capturePaths = install.entries.filter(
      (e) => e.path === '.agents/skills/orcaops-capture/SKILL.md'
    );
    expect(capturePaths).toHaveLength(1);
    // Cursor + opencode still get their own (non-shared) command surfaces;
    // github-copilot + antigravity-cli are skills-only and add no other files.
    expect(await exists(path.join(repo.path, '.cursor/commands/orcaops-status.md'))).toBe(true);
    expect(await exists(path.join(repo.path, '.opencode/commands/orcaops/status.md'))).toBe(true);
    expect(await exists(path.join(repo.path, '.github'))).toBe(false);
  });

  it('IDENTITY GUARD: capture stamps the single invoking agent, never the install set', async () => {
    // Widen the INSTALL set with claude-code FIRST. Attribution is runtime-resolved
    // (flag > env > ambient > 'other') — a capture that wrongly read install.agents[0]
    // would stamp claude-code. This proves capture stamps the actual invoker
    // (capture/plan.ts reads ctx.invokingAgent) and never the install set.
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'codex', '--no-llm', '--json']);
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      install: { agents: string[] };
    };
    cfg.install = { agents: ['claude-code', 'codex'] };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--invoked-by-agent',
      'codex',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'identity guard slice',
          label: 'identity guard slice',
          plan_steps: [{ text: 'do the work', label: 'do the work' }],
        })
      ),
    ]);
    expect(planRes.exitCode).toBe(0);
    const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

    const show = await agent.runRaw(['show', artifactId, '--json']);
    expect(show.exitCode).toBe(0);
    const plan = (JSON.parse(show.stdout) as { artifact: { plan: { agent: unknown } } }).artifact
      .plan;
    expect(typeof plan.agent).toBe('string'); // a single value, never an array
    expect(plan.agent).toBe('codex'); // the invoking agent, NOT install.agents[0] (claude-code)
  });
});
