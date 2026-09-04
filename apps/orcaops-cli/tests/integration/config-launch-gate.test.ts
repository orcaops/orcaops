import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

describe('current config gate', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true, scope: 'project' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // The file under test is the WORKTREE config; a reset is a fresh init and
  // therefore personal, so post-reset reads resolve the effective path.
  const configPath = (): string => path.join(repo.path, '.orcaops', 'config.json');

  it('init --force preserves current settings and artifact/cache bytes', async () => {
    const artifactSentinel = path.join(repo.path, '.orcaops', 'artifacts', 'preserve-me.txt');
    const cacheSentinel = path.join(repo.path, '.orcaops', 'cache', 'preserve-me.txt');
    // Init no longer creates the data directories eagerly; the first write does.
    await mkdir(path.dirname(artifactSentinel), { recursive: true });
    await mkdir(path.dirname(cacheSentinel), { recursive: true });
    await writeFile(artifactSentinel, 'artifact bytes', 'utf8');
    await writeFile(cacheSentinel, 'cache bytes', 'utf8');
    await writeFile(
      configPath(),
      JSON.stringify({
        schema_version: CONFIG_SCHEMA_VERSION,
        install: { agents: ['codex'] },
        naming: { prefix: 'oo' },
        generated_files: 'ignore',
        archive: { enabled: false, redact_secrets: false },
      }),
      'utf8'
    );
    const res = await agent.runRaw(['init', '--force', '--json']);
    expect(res.exitCode).toBe(0);
    const after = JSON.parse(await readFile(configPath(), 'utf8')) as {
      schema_version: number;
      naming?: { prefix?: string };
      install?: { agents?: string[] };
      generated_files?: string;
      archive?: { enabled?: boolean };
    };
    expect(after.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(after.naming?.prefix).toBe('oo');
    expect(after.install?.agents).toEqual(['codex']);
    expect(after.generated_files).toBe('ignore');
    expect(after.archive?.enabled).toBe(false);
    expect(await readFile(artifactSentinel, 'utf8')).toBe('artifact bytes');
    expect(await readFile(cacheSentinel, 'utf8')).toBe('cache bytes');
    expect((JSON.parse(res.stdout) as { config_reset: boolean }).config_reset).toBe(false);
    const status = await agent.runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
  });

  it('explicit config flags override only their setting during forced reconciliation', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        schema_version: CONFIG_SCHEMA_VERSION,
        install: { agents: ['codex'] },
        naming: { prefix: 'oo' },
        archive: { enabled: false, redact_secrets: false },
      }),
      'utf8'
    );
    const res = await agent.runRaw(['init', '--force', '--prefix', 'revised', '--json']);
    expect(res.exitCode).toBe(0);
    const after = JSON.parse(await readFile(configPath(), 'utf8')) as {
      naming: { prefix: string };
      install: { agents: string[] };
      archive: { enabled: boolean };
    };
    expect(after.naming.prefix).toBe('revised');
    expect(after.install.agents).toEqual(['codex']);
    expect(after.archive.enabled).toBe(false);
  });

  it('init --force --reset-config restores defaults while preserving artifact/cache bytes', async () => {
    const artifactSentinel = path.join(repo.path, '.orcaops', 'artifacts', 'preserve-me.txt');
    const cacheSentinel = path.join(repo.path, '.orcaops', 'cache', 'preserve-me.txt');
    // Init no longer creates the data directories eagerly; the first write does.
    await mkdir(path.dirname(artifactSentinel), { recursive: true });
    await mkdir(path.dirname(cacheSentinel), { recursive: true });
    await writeFile(artifactSentinel, 'artifact bytes', 'utf8');
    await writeFile(cacheSentinel, 'cache bytes', 'utf8');
    await writeFile(
      configPath(),
      JSON.stringify({
        schema_version: CONFIG_SCHEMA_VERSION,
        install: { agents: ['codex'] },
        naming: { prefix: 'oo' },
        generated_files: 'ignore',
        archive: { enabled: false, redact_secrets: false },
      }),
      'utf8'
    );

    const res = await agent.runRaw(['init', '--force', '--reset-config', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    // Reset writes the MINIMAL default config: default-valued keys are
    // omitted and resolve back through the schema defaults.
    const after = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      naming?: { prefix?: string };
      install: { agents: string[] };
      generated_files?: string;
    };
    expect(after.naming?.prefix ?? 'orcaops').toBe('orcaops');
    expect(after.install.agents).toEqual(['claude-code']);
    expect(after.generated_files ?? 'commit').toBe('commit');
    expect(await readFile(artifactSentinel, 'utf8')).toBe('artifact bytes');
    expect(await readFile(cacheSentinel, 'utf8')).toBe('cache bytes');
    expect((JSON.parse(res.stdout) as { config_reset: boolean }).config_reset).toBe(true);
  });

  it('a current config with an unknown root key fails with INVALID_CONFIG and names the key', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, unexpected_setting: true }),
      'utf8'
    );
    const res = await agent.runRaw(['status', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as {
      ok: false;
      error: { code: string; message: string; path?: string };
    };
    expect(env.error).toMatchObject({ code: 'INVALID_CONFIG', path: 'unexpected_setting' });
    expect(env.error.message).toContain('unexpected_setting');
  });

  it('init --force refuses invalid current keys and directs the user to reset-config', async () => {
    const raw = JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, unexpected_setting: true });
    await writeFile(configPath(), raw, 'utf8');
    const res = await agent.runRaw(['init', '--force', '--no-llm', '--json']);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CONFIG', path: 'unexpected_setting' },
    });
    expect(res.stdout).toContain('--reset-config');
    expect(await readFile(configPath(), 'utf8')).toBe(raw);
  });

  it('init --force --reset-config resets a config with invalid current keys', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, unexpected_setting: true })
    );
    const res = await agent.runRaw(['init', '--force', '--reset-config', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    const after = JSON.parse(
      await readFile(await effectiveConfigPath(repo.path), 'utf8')
    ) as Record<string, unknown>;
    expect(after.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(after).not.toHaveProperty('unexpected_setting');
  });

  it.each([['--force'], ['--force', '--reset-config']])(
    'init %s refuses an ahead-version config',
    async (...flags) => {
      const raw = JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION + 1, future_field: true });
      await writeFile(configPath(), raw, 'utf8');
      const res = await agent.runRaw(['init', ...flags, '--no-llm', '--json']);
      expect(res.exitCode).toBe(1);
      expect(await readFile(configPath(), 'utf8')).toBe(raw);
    }
  );

  it('init --force refuses unparseable config until reset-config is explicit', async () => {
    const raw = '{ definitely not json';
    await writeFile(configPath(), raw, 'utf8');
    const res = await agent.runRaw(['init', '--force', '--no-llm', '--json']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('--reset-config');
    expect(await readFile(configPath(), 'utf8')).toBe(raw);

    const reset = await agent.runRaw(['init', '--force', '--reset-config', '--no-llm', '--json']);
    expect(reset.exitCode).toBe(0);
    const after = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      schema_version: number;
    };
    expect(after.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('--reset-config requires --force', async () => {
    const before = await readFile(configPath(), 'utf8');
    const res = await agent.runRaw(['init', '--reset-config', '--no-llm', '--json']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('--reset-config` requires `--force');
    expect(await readFile(configPath(), 'utf8')).toBe(before);
  });

  it('init help distinguishes forced reconciliation from config reset', async () => {
    const res = await agent.runRaw(['init', '--help']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('preserve current config');
    expect(res.stdout).toContain('--reset-config');
    expect(res.stdout.replace(/\s+/g, ' ')).toContain('artifacts and cache data are preserved');
  });
});
