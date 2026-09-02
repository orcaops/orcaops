import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDefaultConfig, SUPPORTED_AGENT_IDS } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  INSTALL_MANIFEST_REL,
  readInstallManifest,
  readLocalManifest,
} from '../../src/lib/install-manifest.js';
import {
  assertInvisiblePlan,
  isInvisibleAllowedPath,
  planInstallMutations,
} from '../../src/lib/install-plan.js';
import { executeMutations } from '../../src/lib/mutations.js';
import { canonicalSessionHookCommand } from '../../src/lib/session-hooks.js';

/**
 * The never-touch invariant, matrix-tested: a personal-scope plan on an
 * "enterprise" fixture (tracked AGENTS.md / CLAUDE.md / .gitignore /
 * .claude/settings.json) must NEVER plan a changed mutation outside the
 * allowlist — the excluded .orcaops/ store, CLAUDE.local.md, and git-dir
 * state — across every agent set × bootstrap × session_hooks combination.
 * The ONE sanctioned tracked write: stripping a lingering orcaops
 * session-hook entry (self-clean).
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

      for (const m of plan.mutations.filter((m) => m.changed)) {
        expect(isInvisibleAllowedPath(m.path), `unexpected tracked mutation: ${m.path}`).toBe(true);
      }
      expect(() => assertInvisiblePlan(plan.mutations, plan.sessionHooks)).not.toThrow();
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
    const tracked = plan.mutations.filter((m) => m.changed && !isInvisibleAllowedPath(m.path));
    expect(tracked.map((m) => m.path)).toEqual(['.claude/settings.json']);
    expect(plan.sessionHooks.some((p) => p.action === 'removed')).toBe(true);
    // …and the guard sanctions exactly that.
    expect(() => assertInvisiblePlan(plan.mutations, plan.sessionHooks)).not.toThrow();
  });

  it('isInvisibleAllowedPath denies tracked surfaces and allows the invisible set', () => {
    for (const denied of ['AGENTS.md', 'CLAUDE.md', '.gitignore', '.claude/settings.json']) {
      expect(isInvisibleAllowedPath(denied), denied).toBe(false);
    }
    for (const allowed of [
      '.orcaops/config.json',
      '.orcaops/install.local.json',
      'CLAUDE.local.md',
      '.git/info/exclude',
      '../main/.git/info/exclude',
    ]) {
      expect(isInvisibleAllowedPath(allowed), allowed).toBe(true);
    }
  });

  it('normalizes Windows-shaped paths without widening the invisible set', () => {
    for (const allowed of [
      '.orcaops\\config.json',
      '.orcaops\\install.local.json',
      '.git\\info\\exclude',
      '..\\main\\.git\\info\\exclude',
    ]) {
      expect(isInvisibleAllowedPath(allowed), allowed).toBe(true);
    }
    for (const denied of [
      'AGENTS.md',
      'CLAUDE.md',
      '.gitignore',
      '.claude\\settings.json',
      'docs\\configuration.md',
    ]) {
      expect(isInvisibleAllowedPath(denied), denied).toBe(false);
    }
  });

  it('assertInvisiblePlan throws on an unsanctioned tracked mutation', () => {
    expect(() =>
      assertInvisiblePlan(
        [
          {
            kind: 'replace',
            path: 'AGENTS.md',
            absPath: path.join(repo.path, 'AGENTS.md'),
            containmentRoot: repo.path,
            desiredContent: 'x',
            currentContent: 'y',
            changed: true,
          },
        ],
        []
      )
    ).toThrow(/invisible-install invariant violated/);
  });

  it('removes the personal instruction file before exposing personal paths', async () => {
    const personalConfig = getDefaultConfig();
    personalConfig.install.scope = 'personal';
    personalConfig.install.agents = ['claude-code'];
    const personalPlan = await planInstallMutations({
      repoRoot: repo.path,
      agents: personalConfig.install.agents,
      scope: 'personal',
      config: personalConfig,
      gates: { cloud: false },
      generatedBy: '9.9.9',
      gitignoreLines: [],
      prevInstall: null,
      prevLocal: null,
    });
    await executeMutations(personalPlan.mutations, 'apply');

    const projectConfig = getDefaultConfig();
    projectConfig.install.scope = 'project';
    projectConfig.install.agents = ['claude-code'];
    const projectPlan = await planInstallMutations({
      repoRoot: repo.path,
      agents: projectConfig.install.agents,
      scope: 'project',
      config: projectConfig,
      gates: { cloud: false },
      generatedBy: '9.9.9',
      gitignoreLines: [],
      prevInstall: null,
      prevLocal: await readLocalManifest(repo.path),
    });

    const localRemoval = projectPlan.mutations.findIndex(
      (mutation) => mutation.path === 'CLAUDE.local.md' && mutation.changed
    );
    const excludeStrip = projectPlan.mutations.findIndex(
      (mutation) => mutation.path.endsWith(path.join('info', 'exclude')) && mutation.changed
    );
    expect(projectPlan.mutations[localRemoval]?.kind).toBe('delete');
    expect(localRemoval).toBeGreaterThanOrEqual(0);
    expect(excludeStrip).toBeGreaterThan(localRemoval);
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
      await expect(
        access(path.join(transitionRepo.path, 'CLAUDE.local.md'))
      ).resolves.toBeUndefined();
    } finally {
      await transitionRepo.cleanup();
    }
  });
});
