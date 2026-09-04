import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDefaultConfig, SUPPORTED_AGENT_IDS } from '@orcaops/storage';
import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  INSTALL_MANIFEST_REL,
  readInstallManifest,
  readLocalManifest,
} from '../../src/lib/install-manifest.js';
import {
  assertInvisiblePlan,
  planInstallMutations,
  resolveInvisibleTargets,
} from '../../src/lib/install-plan.js';
import { executeMutations } from '../../src/lib/mutations.js';
import { canonicalSessionHookCommand } from '../../src/lib/session-hooks.js';

/**
 * The never-touch invariant, matrix-tested: a personal-scope plan on an
 * "enterprise" fixture (tracked AGENTS.md / CLAUDE.md / .gitignore /
 * .claude/settings.json) must NEVER plan a changed mutation outside the
 * contained targets — the git common dir's orcaops/ files and info/exclude,
 * git's hooks dir, and this worktree's excluded .orcaops/ store — across
 * every agent set × bootstrap × session_hooks combination. The ONE
 * sanctioned tracked write: stripping a lingering orcaops session-hook entry
 * (self-clean).
 */
describe('invisible-install never-touch guard', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, 'AGENTS.md'), '# Team instructions\n', 'utf8');
    await writeFile(path.join(repo.path, 'CLAUDE.md'), '# Claude notes\n', 'utf8');
    await writeFile(path.join(repo.path, '.gitignore'), 'node_modules/\n', 'utf8');
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2),
      'utf8'
    );
    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'enterprise baseline'], { cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const matrix = [
    { bootstrap: 'manual' as const, sessionHooks: false },
    { bootstrap: 'manual' as const, sessionHooks: true },
    { bootstrap: 'managed' as const, sessionHooks: false },
    { bootstrap: 'managed' as const, sessionHooks: true },
  ];

  for (const { bootstrap, sessionHooks } of matrix) {
    it(`all agents, bootstrap=${bootstrap}, session_hooks=${sessionHooks}: zero tracked-file mutations`, async () => {
      const config = getDefaultConfig();
      config.install.scope = 'personal';
      config.install.agents = [...SUPPORTED_AGENT_IDS];
      config.bootstrap = bootstrap;
      config.session_hooks = { enabled: sessionHooks, payload: 'static', entries: 'project' };

      const plan = await planInstallMutations({
        repoRoot: repo.path,
        agents: config.install.agents,
        scope: 'personal',
        config,
        gates: { cloud: false },
        generatedBy: '9.9.9',
        gitignoreLines: [],
        prevInstall: null,
        prevLocal: null,
      });

      // No project skill/command trees, no committed manifest.
      expect(plan.genFiles).toEqual([]);
      expect(plan.mutations.some((m) => m.path === INSTALL_MANIFEST_REL && m.changed)).toBe(false);

      // No worktree manifest either: the ownership record is the common one.
      expect(plan.mutations.some((m) => m.path.endsWith('install.local.json') && m.changed)).toBe(
        false
      );
      await expect(
        assertInvisiblePlan(repo.path, plan.mutations, plan.sessionHooks)
      ).resolves.toBeUndefined();
    });
  }

  it('a lingering session-hook entry strips — the ONE sanctioned tracked write', async () => {
    await writeFile(
      path.join(repo.path, '.claude', 'settings.json'),
      JSON.stringify(
        {
          permissions: { allow: ['Bash'] },
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume|clear',
                hooks: [{ type: 'command', command: canonicalSessionHookCommand('claude-code') }],
              },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );
    const config = getDefaultConfig();
    config.install.scope = 'personal';
    config.install.agents = ['claude-code'];
    config.session_hooks = { enabled: false, payload: 'static', entries: 'project' };

    const plan = await planInstallMutations({
      repoRoot: repo.path,
      agents: config.install.agents,
      scope: 'personal',
      config,
      gates: { cloud: false },
      generatedBy: '9.9.9',
      gitignoreLines: [],
      prevInstall: null,
      prevLocal: null,
    });

    // The strip IS planned against the tracked settings file…
    expect(plan.mutations.some((m) => m.changed && m.path === '.claude/settings.json')).toBe(true);
    expect(plan.sessionHooks.some((p) => p.action === 'removed')).toBe(true);
    // …and the guard sanctions exactly that.
    await expect(
      assertInvisiblePlan(repo.path, plan.mutations, plan.sessionHooks)
    ).resolves.toBeUndefined();
  });

  const mutationAt = (absPath: string, containmentRoot: string, rel: string) => ({
    kind: 'replace' as const,
    path: rel,
    absPath,
    containmentRoot,
    desiredContent: 'x',
    currentContent: 'y',
    changed: true,
  });

  it('allows only the common orcaops dir, the common info/exclude, git hooks, and this store', async () => {
    const targets = await resolveInvisibleTargets(repo.path);
    const allowed = [
      mutationAt(
        path.join(targets.commonOrcaopsDir, 'config.json'),
        path.dirname(targets.commonOrcaopsDir),
        path.relative(repo.path, path.join(targets.commonOrcaopsDir, 'config.json'))
      ),
      mutationAt(
        targets.commonInfoExclude,
        path.dirname(path.dirname(targets.commonInfoExclude)),
        path.relative(repo.path, targets.commonInfoExclude)
      ),
      mutationAt(
        path.join(repo.path, '.orcaops', 'cache', 'x.db'),
        repo.path,
        '.orcaops/cache/x.db'
      ),
      mutationAt(
        path.join(targets.gitHooksDir ?? '', 'post-merge'),
        path.dirname(targets.gitHooksDir ?? ''),
        path.relative(repo.path, path.join(targets.gitHooksDir ?? '', 'post-merge'))
      ),
    ];
    await expect(assertInvisiblePlan(repo.path, allowed, [])).resolves.toBeUndefined();

    for (const denied of ['AGENTS.md', 'CLAUDE.md', '.gitignore', '.claude/settings.json']) {
      await expect(
        assertInvisiblePlan(
          repo.path,
          [mutationAt(path.join(repo.path, denied), repo.path, denied)],
          []
        )
      ).rejects.toThrow(/invisible-install invariant violated/);
    }
  });

  it('rejects a target inside a sibling worktree even though it is outside this tree', async () => {
    const sibling = await createLinkedWorktree(repo.path);
    try {
      const target = path.join(sibling.path, '.orcaops', 'config.json');
      await expect(
        assertInvisiblePlan(
          repo.path,
          [mutationAt(target, sibling.path, path.relative(repo.path, target))],
          []
        )
      ).rejects.toThrow(/invisible-install invariant violated/);
    } finally {
      await sibling.cleanup();
    }
  });

  it('allows its own untracked store when a linked worktree is nested inside the main checkout', async () => {
    const nested = path.join(repo.path, 'nested-worktree');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'nested-worktree', nested], {
      cwd: repo.path,
    });
    try {
      const configPath = path.join(nested, '.orcaops', 'config.json');
      await expect(
        assertInvisiblePlan(nested, [mutationAt(configPath, nested, '.orcaops/config.json')], [])
      ).resolves.toBeUndefined();
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', nested], { cwd: repo.path });
    }
  });

  it('rejects a tracked file inside the store, and a relative shape is no boundary', async () => {
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(repo.path, '.orcaops', 'tracked.json'), '{}', 'utf8');
    execFileSync('git', ['add', '-f', '.orcaops/tracked.json'], { cwd: repo.path });
    execFileSync('git', ['commit', '-qm', 'track a store file'], { cwd: repo.path });
    await expect(
      assertInvisiblePlan(
        repo.path,
        [
          mutationAt(
            path.join(repo.path, '.orcaops', 'tracked.json'),
            repo.path,
            '.orcaops/tracked.json'
          ),
        ],
        []
      )
    ).rejects.toThrow(/invisible-install invariant violated/);
    // `../` used to be allowed wholesale; an upward path to an unrelated place is refused.
    const outside = path.join(path.dirname(repo.path), 'elsewhere.txt');
    await expect(
      assertInvisiblePlan(
        repo.path,
        [mutationAt(outside, path.dirname(repo.path), path.relative(repo.path, outside))],
        []
      )
    ).rejects.toThrow(/invisible-install invariant violated/);
  });

  it('removes project instruction files without relying on orphan pruning', async () => {
    const transitionRepo = await createTempRepo({ initialBranch: 'main' });
    try {
      const projectConfig = getDefaultConfig();
      projectConfig.install.scope = 'project';
      projectConfig.install.agents = ['claude-code'];
      const projectPlan = await planInstallMutations({
        repoRoot: transitionRepo.path,
        agents: projectConfig.install.agents,
        scope: 'project',
        config: projectConfig,
        gates: { cloud: false },
        generatedBy: '9.9.9',
        gitignoreLines: [],
        prevInstall: null,
        prevLocal: null,
      });
      await executeMutations(projectPlan.mutations, 'apply');

      const personalConfig = getDefaultConfig();
      personalConfig.install.scope = 'personal';
      personalConfig.install.agents = ['claude-code'];
      const personalPlan = await planInstallMutations({
        repoRoot: transitionRepo.path,
        agents: personalConfig.install.agents,
        scope: 'personal',
        config: personalConfig,
        gates: { cloud: false },
        generatedBy: '9.9.9',
        gitignoreLines: [],
        prevInstall: await readInstallManifest(transitionRepo.path),
        prevLocal: await readLocalManifest(transitionRepo.path),
      });
      await executeMutations(personalPlan.mutations, 'apply');

      await expect(access(path.join(transitionRepo.path, 'AGENTS.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(path.join(transitionRepo.path, 'CLAUDE.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // Personal scope owns no instruction file: nothing is created in its place.
      await expect(access(path.join(transitionRepo.path, 'CLAUDE.local.md'))).rejects.toMatchObject(
        { code: 'ENOENT' }
      );
    } finally {
      await transitionRepo.cleanup();
    }
  });
});
