import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { grantsFilePath, readGrants } from '../../src/lib/evaluator-grants.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * The consent gate's hostile-clone matrix (see docs/evaluator-consent.md).
 * Repository config is not authorization: a cloned repo arrives with its own
 * .orcaops/evaluators.yaml — declarations and enables — and none of it may
 * execute a capability-requiring evaluator without a USER-LOCAL grant.
 */

interface EvaluatorRunRow {
  evaluator_ref: string;
  run_status: 'completed' | 'error' | 'skipped';
  verdict: string | null;
  body: string;
  error?: { code: string; message: string };
}

interface CapturePlanEnvelope {
  ok: true;
  artifact_id: string;
  evaluator_results?: EvaluatorRunRow[];
}

const PLAN_INPUT = {
  task: 'consent gate exercise',
  label: 'consent gate exercise',
  plan_steps: [{ text: 'one step', label: 'one step' }],
  touched_scope: [],
  non_goals: [],
};

describe('evaluator consent gate (hostile clone matrix)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;
  let packPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-consent-'));
    packPath = path.join(tmpRoot, 'test-pack');
    await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
    // Start every test with no user-local grants.
    await rm(grantsFilePath(), { force: true });
  });

  afterEach(async () => {
    await rm(grantsFilePath(), { force: true });
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeHostileYaml(opts: { checkedInTrust?: boolean } = {}): Promise<void> {
    const trustedBlock = opts.checkedInTrust
      ? [
          '    trusted:',
          '      granted_at: 2026-01-01T00:00:00.000Z',
          `      source_fingerprint: ${'f'.repeat(64)}`,
          '      trusted_warnings:',
          '        - command_evaluators_present',
          '',
        ].join('\n')
      : '';
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      'schema: orcaops.evaluator_config/v2\n' +
        'packages:\n' +
        '  - id: test-pack\n' +
        '    source:\n' +
        '      kind: path\n' +
        `      path: ${packPath}\n` +
        trustedBlock +
        'evaluators:\n' +
        '  test-pack/pass-fixture:\n' +
        '    enabled: true\n',
      'utf8'
    );
  }

  function passFixtureRun(env: CapturePlanEnvelope): EvaluatorRunRow | undefined {
    return env.evaluator_results?.find((r) => r.evaluator_ref === 'test-pack/pass-fixture');
  }

  it('a hostile clone with no grant is refused: CONSENT_DENIED, never executed', async () => {
    await writeHostileYaml();
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-1' })),
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as CapturePlanEnvelope;
    const run = passFixtureRun(env);
    expect(run?.run_status).toBe('error');
    expect(run?.error?.code).toBe('CONSENT_DENIED');
    expect(run?.error?.message).toMatch(/orcaops eval trust test-pack/);
  });

  it('checked-in trust metadata is rejected as invalid evaluator config', async () => {
    await writeHostileYaml({ checkedInTrust: true });
    const res = await agent.runRaw(['eval', 'list', '--strict', '--json']);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: true,
      evaluators: [],
      errors: [expect.objectContaining({ field_path: 'packages.0' })],
    });
  });

  it('a forged user-local grant (wrong fingerprint) is refused as stale', async () => {
    await writeHostileYaml();
    const { grants } = readGrants({ repoRoot: repo.path });
    expect(grants).toEqual([]);
    await mkdir(path.dirname(grantsFilePath()), { recursive: true });
    await writeFile(
      grantsFilePath(),
      JSON.stringify(
        {
          v: 1,
          grants: [
            {
              kind: 'fingerprint',
              package_id: 'test-pack',
              source_fingerprint: 'f'.repeat(64),
              capabilities: ['command_evaluators_present'],
              granted_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-3' })),
    ]);
    const env = JSON.parse(res.stdout) as CapturePlanEnvelope;
    const run = passFixtureRun(env);
    expect(run?.run_status).toBe('error');
    expect(run?.error?.message).toMatch(/changed since it was granted|no user-local grant/);
  });

  it('a valid grant executes the evaluator; changing a covered runtime file invalidates it', async () => {
    await writeHostileYaml();
    const grantRes = await agent.runRaw(['eval', 'trust', 'test-pack', '--yes', '--json']);
    expect(grantRes.exitCode).toBe(0);

    const ok = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-4' })),
    ]);
    const okEnv = JSON.parse(ok.stdout) as CapturePlanEnvelope;
    expect(passFixtureRun(okEnv)?.run_status).toBe('completed');

    // Mutate a declared command file: the fingerprint-bound grant must stop working.
    const runtimeFile = path.join(packPath, 'runtime', 'pass-fixture.mjs');
    await writeFile(runtimeFile, (await readFile(runtimeFile, 'utf8')) + '\n// drift\n', 'utf8');
    const stale = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-5' })),
    ]);
    const staleEnv = JSON.parse(stale.stdout) as CapturePlanEnvelope;
    const staleRun = passFixtureRun(staleEnv);
    expect(staleRun?.run_status).toBe('error');
    expect(staleRun?.error?.message).toMatch(/changed since it was granted/);
  });

  it('a workspace-dev grant binds to the path and does not transfer to a copy', async () => {
    await writeHostileYaml();
    const grantRes = await agent.runRaw(['eval', 'trust', 'test-pack', '--dev', '--yes', '--json']);
    expect(grantRes.exitCode).toBe(0);

    const ok = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-6' })),
    ]);
    expect(passFixtureRun(JSON.parse(ok.stdout) as CapturePlanEnvelope)?.run_status).toBe(
      'completed'
    );
    // Dev grants survive source churn (that is their point)…
    const runtimeFile = path.join(packPath, 'runtime', 'pass-fixture.mjs');
    await writeFile(runtimeFile, (await readFile(runtimeFile, 'utf8')) + '\n// churn\n', 'utf8');
    const churn = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-7' })),
    ]);
    expect(passFixtureRun(JSON.parse(churn.stdout) as CapturePlanEnvelope)?.run_status).toBe(
      'completed'
    );

    // …but a CLONE of the same pack at another path inherits nothing.
    const clonePath = path.join(tmpRoot, 'cloned-pack');
    await cp(packPath, clonePath, { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      (await readFile(path.join(repo.path, '.orcaops', 'evaluators.yaml'), 'utf8')).replace(
        packPath,
        clonePath
      ),
      'utf8'
    );
    const cloned = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-8' })),
    ]);
    const clonedRun = passFixtureRun(JSON.parse(cloned.stdout) as CapturePlanEnvelope);
    expect(clonedRun?.run_status).toBe('error');
    expect(clonedRun?.error?.code).toBe('CONSENT_DENIED');
  });

  it('a file-reading LLM evaluator from an unconsented pack is refused, not skipped', async () => {
    // Build a pack whose only evaluator is llm + command-filtered tools at
    // post-plan; even under --no-llm the consent gate must refuse it loudly
    // BEFORE any filter could quietly skip it.
    const llmPack = path.join(tmpRoot, 'reader-pack');
    await mkdir(path.join(llmPack, 'evaluators'), { recursive: true });
    await mkdir(path.join(llmPack, 'prompts'), { recursive: true });
    await writeFile(
      path.join(llmPack, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: reader-pack',
        'name: reader-pack',
        'version: 0.0.1',
        'description: file-reading llm pack',
        'evaluator_dir: ./evaluators',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(llmPack, 'prompts', 'read.md'), 'Read files.\n', 'utf8');
    await writeFile(
      path.join(llmPack, 'evaluators', 'reader.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: reader',
        'phase: post-plan',
        'severity: warn',
        'description: reads repo files',
        'engine:',
        '  kind: llm',
        '  additional_context_sections: []',
        '  prompt_file: ./prompts/read.md',
        '  output_format: markdown',
        '  timeout_ms: 120000',
        '  tool_policy:',
        '    mode: command-filtered',
        'filters:',
        '  when_llm: required',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      'schema: orcaops.evaluator_config/v2\n' +
        'packages:\n' +
        '  - id: reader-pack\n' +
        '    source:\n' +
        '      kind: path\n' +
        `      path: ${llmPack}\n` +
        'evaluators:\n' +
        '  reader-pack/reader:\n' +
        '    enabled: true\n',
      'utf8'
    );
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'consent-9' })),
    ]);
    const env = JSON.parse(res.stdout) as CapturePlanEnvelope;
    const run = env.evaluator_results?.find((r) => r.evaluator_ref === 'reader-pack/reader');
    expect(run?.run_status).toBe('error');
    expect(run?.error?.code).toBe('CONSENT_DENIED');
  });

  it('a plain Claude evaluator requires an LLM grant before even a no-llm filtered run', async () => {
    const llmPack = path.join(tmpRoot, 'plain-claude-pack');
    await mkdir(path.join(llmPack, 'evaluators'), { recursive: true });
    await mkdir(path.join(llmPack, 'prompts'), { recursive: true });
    await writeFile(
      path.join(llmPack, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: plain-claude-pack',
        'name: plain-claude-pack',
        'version: 0.0.1',
        'description: plain Claude evaluator pack',
        'evaluator_dir: ./evaluators',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(llmPack, 'prompts', 'plain.md'), 'Decide.\n', 'utf8');
    await writeFile(
      path.join(llmPack, 'evaluators', 'plain.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: plain',
        'phase: post-plan',
        'severity: warn',
        'description: sends capture context to Claude',
        'engine:',
        '  kind: llm',
        '  additional_context_sections: []',
        '  provider: claude',
        '  prompt_file: ./prompts/plain.md',
        '  output_format: markdown',
        '  timeout_ms: 120000',
        'filters:',
        '  when_llm: required',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      'schema: orcaops.evaluator_config/v2\n' +
        'packages:\n' +
        '  - id: plain-claude-pack\n' +
        '    source:\n' +
        '      kind: path\n' +
        `      path: ${llmPack}\n` +
        'evaluators:\n' +
        '  plain-claude-pack/plain:\n' +
        '    enabled: true\n',
      'utf8'
    );

    const refusedResult = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'plain-claude-1' })),
    ]);
    const refused = (
      JSON.parse(refusedResult.stdout) as CapturePlanEnvelope
    ).evaluator_results?.find((run) => run.evaluator_ref === 'plain-claude-pack/plain');
    expect(refused?.error?.code).toBe('CONSENT_DENIED');

    const trustResult = await agent.runRaw([
      'eval',
      'trust',
      'plain-claude-pack',
      '--yes',
      '--json',
    ]);
    const trust = JSON.parse(trustResult.stdout) as { capabilities: string[] };
    expect(trust.capabilities).toEqual(['llm_evaluators_present']);

    const grantedResult = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'plain-claude-2' })),
    ]);
    const granted = (
      JSON.parse(grantedResult.stdout) as CapturePlanEnvelope
    ).evaluator_results?.find((run) => run.evaluator_ref === 'plain-claude-pack/plain');
    expect(granted?.run_status).toBe('skipped');
    expect(granted?.error?.code).not.toBe('CONSENT_DENIED');
  });
});

describe('implicit-codex consent (no declared provider, codex default)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;
  let packPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // ORCAOPS_CODEX_PATH points at nothing so a gate-passing evaluator reaches
    // the provider-availability skip instead of invoking a real codex install.
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CODEX_PATH: path.join(tmpdir(), 'no-such-codex-binary') },
    });
    await agent.init({ noLlm: true });
    // The repo default provider is codex — the shape under attack: an
    // evaluator declaring neither provider nor tool_policy still reaches
    // codex's file-reading tools.
    const configFile = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8')) as {
      llm?: Record<string, unknown>;
    };
    config.llm = { ...(config.llm ?? {}), tool: 'codex' };
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');

    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-implicit-codex-'));
    packPath = path.join(tmpRoot, 'implicit-pack');
    await mkdir(path.join(packPath, 'evaluators'), { recursive: true });
    await mkdir(path.join(packPath, 'prompts'), { recursive: true });
    await writeFile(
      path.join(packPath, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: implicit-pack',
        'name: implicit-pack',
        'version: 0.0.1',
        'description: implicit-provider llm pack',
        'evaluator_dir: ./evaluators',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(packPath, 'prompts', 'plain.md'), 'Decide.\n', 'utf8');
    await writeFile(
      path.join(packPath, 'evaluators', 'plain.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: plain',
        'phase: post-plan',
        'severity: warn',
        'description: declares neither provider nor tool_policy',
        'engine:',
        '  kind: llm',
        '  additional_context_sections: []',
        '  prompt_file: ./prompts/plain.md',
        '  output_format: markdown',
        '  timeout_ms: 120000',
        'filters:',
        '  when_llm: required',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      'schema: orcaops.evaluator_config/v2\n' +
        'packages:\n' +
        '  - id: implicit-pack\n' +
        '    source:\n' +
        '      kind: path\n' +
        `      path: ${packPath}\n` +
        'evaluators:\n' +
        '  implicit-pack/plain:\n' +
        '    enabled: true\n',
      'utf8'
    );
    await rm(grantsFilePath(), { force: true });
  });

  afterEach(async () => {
    await rm(grantsFilePath(), { force: true });
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('is grantable end to end: refused ungranted, eval trust records file-reading, dispatch then passes the gate', async () => {
    // Ungranted: the gate follows the EFFECTIVE provider and refuses.
    const first = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'implicit-codex-1' })),
    ]);
    const firstEnv = JSON.parse(first.stdout) as CapturePlanEnvelope;
    const refused = firstEnv.evaluator_results?.find(
      (r) => r.evaluator_ref === 'implicit-pack/plain'
    );
    expect(refused?.run_status).toBe('error');
    expect(refused?.error?.code).toBe('CONSENT_DENIED');

    // eval trust classifies with the same effective provider, so the
    // file-reading capability is offered and recorded — this exact grant was
    // previously impossible ("nothing to grant"), a permanent deadlock.
    const trustRes = await agent.runRaw(['eval', 'trust', 'implicit-pack', '--yes', '--json']);
    expect(trustRes.exitCode).toBe(0);
    const trustOut = JSON.parse(trustRes.stdout) as {
      ok: true;
      granted: boolean;
      capabilities: string[];
    };
    expect(trustOut.granted).toBe(true);
    expect(trustOut.capabilities).toContain('file_reading_llm_evaluator_present');
    const { grants } = readGrants({ repoRoot: repo.path });
    expect(grants[0]?.capabilities).toContain('file_reading_llm_evaluator_present');

    // Granted: the consent gate passes before provider availability produces
    // the visible skip.
    const second = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'implicit-codex-2' })),
    ]);
    const secondEnv = JSON.parse(second.stdout) as CapturePlanEnvelope;
    const granted = secondEnv.evaluator_results?.find(
      (r) => r.evaluator_ref === 'implicit-pack/plain'
    );
    expect(granted).toBeDefined();
    expect(granted?.run_status).toBe('skipped');
    expect(granted?.error?.code).not.toBe('CONSENT_DENIED');
    expect(granted?.body).toContain('resolved provider codex is not installed');
  });

  it('clearing a Claude pack pin requires re-trust before the unavailable Codex provider can skip', async () => {
    const specPath = path.join(packPath, 'evaluators', 'plain.eval.yaml');
    const spec = await readFile(specPath, 'utf8');
    await writeFile(specPath, spec.replace('  kind: llm\n', '  kind: llm\n  provider: claude\n'));
    const initialTrustResult = await agent.runRaw([
      'eval',
      'trust',
      'implicit-pack',
      '--yes',
      '--json',
    ]);
    const initialTrust = JSON.parse(initialTrustResult.stdout) as { capabilities: string[] };
    expect(initialTrust.capabilities).toEqual(['llm_evaluators_present']);

    const evaluatorConfig = path.join(repo.path, '.orcaops', 'evaluators.yaml');
    const yaml = await readFile(evaluatorConfig, 'utf8');
    await writeFile(
      evaluatorConfig,
      yaml.replace(
        '  implicit-pack/plain:\n    enabled: true\n',
        '  implicit-pack/plain:\n' +
          '    enabled: true\n' +
          '    engine:\n' +
          '      provider: null\n'
      )
    );

    const refusedResult = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'cleared-provider-1' })),
    ]);
    const refused = (
      JSON.parse(refusedResult.stdout) as CapturePlanEnvelope
    ).evaluator_results?.find((run) => run.evaluator_ref === 'implicit-pack/plain');
    expect(refused?.error?.code).toBe('CONSENT_DENIED');
    expect(refused?.error?.message).toContain('.orcaops/evaluators.yaml provider override');
    expect(refused?.error?.message).toContain('repository config cannot authorize');

    const retrustResult = await agent.runRaw(['eval', 'trust', 'implicit-pack', '--yes', '--json']);
    const retrust = JSON.parse(retrustResult.stdout) as { capabilities: string[] };
    expect(retrust.capabilities).toContain('llm_evaluators_present');
    expect(retrust.capabilities).toContain('file_reading_llm_evaluator_present');

    const skippedResult = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ ...PLAN_INPUT, idempotency_key: 'cleared-provider-2' })),
    ]);
    const skipped = (
      JSON.parse(skippedResult.stdout) as CapturePlanEnvelope
    ).evaluator_results?.find((run) => run.evaluator_ref === 'implicit-pack/plain');
    expect(skipped?.run_status).toBe('skipped');
    expect(skipped?.body).toContain('resolved provider codex is not installed');
    expect(skipped?.body).toContain(
      'provider pin cleared by your .orcaops/evaluators.yaml override; selected from global llm.tool'
    );
  });
});
