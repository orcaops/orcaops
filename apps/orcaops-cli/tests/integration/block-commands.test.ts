import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDefaultConfig, uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture, grantEvaluatorPack, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

const writerInterception = vi.hoisted(() => ({ beforeOpen: null as null | (() => Promise<void>) }));
vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/storage/history/database')>();
  return {
    ...actual,
    openProjectDatabase: async (...args: Parameters<typeof actual.openProjectDatabase>) => {
      if (args[0].mode === 'writer' && writerInterception.beforeOpen) {
        const run = writerInterception.beforeOpen;
        writerInterception.beforeOpen = null;
        await run();
      }
      return actual.openProjectDatabase(...args);
    },
  };
});

interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string };
}

interface AckOk {
  ok: true;
  artifact_id: string;
  evaluator: string;
  action: 'acknowledged';
  acknowledged_at: string;
}

interface DismissOk {
  ok: true;
  artifact_id: string;
  evaluator: string;
  action: 'dismissed';
  dismissed_at: string;
}

describe('orcaops block acknowledge / dismiss', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let repo: { path: string };
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    writerInterception.beforeOpen = null;
    f = await fixture();
    repo = { path: f.main };
    const config = getDefaultConfig();
    config.llm.tool = 'none';
    config.install.scope = 'project';
    await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
    await writeFile(path.join(f.main, '.orcaops', 'config.json'), JSON.stringify(config));
    const { configDir } = await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK_ABS_PATH,
      enable: { 'test-pack/api-stub': false, 'test-pack/strict-stub': false },
    });
    agent = makeAgent({
      cwd: f.main,
      env: {
        ORCAOPS_ROOT: f.main,
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_CONFIG_HOME: configDir,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
  });

  async function capturePlan() {
    return { artifact_id: await f.capture() };
  }

  async function plantBlockViolation(input: {
    cwd: string;
    artifactId: string;
    evaluatorRef: string;
    idempotencyKey?: string;
  }) {
    const payload = {
      schema: 'orcaops.evaluator_run/v1' as const,
      run_id: uuidv7(),
      artifact_id: input.artifactId,
      evaluator_ref: input.evaluatorRef,
      package_id: input.evaluatorRef.split('/')[0],
      evaluator_id: input.evaluatorRef.split('/')[1],
      phase: 'pre-pr' as const,
      severity: 'block' as const,
      run_status: 'completed' as const,
      verdict: 'violation' as const,
      body: 'VIOLATION\n\nExplicit fixture violation',
      ts: new Date().toISOString(),
    };
    await f.mutate(input.artifactId, payload, (semantics) =>
      semantics.writeEvaluatorRunPayload(input.artifactId, payload, {
        idempotencyKey: input.idempotencyKey,
      })
    );
    return payload.run_id;
  }

  async function resolveBlock(
    artifactId: string,
    key: string,
    options: {
      verb?: string;
      reason?: string;
      evaluator?: string;
      runId?: string;
      session?: string;
    } = {}
  ) {
    const result = await agent.runRaw([
      'block',
      options.verb ?? 'dismiss',
      '--artifact',
      artifactId,
      '--evaluator',
      options.evaluator ?? 'test-pack/api-stub',
      '--reason',
      options.reason ?? 'Intentional resolution',
      '--idempotency-key',
      key,
      ...(options.runId === undefined ? [] : ['--run-id', options.runId]),
      ...(options.session === undefined ? [] : ['--agent-session-id', options.session]),
    ]);
    return { ...result, value: JSON.parse(result.stdout) };
  }

  it('replays the original resolution after a newer blocking run without changing retained state', async () => {
    const artifactId = await f.capture();
    const runId = await plantBlockViolation({
      cwd: f.main,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
    });
    const key = uuidv7();
    const first = await resolveBlock(artifactId, key);
    expect(first.exitCode, first.stdout).toBe(0);
    await plantBlockViolation({ cwd: f.main, artifactId, evaluatorRef: 'test-pack/api-stub' });
    const before = await inventory(f.temporary);
    const replay = await resolveBlock(artifactId, key);
    expect(replay.exitCode, replay.stdout).toBe(0);
    expect(replay.value).toMatchObject({ run_id: runId, dismissed_at: first.value.dismissed_at });
    expect(await inventory(f.temporary)).toEqual(before);

    const explicitReplay = await resolveBlock(artifactId, key, { runId });
    expect(explicitReplay.value).toEqual(replay.value);
    expect(await inventory(f.temporary)).toEqual(before);

    for (const changed of [
      { reason: 'Different reason' },
      { evaluator: 'test-pack/strict-stub' },
      { verb: 'acknowledge' },
      { session: 'Different session' },
      { runId: uuidv7() },
    ]) {
      const conflict = await resolveBlock(artifactId, key, changed);
      expect(conflict.value).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(await inventory(f.temporary)).toEqual(before);
    }
  });

  it('scopes retry keys to disposition events and normalizes only the reason', async () => {
    const artifactId = await f.capture();
    const key = uuidv7();
    const runId = await plantBlockViolation({
      cwd: f.main,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
      idempotencyKey: key,
    });
    const first = await resolveBlock(artifactId, key, {
      runId,
      reason: 'Intentional\u0001 resolution',
    });
    expect(first.value).toMatchObject({ ok: true, run_id: runId });
    const before = await inventory(f.temporary);
    const replay = await resolveBlock(artifactId, key);
    expect(replay.value).toEqual(first.value);
    expect(await inventory(f.temporary)).toEqual(before);
    expect(
      readProjectArtifact(f.writer, artifactId)!.thread.events.filter(
        (event) => event.record.idempotency_key === key
      )
    ).toHaveLength(2);
  });

  it('rejects control characters in identifiers before opening a writer', async () => {
    const artifactId = await f.capture();
    const runId = await plantBlockViolation({
      cwd: f.main,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
    });
    const key = uuidv7();
    const before = await inventory(f.temporary);
    const beforeOpen = vi.fn(async () => undefined);
    writerInterception.beforeOpen = beforeOpen;
    for (const [artifact, retryKey, options] of [
      [`${artifactId}\u0001`, key, {}],
      [artifactId, `${key}\u0001`, {}],
      [artifactId, key, { evaluator: 'test-pack/api-stub\u0001' }],
      [artifactId, key, { runId: `${runId}\u0001` }],
      [artifactId, key, { session: 'session\u0001' }],
    ] as const) {
      const result = await resolveBlock(artifact, retryKey, options);
      expect(result.value).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await inventory(f.temporary)).toEqual(before);
    }
    expect(beforeOpen).not.toHaveBeenCalled();
  });

  it('does not retarget a resolution when a newer blocking run lands during preparation', async () => {
    const artifactId = await f.capture();
    await plantBlockViolation({ cwd: f.main, artifactId, evaluatorRef: 'test-pack/api-stub' });
    let afterConcurrentWrite: Awaited<ReturnType<typeof inventory>> | undefined;
    writerInterception.beforeOpen = async () => {
      await plantBlockViolation({ cwd: f.main, artifactId, evaluatorRef: 'test-pack/api-stub' });
      afterConcurrentWrite = await inventory(f.temporary);
    };
    const result = await resolveBlock(artifactId, uuidv7());
    expect(result.value).toMatchObject({ ok: false, error: { code: 'NO_BLOCKING_RUN' } });
    expect(afterConcurrentWrite).toBeDefined();
    expect(await inventory(f.temporary)).toEqual(afterConcurrentWrite);
  });

  it('returns a concurrent committed resolution with its original timestamp', async () => {
    const artifactId = await f.capture();
    const runId = await plantBlockViolation({
      cwd: f.main,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
    });
    const key = uuidv7();
    const ts = '2026-09-06T00:00:00.000Z';
    writerInterception.beforeOpen = async () => {
      const payload = {
        schema: 'orcaops.evaluator_disposition/v1' as const,
        disposition_id: uuidv7(),
        artifact_id: artifactId,
        run_id: runId,
        evaluator_ref: 'test-pack/api-stub',
        disposition: 'dismissed' as const,
        reason: 'Intentional resolution',
        agent_session_id: null,
        ts,
      };
      await f.mutate(artifactId, payload, (semantics) =>
        semantics.writeEvaluatorDisposition(artifactId, payload, { idempotencyKey: key })
      );
    };
    const result = await resolveBlock(artifactId, key);
    expect(result.value).toMatchObject({ ok: true, run_id: runId, dismissed_at: ts });
    expect(
      readProjectArtifact(f.writer, artifactId)!.thread.events.filter(
        (event) => event.record.type === 'evaluator_disposition_recorded'
      )
    ).toHaveLength(1);
  });

  it('refuses secrets before writer admission and never replaces missing registered history', async () => {
    const artifactId = await f.capture();
    await plantBlockViolation({ cwd: f.main, artifactId, evaluatorRef: 'test-pack/api-stub' });
    const before = await inventory(f.temporary);
    writerInterception.beforeOpen = async () => {
      throw new Error('Writer must remain unopened');
    };
    const secret = await resolveBlock(artifactId, uuidv7(), { reason: 'AKIAIOSFODNN7EXAMPLE' });
    expect(secret.value).toMatchObject({ ok: false, error: { code: 'SECRET_IN_PAYLOAD' } });
    expect(await inventory(f.temporary)).toEqual(before);
    expect(writerInterception.beforeOpen).not.toBeNull();
    writerInterception.beforeOpen = null;
    f.writer.close();
    await rm(f.writer.databasePath);
    const missing = await inventory(f.temporary);
    const result = await resolveBlock(artifactId, uuidv7());
    expect(result.value).toMatchObject({ ok: false, error: { code: 'HISTORY_MISSING' } });
    expect(await inventory(f.temporary)).toEqual(missing);
  });

  describe('block acknowledge', () => {
    it('acknowledges a block when the evaluator opts in via on_block', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'test-pack/api-stub',
      });
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'intentional removal',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const env = JSON.parse(res.stdout) as AckOk;
      expect(env.ok).toBe(true);
      expect(env.action).toBe('acknowledged');
      expect(env.evaluator).toBe('test-pack/api-stub');
    });

    it('rejects with BLOCK_NOT_ACKNOWLEDGEABLE for evaluators that do NOT opt in', async () => {
      // test-pack/strict-stub is severity=block but does NOT have
      // resolution.acknowledge.enabled set; the install-time
      // discovery resolves the ref, and the acknowledge command
      // rejects with BLOCK_NOT_ACKNOWLEDGEABLE.
      const plan = await capturePlan();
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/strict-stub',
        '--reason',
        'I want this',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('BLOCK_NOT_ACKNOWLEDGEABLE');
      expect(env.error.message).toMatch(/orcaops block dismiss/);
    });

    it('rejects with EVALUATOR_NOT_FOUND for an unknown evaluator name', async () => {
      const plan = await capturePlan();
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'does-not-exist',
        '--reason',
        'r',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('EVALUATOR_NOT_FOUND');
    });

    it('does not allow acknowledging the lifecycle evaluator inventory', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'orcaops/lifecycle-evaluator-inventory',
      });
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'orcaops/lifecycle-evaluator-inventory',
        '--reason',
        'r',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('EVALUATOR_NOT_FOUND');
    });

    it('rejects with UNKNOWN_ARTIFACT for an unknown artifact id', async () => {
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        'nonexistent',
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'r',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('UNKNOWN_ARTIFACT');
    });
  });

  describe('block dismiss', () => {
    it('dismisses a block-severity evaluator regardless of on_block opt-in', async () => {
      // test-pack/strict-stub is severity=block with no acknowledge
      // opt-in. block dismiss is the always-available resolution path
      // and must succeed regardless of the spec's acknowledge config.
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'test-pack/strict-stub',
      });

      const res = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/strict-stub',
        '--reason',
        'false positive',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const env = JSON.parse(res.stdout) as DismissOk;
      expect(env.ok).toBe(true);
      expect(env.action).toBe('dismissed');
    });

    it('dismisses the built-in lifecycle evaluator inventory', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'orcaops/lifecycle-evaluator-inventory',
      });

      const res = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'orcaops/lifecycle-evaluator-inventory',
        '--reason',
        'inventory recovered',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const env = JSON.parse(res.stdout) as DismissOk;
      expect(env.ok).toBe(true);
      expect(env.action).toBe('dismissed');
      expect(env.evaluator).toBe('orcaops/lifecycle-evaluator-inventory');
    });

    it('rejects unknown evaluator refs even when they have a blocking run', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'unknown-pack/unknown-evaluator',
      });

      const res = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'unknown-pack/unknown-evaluator',
        '--reason',
        'r',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('EVALUATOR_NOT_FOUND');
    });

    it('rejects with INVALID_INPUT when dismissing a non-block evaluator', async () => {
      // Install bundled `core` so we can target a real non-block
      // evaluator (core/plan-mentions-tests is severity=warn).
      // test-pack ships only block-severity stubs, so the bundled
      // first-party pack is the natural home for this case.
      const addCore = await agent.runRaw([
        'eval',
        'add-pack',
        '@orcaops/evaluator-pack',
        'core',
        '--yes',
        '--json',
      ]);
      expect(addCore.exitCode, addCore.stderr || addCore.stdout).toBe(0);
      const plan = await capturePlan();
      const res = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'core/plan-mentions-tests',
        '--reason',
        'r',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(1);
      const env = JSON.parse(res.stdout) as ErrEnvelope;
      expect(env.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('--json flag accepted for consistency', () => {
    it('block acknowledge --json: still emits JSON, exit 0 (no commander rejection)', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'test-pack/api-stub',
      });
      const res = await agent.runRaw([
        'block',
        'acknowledge',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'r',
        '--json',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      expect(res.stderr).not.toMatch(/unknown option/);
      const env = JSON.parse(res.stdout) as AckOk;
      expect(env.ok).toBe(true);
    });

    it('block dismiss --json: still emits JSON, exit 0 (no commander rejection)', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'test-pack/api-stub',
      });
      const res = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'r',
        '--json',
      ]);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      expect(res.stderr).not.toMatch(/unknown option/);
      const env = JSON.parse(res.stdout) as DismissOk;
      expect(env.ok).toBe(true);
    });
  });

  describe('dismiss → summary unblocks', () => {
    it('after `block dismiss`, capture summary succeeds', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'test-pack/api-stub',
      });
      const dismiss = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'fp',
      ]);
      expect(dismiss.exitCode, dismiss.stdout + dismiss.stderr).toBe(0);
      const sumRes = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
      ]);
      expect(sumRes.exitCode, sumRes.stdout + sumRes.stderr).toBe(0);
    });

    it('unblocks summary after dismissing the lifecycle evaluator inventory', async () => {
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'orcaops/lifecycle-evaluator-inventory',
      });

      const dismiss = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'orcaops/lifecycle-evaluator-inventory',
        '--reason',
        'inventory recovered',
      ]);
      expect(dismiss.exitCode, dismiss.stdout + dismiss.stderr).toBe(0);

      const sumRes = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
      ]);
      expect(sumRes.exitCode, sumRes.stdout + sumRes.stderr).toBe(0);
    });

    it('can explicitly disposition a core checkpoint block', async () => {
      const addCore = await agent.runRaw([
        'eval',
        'add-pack',
        '@orcaops/evaluator-pack',
        'core',
        '--yes',
        '--json',
      ]);
      expect(addCore.exitCode, addCore.stderr || addCore.stdout).toBe(0);
      const plan = await capturePlan();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId: plan.artifact_id,
        evaluatorRef: 'core/checkpoint-scope-density',
      });
      const dismiss = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        plan.artifact_id,
        '--evaluator',
        'core/checkpoint-scope-density',
        '--reason',
        'historical checkpoint reconstructed independently',
      ]);
      expect(dismiss.exitCode, dismiss.stdout + dismiss.stderr).toBe(0);
      expect((JSON.parse(dismiss.stdout) as DismissOk).action).toBe('dismissed');
    });
  });
});
