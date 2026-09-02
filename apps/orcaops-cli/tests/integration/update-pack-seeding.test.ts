import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * `eval update-pack` seeding: update-pack must write config entries for
 * refs a pack gained AFTER registration, so a newly-added evaluator does
 * not need a manual yaml edit to run. These tests grow a temp copy of the
 * test-pack after add-pack and assert the new refs get seeded
 * non-destructively: existing user
 * overrides — including `enabled: false` — are never touched, and the
 * seeding decision matches add-pack's deterministic default
 * (command-engine enables, llm-engine and `default_enabled: false`
 * seed off).
 */

interface YamlConfig {
  schema: string;
  packages: Array<{ id: string }>;
  evaluators: Record<string, { enabled: boolean }>;
}

async function readYaml(repoRoot: string): Promise<YamlConfig> {
  const raw = await readFile(path.join(repoRoot, '.orcaops', 'evaluators.yaml'), 'utf8');
  return parseYaml(raw) as YamlConfig;
}

describe('orcaops eval update-pack — seeds refs gained after registration', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-update-seed-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function withTempTestPack(callback: (packPath: string) => Promise<void>): Promise<void> {
    const parent = await mkdtemp(path.join(tmpRoot, 'tp-'));
    const packPath = path.join(parent, 'test-pack');
    await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
    try {
      await callback(packPath);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  it('seeds a new command-engine ref and preserves an existing user override', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);

      // A user choice update-pack must never rewrite: flip a seeded ref off.
      const configPath = path.join(repo.path, '.orcaops', 'evaluators.yaml');
      const config = await readYaml(repo.path);
      expect(config.evaluators['test-pack/pass-fixture']).toEqual({ enabled: true });
      config.evaluators['test-pack/pass-fixture'] = { enabled: false };
      await writeFile(configPath, stringifyYaml(config), 'utf8');

      // Grow the pack: a new command-engine evaluator reusing an existing
      // runtime stub (the realistic "pack gained an evaluator" case).
      await writeFile(
        path.join(packPath, 'evaluators', 'new-check.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: new-check',
          'phase: post-plan',
          'severity: info',
          'description: A ref added to the pack after registration.',
          'engine:',
          '  kind: command',
          '  command:',
          '    - node',
          '    - ./runtime/pass-fixture.mjs',
        ].join('\n'),
        'utf8'
      );
      await rm(path.join(packPath, 'evaluators', 'strict-stub.eval.yaml'));

      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as {
        ok: true;
        trust_invalidated: boolean;
        evaluators_seeded: string[];
        evaluators_seeded_disabled: string[];
        evaluators_removed: string[];
      };
      expect(env.evaluators_seeded).toEqual(['test-pack/new-check']);
      expect(env.evaluators_seeded_disabled).toEqual([]);
      expect(env.evaluators_removed).toEqual(['test-pack/strict-stub']);
      // Growing the pack also drifts the source fingerprint — the trust
      // revocation composes with seeding in the same run.
      expect(env.trust_invalidated).toBe(true);

      const after = await readYaml(repo.path);
      expect(after.evaluators['test-pack/new-check']).toEqual({ enabled: true });
      expect(after.evaluators['test-pack/strict-stub']).toBeUndefined();
      // The user override survives verbatim.
      expect(after.evaluators['test-pack/pass-fixture']).toEqual({ enabled: false });
    });
  });

  it('seeds llm-engine and default_enabled:false refs as disabled under the deterministic default', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);

      await mkdir(path.join(packPath, 'prompts'), { recursive: true });
      await writeFile(
        path.join(packPath, 'prompts', 'seeded-review.md'),
        'You are a review assistant.\n',
        'utf8'
      );
      await writeFile(
        path.join(packPath, 'evaluators', 'llm-added.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: llm-added',
          'phase: pre-pr',
          'severity: warn',
          'description: An llm-engine ref added after registration.',
          'engine:',
          '  kind: llm',
          '  additional_context_sections: []',
          '  prompt_file: ./prompts/seeded-review.md',
          '  output_format: markdown',
          'filters:',
          '  when_llm: required',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(packPath, 'evaluators', 'opt-in-added.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: opt-in-added',
          'phase: post-plan',
          'severity: info',
          'description: A default_enabled:false ref added after registration.',
          'default_enabled: false',
          'engine:',
          '  kind: command',
          '  command:',
          '    - node',
          '    - ./runtime/pass-fixture.mjs',
        ].join('\n'),
        'utf8'
      );

      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as {
        ok: true;
        evaluators_seeded: string[];
        evaluators_seeded_disabled: string[];
      };
      expect(env.evaluators_seeded).toEqual([]);
      expect(env.evaluators_seeded_disabled).toEqual([
        'test-pack/llm-added',
        'test-pack/opt-in-added',
      ]);

      const after = await readYaml(repo.path);
      expect(after.evaluators['test-pack/llm-added']).toEqual({ enabled: false });
      expect(after.evaluators['test-pack/opt-in-added']).toEqual({ enabled: false });
    });
  });
});
