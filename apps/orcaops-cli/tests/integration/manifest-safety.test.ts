import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { CLI_VERSION } from '../../src/lib/cli-version.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * The P0 manifest-safety contract, exercised through the real commands: a
 * corrupted or adversarial install manifest must produce one typed,
 * actionable failure BEFORE any mutation planning — never an uncaught
 * parser/path exception, and never a mutated worktree.
 */
describe('install-manifest safety across command surfaces', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true, scope: 'project', agentsMd: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const manifestPath = (): string => path.join(repo.path, '.orcaops', 'install.json');
  const localPath = (): string => path.join(repo.path, '.orcaops', 'install.local.json');

  const writeGlobalCollision = async (
    globalRoot: string,
    kind: 'materialized-path' | 'store-path'
  ): Promise<string> => {
    const desiredPath = path.join(
      globalRoot,
      'claude-code',
      'skills',
      'orcaops-capture',
      'SKILL.md'
    );
    const entryPath =
      kind === 'materialized-path'
        ? desiredPath
        : path.join(globalRoot, 'claude-code', 'skills', 'nested', 'orcaops-capture', 'SKILL.md');
    const storePath = path.join(
      globalRoot,
      'store',
      'claude-code',
      'skill',
      'orcaops-capture',
      'SKILL.md'
    );
    const globalManifestPath = path.join(globalRoot, 'install.local.json');
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      globalManifestPath,
      `${JSON.stringify(
        {
          manifest_version: 1,
          materialized_by: CLI_VERSION,
          entries: [
            {
              agent: 'claude-code',
              surface: 'skill',
              prefix: 'oo',
              path: entryPath,
              materialization: kind === 'materialized-path' ? 'copy' : 'symlink',
              ...(kind === 'store-path'
                ? { symlinkTarget: path.relative(path.dirname(entryPath), storePath) }
                : {}),
              expectedHash: kind === 'materialized-path' ? 'seed-hash' : null,
              refs: ['another-repo'],
            },
          ],
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    return globalManifestPath;
  };

  it('update refuses a corrupted committed manifest with a typed error and no mutation', async () => {
    const before = await readFile(manifestPath(), 'utf8');
    await writeFile(manifestPath(), '{ definitely not json', 'utf8');

    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/install manifest/);

    // The corrupt file is untouched (no partial repair) and nothing else moved.
    expect(await readFile(manifestPath(), 'utf8')).toBe('{ definitely not json');
    await writeFile(manifestPath(), before, 'utf8');
  });

  it('update refuses a non-canonical backslash managed path with regenerate guidance', async () => {
    await writeFile(
      manifestPath(),
      JSON.stringify({
        manifest_version: 1,
        naming_prefix: 'orcaops',
        install_agents: ['claude-code'],
        entries: [{ kind: 'generated-file', path: '.claude\\skills\\x\\SKILL.md' }],
      }),
      'utf8'
    );

    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/canonical slash-relative/);
  });

  it('uninstall refuses a traversal path in the local manifest before touching anything', async () => {
    await writeFile(
      localPath(),
      JSON.stringify({
        manifest_version: 1,
        entries: [
          {
            kind: 'generated-file',
            path: '../victim.md',
            expectedHash: 'H',
            provenance: 'created',
            deleteMode: 'hash',
          },
        ],
      }),
      'utf8'
    );

    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('uninstall refuses a null-target hash-deletable symlink record at the read boundary', async () => {
    await writeFile(
      localPath(),
      JSON.stringify({
        manifest_version: 1,
        entries: [
          {
            kind: 'injected-block',
            path: 'CLAUDE.md',
            expectedHash: null,
            provenance: 'created',
            deleteMode: 'hash',
            materialization: 'symlink',
            symlinkTarget: null,
          },
        ],
      }),
      'utf8'
    );

    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/symlinkTarget/);
  });

  it('doctor degrades a corrupt GLOBAL manifest to a failing global-install check', async () => {
    const { mkdtemp, rm: rmDir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-groot-safety-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await writeFile(path.join(globalRoot, 'install.local.json'), '{ corrupt', 'utf8');

      const res = await globalAgent.runRaw(['doctor', '--json']);
      expect(res.exitCode).toBeLessThanOrEqual(1);
      const r = JSON.parse(res.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      };
      const gi = r.checks.find((c) => c.name === 'global-install');
      expect(gi?.status).toBe('fail');
      expect((gi?.details ?? []).join('\n')).toMatch(/global install manifest/);
    } finally {
      await rmDir(globalRoot, { recursive: true, force: true });
    }
  });

  it('doctor --fix degrades a corrupted project manifest to a failing fix check', async () => {
    // Differential: only the --fix path reads the project manifests, and the
    // assertion pins the SPECIFIC check + message, so this fails when either
    // the strict reader or the guard wrapping disappears.
    await writeFile(manifestPath(), '{ nope', 'utf8');

    const res = await agent.runRaw(['doctor', '--fix', '--dry-run', '--json']);
    expect(res.exitCode).toBeLessThanOrEqual(1);
    const r = JSON.parse(res.stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    const fix = r.checks.find((c) => c.name === 'fix');
    expect(fix?.status).toBe('fail');
    expect((fix?.details ?? []).join('\n')).toMatch(/install manifest/);
  });

  it('update refuses a wrong manifest_version through the real command', async () => {
    await writeFile(
      manifestPath(),
      JSON.stringify({ manifest_version: 2, install_agents: [], entries: [] }),
      'utf8'
    );
    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('init on an existing repo refuses a corrupted manifest with the typed error', async () => {
    await writeFile(manifestPath(), '{ nope', 'utf8');
    const res = await agent.runRaw(['init', '--no-llm', '--force', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/install manifest/);
  });

  it('link refuses a corrupted local manifest with the typed error', async () => {
    await writeFile(localPath(), '{ nope', 'utf8');
    const res = await agent.runRaw(['link', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('a corrupt GLOBAL manifest fails update BEFORE any project mutation lands', async () => {
    // DIFFERENTIAL by construction: a managed skill file is deleted first, so
    // a fix-less run (preflight after project execution) would restore it
    // before failing on the global phase. The assertion that it stays absent
    // is what discriminates the preflight ordering, and the manifest bytes
    // prove nothing else was rewritten.
    const { mkdtemp, rm: rmDir, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-groot-preflight-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await writeFile(path.join(globalRoot, 'install.local.json'), '{ corrupt', 'utf8');

      const skillPath = path.join(repo.path, '.claude', 'skills');
      const managed = (await readdir(skillPath, { recursive: true }))
        .map(String)
        .find((p) => p.endsWith('SKILL.md'));
      expect(managed).toBeDefined();
      const dirtied = path.join(skillPath, managed!);
      await rmDir(dirtied, { force: true });
      const beforeManifest = await readFile(manifestPath(), 'utf8');

      const res = await globalAgent.runRaw(['update', '--json']);
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
      expect(env.error.code).toBe('INVALID_INPUT');
      expect(env.error.message).toMatch(/global install manifest/);

      // Atomicity: the deleted managed file was NOT restored (the project
      // phase never executed) and the committed manifest is byte-identical.
      await expect(readFile(dirtied, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(manifestPath(), 'utf8')).toBe(beforeManifest);
    } finally {
      await rmDir(globalRoot, { recursive: true, force: true });
    }
  });

  it('a global store collision fails update before config or manifests change', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-store-preflight-'));
    try {
      const globalManifestPath = await writeGlobalCollision(globalRoot, 'store-path');
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      const projectPaths = [
        path.join(repo.path, '.orcaops', 'config.json'),
        manifestPath(),
        localPath(),
        path.join(repo.path, 'AGENTS.md'),
      ];
      const beforeProject = await Promise.all(projectPaths.map((file) => readFile(file, 'utf8')));
      const beforeGlobal = await readFile(globalManifestPath, 'utf8');

      const res = await globalAgent.runRaw([
        'update',
        '--scope',
        'global',
        '--link',
        'symlink',
        '--json',
      ]);

      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout) as { ok: false; error: { message: string } };
      expect(env.error.message).toMatch(/both derive the store file/);
      expect(await Promise.all(projectPaths.map((file) => readFile(file, 'utf8')))).toEqual(
        beforeProject
      );
      expect(await readFile(globalManifestPath, 'utf8')).toBe(beforeGlobal);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('a global materialized-path collision fails init before creating project state', async () => {
    const target = await createTempRepo({ initialBranch: 'main' });
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-path-preflight-'));
    try {
      const globalManifestPath = await writeGlobalCollision(globalRoot, 'materialized-path');
      const beforeGlobal = await readFile(globalManifestPath, 'utf8');
      const targetAgent = makeAgent({
        cwd: target.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot },
      });

      const res = await targetAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--agents',
        'claude-code',
        '--no-llm',
        '--json',
      ]);

      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout) as { ok: false; error: { message: string } };
      expect(env.error.message).toMatch(/both materialize at/);
      for (const rel of [
        path.join('.orcaops', 'config.json'),
        path.join('.orcaops', 'install.json'),
        path.join('.orcaops', 'install.local.json'),
        'AGENTS.md',
      ]) {
        await expect(readFile(path.join(target.path, rel), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await readFile(globalManifestPath, 'utf8')).toBe(beforeGlobal);
    } finally {
      await target.cleanup();
      await rm(globalRoot, { recursive: true, force: true });
    }
  });
});
