import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Personal scope through update / doctor / drift: the
 * update round-trip is idempotent and reconciles info/exclude (never
 * .gitignore), doctor gives a clean bill with no false project-tree
 * staleness, and the full scope-switch matrix
 * project → personal → project reconciles: project trees pruned on the
 * way in (stale committed install.json removed), regenerated on the
 * way out.
 */

describe('orcaops update/doctor — personal scope', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let globalRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-personal-upd-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const p = (...s: string[]): string => path.join(repo.path, ...s);
  const exists = async (abs: string): Promise<boolean> => {
    try {
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  };
  const gitStatus = (): string =>
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repo.path,
    })
      .toString()
      .trim();
  const gitStatusEntries = (): string[] =>
    gitStatus()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const code = line.slice(0, 2);
        const file = line.slice(2).trim();
        if (code.includes('D')) return `D ${file}`;
        if (code.includes('M')) return `M ${file}`;
        return `${code} ${file}`;
      })
      .sort();

  it('update --personal with a non-claude-code install set succeeds with the advisory', async () => {
    // Personal supports every agent now (skills go global); the shared
    // personalScopeWarnings helper surfaces the one structural gap — only
    // Claude Code reads CLAUDE.local.md — as a warning, not a hard stop.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code,codex',
      '--agents-md',
    ]);

    const res = await agent.runRaw(['update', '--personal', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; warnings: string[] };
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w) => w.includes('only reaches Claude Code'))).toBe(true);
    // This run leaves project scope, so the de-adoption warning fires too.
    expect(out.warnings.some((w) => w.includes('de-adopts the repo'))).toBe(true);
    const cfg = JSON.parse(await readFile(p('.orcaops', 'config.json'), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg.install.scope).toBe('personal');
  });

  it('personal update round-trip: idempotent, exclude reconciled, no install.json, doctor clean', async () => {
    const init = await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    expect(init.exitCode).toBe(0);

    const first = await agent.runRaw(['update', '--json']);
    expect(first.exitCode).toBe(0);
    const out1 = JSON.parse(first.stdout) as {
      scope: string;
      pruned: string[];
      warnings: string[];
    };
    expect(out1.scope).toBe('personal');
    // Steady-state personal run: no scope left project, so no de-adoption warning.
    expect(out1.warnings.some((w) => w.includes('de-adopts the repo'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await exists(p('.claude', 'skills'))).toBe(false);
    expect(gitStatus()).toBe('');

    // info/exclude survived the update reconcile; .gitignore never appears.
    const exclude = await readFile(p('.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('CLAUDE.local.md');
    expect(await exists(p('.gitignore'))).toBe(false);

    // Second update: nothing changes (idempotent).
    const second = await agent.runRaw(['update', '--json']);
    expect(second.exitCode).toBe(0);
    const out2 = JSON.parse(second.stdout) as {
      installed: string[];
      refreshed: string[];
      pruned: string[];
    };
    expect(out2.installed).toEqual([]);
    expect(out2.refreshed).toEqual([]);
    expect(out2.pruned).toEqual([]);
    expect(gitStatus()).toBe('');

    // Doctor: clean bill — no false missing/stale from project paths, the
    // block check reads CLAUDE.local.md, and drift stays quiet.
    const doctor = await agent.runRaw(['doctor', '--json']);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string; summary: string }>;
    };
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    expect(byName.get('agent-skills')?.status).toBe('pass');
    expect(byName.get('agent-skills')?.summary).toContain('personal');
    expect(byName.get('agents-md')?.status).toBe('pass');
    expect(byName.get('agents-md')?.summary).toContain('CLAUDE.local.md');
    expect(byName.get('block-skill-refs')?.status).toBe('pass');
  });

  it.each([
    ['without a trailing newline', Buffer.from('dist/')],
    ['with CRLF line endings', Buffer.from('dist/\r\ncoverage/\r\n')],
    ['with consecutive blank lines', Buffer.from('dist/\n\n\ncoverage/\n')],
  ])('personal update leaves .gitignore byte-untouched %s', async (_case, original) => {
    const init = await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    expect(init.exitCode).toBe(0);
    await writeFile(p('.gitignore'), original);

    const update = await agent.runRaw(['update', '--json']);

    expect(update.exitCode).toBe(0);
    expect(await readFile(p('.gitignore'))).toEqual(original);
  });

  it('scope switch project → personal → project reconciles every surface', async () => {
    // 1. Standard project install, committed (the "enterprise baseline").
    const init = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);
    expect(init.exitCode).toBe(0);
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(true);
    const projectInstall = JSON.parse(await readFile(p('.orcaops', 'install.json'), 'utf8')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'project install'], { cwd: repo.path });

    // 2. Switch to personal: project trees pruned, stale committed
    //    install.json removed, block moves to CLAUDE.local.md.
    const toPersonal = await agent.runRaw(['update', '--personal', '--json']);
    expect(toPersonal.exitCode).toBe(0);
    const personalOut = JSON.parse(toPersonal.stdout) as {
      scope: string;
      pruned: string[];
      removed_install_manifest: boolean;
      warnings: string[];
    };
    expect(personalOut.scope).toBe('personal');
    // De-adoption is visible work: committing the tracked modifications this
    // transition makes would de-adopt the repo team-wide, so it must say so.
    expect(personalOut.warnings.some((w) => w.includes('de-adopts the repo'))).toBe(true);
    expect(personalOut.pruned.length).toBeGreaterThan(0);
    expect(personalOut.removed_install_manifest).toBe(true);
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await readFile(p('CLAUDE.local.md'), 'utf8')).toContain('<!-- orcaops:start');
    expect(await exists(p('AGENTS.md'))).toBe(false);
    expect(await exists(p('CLAUDE.md'))).toBe(false);
    // Global materialization carries the skills now.
    expect(
      await exists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
    ).toBe(true);
    // Config persisted the switch.
    const cfg = JSON.parse(await readFile(p('.orcaops', 'config.json'), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg.install.scope).toBe('personal');
    // Git shows ONLY the deliberate switch surface: deletions of the
    // pruned tracked trees, the managed-.gitignore-lines prune, and the
    // persisted scope in the (previously committed) config. No NEW
    // tracked content appears.
    const projectOwnedPaths = projectInstall.entries
      .filter((entry) => entry.kind !== 'gitignore-entry')
      .map((entry) => `D ${entry.path}`);
    expect(gitStatusEntries()).toEqual(
      [
        'D .orcaops/install.json',
        'M .gitignore',
        'M .orcaops/config.json',
        ...projectOwnedPaths,
      ].sort()
    );

    // Doctor stays green mid-switch state.
    const doctor = await agent.runRaw(['doctor', '--json']);
    expect(doctor.exitCode).toBe(0);

    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'personal scope'], { cwd: repo.path });
    expect(gitStatus()).toBe('');

    // 3. Switch back to project: trees regenerate, install.json returns,
    //    the exclude section is pruned back out.
    const toProject = await agent.runRaw(['update', '--scope', 'project', '--json']);
    expect(toProject.exitCode).toBe(0);
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(true);
    expect(await exists(p('CLAUDE.local.md'))).toBe(false);
    expect(await readFile(p('AGENTS.md'), 'utf8')).toContain('<!-- orcaops:start');
    const cfg2 = JSON.parse(await readFile(p('.orcaops', 'config.json'), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg2.install.scope).toBe('project');
    const restoredInstall = JSON.parse(await readFile(p('.orcaops', 'install.json'), 'utf8')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    const restoredPaths = restoredInstall.entries
      .filter((entry) => entry.kind !== 'gitignore-entry')
      .map((entry) => `?? ${entry.path}`);
    expect(gitStatusEntries()).toEqual(
      [
        'M .gitignore',
        'M .orcaops/config.json',
        '?? .orcaops/install.json',
        ...restoredPaths,
      ].sort()
    );
  });
});
