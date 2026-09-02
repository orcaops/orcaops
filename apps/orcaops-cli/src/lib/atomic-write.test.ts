import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvaluatorConfig } from '@orcaops/evaluator-protocol';

import { atomicWriteFile } from './atomic-write.js';
import {
  CONFIG_YAML_HEADER,
  emptyEvaluatorsConfig,
  evaluatorsConfigPath,
  readEvaluatorsConfig,
  writeEvaluatorsConfig,
} from './evaluators-config.js';

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-atomic-write-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips content', async () => {
    const target = path.join(dir, 'file.txt');
    await atomicWriteFile(target, 'hello world');
    expect(await readFile(target, 'utf8')).toBe('hello world');
  });

  it('creates missing parent directories', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'file.txt');
    await atomicWriteFile(target, 'created');
    expect(await readFile(target, 'utf8')).toBe('created');
  });

  it('overwrites an existing file', async () => {
    const target = path.join(dir, 'file.txt');
    await atomicWriteFile(target, 'first');
    await atomicWriteFile(target, 'second');
    expect(await readFile(target, 'utf8')).toBe('second');
  });

  it('leaves no temp sibling after a successful write', async () => {
    const target = path.join(dir, 'file.txt');
    await atomicWriteFile(target, 'done');
    const entries = await readdir(dir);
    expect(entries).toEqual(['file.txt']);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
  });

  it('cleans up the temp sibling when the write fails', async () => {
    // Point the target at an existing directory so the final rename fails
    // (EISDIR/ENOTEMPTY) after the temp file is already written.
    const target = path.join(dir, 'a-directory');
    await mkdir(target, { recursive: true });

    await expect(atomicWriteFile(target, 'data')).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    // The directory target is untouched by the failed write.
    expect(entries).toContain('a-directory');
  });

  it('preserves the target and cleans up when a pre-rename guard fails', async () => {
    const target = path.join(dir, 'guarded.txt');
    await writeFile(target, 'original', 'utf8');

    await expect(
      atomicWriteFile(target, 'replacement', {
        beforeRename: async () => {
          throw new Error('changed');
        },
      })
    ).rejects.toThrow('changed');

    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await readdir(dir)).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });
});

describe('writeEvaluatorsConfig (atomic)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-eval-config-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('round-trips config and preserves the canonical header', async () => {
    const config: EvaluatorConfig = {
      ...emptyEvaluatorsConfig(),
      packages: [{ id: 'demo-pack', source: { kind: 'path', path: './evaluators/demo' } }],
      evaluators: { 'demo-pack/some-eval': { enabled: false } },
    };

    await writeEvaluatorsConfig(repoRoot, config);

    // Raw file keeps the header comment.
    const raw = await readFile(evaluatorsConfigPath(repoRoot), 'utf8');
    expect(raw.startsWith(CONFIG_YAML_HEADER)).toBe(true);
    expect(CONFIG_YAML_HEADER).toContain('https://orcaops.dev/evaluators');
    expect(CONFIG_YAML_HEADER).not.toContain('/docs/evaluators-config');

    // Parsed round-trip preserves the meaningful content.
    const read = await readEvaluatorsConfig(repoRoot);
    expect(read).not.toBeNull();
    expect(read?.packages).toEqual(config.packages);
    expect(read?.evaluators).toEqual(config.evaluators);
    expect(read?.schema).toBe(config.schema);
  });

  it('creates .orcaops/ on write and leaves no temp file behind', async () => {
    await writeEvaluatorsConfig(repoRoot, emptyEvaluatorsConfig());
    const orcaopsDir = path.join(repoRoot, '.orcaops');
    const entries = await readdir(orcaopsDir);
    expect(entries).toContain('evaluators.yaml');
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
  });
});
