import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_HIDDEN_COMMANDS } from '@orcaops/adapters';
import { FileStore } from '@orcaops/core';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { loginAction } from '../../src/commands/login.js';
import { logoutAction } from '../../src/commands/logout.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { type MockOAuthServer, startMockOAuthServer } from '../fixtures/mock-oauth-server.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * The gate's lifecycle against REAL credential detection: no
 * ORCAOPS_CLOUD_FEATURES override anywhere in this file, so every assertion
 * runs through the same credentials-file read a user's machine performs.
 */

interface DoctorReport {
  checks: { name: string; status: string; summary?: string; details?: string[] }[];
}

const CLOUD_SKILLS = ['orcaops-plan-approval', 'orcaops-review'];

const skillPath = (repoRoot: string, id: string): string =>
  path.join(repoRoot, '.claude', 'skills', id, 'SKILL.md');

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false
  );
}

async function installedCloudSkills(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const id of CLOUD_SKILLS) {
    if (await exists(skillPath(repoRoot, id))) found.push(id);
  }
  return found;
}

async function manifestMentionsCloud(repoRoot: string): Promise<boolean> {
  const raw = await readFile(path.join(repoRoot, '.orcaops', 'install.json'), 'utf8');
  return CLOUD_SKILLS.some((id) => raw.includes(id));
}

describe('cloud gate lifecycle (real credential detection)', () => {
  let mock: MockOAuthServer;
  let repo: TempRepo;
  let configHome: string;
  let store: FileStore;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    mock = await startMockOAuthServer();
    repo = await createTempRepo({ initialBranch: 'main' });
    configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-cfg-'));
    store = new FileStore({ dir: configHome });
    // The gate resolves the credentials file from this, so it is what makes
    // detection real rather than forced.
    vi.stubEnv('ORCAOPS_CONFIG_HOME', configHome);
    originalExit = process.exit;
    Object.defineProperty(process, 'exit', {
      value: ((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never,
      configurable: true,
      writable: true,
    });
    await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--install-agent',
      'claude-code',
    ]);
  });

  afterEach(async () => {
    await mock.shutdown();
    await repo.cleanup();
    await rm(configHome, { recursive: true, force: true });
    Object.defineProperty(process, 'exit', {
      value: originalExit,
      configurable: true,
      writable: true,
    });
    vi.unstubAllEnvs();
  });

  function driveBrowser(authzUrl: string): Promise<void> {
    return (async () => {
      const authorize = await fetch(authzUrl, { redirect: 'manual' });
      const callbackUrl = authorize.headers.get('location');
      if (!callbackUrl) throw new Error(`mock AS /authorize returned ${authorize.status}`);
      await fetch(callbackUrl, { redirect: 'manual' });
    })();
  }

  /** loginAction is a direct action, so it needs the invocation frame the CLI would supply. */
  function loginInRepo(): Promise<void> {
    return runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      loginAction({
        baseUrl: mock.baseUrl,
        store,
        openBrowser: false,
        onAuthorizeUrl: driveBrowser,
      })
    );
  }

  it('installs no cloud skills for a machine with no credentials file', async () => {
    expect(await installedCloudSkills(repo.path)).toEqual([]);
    expect(await manifestMentionsCloud(repo.path)).toBe(false);
  });

  it('materializes the cloud skills on login', async () => {
    // ORCAOPS_DISABLE_DRAIN is deliberately NOT set: it is the hook's own
    // kill-switch, and the rest of the login suite sets it, so this is the only
    // place the post-login materialization actually runs.
    await loginInRepo();
    expect(store.read(mock.baseUrl)).not.toBeNull();
    expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    expect(await manifestMentionsCloud(repo.path)).toBe(true);
  });

  it('honours the drain kill-switch', async () => {
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    await loginInRepo();
    expect(store.read(mock.baseUrl)).not.toBeNull();
    expect(await installedCloudSkills(repo.path)).toEqual([]);
  });

  it('leaves the cloud skills on disk after logout', async () => {
    await loginInRepo();
    expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);

    await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      logoutAction({ baseUrl: mock.baseUrl, json: true })
    );
    expect(store.read(mock.baseUrl)).toBeNull();

    // The gate blocks creation, never deletion.
    expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    expect(await manifestMentionsCloud(repo.path)).toBe(true);
  });

  it('carries the manifest entries through an update run after logout', async () => {
    await loginInRepo();
    const before = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');

    await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      logoutAction({ baseUrl: mock.baseUrl, json: true })
    );
    await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'update',
      '--json',
    ]);

    expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')).toBe(before);
  });

  it('keeps the cloud entries when link rebuilds the manifest after logout', async () => {
    // link rebuilds the committed manifest from the GATED skill set. Building it
    // directly dropped the cloud entries, and the loss is unrecoverable: the
    // next update reads that stripped manifest and has nothing to preserve.
    await loginInRepo();
    const before = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');

    await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      logoutAction({ baseUrl: mock.baseUrl, json: true })
    );
    await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'link',
      '--yes',
      '--json',
    ]);

    expect(await manifestMentionsCloud(repo.path)).toBe(true);
    expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    // link consolidates the instruction files, so only those entries may move.
    const after = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');
    const generated = (raw: string): string[] =>
      (JSON.parse(raw) as { entries: { kind: string; path: string }[] }).entries
        .filter((e) => e.kind === 'generated-file')
        .map((e) => e.path);
    expect(generated(after)).toEqual(generated(before));
  });

  describe('post-login materialization', () => {
    /** Stamp every generated file older, so a full plan would rewrite all of them. */
    async function staleStampRepo(): Promise<void> {
      const manifest = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
      ) as { entries: { kind: string; path: string }[] };
      for (const e of manifest.entries.filter((x) => x.kind === 'generated-file')) {
        const p = path.join(repo.path, e.path);
        const body = await readFile(p, 'utf8');
        await writeFile(p, body.replace(/orcaops@[\d.]+/g, 'orcaops@0.0.1'));
      }
    }

    it('writes only the cloud skill files and the manifests, even on a stale repo', async () => {
      // A full install plan would rewrite every stale-stamped file here.
      await staleStampRepo();
      const watched = [
        'CLAUDE.md',
        'AGENTS.md',
        '.claude/skills/orcaops-capture/SKILL.md',
        '.claude/skills/orcaops-summary/SKILL.md',
        '.claude/commands/orcaops/digest.md',
        '.gitignore',
      ];
      const before = new Map<string, string | null>();
      for (const rel of watched) {
        before.set(rel, await readFile(path.join(repo.path, rel), 'utf8').catch(() => null));
      }

      await loginInRepo();

      // Everything outside the cloud skills is untouched, stale stamps and all.
      for (const rel of watched) {
        const after = await readFile(path.join(repo.path, rel), 'utf8').catch(() => null);
        expect(after, `login rewrote ${rel}`).toBe(before.get(rel));
      }
      // …and the cloud skills themselves are there.
      expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    });

    it('reports the cloud subset, not the whole generate result', async () => {
      await staleStampRepo();
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      await loginInRepo();
      spy.mockRestore();
      // A full plan would have reported every stale file here.
      expect(out.join('')).toContain('Cloud skills ready: 2 installed, 0 refreshed.');
    });

    it('materializes through the browser flow when the stored session cannot refresh', async () => {
      // A stored-but-unrefreshable session must fall through the connected
      // short-circuit into the fresh-auth flow, and that arm must still
      // materialize — reached via fall-through, not a clean first login.
      await writeFile(
        path.join(configHome, 'credentials.json'),
        JSON.stringify({
          [mock.baseUrl]: {
            v: 1,
            loginMethod: 'oauth',
            baseUrl: mock.baseUrl,
            userId: 'u',
            orgId: 'o',
            orgName: null,
            orgSlug: null,
            email: 'stale@b.c',
            accessToken: 'expired',
            refreshToken: 'never-issued',
            expiresAt: Math.floor(Date.now() / 1000) - 3600,
          },
        }),
        { mode: 0o600 }
      );

      await loginInRepo();

      const fresh = store.read(mock.baseUrl);
      expect(fresh).not.toBeNull();
      expect(fresh!.accessToken).not.toBe('expired');
      expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    });

    it('materializes when already logged in, without a browser re-auth', async () => {
      await loginInRepo();
      for (const id of CLOUD_SKILLS) {
        await rm(path.dirname(skillPath(repo.path, id)), { recursive: true, force: true });
      }
      expect(await installedCloudSkills(repo.path)).toEqual([]);

      // No --reauth: the path a user in a fresh clone reaches for.
      await loginInRepo();
      expect(await installedCloudSkills(repo.path)).toEqual(CLOUD_SKILLS);
    });

    it('emits the same JSON key set from both login paths', async () => {
      const capture = async (): Promise<Record<string, unknown>> => {
        const out: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
          out.push(String(chunk));
          return true;
        });
        await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
          loginAction({
            baseUrl: mock.baseUrl,
            store,
            json: true,
            openBrowser: false,
            onAuthorizeUrl: driveBrowser,
          })
        );
        spy.mockRestore();
        return JSON.parse(out.join('')) as Record<string, unknown>;
      };
      const fresh = await capture();
      const already = await capture();
      // A consumer must not branch on alreadyLoggedIn to know which fields exist.
      expect(Object.keys(already).sort()).toEqual(Object.keys(fresh).sort());
      expect(already.alreadyLoggedIn).toBe(true);
      expect(fresh.alreadyLoggedIn).toBe(false);
      expect(already.drain).toBeNull();
    });

    it('names which preflight disagreed when it refuses', async () => {
      // One flat line left the user guessing which check to fix.
      await loginInRepo();
      const manifestPath = path.join(repo.path, '.orcaops', 'install.json');
      const m = JSON.parse(await readFile(manifestPath, 'utf8')) as { naming_prefix: string };
      m.naming_prefix = 'oo';
      await writeFile(manifestPath, JSON.stringify(m, null, 2));

      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      await loginInRepo();
      spy.mockRestore();
      expect(out.join('')).toContain('naming prefix');
    });

    it('names the install agent set when that preflight disagrees', async () => {
      await loginInRepo();
      const manifestPath = path.join(repo.path, '.orcaops', 'install.json');
      const m = JSON.parse(await readFile(manifestPath, 'utf8')) as { install_agents: string[] };
      m.install_agents = [...m.install_agents, 'codex'];
      await writeFile(manifestPath, JSON.stringify(m, null, 2));

      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      await loginInRepo();
      spy.mockRestore();
      expect(out.join('')).toContain('install agent set');
    });

    it('tells a global-scope repo to run update instead of reporting success', async () => {
      const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-gscope-'));
      await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_GLOBAL_ROOT: globalRoot },
      }).runRaw(['update', '--scope', 'global', '--json']);

      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      await loginInRepo();
      spy.mockRestore();

      expect(out.join('')).toContain('orcaops update');
      expect(out.join('')).toContain('install scope: global');
      await rm(globalRoot, { recursive: true, force: true });
    });

    it('materializes the cloud skills into the global root on the advised update', async () => {
      // The deferral advice is a contract: following it must land the skills.
      const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-gmat-'));
      const env = { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_GLOBAL_ROOT: globalRoot };
      const globalSkill = (id: string): string =>
        path.join(globalRoot, 'claude-code', 'skills', id, 'SKILL.md');
      await makeAgent({ cwd: repo.path, env }).runRaw(['update', '--scope', 'global', '--json']);
      for (const id of CLOUD_SKILLS) expect(await exists(globalSkill(id))).toBe(false);

      await loginInRepo();
      await makeAgent({ cwd: repo.path, env }).runRaw(['update', '--json']);
      for (const id of CLOUD_SKILLS) expect(await exists(globalSkill(id))).toBe(true);
      await rm(globalRoot, { recursive: true, force: true });
    });
  });

  it('hides the cloud commands from help until credentials exist', async () => {
    const agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } });
    const anonymous = await agent.runRaw(['--help']);
    expect(anonymous.stdout).toContain('login');
    expect(anonymous.stdout).not.toMatch(/^\s+plan\s/m);
    expect(anonymous.stdout).not.toMatch(/^\s+whoami\s/m);

    await writeFile(
      path.join(configHome, 'credentials.json'),
      JSON.stringify({
        [mock.baseUrl]: {
          v: 1,
          loginMethod: 'oauth',
          baseUrl: mock.baseUrl,
          userId: 'u',
          orgId: 'o',
          orgName: null,
          orgSlug: null,
          email: 'a@b.c',
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
      { mode: 0o600 }
    );

    const authed = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome },
    }).runRaw(['--help']);
    expect(authed.stdout).toMatch(/^\s+plan\s/m);
    expect(authed.stdout).toMatch(/^\s+whoami\s/m);
  });

  describe('credential short-circuits through the help gate', () => {
    const credentialEntry = (baseUrl: string): Record<string, unknown> => ({
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'u',
      orgId: 'o',
      orgName: null,
      orgSlug: null,
      email: 'a@b.c',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    async function cloudCommandsShown(env: Record<string, string>): Promise<boolean> {
      const out = await makeAgent({ cwd: repo.path, env }).runRaw(['--help']);
      return /^\s+plan\s/m.test(out.stdout) && /^\s+whoami\s/m.test(out.stdout);
    }

    it('opens on ORCAOPS_TOKEN with no credentials file', async () => {
      expect(
        await cloudCommandsShown({ ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_TOKEN: 'tok-1' })
      ).toBe(true);
    });

    it('stays shut on an empty ORCAOPS_TOKEN', async () => {
      expect(await cloudCommandsShown({ ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_TOKEN: '' })).toBe(
        false
      );
    });

    it('opens when the keyring store is selected', async () => {
      expect(
        await cloudCommandsShown({
          ORCAOPS_CONFIG_HOME: configHome,
          ORCAOPS_CREDENTIAL_STORE: 'keyring',
        })
      ).toBe(true);
    });

    it('opens from a credentials file holding two clouds', async () => {
      await writeFile(
        path.join(configHome, 'credentials.json'),
        JSON.stringify({
          'https://cloud-a.example': credentialEntry('https://cloud-a.example'),
          'https://cloud-b.example': credentialEntry('https://cloud-b.example'),
        }),
        { mode: 0o600 }
      );
      expect(await cloudCommandsShown({ ORCAOPS_CONFIG_HOME: configHome })).toBe(true);
    });
  });

  describe('the gate across adapters (universal .agents tree)', () => {
    it.each([['codex'], ['cursor'], ['github-copilot'], ['codex,cursor']])(
      'gates, materializes, survives, and uninstalls for %s',
      async (agents) => {
        const matrixRepo = await createTempRepo({ initialBranch: 'main' });
        const cfg = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-mx-'));
        try {
          const a = makeAgent({ cwd: matrixRepo.path, env: { ORCAOPS_CONFIG_HOME: cfg } });
          await a.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--agents', agents]);
          const skill = (id: string): string =>
            path.join(matrixRepo.path, '.agents', 'skills', id, 'SKILL.md');
          expect(await exists(skill('orcaops-plan-approval'))).toBe(false);
          expect(await exists(skill('orcaops-review'))).toBe(false);

          await writeFile(
            path.join(cfg, 'credentials.json'),
            JSON.stringify({
              'https://cloud.example': {
                v: 1,
                loginMethod: 'oauth',
                baseUrl: 'https://cloud.example',
                userId: 'u',
                orgId: 'o',
                orgName: null,
                orgSlug: null,
                email: 'a@b.c',
                accessToken: 'at',
                refreshToken: 'rt',
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              },
            }),
            { mode: 0o600 }
          );
          await a.runRaw(['update', '--json']);
          expect(await exists(skill('orcaops-plan-approval'))).toBe(true);
          expect(await exists(skill('orcaops-review'))).toBe(true);

          await rm(path.join(cfg, 'credentials.json'));
          await a.runRaw(['update', '--json']);
          expect(await exists(skill('orcaops-plan-approval'))).toBe(true);

          await a.runRaw(['uninstall', '--json']);
          expect(await exists(skill('orcaops-plan-approval'))).toBe(false);
          expect(await exists(path.join(matrixRepo.path, '.agents', 'skills'))).toBe(false);
        } finally {
          await matrixRepo.cleanup();
          await rm(cfg, { recursive: true, force: true });
        }
      }
    );
  });

  it('reports user-level cloud skills left by an earlier signed-in install', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-global-'));
    const skillsDir = path.join(globalRoot, 'claude-code', 'skills');
    const residue = path.join(skillsDir, 'orcaops-plan-approval');
    await mkdir(residue, { recursive: true });
    await writeFile(path.join(residue, 'SKILL.md'), 'generatedBy: "orcaops@0.0.5"\n');

    const withResidue = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_GLOBAL_ROOT: globalRoot },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(withResidue.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    expect(drift?.status).toBe('pass');
    expect((drift?.details ?? []).join('\n')).toContain(residue);

    // Nothing is deleted from the user's directory.
    await expect(access(path.join(residue, 'SKILL.md'))).resolves.toBeUndefined();
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('does not tell a live global install to delete itself', async () => {
    // Same files as the residue case, but still ref-counted: advising removal
    // would delete a healthy install the next login re-materializes.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-owned-'));
    const skillsDir = path.join(globalRoot, 'claude-code', 'skills');
    const owned = path.join(skillsDir, 'orcaops-plan-approval');
    await mkdir(owned, { recursive: true });
    await writeFile(path.join(owned, 'SKILL.md'), 'generatedBy: "orcaops@0.0.5"\n');
    await writeFile(
      path.join(globalRoot, 'install.local.json'),
      JSON.stringify({
        manifest_version: 1,
        materialized_by: '0.0.5',
        entries: [
          {
            agent: 'claude-code',
            surface: 'skill',
            prefix: 'orcaops',
            path: path.join(owned, 'SKILL.md'),
            materialization: 'copy',
            // A copy entry must record a hash for the manifest reader to accept it.
            expectedHash: 'a'.repeat(64),
            refs: ['someRepo'],
          },
        ],
      })
    );

    const report = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_GLOBAL_ROOT: globalRoot },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    const details = (drift?.details ?? []).join('\n');

    expect(details).toContain(owned);
    expect(details).toContain('kept, not pruned');
    expect(details).not.toContain('remove the directories');
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('does not let a directory-level neighbour entry claim a residue skill', async () => {
    // The separator guard's unfired arm: an entry recorded at directory level
    // for `orcaops-review-extra` must not own the `orcaops-review` residue dir.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-sep-'));
    const skillsDir = path.join(globalRoot, 'claude-code', 'skills');
    const residue = path.join(skillsDir, 'orcaops-review');
    await mkdir(residue, { recursive: true });
    await writeFile(path.join(residue, 'SKILL.md'), 'generatedBy: "orcaops@0.0.5"\n');
    await writeFile(
      path.join(globalRoot, 'install.local.json'),
      JSON.stringify({
        manifest_version: 1,
        materialized_by: '0.0.5',
        entries: [
          {
            agent: 'claude-code',
            surface: 'skill',
            prefix: 'orcaops',
            path: path.join(skillsDir, 'orcaops-review-extra'),
            materialization: 'copy',
            expectedHash: 'a'.repeat(64),
            refs: ['someRepo'],
          },
        ],
      })
    );

    const report = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_GLOBAL_ROOT: globalRoot },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    const details = (drift?.details ?? []).join('\n');

    expect(details).toContain(residue);
    expect(details).toContain('remove the directories');
    expect(details).not.toContain('kept, not pruned');
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('emits no cloud-named check and recommends no hidden command', async () => {
    // General-purpose: catches the next leaked recommendation, not just this one.
    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const checks = (JSON.parse(report.stdout) as DoctorReport).checks;

    for (const c of checks)
      expect(c.name, `check "${c.name}" names the cloud`).not.toMatch(/cloud/);

    const prose = checks.map((c) => [c.summary, ...(c.details ?? [])].join('\n')).join('\n');
    for (const command of CLOUD_HIDDEN_COMMANDS) {
      expect(prose, `recommends the hidden \`orcaops ${command}\``).not.toContain(
        `orcaops ${command}`
      );
    }
  });

  it('stays silent about a global dir that does not exist', async () => {
    // The common case for a fresh install, and previously an outright doctor
    // failure: the containment root was lstat-ed before it was known to exist.
    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    expect(drift?.status).toBe('pass');
    expect(drift?.details).toBeUndefined();
  });

  it('reports cloud skills preserved in the repo after logout', async () => {
    // They survive by design, so without a note an inert skill has no
    // explanation. Distinct from the user-level message: these are committed,
    // so removal is never the advice.
    await loginInRepo();
    await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      logoutAction({ baseUrl: mock.baseUrl, json: true })
    );

    // Isolate the global skills dir: otherwise the user-level residue note
    // bleeds in and the test reads the developer's own machine.
    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    const details = (drift?.details ?? []).join('\n');

    expect(drift?.status).toBe('pass');
    expect(details).toContain('orcaops-plan-approval');
    expect(details).toContain('orcaops login');
    // Committed files: removal is never the advice.
    expect(details).not.toContain('remove the directories');
  });

  it('explains old-prefix inert cloud skills after a rename', async () => {
    // The drift scan keys on the current prefix; the committed manifest is
    // what still owns a renamed-away cloud skill and earns it the note.
    await loginInRepo();
    await rm(path.join(configHome, 'credentials.json'));
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      naming?: { prefix?: string };
    };
    config.naming = { ...(config.naming ?? {}), prefix: 'oo' };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'update',
      '--json',
    ]);

    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    const details = (drift?.details ?? []).join('\n');

    expect(drift?.status).toBe('pass');
    expect(details).toContain('orcaops-plan-approval');
    expect(details).toContain('orcaops login');
    expect(details).not.toContain('remove the directories');
  });

  it('says nothing about preserved skills while signed in', async () => {
    await loginInRepo();
    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    expect(drift?.status).toBe('pass');
    expect(drift?.details).toBeUndefined();
  });

  it('keeps the cloud explanation when ordinary disabled-skill residue is also present', async () => {
    // Both notes share one detail list, so the disabled-skill branch must not
    // consume it before the cloud lines are in.
    await loginInRepo();
    await runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
      logoutAction({ baseUrl: mock.baseUrl, json: true })
    );
    // An ordinary skill that is installed but disabled — the warn branch.
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      skills?: { enabled?: Record<string, boolean> };
    };
    config.skills = { ...(config.skills ?? {}), enabled: { digest: false } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const report = await makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CONFIG_HOME: configHome,
        ORCAOPS_GLOBAL_ROOT: path.join(tmpdir(), 'orcaops-gate-absent-global'),
      },
    }).runRaw(['doctor', '--json']);
    const drift = (JSON.parse(report.stdout) as DoctorReport).checks.find(
      (c) => c.name === 'skill-drift'
    );
    const details = (drift?.details ?? []).join('\n');

    expect(drift?.status).toBe('warn');
    expect(details).toContain('orcaops update');
    expect(details).toContain('orcaops-plan-approval');
    expect(details).toContain('inert without');
  });

  it('settles the renamed manifest in one pass and stays put on the next update', async () => {
    await loginInRepo();
    await rm(path.join(configHome, 'credentials.json'));

    const manifestPath = path.join(repo.path, '.orcaops', 'install.json');
    const skillIds = (raw: string): string[] =>
      (JSON.parse(raw) as { entries: { kind: string; path: string }[] }).entries
        .filter((e) => e.kind === 'generated-file' && e.path.includes('/skills/'))
        .map((e) =>
          e.path
            .split('/skills/')[1]!
            .split('/')[0]!
            .replace(/^(oo|orcaops)-/, '')
        );
    const before = skillIds(await readFile(manifestPath, 'utf8'));

    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      naming?: { prefix?: string };
    };
    config.naming = { ...(config.naming ?? {}), prefix: 'oo' };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = { ORCAOPS_CONFIG_HOME: configHome };
    await makeAgent({ cwd: repo.path, env }).runRaw(['update', '--json']);
    const first = await readFile(manifestPath, 'utf8');
    // Preserved old-prefix entries hold their template slots, not the end.
    expect(skillIds(first)).toEqual(before);
    expect(first).toContain('orcaops-plan-approval');

    await makeAgent({ cwd: repo.path, env }).runRaw(['update', '--json']);
    expect(await readFile(manifestPath, 'utf8')).toBe(first);
  });

  it('captures without a cloud warning on a machine with no credentials', async () => {
    const r = await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'prove the anonymous capture stays quiet about the cloud',
          label: 'quiet anonymous capture',
          plan_steps: [{ text: 'one step', label: 'one step' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(r.stderr).not.toContain('Cloud sync');
    const ok = JSON.parse(r.stdout) as {
      cloud_sync: { status: string; reason?: string };
      next_actions?: { verb: string; command: string; effect: string }[];
    };
    expect(ok.cloud_sync).toMatchObject({ status: 'skipped', reason: 'no_cloud_configured' });
    // The runtime hint channel must stay cloud-silent too: no action may name
    // the approval track or an upload on a machine without credentials.
    const hintText = (ok.next_actions ?? [])
      .map((a) => `${a.verb} ${a.command} ${a.effect}`)
      .join('\n');
    expect(hintText).not.toMatch(/plan-approval|plan upload/);
  });

  it('a credentialed capture offers the approval track as a next action', async () => {
    await writeFile(
      path.join(configHome, 'credentials.json'),
      JSON.stringify({
        [mock.baseUrl]: {
          v: 1,
          loginMethod: 'oauth',
          baseUrl: mock.baseUrl,
          userId: 'u',
          orgId: 'o',
          orgName: null,
          orgSlug: null,
          email: 'a@b.c',
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
      { mode: 0o600 }
    );
    const r = await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'offer the approval track after a credentialed capture',
          label: 'credentialed capture hint',
          plan_steps: [{ text: 'one step', label: 'one step' }],
          touched_scope: [],
        })
      ),
    ]);
    const ok = JSON.parse(r.stdout) as { next_actions?: { verb: string }[] };
    expect((ok.next_actions ?? []).map((a) => a.verb)).toContain('plan-approval');
  });

  it('reports a materialization failure without failing the login', async () => {
    await writeFile(path.join(repo.path, '.orcaops', 'install.json'), '{ not json');
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await loginInRepo();
    } finally {
      spy.mockRestore();
    }
    // The session is good even though the repo write failed.
    expect(store.read(mock.baseUrl)).not.toBeNull();
    expect(written.join('')).toContain('could not be installed');
    expect(written.join('')).toContain('orcaops update');
  });

  it('stays quiet on the human path when there is nothing to install', async () => {
    // No install manifest: not a failure, so it must not warn.
    await rm(path.join(repo.path, '.orcaops', 'install.json'), { force: true });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await loginInRepo();
    } finally {
      spy.mockRestore();
    }
    expect(store.read(mock.baseUrl)).not.toBeNull();
    expect(written.join('')).not.toContain('could not be installed');
  });
});
