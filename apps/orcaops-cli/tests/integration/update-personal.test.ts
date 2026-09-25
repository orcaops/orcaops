import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { MANIFEST_VERSION } from '../../src/lib/install-manifest.js';
import { withRepositoryInstallLock } from '../../src/lib/repository-install-lock.js';
import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

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

  it('keeps local-only no-op reporting unchanged', async () => {
    expect(
      (
        await agent.runRaw([
          'init',
          '--scope',
          'project',
          '--agents',
          'claude-code',
          '--no-llm',
          '--json',
        ])
      ).exitCode
    ).toBe(0);
    for (const flags of [[], ['--dry-run']]) {
      const result = await agent.runRaw(['update', ...flags]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Everything is already up to date');
      expect(result.stdout).not.toContain('Global scope');
    }
  });

  it('update --personal with a non-claude-code install set succeeds', async () => {
    // Personal supports every agent: skills go global and no instruction
    // file is involved, so there is nothing agent-specific to warn about.
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
    expect(out.warnings.some((w) => w.includes('only reaches Claude Code'))).toBe(false);
    // This run leaves project scope, so the de-adoption warning fires too.
    expect(out.warnings.some((w) => w.includes('de-adopts the repo'))).toBe(true);
    const cfg = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg.install.scope).toBe('personal');
  });

  it('adopts an existing shared personal config instead of overwriting it', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    const sharedPath = await effectiveConfigPath(repo.path);
    const shared = JSON.parse(await readFile(sharedPath, 'utf8')) as Record<string, unknown>;
    shared.naming = { prefix: 'shared' };
    shared.capture = { exclude: ['shared/**'] };
    await writeFile(sharedPath, `${JSON.stringify(shared, null, 2)}\n`, 'utf8');
    const sharedBytes = await readFile(sharedPath, 'utf8');
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const worktreePath = p('.orcaops', 'config.json');
    const worktree = JSON.parse(await readFile(worktreePath, 'utf8')) as Record<string, unknown>;
    worktree.naming = { prefix: 'worktree' };
    await writeFile(worktreePath, `${JSON.stringify(worktree, null, 2)}\n`, 'utf8');

    const result = await agent.runRaw(['update', '--scope', 'personal', '--json']);

    expect(result.exitCode).toBe(0);
    expect(await exists(worktreePath)).toBe(false);
    expect(await readFile(sharedPath, 'utf8')).toBe(sharedBytes);
    const adopted = JSON.parse(await readFile(sharedPath, 'utf8')) as {
      naming: { prefix: string };
      capture: { exclude: string[] };
    };
    expect(adopted.naming.prefix).toBe('shared');
    expect(adopted.capture.exclude).toEqual(['shared/**']);
  });

  it('merges combined transition flags with a locked shared-config update', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    const sharedPath = await effectiveConfigPath(repo.path);
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const commonDir = await new Repo(repo.path).getCommonDirAbsolute();
    let pending: ReturnType<typeof agent.runRaw> | undefined;

    await withRepositoryInstallLock(commonDir, async () => {
      pending = agent.runRaw([
        'update',
        '--scope',
        'personal',
        '--prefix',
        'joined',
        '--link',
        'symlink',
        '--json',
      ]);
      await delay(200);
      const shared = JSON.parse(await readFile(sharedPath, 'utf8')) as Record<string, unknown>;
      shared.capture = { exclude: ['concurrent/**'] };
      await writeFile(sharedPath, `${JSON.stringify(shared, null, 2)}\n`, 'utf8');
    });

    const result = await pending;
    expect(result?.exitCode).toBe(0);
    const config = JSON.parse(await readFile(sharedPath, 'utf8')) as {
      install: { link: string };
      naming: { prefix: string };
      capture: { exclude: string[] };
    };
    expect(config.install.link).toBe('symlink');
    expect(config.naming.prefix).toBe('joined');
    expect(config.capture.exclude).toEqual(['concurrent/**']);
  });

  it.each([
    ['update', ['update', '--scope', 'personal', '--json']],
    ['init', ['init', '--force', '--personal', '--json']],
  ])('refuses %s when the existing shared config is not personal', async (_name, command) => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const commonPath = p('.git', 'orcaops', 'config.json');
    await writeFile(
      commonPath,
      '{"schema_version":6,"install":{"scope":"project"},"sentinel":"keep"}\n',
      'utf8'
    );
    const beforeCommon = await readFile(commonPath, 'utf8');
    const worktreePath = p('.orcaops', 'config.json');
    const beforeWorktree = await readFile(worktreePath, 'utf8');

    const result = await agent.runRaw(command);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'INVALID_CONFIG' },
    });
    expect(result.stdout).toContain('does not explicitly declare install.scope');
    expect(await readFile(commonPath, 'utf8')).toBe(beforeCommon);
    expect(await readFile(worktreePath, 'utf8')).toBe(beforeWorktree);
  });

  it('personal update round-trip: idempotent, exclude reconciled, no install.json, doctor clean', async () => {
    const init = await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
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
    expect(exclude).toContain('.orcaops/');
    expect(exclude).not.toContain('CLAUDE.local.md');
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

    // Doctor: no false missing/stale from project paths, no instruction file
    // to check under personal, and drift stays quiet.
    const doctor = await agent.runRaw(['doctor', '--json']);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
    };
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    expect(byName.get('agent-skills')?.status).toBe('pass');
    expect(byName.get('agent-skills')?.summary).toContain('personal');
    expect(byName.get('agents-md')?.status).toBe('pass');
    expect(byName.get('agents-md')?.summary).toContain('bootstrap=manual');
    expect(byName.get('block-skill-refs')?.status).toBe('pass');
    // Personal scope manages no instruction file and registered no hook, so
    // nothing carries routing — and the recovery is two actions, never one.
    const hooks = byName.get('session-hooks');
    expect(hooks?.status).toBe('warn');
    expect(hooks?.summary).toContain('no bootstrap surface carries skill routing');
    expect(hooks?.details?.join('\n')).toContain('orcaops session-hooks install');
  });

  it('preserves the exclusion when stale ownership prevents a safe scope exit', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    await writeFile(p('.git', 'orcaops', 'personal-manifest.json'), '{ not json', 'utf8');

    const update = await agent.runRaw(['update', '--scope', 'project', '--json']);

    expect(update.exitCode).toBe(0);
    const output = JSON.parse(update.stdout) as { warnings: string[] };
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cannot prove exclusion ownership because it is stale'),
      ])
    );
    const exclude = await readFile(p('.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.orcaops/');
  });

  it.each([
    ['without a trailing newline', Buffer.from('dist/')],
    ['with CRLF line endings', Buffer.from('dist/\r\ncoverage/\r\n')],
    ['with consecutive blank lines', Buffer.from('dist/\n\n\ncoverage/\n')],
  ])('personal update leaves .gitignore byte-untouched %s', async (_case, original) => {
    const init = await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    expect(init.exitCode).toBe(0);
    await writeFile(p('.gitignore'), original);

    const update = await agent.runRaw(['update', '--json']);

    expect(update.exitCode).toBe(0);
    expect(await readFile(p('.gitignore'))).toEqual(original);
  });

  it.each([
    ['deletes an untracked .gitignore orcaops created', null, false, null],
    // Accepted edge case: an untracked file cannot show it predates orcaops.
    ['deletes a pre-existing untracked empty .gitignore', '', false, null],
    ['keeps a tracked empty .gitignore', '', true, ''],
    ['keeps user lines in an untracked .gitignore', 'dist/\n', false, 'dist/\n'],
  ] as const)('leaving global scope %s', async (_label, original, tracked, expected) => {
    if (original !== null) await writeFile(p('.gitignore'), original);
    if (tracked) {
      execFileSync('git', ['add', '.gitignore'], { cwd: repo.path });
      execFileSync('git', ['commit', '-m', 'empty gitignore'], { cwd: repo.path });
    }
    expect(
      (await agent.runRaw(['init', '--personal', '--agents', 'claude-code', '--no-llm'])).exitCode
    ).toBe(0);
    expect((await agent.runRaw(['update', '--scope', 'global'])).exitCode).toBe(0);
    expect(await readFile(p('.gitignore'), 'utf8')).toContain('# >>> orcaops >>>');

    const back = await agent.runRaw(['update', '--scope', 'personal']);

    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain('scope changed global → personal');
    expect(back.stdout).toContain('de-adopts the repo');
    expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
    if (expected === null) {
      expect(await exists(p('.gitignore'))).toBe(false);
      expect(back.stdout).toContain('  - .gitignore\n');
    } else {
      expect(await readFile(p('.gitignore'), 'utf8')).toBe(expected);
    }
    if (tracked) expect(gitStatus()).not.toContain('.gitignore');
  });

  describe('a leftover worktree install.local.json in a steady personal run', () => {
    const leftover = (): string => p('.orcaops', 'install.local.json');
    const validManifest = `${JSON.stringify({ manifest_version: MANIFEST_VERSION, entries: [] }, null, 2)}\n`;
    const plant = async (content: string): Promise<void> => {
      expect(
        (await agent.runRaw(['init', '--personal', '--agents', 'claude-code', '--no-llm'])).exitCode
      ).toBe(0);
      await mkdir(p('.orcaops'), { recursive: true });
      await writeFile(leftover(), content, 'utf8');
    };

    it('is removed when valid and untracked, and a dry run only reports it', async () => {
      await plant(validManifest);

      const preview = await agent.runRaw(['update', '--dry-run']);

      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain('  - .orcaops/install.local.json\n');
      expect(await readFile(leftover(), 'utf8')).toBe(validManifest);

      const applied = await agent.runRaw(['update']);

      expect(applied.exitCode).toBe(0);
      expect(await exists(leftover())).toBe(false);
      expect(gitStatus()).toBe('');
    });

    it('survives with a warning when git tracks it', async () => {
      await plant(validManifest);
      execFileSync('git', ['add', '-f', '.orcaops/install.local.json'], { cwd: repo.path });
      execFileSync('git', ['commit', '-m', 'track the leftover'], { cwd: repo.path });

      const res = await agent.runRaw(['update', '--json']);

      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { warnings: string[] };
      expect(
        out.warnings.some(
          (w) => w.includes('.orcaops/install.local.json') && w.includes('git tracks it')
        )
      ).toBe(true);
      expect(await readFile(leftover(), 'utf8')).toBe(validManifest);
      expect(gitStatus()).toBe('');
    });

    it.each([
      ['malformed JSON', '{ not json'],
      [
        'an unknown field',
        JSON.stringify({ manifest_version: MANIFEST_VERSION, entries: [], extra: true }),
      ],
    ])('survives with a warning when it holds %s', async (_label, content) => {
      await plant(content);

      const res = await agent.runRaw(['update', '--json']);

      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { warnings: string[] };
      expect(
        out.warnings.some(
          (w) =>
            w.includes('.orcaops/install.local.json') &&
            w.includes('not a valid orcaops install manifest')
        )
      ).toBe(true);
      expect(await readFile(leftover(), 'utf8')).toBe(content);
    });
  });

  it('reports a personal → global switch and every file it writes, in preview and apply', async () => {
    expect(
      (await agent.runRaw(['init', '--personal', '--agents', 'claude-code', '--no-llm', '--json']))
        .exitCode
    ).toBe(0);
    const switchWrites = [
      '+ .orcaops/config.json',
      '+ .gitignore',
      '+ .orcaops/install.json',
      '+ .orcaops/install.local.json',
      '~ .git/info/exclude',
    ];

    const preview = await agent.runRaw(['update', '--scope', 'global', '--dry-run']);

    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Scope changed: personal → global');
    for (const line of switchWrites) expect(preview.stdout).toContain(`  ${line}\n`);
    expect(preview.stdout).not.toContain('Everything is already up to date');
    expect(gitStatus()).toBe('');

    const applied = await agent.runRaw(['update', '--scope', 'global']);

    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain('Scope changed: personal → global');
    for (const line of switchWrites) expect(applied.stdout).toContain(`  ${line}\n`);
    expect(applied.stdout).not.toContain('Everything is already up to date');

    const steady = await agent.runRaw(['update', '--json']);
    const out = JSON.parse(steady.stdout) as {
      scope_changed: unknown;
      other_changes: unknown[];
    };
    expect(out.scope_changed).toBeNull();
    expect(out.other_changes).toEqual([]);
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
      preserved_orphans: Array<{ path: string; reason: string }>;
      removed_install_manifest: boolean;
      scope_changed: { from: string; to: string } | null;
      warnings: string[];
    };
    expect(personalOut.scope).toBe('personal');
    expect(personalOut.scope_changed).toEqual({ from: 'project', to: 'personal' });
    // The planner excised the instruction blocks, so none is "preserved".
    expect(personalOut.preserved_orphans).toEqual([]);
    // De-adoption is visible work: committing the tracked modifications this
    // transition makes would de-adopt the repo team-wide, so it must say so.
    expect(personalOut.warnings.some((w) => w.includes('de-adopts the repo'))).toBe(true);
    expect(personalOut.pruned.length).toBeGreaterThan(0);
    expect(personalOut.removed_install_manifest).toBe(true);
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
    expect(await exists(p('CLAUDE.local.md'))).toBe(false);
    expect(await exists(p('AGENTS.md'))).toBe(false);
    expect(await exists(p('CLAUDE.md'))).toBe(false);
    // Global materialization carries the skills now.
    expect(
      await exists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
    ).toBe(true);
    // Config persisted the switch.
    const cfg = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg.install.scope).toBe('personal');
    // Git shows ONLY the deliberate switch surface: deletions of the
    // pruned tracked trees, the managed-.gitignore-lines prune, and the
    // removal of the (previously committed) worktree config — the personal
    // config now lives in the git common dir, outside the tree. No NEW
    // tracked content appears.
    const projectOwnedPaths = projectInstall.entries
      .filter((entry) => entry.kind !== 'gitignore-entry')
      .map((entry) => `D ${entry.path}`);
    expect(gitStatusEntries()).toEqual(
      [
        'D .orcaops/config.json',
        'D .orcaops/install.json',
        'M .gitignore',
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
    // Personal scope stored bootstrap=manual, and a scope switch does not
    // re-opt into a managed block: AGENTS.md is not recreated until the user
    // asks for it (`--agents-md` / configure).
    expect(await exists(p('AGENTS.md'))).toBe(false);
    const cfg2 = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      install: { scope: string };
    };
    expect(cfg2.install.scope).toBe('project');
    const projectExclude = await readFile(p('.git', 'info', 'exclude'), 'utf8');
    expect(projectExclude).not.toContain('# >>> orcaops >>>');
    const releasedManifest = JSON.parse(
      await readFile(p('.git', 'orcaops', 'personal-manifest.json'), 'utf8')
    ) as { info_exclude?: string[] };
    expect(releasedManifest.info_exclude ?? []).toEqual([]);
    const restoredInstall = JSON.parse(await readFile(p('.orcaops', 'install.json'), 'utf8')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    const restoredPaths = restoredInstall.entries
      .filter((entry) => entry.kind !== 'gitignore-entry')
      .map((entry) => `?? ${entry.path}`);
    expect(gitStatusEntries()).toEqual(
      [
        'M .gitignore',
        '?? .orcaops/config.json',
        '?? .orcaops/install.json',
        ...restoredPaths,
      ].sort()
    );
  });
});
