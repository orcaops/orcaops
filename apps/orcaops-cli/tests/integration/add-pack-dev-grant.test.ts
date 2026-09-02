import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { grantsFilePath, readGrants } from '../../src/lib/evaluator-grants.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * `eval add-pack --dev` — registration and a workspace-dev grant in ONE act.
 *
 * Why the flag exists: `eval trust --dev` requires the pack to already be
 * registered, and `add-pack` requires consent, so a non-interactive agent had
 * to take a fingerprint grant via `--yes` and replace it afterwards. That
 * momentarily holds exactly the durable trust the authoring skill's stop line
 * forbids — a boundary crossing observed in a real field run, not a
 * hypothetical.
 *
 * No checkpoint in this repository had previously touched `add-pack.ts`, so
 * these cases carry the whole safety burden for the change.
 */
describe('eval add-pack --dev', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;
  let packPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-addpack-dev-'));
    packPath = path.join(tmpRoot, 'test-pack');
    await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
    await rm(grantsFilePath(), { force: true });
  });

  afterEach(async () => {
    await rm(grantsFilePath(), { force: true });
    await rm(tmpRoot, { recursive: true, force: true });
    await repo.cleanup();
  });

  const configText = async (): Promise<string | null> => {
    try {
      return await readFile(path.join(repo.path, '.orcaops', 'evaluators.yaml'), 'utf8');
    } catch {
      return null;
    }
  };

  interface AddPackOk {
    ok: true;
    trust: string;
    evaluators_enabled: string[];
    evaluators_disabled: string[];
    pack: { pack_root: string };
  }

  it('writes exactly one workspace-dev grant alongside the registration', async () => {
    const res = await agent.runRaw(['eval', 'add-pack', packPath, '--dev', '--yes', '--json']);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout) as AddPackOk;

    // JSON output names the grant kind — a reader must not have to infer it.
    expect(body.trust).toBe('user-local-dev-grant');

    const { grants } = readGrants({ repoRoot: repo.path });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      kind: 'workspace-dev',
      package_id: 'test-pack',
      resolved_path: body.pack.pack_root,
    });
    // The whole point: no fingerprint grant is left behind for this pack.
    expect(grants.some((g) => g.kind === 'fingerprint')).toBe(false);

    expect(await configText()).toContain('test-pack');
  });

  it('rejects a non-path source before touching either store', async () => {
    const before = { config: await configText(), grants: readGrants({ repoRoot: repo.path }) };

    const res = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--dev',
      '--yes',
      '--json',
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('INVALID_INPUT');
    expect(res.stdout).toContain('--dev');
    // Silently downgrading to a fingerprint grant would hand back the exact
    // durable trust this flag exists to avoid, so the failure must be inert.
    expect(await configText()).toEqual(before.config);
    expect(readGrants({ repoRoot: repo.path }).grants).toEqual(before.grants.grants);
  });

  it('does not imply --yes: consent is still required, and denial writes nothing', async () => {
    const before = { config: await configText(), grants: readGrants({ repoRoot: repo.path }) };

    const res = await agent.runRaw(['eval', 'add-pack', packPath, '--dev', '--json']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('INVALID_INPUT');
    // A dev grant trusts whatever that path later becomes — MORE permissive
    // than a fingerprint grant — so skipping consent would be a regression.
    expect(readGrants({ repoRoot: repo.path }).grants).toEqual(before.grants.grants);
    expect(await configText()).toEqual(before.config);
  });

  it('does not imply --disabled: evaluators seed exactly as they do without it', async () => {
    const dev = await agent.runRaw(['eval', 'add-pack', packPath, '--dev', '--yes', '--json']);
    expect(dev.exitCode).toBe(0);
    const devBody = JSON.parse(dev.stdout) as AddPackOk;
    expect(devBody.evaluators_enabled.length).toBeGreaterThan(0);

    // Same pack, same profile, no --dev: the enabled/disabled split is
    // identical, so --dev changes the GRANT and nothing else.
    await rm(grantsFilePath(), { force: true });
    const repo2 = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent2 = makeAgent({ cwd: repo2.path });
      await agent2.init({ noLlm: true });
      const plain = await agent2.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
      expect(plain.exitCode).toBe(0);
      const plainBody = JSON.parse(plain.stdout) as AddPackOk;
      expect(devBody.evaluators_enabled).toEqual(plainBody.evaluators_enabled);
      expect(devBody.evaluators_disabled).toEqual(plainBody.evaluators_disabled);
      // Regression guard: the default path still mints a fingerprint grant.
      expect(plainBody.trust).toBe('user-local-grant');
      expect(readGrants({ repoRoot: repo2.path }).grants[0]?.kind).toBe('fingerprint');
    } finally {
      await repo2.cleanup();
    }
  });

  it('names the dev grant in human output too, not only --json', async () => {
    const res = await agent.runRaw(['eval', 'add-pack', packPath, '--dev', '--yes']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('user-local-dev-grant');
  });

  it('advertises the flag in help, so the atomic form is discoverable', async () => {
    const help = await agent.runRaw(['eval', 'add-pack', '--help']);
    expect(help.stdout).toContain('--dev');
    expect(help.stdout).toMatch(/workspace path/i);
  });
});
