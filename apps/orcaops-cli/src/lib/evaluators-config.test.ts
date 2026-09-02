import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvaluatorConfig } from '@orcaops/evaluator-protocol';

import { readEvaluatorsConfig, writeEvaluatorsConfig } from './evaluators-config.js';
import { OrcaopsError } from '../io/errors.js';

let repoRoot: string;

async function writeConfig(yaml: string): Promise<void> {
  await mkdir(path.join(repoRoot, '.orcaops'), { recursive: true });
  await writeFile(path.join(repoRoot, '.orcaops', 'evaluators.yaml'), yaml, 'utf8');
}

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-evcfg-'));
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe('readEvaluatorsConfig ingress validation', () => {
  it('returns null when the file is absent', async () => {
    expect(await readEvaluatorsConfig(repoRoot)).toBeNull();
  });

  it('returns the empty config for an empty file', async () => {
    await writeConfig('');
    const config = await readEvaluatorsConfig(repoRoot);
    expect(config).toMatchObject({ packages: [], evaluators: {} });
  });

  it('refuses a final config symlink for reads and writes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-evcfg-outside-'));
    const external = path.join(outside, 'evaluators.yaml');
    await writeFile(external, 'packages: []\nevaluators: {}\n', 'utf8');
    await mkdir(path.join(repoRoot, '.orcaops'), { recursive: true });
    await symlink(external, path.join(repoRoot, '.orcaops', 'evaluators.yaml'));

    try {
      await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/must not contain symlinks/);
      await expect(
        writeEvaluatorsConfig(repoRoot, {
          schema: 'orcaops.evaluator_config/v2',
          runtime: { max_concurrent: 4 },
          packages: [],
          evaluators: {},
        })
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readFile(external, 'utf8')).toBe('packages: []\nevaluators: {}\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a scalar root with a clear error', async () => {
    await writeConfig('just a string');
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(OrcaopsError);
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/invalid at \(root\)/);
  });

  it('rejects a sequence root with a clear error', async () => {
    await writeConfig('- a\n- b\n');
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/invalid at \(root\)/);
  });

  it('rejects a null package entry, naming the path', async () => {
    await writeConfig('schema: orcaops.evaluator_config/v2\npackages:\n  - null\nevaluators: {}\n');
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/packages\.0/);
  });

  it('rejects a wrong-typed nested value, naming the path', async () => {
    await writeConfig(
      'schema: orcaops.evaluator_config/v2\npackages: []\nevaluators:\n  core/x:\n    enabled: "yes"\n'
    );
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/evaluators\.core\/x\.enabled/);
  });

  it('rejects checked-in trust metadata instead of preserving it', async () => {
    await writeConfig(
      'schema: orcaops.evaluator_config/v2\n' +
        'packages:\n' +
        '  - id: core\n' +
        "    source: { kind: bundled, package: '@orcaops/evaluator-pack', pack: core }\n" +
        '    trusted:\n' +
        '      granted_at: 2026-01-01T00:00:00.000Z\n' +
        '      source_fingerprint: abc123\n' +
        '      trusted_warnings: [command_evaluators_present]\n' +
        'evaluators: {}\n'
    );
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toMatchObject({
      inputPath: 'packages.0',
    });
  });

  it('rejects unparseable YAML with a parse error, not a crash', async () => {
    await writeConfig('schema: [unclosed');
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/YAML parse failed/);
  });

  it.each([
    ['root', 'custom_note: reject me\npackages: []\nevaluators: {}\n'],
    [
      'package',
      'packages:\n' +
        '  - id: core\n' +
        "    source: { kind: bundled, package: '@orcaops/evaluator-pack', pack: core }\n" +
        '    annotation: reject me\n' +
        'evaluators: {}\n',
    ],
    [
      'override',
      'packages:\n' +
        '  - id: core\n' +
        "    source: { kind: bundled, package: '@orcaops/evaluator-pack', pack: core }\n" +
        'evaluators:\n' +
        '  core/x:\n' +
        '    enabled: true\n' +
        '    memo: reject me\n',
    ],
  ])('rejects unknown %s fields', async (_level, body) => {
    await writeConfig(`schema: orcaops.evaluator_config/v2\n${body}`);
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toThrow(/Unrecognized key/);
  });

  it('rejects arbitrary schema identifiers', async () => {
    await writeConfig('schema: custom/v9\npackages: []\nevaluators: {}\n');
    await expect(readEvaluatorsConfig(repoRoot)).rejects.toMatchObject({ inputPath: 'schema' });
  });

  it('validates the complete target before replacing the existing file', async () => {
    const original =
      'schema: orcaops.evaluator_config/v2\n' +
      'runtime: { max_concurrent: 2 }\n' +
      'packages: []\n' +
      'evaluators: {}\n';
    await writeConfig(original);

    const invalid = {
      schema: 'orcaops.evaluator_config/v2',
      runtime: { max_concurrent: 4 },
      packages: [],
      evaluators: { 'missing/ref': { enabled: true } },
    } as unknown as EvaluatorConfig;

    await expect(writeEvaluatorsConfig(repoRoot, invalid)).rejects.toMatchObject({
      inputPath: 'evaluators.missing/ref',
    });
    expect(await readFile(path.join(repoRoot, '.orcaops', 'evaluators.yaml'), 'utf8')).toBe(
      original
    );
  });

  it("accepts this repository's real config shape", async () => {
    await writeConfig(
      'schema: orcaops.evaluator_config/v2\n' +
        'runtime:\n  max_concurrent: 4\n' +
        'packages:\n' +
        '  - id: core\n' +
        '    source:\n' +
        '      kind: bundled\n' +
        "      package: '@orcaops/evaluator-pack'\n" +
        '      pack: core\n' +
        'evaluators:\n' +
        '  core/checkpoint-scope-density:\n' +
        '    enabled: true\n'
    );
    const config = await readEvaluatorsConfig(repoRoot);
    expect(config?.packages[0]?.id).toBe('core');
    expect(config?.evaluators['core/checkpoint-scope-density']?.enabled).toBe(true);
  });
});
