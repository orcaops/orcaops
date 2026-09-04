import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { planInstallMutations } from '../../src/lib/install-plan.js';
import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

vi.mock('../../src/lib/install-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/install-plan.js')>();
  return { ...actual, planInstallMutations: vi.fn(actual.planInstallMutations) };
});

interface DoctorReport {
  ok: true;
  overall: 'pass' | 'warn' | 'fail';
  orcaops_version: string;
  repo_root: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    summary: string;
    details?: string[];
  }>;
}

function findCheck(report: DoctorReport, name: string): DoctorReport['checks'][number] {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`No check named "${name}" in report`);
  return c;
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `doctor --fix`. Repair routes through the shared planInstallMutations
 * mutation path (NOT raw force:true writers), honors bootstrap=manual (repairs
 * skills/commands but never re-adds the block), and preserves current-stamp user
 * edits (force:false). After applying, the install checks are re-run so the report
 * reflects the repair.
 */
describe('orcaops doctor --fix', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-doctor-fix' } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('repairs a stale skill stamp and seeds existing history', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      original.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-fix'),
      'utf8'
    );

    // Sanity: plain doctor warns on the stale stamp.
    const before = await agent.runRaw(['doctor', '--json']);
    expect(findCheck(JSON.parse(before.stdout) as DoctorReport, 'agent-skills').status).toBe(
      'warn'
    );

    // --fix repairs and re-runs both the install and seed checks.
    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(r.overall).toBe('pass');
    expect(findCheck(r, 'agent-skills').status).toBe('pass');
    expect(findCheck(r, 'seed').status).toBe('pass');
    const fix = findCheck(r, 'fix');
    expect(fix.summary).toMatch(/repaired \d+ file/);
    expect(fix.summary).toContain('resumed `orcaops seed --yes`');

    const repaired = await readFile(skillPath, 'utf8');
    expect(repaired).not.toContain('0.0.0-stale-fix');
    expect(repaired).toContain(`orcaops@${r.orcaops_version}`);
  });

  it('leaves an AHEAD skill byte-identical and keeps warning (a behind CLI is not "fixed")', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    const aheadBytes = original.replace(/orcaops@[^"]+/, 'orcaops@99.0.0');
    await writeFile(skillPath, aheadBytes, 'utf8');

    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(await readFile(skillPath, 'utf8')).toBe(aheadBytes);
    const check = findCheck(r, 'agent-skills');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/newer-than-CLI/);
  });

  it('repairs a genuinely STALE skill alongside an AHEAD one — the guard discriminates', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const stalePath = path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md');
    const aheadPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    await writeFile(
      stalePath,
      (await readFile(stalePath, 'utf8')).replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-mix'),
      'utf8'
    );
    const aheadBytes = (await readFile(aheadPath, 'utf8')).replace(
      /orcaops@[^"]+/,
      'orcaops@99.0.0'
    );
    await writeFile(aheadPath, aheadBytes, 'utf8');

    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(await readFile(stalePath, 'utf8')).toContain(`orcaops@${r.orcaops_version}`);
    expect(await readFile(aheadPath, 'utf8')).toBe(aheadBytes);
  });

  it('refreshes a stale SECOND agent under a multi-agent install set', async () => {
    // Install BOTH agents, then stale only codex's skill — proves the --fix sweep
    // iterates config.install.agents, not just the primary.
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'claude-code,codex', '--no-llm']);
    const codexSkill = path.join(repo.path, '.agents', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(codexSkill, 'utf8');
    await writeFile(
      codexSkill,
      original.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-codex'),
      'utf8'
    );

    // Plain doctor warns on the stale second-agent skill.
    const before = await agent.runRaw(['doctor', '--json']);
    expect(findCheck(JSON.parse(before.stdout) as DoctorReport, 'agent-skills').status).toBe(
      'warn'
    );

    // --fix repairs the SECOND agent → green, refreshed to current.
    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(findCheck(r, 'agent-skills').status).toBe('pass');
    const repaired = await readFile(codexSkill, 'utf8');
    expect(repaired).not.toContain('0.0.0-stale-codex');
    expect(repaired).toContain(`orcaops@${r.orcaops_version}`);
  });

  it('restores a missing skill file', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md');
    await rm(skillPath);

    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(findCheck(r, 'agent-skills').status).toBe('pass');
    expect(await readOrNull(skillPath)).not.toBeNull();
  });

  it('under bootstrap=manual: repairs skills but never re-adds the instruction block', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--no-agents-md']); // bootstrap=manual
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    // No managed block after a manual init.
    const beforeBlock = await readOrNull(agentsPath);
    expect(beforeBlock === null || !beforeBlock.includes('orcaops:start')).toBe(true);

    // Stale a skill so --fix has real work to do.
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-digest', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      original.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-manual'),
      'utf8'
    );

    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    // Skill repaired …
    expect(findCheck(r, 'agent-skills').status).toBe('pass');
    expect(await readFile(skillPath, 'utf8')).not.toContain('0.0.0-stale-manual');
    // … but the block was NOT re-added.
    const afterBlock = await readOrNull(agentsPath);
    expect(afterBlock === null || !afterBlock.includes('orcaops:start')).toBe(true);
    // And the agents-md check stays suppressed (manual).
    expect(findCheck(r, 'agents-md').summary).toMatch(/bootstrap=manual/);
  });

  it('preserves a current-stamp user-edited skill (force:false)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    // Edit the BODY but keep the current stamp → the generator treats it as
    // unchanged (stamp matches), so --fix must not clobber the edit.
    const edited = `${original}\n<!-- user note: do not clobber -->\n`;
    await writeFile(skillPath, edited, 'utf8');

    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    expect(await readFile(skillPath, 'utf8')).toContain('user note: do not clobber');
  });

  it('seeds root-only mechanical history', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const after = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(after.exitCode).toBe(0);
    const r = JSON.parse(after.stdout) as DoctorReport;
    expect(r.overall).toBe('pass');
    expect(findCheck(r, 'fix').summary).toContain('resumed `orcaops seed --yes`');
    expect(findCheck(r, 'seed').status).toBe('pass');
  });

  it('preserves matching user gitignore lines across update, doctor repair, and uninstall', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const gitignorePath = path.join(repo.path, '.gitignore');
    const userLine = '.orcaops/cache/\n';
    await writeFile(gitignorePath, userLine + (await readFile(gitignorePath, 'utf8')), 'utf8');

    await agent.runRaw(['update', '--json']);
    const afterUpdate = await readFile(gitignorePath, 'utf8');
    expect(afterUpdate).toMatch(/^\.orcaops\/cache\/\n/);

    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md');
    await rm(skillPath);
    const fixed = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(fixed.exitCode).toBe(0);
    expect(await readFile(gitignorePath, 'utf8')).toBe(afterUpdate);
    expect(await readOrNull(skillPath)).not.toBeNull();

    const uninstalled = await agent.runRaw(['uninstall', '--purge-data', '--json']);
    expect(uninstalled.exitCode).toBe(0);
    expect(await readFile(gitignorePath, 'utf8')).toBe(userLine);
  });

  it('preserves matching user info/exclude lines across update, doctor repair, and uninstall', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-personal-fix-'));
    const personalAgent = makeAgent({
      cwd: repo.path,
      env: {
        CLAUDE_SESSION_ID: 'test-doctor-fix-personal',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
      },
    });
    try {
      await personalAgent.runRaw(['init', '--personal', '--yes', '--no-llm']);
      const excludePath = path.join(repo.path, '.git', 'info', 'exclude');
      const userLine = '.orcaops/\n';
      await writeFile(excludePath, userLine + (await readFile(excludePath, 'utf8')), 'utf8');

      const healthy = await personalAgent.runRaw(['doctor', '--json']);
      expect(findCheck(JSON.parse(healthy.stdout) as DoctorReport, 'info-exclude').status).toBe(
        'pass'
      );
      await personalAgent.runRaw(['update', '--json']);
      expect(await readFile(excludePath, 'utf8')).toMatch(/^\.orcaops\/\n/);

      // Empty the managed block (the user's own leading line stays) → stale.
      const stale = (await readFile(excludePath, 'utf8')).replace(
        '# >>> orcaops >>>\n.orcaops/\n',
        '# >>> orcaops >>>\n'
      );
      await writeFile(excludePath, stale, 'utf8');
      const fixed = await personalAgent.runRaw(['doctor', '--fix', '--json']);
      expect(fixed.exitCode).toBe(0);
      const repaired = await readFile(excludePath, 'utf8');
      expect(repaired).toMatch(/^\.orcaops\/\n/);
      expect(repaired).toContain('# >>> orcaops >>>\n.orcaops/\n');
      expect(repaired).not.toContain('CLAUDE.local.md');

      const uninstalled = await personalAgent.runRaw(['uninstall', '--purge-data', '--json']);
      expect(uninstalled.exitCode).toBe(0);
      expect(await readFile(excludePath, 'utf8')).toMatch(/^\.orcaops\/\n/);
      expect(await readFile(excludePath, 'utf8')).toContain('# >>> orcaops >>>\n.orcaops/\n');
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('repairs the info/exclude section for a repo that installs no agents', async () => {
    // The agent-independent repairs live inside the same planner as the
    // per-agent generation, so gating that planner on a non-empty agent set
    // left `--fix` unable to repair the warning it had just printed.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-noagents-fix-'));
    const personalAgent = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor-fix-no-agents', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
    try {
      await personalAgent.runRaw(['init', '--personal', '--yes', '--no-llm']);
      // The empty install set of manual mode — the interview offers it, and
      // it is what a repo driving orcaops by hand ends up with.
      const configPath = await effectiveConfigPath(repo.path);
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        install: { agents: string[] };
      };
      config.install.agents = [];
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      const excludePath = path.join(repo.path, '.git', 'info', 'exclude');
      await writeFile(excludePath, '*.swp\n', 'utf8');

      const warned = await personalAgent.runRaw(['doctor', '--json']);
      expect(findCheck(JSON.parse(warned.stdout) as DoctorReport, 'info-exclude').status).toBe(
        'warn'
      );

      const fixed = await personalAgent.runRaw(['doctor', '--fix', '--json']);
      expect(fixed.exitCode).toBe(0);
      expect(await readFile(excludePath, 'utf8')).toContain('.orcaops/');
      expect(findCheck(JSON.parse(fixed.stdout) as DoctorReport, 'info-exclude').status).toBe(
        'pass'
      );
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('--fix --dry-run previews the repair without writing (overall stays at pre-fix warn)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      original.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-dry'),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--fix', '--dry-run', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    // The fix is PLANNED, not applied …
    expect(findCheck(r, 'fix').summary).toMatch(/would repair \d+ file/);
    // … so the stale file is untouched and the install check stays warn.
    expect(await readFile(skillPath, 'utf8')).toContain('0.0.0-stale-dry');
    expect(findCheck(r, 'agent-skills').status).toBe('warn');
    expect(r.overall).toBe('warn'); // a dry run never claims green
  });

  it('under scope=global: --fix does NOT write a project skill/command tree', async () => {
    // Hermetic global root so init --scope global materializes off-repo.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-groot-fix-'));
    const gAgent = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor-fix-global', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
    try {
      await gAgent.runRaw(['init', '--agents', 'claude-code', '--scope', 'global', '--no-llm']);
      const projSkill = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
      const projCmd = path.join(repo.path, '.claude', 'commands', 'orcaops', 'status.md');
      // Global scope → no project skill/command tree after init.
      expect(await readOrNull(projSkill)).toBeNull();

      // Invariant: --fix must not drop scope and write a project tree into a global repo.
      // With scope threaded, the global-scoped repo stays free of project files.
      const after = await gAgent.runRaw(['doctor', '--fix', '--json']);
      expect(after.exitCode).toBe(0);
      expect(await readOrNull(projSkill)).toBeNull();
      expect(await readOrNull(projCmd)).toBeNull();
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('refuses a personal repair plan that would touch a tracked path before any write', async () => {
    const trackedPath = path.join(repo.path, 'AGENTS.md');
    const trackedContent = '# Team instructions\n';
    await writeFile(trackedPath, trackedContent, 'utf8');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'team instructions'], { cwd: repo.path });
    await agent.runRaw(['init', '--scope', 'personal', '--json', '--no-llm']);

    vi.mocked(planInstallMutations).mockImplementationOnce(async (input) => {
      const actual = await vi.importActual<typeof import('../../src/lib/install-plan.js')>(
        '../../src/lib/install-plan.js'
      );
      const plan = await actual.planInstallMutations(input);
      plan.mutations.push({
        kind: 'replace',
        path: 'AGENTS.md',
        absPath: trackedPath,
        containmentRoot: input.repoRoot,
        desiredContent: '# overwritten\n',
        currentContent: trackedContent,
        changed: true,
      });
      return plan;
    });

    const refused = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain(
      'invisible-install invariant violated'
    );
    expect(await readFile(trackedPath, 'utf8')).toBe(trackedContent);

    const repaired = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(repaired.exitCode).toBe(0);
    expect(await readFile(trackedPath, 'utf8')).toBe(trackedContent);
  });

  it('human output surfaces successful install and seed repairs', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await rm(path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md'));
    const res = await agent.runRaw(['doctor', '--fix']); // human mode
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/fix/);
    expect(res.stdout).toContain('repaired');
    expect(res.stdout).toContain('resumed `orcaops seed --yes`');
    expect(res.stdout).toMatch(/^Overall: PASS/m);
  });
});
