import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

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
 * The install-set flags and deterministic selection rules. The test
 * harness pipes stdout (non-TTY), so the interactive checklist is never reached and
 * every case below resolves deterministically through flags / the seed default.
 */
describe('orcaops init — install-set selection', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const installAgents = async (): Promise<string[]> => {
    const install = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
    ) as { install_agents: string[] };
    return install.install_agents;
  };

  it('default (no flags, non-interactive) installs only the default seed target', async () => {
    const res = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    // Detection NEVER widens a non-interactive install — deterministic regardless of
    // what is installed on the test machine.
    expect(await installAgents()).toEqual(['claude-code']);
  });

  it('names every installed agent surface in the human summary', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--no-llm',
      '--agents',
      'claude-code,codex',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Installed agent integration for claude-code, codex:');
    expect(res.stdout).toContain('.claude/skills/orcaops-*/SKILL.md');
    expect(res.stdout).toContain('.agents/skills/orcaops-*/SKILL.md');
  });

  it('init --force re-init PRESERVES ahead-stamped files (its --force gates re-init, not downgrade)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md', '--json']);
    const rel = '.claude/skills/orcaops-capture/SKILL.md';
    const abs = path.join(repo.path, rel);
    const aheadBytes = (await readFile(abs, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0');
    await (await import('node:fs/promises')).writeFile(abs, aheadBytes, 'utf8');

    const res = await agent.runRaw(['init', '--force', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    expect(await readFile(abs, 'utf8')).toBe(aheadBytes);

    const out = JSON.parse(res.stdout) as {
      preserved_ahead: { path: string; stamped_version: string }[];
      warnings: string[];
    };
    expect(out.preserved_ahead).toEqual([{ path: rel, stamped_version: '99.0.0' }]);
    expect(out.warnings.join('\n')).toMatch(/NEWER orcaops/);
  });

  it('--agents <csv> installs the whole set without persisting capture identity', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'claude-code,codex',
      '--no-llm',
      '--json',
      '--agents-md',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { install_agents: string[]; agent_tool: string };
    expect(out.install_agents).toEqual(['claude-code', 'codex']);
    expect(await installAgents()).toEqual(['claude-code', 'codex']);
    // Both skill trees materialized.
    expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    expect(await exists(path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    // Block injected once into the union.
    const md = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(md.match(/<!-- orcaops:start/g) ?? []).toHaveLength(1);
  });

  it('repeatable --install-agent accumulates the set', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--install-agent',
      'claude-code',
      '--install-agent',
      'codex',
      '--no-llm',
      '--json',
      '--agents-md',
    ]);
    expect(await installAgents()).toEqual(['claude-code', 'codex']);
  });

  it('--agents codex seeds the install set to [codex]', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'codex', '--no-llm', '--json']);
    expect(await installAgents()).toEqual(['codex']);
  });

  it("an explicitly empty --agents '' installs nothing (manual mode)", async () => {
    await agent.runRaw(['init', '--scope', 'project', '--agents', '', '--no-llm', '--json']);
    expect(await installAgents()).toEqual([]);
  });

  it('--agents persists the install set with no static capture identity', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'codex',
      '--no-llm',
      '--json',
    ]);
    const out = JSON.parse(res.stdout) as { agent_tool: string; install_agents: string[] };
    expect(out.install_agents).toEqual(['codex']);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    // Attribution is runtime-resolved per invocation — init never writes an
    // agent identity.
    expect('agent' in cfg).toBe(false);
    expect(cfg.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('--yes reproduces the non-interactive default', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--no-llm', '--json']);
    expect(await installAgents()).toEqual(['claude-code']);
  });

  it('rejects an unsupported install agent', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'bogus-agent',
      '--no-llm',
      '--json',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/not a supported install target/);
  });

  it('installs skills, per-agent commands, and one block for the aider-desk, opencode, and cursor agents', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'aider-desk,opencode,cursor',
      '--no-llm',
      '--json',
      '--agents-md',
    ]);
    expect(res.exitCode).toBe(0);
    // Canonical SUPPORTED_AGENT_IDS order regardless of the flag order.
    expect(await installAgents()).toEqual(['cursor', 'opencode', 'aider-desk']);
    // cursor + opencode share the universal skills tree; aider-desk has its own.
    expect(await exists(path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    expect(await exists(path.join(repo.path, '.aider-desk/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    // Per-agent command layouts: cursor flat body-only; opencode/aider-desk nested.
    const cursorCmd = await readFile(
      path.join(repo.path, '.cursor/commands/orcaops-status.md'),
      'utf8'
    );
    expect(cursorCmd).not.toMatch(/^---/);
    expect(cursorCmd).toMatch(/generatedBy:\s*"orcaops@/);
    const openCodeCmd = await readFile(
      path.join(repo.path, '.opencode/commands/orcaops/status.md'),
      'utf8'
    );
    expect(openCodeCmd).toMatch(/^---\ndescription: /);
    expect(await exists(path.join(repo.path, '.aider-desk/commands/orcaops/status.md'))).toBe(true);
    // Block injected once into the shared AGENTS.md union.
    const md = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(md.match(/<!-- orcaops:start/g) ?? []).toHaveLength(1);
    // No static capture identity is persisted.
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect('agent' in cfg).toBe(false);
  });

  it('--agents aider-desk writes a config that stays parseable on the next run', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'aider-desk',
      '--no-llm',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    // No identity to round-trip — the install id lives
    // only in install.agents, where 'aider-desk' is valid as-is.
    expect('agent' in cfg).toBe(false);
    expect((cfg.install as { agents: string[] }).agents).toEqual(['aider-desk']);
    const reread = await agent.runRaw(['status', '--json']);
    expect(reread.exitCode).toBe(0);
  });

  it('--agents aider-desk seeds the install set to [aider-desk]', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'aider-desk',
      '--no-llm',
      '--json',
    ]);
    expect(await installAgents()).toEqual(['aider-desk']);
  });

  it('installs github-copilot skills-only: universal tree + block, zero command files', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'github-copilot',
      '--no-llm',
      '--json',
      '--agents-md',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await installAgents()).toEqual(['github-copilot']);
    // Copilot reads the universal tree; skills ARE its slash commands, so no
    // command dir of any kind is materialized (and never a .github/ tree).
    expect(await exists(path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
    expect(await exists(path.join(repo.path, '.github'))).toBe(false);
    const md = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(md.match(/<!-- orcaops:start/g) ?? []).toHaveLength(1);
    // No static capture identity is persisted; the install id stands alone.
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect('agent' in cfg).toBe(false);
    const reread = await agent.runRaw(['status', '--json']);
    expect(reread.exitCode).toBe(0);
  });

  it('--agents github-copilot seeds the install set to [github-copilot]', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'github-copilot',
      '--no-llm',
      '--json',
    ]);
    expect(await installAgents()).toEqual(['github-copilot']);
  });

  it('--agents opencode seeds the install set to [opencode]', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'opencode',
      '--no-llm',
      '--json',
    ]);
    expect(await installAgents()).toEqual(['opencode']);
  });
});
