import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { plantBlockViolation, TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

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
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    // Install the tests/fixtures/test-pack so refs like
    // `test-pack/api-stub` resolve through discoverEvaluators when
    // CLI commands (block dismiss/acknowledge) look them up.
    await agent.runRaw(['eval', 'add-pack', TEST_PACK_ABS_PATH, '--yes', '--json']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(): Promise<{ artifact_id: string }> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    return JSON.parse(planRes.stdout) as { artifact_id: string };
  }

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
      expect(res.exitCode).toBe(0);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(0);
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
      expect(res.exitCode).toBe(0);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(1);
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
      expect(res.exitCode).toBe(0);
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
      expect(res.exitCode).toBe(0);
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
      expect(dismiss.exitCode).toBe(0);
      const sumRes = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
      ]);
      expect(sumRes.exitCode).toBe(0);
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
      expect(dismiss.exitCode).toBe(0);

      const sumRes = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
      ]);
      expect(sumRes.exitCode).toBe(0);
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
      expect(dismiss.exitCode).toBe(0);
      expect((JSON.parse(dismiss.stdout) as DismissOk).action).toBe('dismissed');
    });
  });
});
