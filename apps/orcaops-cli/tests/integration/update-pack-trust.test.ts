import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { readGrants } from '../../src/lib/evaluator-grants.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * Trust-invalidation tests for `orcaops eval update-pack`.
 *
 * Five cases:
 *
 *   1. Mutated declared runtime invalidates trust + emits a covered-file notice.
 *   2. No-change run leaves trust intact + does NOT touch yaml mtime.
 *   3. Command evaluators replaced with an LLM-only pack → changed covered
 *      files invalidate the grant; the replacement still requires LLM consent.
 *   4. Removing every capability-requiring evaluator revokes the obsolete
 *      grant and reports capability removal.
 *   5. A repo-contained grant store is refused without permission repair.
 *
 * Mutation tests work on per-test temp copies of
 * the workspace test-pack — never the shared `tests/fixtures/test-pack/`
 * directly. `withTempTestPack` provides the helper.
 */

async function getYamlMtimeMs(repoRoot: string): Promise<number> {
  const st = await stat(path.join(repoRoot, '.orcaops', 'evaluators.yaml'));
  return st.mtimeMs;
}

describe('orcaops eval update-pack — trust invalidation', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-update-trust-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function currentGrants() {
    return readGrants({ repoRoot: repo.path }).grants;
  }

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

  it('mutated declared runtime file invalidates the grant with a covered-file notice', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeDefined();

      // Mutate runtime bytes; update-pack should detect the
      // fingerprint mismatch and revoke the user-local grant.
      const runtimeFile = path.join(packPath, 'runtime', 'api-stub.mjs');
      const original = await readFile(runtimeFile, 'utf8');
      await writeFile(runtimeFile, original + '\n// mutation marker\n', 'utf8');

      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as {
        ok: true;
        trust_invalidated: boolean;
        note: string;
      };
      expect(env.trust_invalidated).toBe(true);
      expect(updateRes.stderr).toMatch(/covered pack files that changed/i);
      expect(updateRes.stderr).toMatch(/orcaops eval trust test-pack/);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeUndefined();
    });
  });

  it('no-change run leaves the grant intact and does not bump yaml mtime', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);
      const before = currentGrants().find((g) => g.package_id === 'test-pack');
      expect(before?.kind).toBe('fingerprint');
      const fpBefore = before?.kind === 'fingerprint' ? before.source_fingerprint : undefined;
      expect(fpBefore).toMatch(/^[0-9a-f]{64}$/);
      const mtimeBefore = await getYamlMtimeMs(repo.path);

      // Briefly wait to ensure mtime granularity isn't a false negative.
      await new Promise((r) => setTimeout(r, 25));
      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as { ok: true; trust_invalidated: boolean };
      expect(env.trust_invalidated).toBe(false);

      const after = currentGrants().find((g) => g.package_id === 'test-pack');
      const fpAfter = after?.kind === 'fingerprint' ? after.source_fingerprint : undefined;
      expect(fpAfter).toBe(fpBefore);
      expect(after?.granted_at).toBe(before?.granted_at);

      const mtimeAfter = await getYamlMtimeMs(repo.path);
      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'does not repair a configured grant store inside the repository',
    async () => {
      await withTempTestPack(async (packPath) => {
        const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
        expect(installRes.exitCode).toBe(0);

        const insideDir = path.join(repo.path, '.repo-controlled-grants');
        await mkdir(insideDir);
        await chmod(insideDir, 0o755);
        vi.stubEnv('ORCAOPS_CONFIG_HOME', insideDir);
        try {
          const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);

          expect(updateRes.exitCode).toBe(0);
          expect(updateRes.stderr).toMatch(/outside the repository/);
          expect((await stat(insideDir)).mode & 0o777).toBe(0o755);
        } finally {
          vi.unstubAllEnvs();
        }
      });
    }
  );

  it('replacing command evaluators with LLM evaluators revokes the changed-source grant', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeDefined();

      // Replace the pack contents with a valid no-command pack: same
      // manifest id (so the registered entry still points at it),
      // single LLM-engine evaluator, prompt file inside the pack root.
      // Must be a valid pack, not just an `engine.kind:
      // llm` mutation that fails validatePack.
      await rm(path.join(packPath, 'evaluators'), { recursive: true, force: true });
      await rm(path.join(packPath, 'runtime'), { recursive: true, force: true });
      await mkdir(path.join(packPath, 'evaluators'), { recursive: true });
      await mkdir(path.join(packPath, 'prompts'), { recursive: true });
      // Keep the same package id so the registered entry resolves.
      await writeFile(
        path.join(packPath, 'package.yaml'),
        [
          'schema: orcaops.evaluator_package/v1',
          'id: test-pack',
          'name: test-pack',
          'version: 0.0.2',
          'description: LLM-only replacement',
          'evaluator_dir: ./evaluators',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(packPath, 'prompts', 'review.md'),
        'You are a code review assistant.\n',
        'utf8'
      );
      await writeFile(
        path.join(packPath, 'evaluators', 'llm-stub.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: llm-stub',
          'phase: pre-pr',
          'severity: warn',
          'description: LLM replacement stub',
          'engine:',
          '  kind: llm',
          '  additional_context_sections: []',
          '  prompt_file: ./prompts/review.md',
          '  output_format: markdown',
          'filters:',
          '  when_llm: required',
        ].join('\n'),
        'utf8'
      );

      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as {
        ok: true;
        trust_invalidated: boolean;
        note: string;
      };
      expect(env.trust_invalidated).toBe(true);
      expect(updateRes.stderr).toMatch(/covered pack files that changed since trust was granted/i);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeUndefined();
    });
  });

  it('removing every evaluator revokes a grant that no longer authorizes a capability', async () => {
    await withTempTestPack(async (packPath) => {
      const installRes = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(installRes.exitCode).toBe(0);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeDefined();

      await rm(path.join(packPath, 'evaluators'), { recursive: true, force: true });
      await rm(path.join(packPath, 'runtime'), { recursive: true, force: true });
      await mkdir(path.join(packPath, 'evaluators'), { recursive: true });
      await writeFile(
        path.join(packPath, 'package.yaml'),
        [
          'schema: orcaops.evaluator_package/v1',
          'id: test-pack',
          'name: test-pack',
          'version: 0.0.2',
          'description: deterministic-empty replacement',
          'evaluator_dir: ./evaluators',
        ].join('\n'),
        'utf8'
      );

      const updateRes = await agent.runRaw(['eval', 'update-pack', 'test-pack', '--json']);
      expect(updateRes.exitCode).toBe(0);
      const env = JSON.parse(updateRes.stdout) as {
        ok: true;
        trust_invalidated: boolean;
        note: string;
      };
      expect(env.trust_invalidated).toBe(true);
      expect(env.note).toMatch(/no command or LLM evaluators remain/i);
      expect(updateRes.stderr).toMatch(/no longer requires evaluator trust/i);
      expect(currentGrants().find((g) => g.package_id === 'test-pack')).toBeUndefined();
    });
  });
});
