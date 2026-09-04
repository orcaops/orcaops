import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { readGrants } from '../../src/lib/evaluator-grants.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * Trust prompt tests (in-process, non-interactive).
 *
 * Covers four prompt-path cases that can run inside InProcessAgent
 * without needing real stdin:
 *
 *   1. `--yes` bypass: trust grant + fingerprint persisted.
 *   2. JSON-without-yes rejects: structured OrcaopsError.
 *   3. LLM-only pack requires explicit consent and records its capability.
 *   4. `--force` re-grants stale trust by replacing the user-local grant.
 *
 * Interactive Y/N cases live in `tests/smoke/add-pack-trust.test.ts` since
 * InProcessAgent rejects stdin (see in-process-agent.ts). Fork containment
 * stays here to avoid changing the exported test-file inventory.
 */

interface YamlPackEntry {
  id: string;
  source: { kind: string; path?: string; package?: string; pack?: string };
}
interface YamlConfig {
  schema: string;
  packages: YamlPackEntry[];
  evaluators: Record<string, unknown>;
}

async function readYaml(repoRoot: string): Promise<YamlConfig> {
  const raw = await readFile(path.join(repoRoot, '.orcaops', 'evaluators.yaml'), 'utf8');
  return parseYaml(raw) as YamlConfig;
}

describe('orcaops eval add-pack — trust prompt (in-process)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true, scope: 'project' });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-trust-cli-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Copy the workspace test-pack to a temp dir so tests can mutate
   * runtime bytes without disturbing the shared fixture.
   */
  async function freshTestPack(): Promise<string> {
    const packPath = path.join(tmpRoot, `pack-${Math.random().toString(36).slice(2)}`);
    await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
    return packPath;
  }

  /**
   * Build a minimal LLM-only pack. It still sends capture context through the
   * user's authenticated provider, so its `llm_evaluators_present` warning is
   * consent-gated even without command or file-reading capabilities.
   */
  async function buildLlmOnlyPack(): Promise<string> {
    const packPath = path.join(tmpRoot, `llm-only-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(packPath, 'evaluators'), { recursive: true });
    await mkdir(path.join(packPath, 'prompts'), { recursive: true });
    await writeFile(
      path.join(packPath, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: llm-only-pack',
        'name: llm-only-pack',
        'version: 0.0.1',
        'description: LLM-only test pack',
        'evaluator_dir: ./evaluators',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(packPath, 'prompts', 'test.md'), 'You are a test prompt.\n', 'utf8');
    await writeFile(
      path.join(packPath, 'evaluators', 'llm-stub.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: llm-stub',
        'phase: pre-pr',
        'severity: warn',
        'description: LLM-only stub',
        'engine:',
        '  kind: llm',
        '  additional_context_sections: []',
        '  prompt_file: ./prompts/test.md',
        '  output_format: markdown',
        'filters:',
        '  when_llm: required',
      ].join('\n'),
      'utf8'
    );
    return packPath;
  }

  it('--yes bypass: a USER-LOCAL fingerprint grant is written, never a yaml block', async () => {
    const packPath = await freshTestPack();
    const r = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
    expect(r.exitCode).toBe(0);
    // Repository config is not authorization: the yaml entry carries NO trust.
    const yaml = await readYaml(repo.path);
    const entry = yaml.packages.find((p) => p.id === 'test-pack');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('trusted');
    // The grant lives in the hermetic user-local store.
    const { grants } = readGrants({ repoRoot: repo.path });
    const grant = grants.find((g) => g.package_id === 'test-pack');
    expect(grant?.kind).toBe('fingerprint');
    expect(grant?.capabilities).toEqual(['command_evaluators_present']);
    if (grant?.kind === 'fingerprint') {
      expect(grant.source_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('JSON-without-yes rejects with structured INVALID_INPUT mentioning --yes', async () => {
    const packPath = await freshTestPack();
    const r = await agent.runRaw(['eval', 'add-pack', packPath, '--json']);
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/--yes/);
  });

  it('LLM-only pack requires --yes and persists the LLM capability', async () => {
    const packPath = await buildLlmOnlyPack();
    const refused = await agent.runRaw(['eval', 'add-pack', packPath, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain('--yes');

    const accepted = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
    expect(accepted.exitCode).toBe(0);
    const grant = readGrants({ repoRoot: repo.path }).grants.find(
      (candidate) => candidate.package_id === 'llm-only-pack'
    );
    expect(grant?.capabilities).toEqual(['llm_evaluators_present']);
  });

  it('deterministic and all profiles differ for LLM evaluators', async () => {
    const packPath = await buildLlmOnlyPack();

    const deterministic = await agent.runRaw([
      'eval',
      'add-pack',
      packPath,
      '--profile',
      'deterministic',
      '--yes',
      '--json',
    ]);
    expect(deterministic.exitCode).toBe(0);
    expect((await readYaml(repo.path)).evaluators['llm-only-pack/llm-stub']).toEqual({
      enabled: false,
    });

    const all = await agent.runRaw([
      'eval',
      'add-pack',
      packPath,
      '--force',
      '--profile',
      'all',
      '--yes',
      '--json',
    ]);
    expect(all.exitCode).toBe(0);
    expect((await readYaml(repo.path)).evaluators['llm-only-pack/llm-stub']).toEqual({
      enabled: true,
    });
  });

  it('--force re-grants stale trust with the recomputed fingerprint (user-local)', async () => {
    const packPath = await freshTestPack();
    const r1 = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
    expect(r1.exitCode).toBe(0);
    const before = readGrants({ repoRoot: repo.path }).grants.find(
      (g) => g.package_id === 'test-pack'
    );
    expect(before?.kind).toBe('fingerprint');
    const fpBefore = before?.kind === 'fingerprint' ? before.source_fingerprint : undefined;
    expect(fpBefore).toMatch(/^[0-9a-f]{64}$/);

    // Mutate a declared command file's bytes so the pack-file fingerprint shifts.
    const runtimeFile = path.join(packPath, 'runtime', 'api-stub.mjs');
    const original = await readFile(runtimeFile, 'utf8');
    await writeFile(runtimeFile, original + '\n// mutation marker\n', 'utf8');

    const r2 = await agent.runRaw(['eval', 'add-pack', packPath, '--force', '--yes', '--json']);
    expect(r2.exitCode).toBe(0);
    const after = readGrants({ repoRoot: repo.path }).grants.find(
      (g) => g.package_id === 'test-pack'
    );
    const fpAfter = after?.kind === 'fingerprint' ? after.source_fingerprint : undefined;
    expect(fpAfter).toMatch(/^[0-9a-f]{64}$/);
    expect(fpAfter).not.toBe(fpBefore);
  });

  it('fork-pack refuses a relative redirect and accepts an explicit absolute target', async () => {
    const added = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);
    const outside = path.join(tmpRoot, 'fork-output');
    await mkdir(outside);
    await symlink(outside, path.join(repo.path, 'forks'));

    const rejected = await agent.runRaw([
      'eval',
      'fork-pack',
      'core',
      '--to',
      'forks/core',
      '--json',
    ]);

    expect(rejected.exitCode).toBe(1);
    expect(await readdir(outside)).toEqual([]);
    const unchanged = await readYaml(repo.path);
    expect(unchanged.packages.find((entry) => entry.id === 'core')?.source.kind).toBe('bundled');

    const absoluteTarget = path.join(outside, 'core');
    const accepted = await agent.runRaw([
      'eval',
      'fork-pack',
      'core',
      '--to',
      absoluteTarget,
      '--json',
    ]);

    expect(accepted.exitCode).toBe(0);
    expect((JSON.parse(accepted.stdout) as { grant_revoked: boolean }).grant_revoked).toBe(true);
    expect(
      readGrants({ repoRoot: repo.path }).grants.find(
        (candidate) => candidate.package_id === 'core'
      )
    ).toBeUndefined();
    expect(await readFile(path.join(absoluteTarget, 'package.yaml'), 'utf8')).toContain('id: core');
  });
});
