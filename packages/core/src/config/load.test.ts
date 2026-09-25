import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION, ConfigValidationError, getDefaultConfig } from '@orcaops/storage';

import {
  getConfigPath,
  loadConfig,
  loadReadOnlyProjectConfig,
  READ_ONLY_PROJECT_CONFIG_PATHS,
} from './load.js';

describe('loadConfig', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-cfg-'));
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-cfg-outside-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const writeConfig = async (raw: string) => {
    await mkdir(path.join(root, '.orcaops'), { recursive: true });
    await writeFile(getConfigPath(root), raw, 'utf8');
  };

  it('returns defaults when no config file exists', async () => {
    const cfg = await loadConfig(root);
    expect(cfg.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(cfg.install.agents).toEqual(['claude-code']);
  });

  it('throws on a missing config when allowMissing is false', async () => {
    await expect(loadConfig(root, { allowMissing: false })).rejects.toThrow();
  });

  it.each([5, 6, 7])('loads a v%i config and never rewrites it (no churn)', async (version) => {
    const raw = JSON.stringify({ schema_version: version, install: { agents: ['codex'] } });
    await writeConfig(raw);
    const cfg = await loadConfig(root);
    expect(cfg.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(cfg.install.agents).toEqual(['codex']);
    expect(cfg.llm.tool).toBe('auto'); // filled from defaults in the returned value
    expect(cfg.knowledge_processing.enabled).toBe(false);
    expect(cfg.knowledge_processing).toEqual(getDefaultConfig().knowledge_processing);
    const after = await readFile(getConfigPath(root), 'utf8');
    expect(after).toBe(raw);
  });

  it('loads released workflow settings without rewriting the file or enabling processing', async () => {
    const workflow = { commit_inside_window: false, routing: { suppress: ['digest'] } };
    const raw = JSON.stringify({ schema_version: 7, workflow });
    await writeConfig(raw);
    const config = await loadConfig(root);
    expect(config.workflow).toMatchObject(workflow);
    expect(config.knowledge_processing.enabled).toBe(false);
    expect(await readFile(getConfigPath(root), 'utf8')).toBe(raw);
  });

  it('names the file and the key when knowledge_processing is malformed', async () => {
    const raw = JSON.stringify({
      schema_version: CONFIG_SCHEMA_VERSION,
      knowledge_processing: { max_calls_per_hour: 'sixty' },
    });
    await writeConfig(raw);

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: 'knowledge_processing.max_calls_per_hour',
      message: expect.stringContaining(getConfigPath(root)),
    } satisfies Partial<ConfigValidationError>);
    expect(await readFile(getConfigPath(root), 'utf8')).toBe(raw);
  });

  it('rejects an unknown root key as INVALID_CONFIG and names it', async () => {
    await writeConfig(JSON.stringify({ schema_version: 5, unknown_root: true }));

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: 'unknown_root',
      message: expect.stringContaining('unknown_root'),
    } satisfies Partial<ConfigValidationError>);
  });

  it('rejects non-current configs with regeneration guidance, touching nothing', async () => {
    for (const raw of [
      JSON.stringify({ schema_version: 1, agent: 'codex' }),
      JSON.stringify({ schema_version: 2, agent: 'codex', install: { agents: ['codex'] } }),
      JSON.stringify({ schema_version: 3, install: { agents: ['codex'] } }),
      JSON.stringify({ schema_version: 4, install: { agents: ['codex'] } }),
    ]) {
      await writeConfig(raw);
      await expect(loadConfig(root)).rejects.toThrow(/requires 8.*orcaops init --force/s);
      expect(await readFile(getConfigPath(root), 'utf8')).toBe(raw);
    }
  });

  it('rejects a stringified version naming the type error', async () => {
    await writeConfig(JSON.stringify({ schema_version: '7', install: { agents: ['codex'] } }));
    await expect(loadConfig(root)).rejects.toThrow(/number 8.*string "7"/s);
  });

  it('rejects a version ahead of this build with the newer-orcaops message', async () => {
    const raw = JSON.stringify({
      schema_version: CONFIG_SCHEMA_VERSION + 1,
      knowledge_processing: { enabled: true },
    });
    await writeConfig(raw);
    await expect(loadConfig(root)).rejects.toThrow(/Upgrade orcaops/);
    expect(await readFile(getConfigPath(root), 'utf8')).toBe(raw);
  });

  it('throws a clear error on invalid JSON', async () => {
    await writeConfig('{ not json');
    await expect(loadConfig(root)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses to read a config through a symlinked .orcaops directory', async () => {
    const outsideConfig = path.join(outside, 'config.json');
    const raw = JSON.stringify({ schema_version: 5, install: { agents: ['codex'] } });
    await writeFile(outsideConfig, raw, 'utf8');
    await symlink(outside, path.join(root, '.orcaops'));

    await expect(loadConfig(root)).rejects.toThrow(/must not contain symlinks/);
    expect(await readFile(outsideConfig, 'utf8')).toBe(raw);
  });

  it('refuses to read a config through a final-component symlink', async () => {
    const outsideConfig = path.join(outside, 'config.json');
    const raw = JSON.stringify({ schema_version: 5, install: { agents: ['codex'] } });
    await writeFile(outsideConfig, raw, 'utf8');
    await mkdir(path.join(root, '.orcaops'));
    await symlink(outsideConfig, getConfigPath(root));

    await expect(loadConfig(root)).rejects.toThrow(/must not contain symlinks/);
    expect(await readFile(outsideConfig, 'utf8')).toBe(raw);
  });
});

describe('loadReadOnlyProjectConfig', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-read-cfg-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeConfig = async (value: unknown) => {
    await mkdir(path.join(root, '.orcaops'), { recursive: true });
    await writeFile(getConfigPath(root), JSON.stringify(value), 'utf8');
  };

  it('keeps the cross-version contract explicit', () => {
    expect(READ_ONLY_PROJECT_CONFIG_PATHS).toEqual([
      ['artifacts', 'path'],
      ['cache', 'path'],
      ['diff_fingerprint', 'max_diff_bytes'],
      ['review', 'max_diff_bytes'],
      ['review', 'include_untracked'],
      ['capture', 'exclude'],
      ['capture', 'exclude_builtins'],
      ['redact', 'allow'],
    ]);
  });

  it('carries the capture exclude set through, so the review tree honours it', async () => {
    // The review floor pins its tree to a durable ref. Projecting the opt-ins
    // without the exclude set that outranks them would narrow the set to the
    // built-ins on exactly the path where the miss is durable.
    await writeConfig({
      schema_version: 6,
      capture: { exclude: ['**/*.secret'], exclude_builtins: false },
    });

    const config = await loadReadOnlyProjectConfig(root);
    expect(config.capture.exclude).toEqual(['**/*.secret']);
    expect(config.capture.exclude_builtins).toBe(false);
  });

  it('reads relevant leaves from an older config and ignores unrelated fields', async () => {
    await writeConfig({
      schema_version: 4,
      llm: { default_timeout_ms: 30_000, future_llm_key: true },
      artifacts: { path: '.orcaops/legacy-artifacts', gitignore: false, future_key: true },
      cache: { path: '.orcaops/legacy-cache.db', future_key: true },
      diff_fingerprint: { enabled: false, max_diff_bytes: 123_456, future_key: true },
      review: {
        max_diff_bytes: 654_321,
        include_untracked: ['fixtures/**'],
        stub_paths: ['generated/**'],
        future_key: true,
      },
      future_root: { enabled: true },
    });

    const config = await loadReadOnlyProjectConfig(root);
    expect(config.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.artifacts.path).toBe('.orcaops/legacy-artifacts');
    expect(config.cache.path).toBe('.orcaops/legacy-cache.db');
    expect(config.diff_fingerprint.max_diff_bytes).toBe(123_456);
    expect(config.review.max_diff_bytes).toBe(654_321);
    expect(config.review.include_untracked).toEqual(['fixtures/**']);
    expect(config.review.stub_paths).toEqual([]);
    expect(config.llm).not.toHaveProperty('default_timeout_ms');
  });

  it('uses current defaults when relevant leaves are absent', async () => {
    await writeConfig({ schema_version: 999, future_root: true });

    const config = await loadReadOnlyProjectConfig(root);
    expect(config.artifacts.path).toBe('.orcaops/artifacts');
    expect(config.cache.path).toBe('.orcaops/cache/orcaops.db');
    expect(config.review.include_untracked).toEqual([]);
  });

  it.each([
    [{ artifacts: { path: '../outside' } }, 'artifacts.path'],
    [{ cache: { path: '/tmp/outside.db' } }, 'cache.path'],
    [{ review: { max_diff_bytes: 'large' } }, 'review.max_diff_bytes'],
    [{ review: 'invalid' }, 'review'],
  ])('rejects malformed relevant input %#', async (value, expectedPath) => {
    await writeConfig(value);
    await expect(loadReadOnlyProjectConfig(root)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: expectedPath,
    } satisfies Partial<ConfigValidationError>);
  });

  it('leaves strict operational config loading unchanged', async () => {
    await writeConfig({ schema_version: 4, llm: { default_timeout_ms: 30_000 } });

    await expect(loadConfig(root)).rejects.toThrow(/requires 8/);
    await expect(loadReadOnlyProjectConfig(root)).resolves.toMatchObject({
      schema_version: CONFIG_SCHEMA_VERSION,
    });
  });
});
