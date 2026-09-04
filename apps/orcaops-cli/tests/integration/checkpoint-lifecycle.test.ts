import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '@orcaops/storage';
import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { installTestPack, TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

/**
 * Two-phase checkpoint lifecycle — open / close / abandon.
 *
 * Covers the
 * canonical happy path, concurrent opens with disjoint scope,
 * overlap rejection, completion gates, abandon-then-reopen, subagent
 * attribution, close validation against declared scope, pre-append
 * `checkpoint-scope-density` block + policy_exceptions resolution,
 * and idempotent replay on each verb.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OkEnvelope {
  ok: true;
  [k: string]: unknown;
}
interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string; path?: string };
}

function parseOk<T = OkEnvelope>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

function parseErr(r: CliResult): ErrEnvelope {
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(false);
  return parsed as ErrEnvelope;
}

interface CapturedPlan {
  artifact_id: string;
  /** Server-minted UUIDv7 step_ids in plan order. */
  step_ids: string[];
}

describe('two-phase checkpoint lifecycle', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once and
  // give each test a ~20ms copy of the result.
  const template = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath }).runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await template.checkout();
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  afterAll(async () => {
    await template.destroy();
  });

  async function capturePlan(plan_step_texts: string[]): Promise<CapturedPlan> {
    const plan_steps = plan_step_texts.map((text, idx) => ({ text, label: `s${idx + 1}` }));
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'lifecycle e2e',
          label: 'lifecycle-e2e',
          plan_steps,
          touched_scope: [],
        })
      ),
    ]);
    const ok = parseOk<
      OkEnvelope & {
        artifact_id: string;
        plan_steps: Array<{ step_id: string; idx: number; label: string; text: string }>;
      }
    >(r);
    return { artifact_id: ok.artifact_id, step_ids: ok.plan_steps.map((s) => s.step_id) };
  }

  async function open(payload: Record<string, unknown>): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          ...payload,
        })
      ),
    ]);
  }

  async function close(payload: Record<string, unknown>): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          ...payload,
        })
      ),
    ]);
  }

  async function abandon(payload: Record<string, unknown>): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `abandon-${randomUUID()}`,
          ...payload,
        })
      ),
    ]);
  }

  it('happy path: plan → open[1] → close[1] → open[2] → close[2]', async () => {
    const plan = await capturePlan(['step a', 'step b']);
    const o1 = parseOk<OkEnvelope & { n: number; status: string }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    expect(o1.n).toBe(1);
    expect(o1.status).toBe('open');

    const c1 = parseOk<OkEnvelope & { n: number; status: string }>(
      await close({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1',
        files_changed: ['src/a.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    expect(c1.status).toBe('closed');

    const o2 = parseOk<OkEnvelope & { n: number }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[1]],
      })
    );
    expect(o2.n).toBe(2);

    parseOk(
      await close({
        artifact_id: plan.artifact_id,
        n: 2,
        summary: 'cp2',
        files_changed: ['src/b.ts'],
        completed_step_ids: [plan.step_ids[1]],
      })
    );
  });

  it('fails checkpoint close closed when an enabled configured evaluator is absent from the executing pack', async () => {
    const plan = await capturePlan(['step a', 'step b']);
    parseOk(
      await agent.runRaw(['eval', 'add-pack', '@orcaops/evaluator-pack', 'core', '--yes', '--json'])
    );
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const configPath = path.join(repo.path, '.orcaops', 'evaluators.yaml');
    const evaluatorConfig = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      `${evaluatorConfig.trimEnd()}\n  core/future-blocking-rule:\n    enabled: true\n`,
      'utf8'
    );

    const closed = parseOk<
      OkEnvelope & {
        status: string;
        blocking: boolean;
        evaluator_results: Array<{
          evaluator_ref: string;
          run_status: string;
          verdict: string | null;
          error?: { code: string };
        }>;
      }
    >(
      await close({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'close under a deliberately stale evaluator inventory',
        files_changed: [],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    expect(closed.status).toBe('closed');
    expect(closed.blocking).toBe(true);
    expect(closed.evaluator_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evaluator_ref: 'core/future-blocking-rule',
          run_status: 'error',
          error: expect.objectContaining({ code: 'EVALUATOR_REF_UNRESOLVED' }),
        }),
        expect.objectContaining({
          evaluator_ref: 'orcaops/lifecycle-evaluator-inventory',
          verdict: 'violation',
        }),
      ])
    );

    const shown = parseOk<
      OkEnvelope & {
        artifact: {
          evaluator_log: {
            runs: Array<{
              checkpoint_n: number | null;
              evaluator_ref: string;
              run_status: string;
              disposition: string | null;
            }>;
          };
        };
      }
    >(await agent.runRaw(['show', plan.artifact_id, '--json']));
    expect(shown.artifact.evaluator_log.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpoint_n: 1,
          evaluator_ref: 'core/future-blocking-rule',
          run_status: 'error',
        }),
        expect.objectContaining({
          checkpoint_n: 1,
          evaluator_ref: 'orcaops/lifecycle-evaluator-inventory',
          disposition: 'unresolved',
        }),
      ])
    );
  });

  it('concurrent opens get sequential n with disjoint scopes', async () => {
    const plan = await capturePlan(['a', 'b', 'c']);

    // Truly concurrent: both opens are dispatched before either has
    // acquired the artifact lock. The filesystem mkdir-EEXIST lock in
    // packages/storage/src/locks.ts serializes the two opens; the
    // later acquirer waits then runs nextCheckpointN under the lock,
    // so both succeed with distinct sequential n values.
    const [r1, r2] = await Promise.all([
      open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }),
      open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[1]] }),
    ]);
    const o1 = parseOk<OkEnvelope & { n: number }>(r1);
    const o2 = parseOk<OkEnvelope & { n: number }>(r2);
    expect(o1.n).not.toBe(o2.n);
    // Both n values must be sequential (1 and 2 in some order).
    expect(new Set([o1.n, o2.n])).toEqual(new Set([1, 2]));
  });

  it('OPEN_CP_OVERLAP: two opens declaring the same step are rejected', async () => {
    const plan = await capturePlan(['a', 'b']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const r = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
    });
    expect(r.exitCode).toBe(1);
    const err = parseErr(r);
    expect(err.error.code).toBe('OPEN_CP_OVERLAP');
    expect(err.error.message).toContain(plan.step_ids[0]);
  });

  it('OPEN_CP_OVERLAP: opening a step already claimed by a closed cp is rejected', async () => {
    const plan = await capturePlan(['a', 'b']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    parseOk(
      await close({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1',
        files_changed: [],
        completed_step_ids: [plan.step_ids[0]],
      })
    );

    const r = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
    });
    expect(parseErr(r).error.code).toBe('OPEN_CP_OVERLAP');
  });

  it('abandon releases declared steps; the same scope can be re-opened on a fresh cp', async () => {
    const plan = await capturePlan(['a', 'b']);
    const o1 = parseOk<OkEnvelope & { n: number }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    parseOk(await abandon({ artifact_id: plan.artifact_id, n: o1.n, reason: 'rescope' }));

    // Step 1 is now uncovered again; a fresh open succeeds.
    const o2 = parseOk<OkEnvelope & { n: number; status: string }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    expect(o2.n).toBe(2);
    expect(o2.status).toBe('open');
  });

  it('close rejects completed_step_ids that were not declared at open', async () => {
    const plan = await capturePlan(['a', 'b', 'c']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const r = await close({
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'cp1',
      files_changed: [],
      completed_step_ids: [plan.step_ids[0], plan.step_ids[1]],
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/declared/);
  });

  it('refuses a completed-step close without verification and keeps the checkpoint open', async () => {
    const plan = await capturePlan(['a']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const result = await close({
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'claims completion without proof',
      files_changed: [],
      verification: [],
      completed_step_ids: [plan.step_ids[0]],
    });

    expect(result.exitCode).toBe(1);
    const error = parseErr(result);
    expect(error.error).toMatchObject({ code: 'INVALID_INPUT', path: 'verification' });
    expect(error.error.message).toContain('Run the proving command fresh');

    const status = parseOk<
      OkEnvelope & {
        artifacts: Array<{ id: string; open_checkpoints: Array<{ n: number }> }>;
      }
    >(await agent.runRaw(['status', '--json']));
    expect(
      status.artifacts.find((artifact) => artifact.id === plan.artifact_id)?.open_checkpoints
    ).toEqual([expect.objectContaining({ n: 1 })]);
  });

  it('subagent attribution: agent_session_id flows through to status surfaces', async () => {
    const plan = await capturePlan(['a', 'b']);
    const ok = parseOk<OkEnvelope & { agent_session_id: string }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
        agent_session_id: 'subagent-a',
      })
    );
    expect(ok.agent_session_id).toBe('subagent-a');
  });

  it('completion gates: pre-pr-check refuses while any open cp exists', async () => {
    const plan = await capturePlan(['a', 'b']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const r = await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `pp-${randomUUID()}`,
          artifact_id: plan.artifact_id,
        })
      ),
    ]);
    expect(r.exitCode).toBe(1);
    expect(parseErr(r).error.message).toMatch(/open checkpoint/);
  });

  it('completion gates: summary refuses while any open cp exists', async () => {
    const plan = await capturePlan(['a', 'b']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const r = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          outcome: 'shipped',
        })
      ),
    ]);
    expect(r.exitCode).toBe(1);
    expect(parseErr(r).error.message).toMatch(/open checkpoint/);
  });

  it('idempotent replay on close', async () => {
    const plan = await capturePlan(['a']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const key = `close-fixed-${randomUUID()}`;
    const payload = {
      idempotency_key: key,
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'cp1',
      files_changed: [],
      verification: [{ command: 'test fixture', exit_code: 0 }],
      completed_step_ids: [plan.step_ids[0]],
    };

    const r1 = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r1.exitCode).toBe(0);

    const r2 = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r2.exitCode).toBe(0);
    const replay = parseOk<OkEnvelope & { idempotency_status?: string }>(r2);
    expect(replay.idempotency_status).toBe('replay');
  });

  it('idempotent replay on abandon', async () => {
    const plan = await capturePlan(['a']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );

    const key = `aban-fixed-${randomUUID()}`;
    const payload = {
      idempotency_key: key,
      artifact_id: plan.artifact_id,
      n: 1,
      reason: 'cancel',
    };

    const r1 = await agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r1.exitCode).toBe(0);

    const r2 = await agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r2.exitCode).toBe(0);
    expect(parseOk<OkEnvelope & { idempotency_status?: string }>(r2).idempotency_status).toBe(
      'replay'
    );
  });

  // ── pre-append checkpoint-open evaluator gate ────────────────────

  it('pre-append block: oversized open is rejected without writing; replay with policy_exceptions[] succeeds', async () => {
    // 9 steps; declare 9/9 → 100% > 60% threshold → blocked.
    const plan = await capturePlan(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    // Install bundled `core` so `core/checkpoint-scope-density`
    // resolves and fires on cp-open (init does not auto-install packs).
    const addPackCore = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPackCore.exitCode).toBe(0);

    const blocked = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [
        plan.step_ids[0],
        plan.step_ids[1],
        plan.step_ids[2],
        plan.step_ids[3],
        plan.step_ids[4],
        plan.step_ids[5],
        plan.step_ids[6],
        plan.step_ids[7],
        plan.step_ids[8],
      ],
    });
    // The block is surfaced as ok:false envelope from inside runCapture
    // but exit code stays 0 (success-shaped error). Check for the blocked
    // marker in stdout.
    const parsed = JSON.parse(blocked.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('blocked');
    const evaluatorResults = parsed.evaluator_results as Array<{
      evaluator_ref: string;
      status: string;
    }>;
    expect(evaluatorResults.some((r) => r.evaluator_ref === 'core/checkpoint-scope-density')).toBe(
      true
    );

    // Retry with policy_exceptions[] naming the blocked evaluator (full ref).
    const ok = parseOk<OkEnvelope & { policy_exceptions: unknown[] }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [
          plan.step_ids[0],
          plan.step_ids[1],
          plan.step_ids[2],
          plan.step_ids[3],
          plan.step_ids[4],
          plan.step_ids[5],
          plan.step_ids[6],
          plan.step_ids[7],
          plan.step_ids[8],
        ],
        policy_exceptions: [
          { evaluator: 'core/checkpoint-scope-density', reason: 'mechanical rename' },
        ],
      })
    );
    expect(ok.policy_exceptions).toHaveLength(1);
  });

  it('pre-append gate fails closed when a block-severity evaluator emits invalid output', async () => {
    const plan = await capturePlan(['a', 'b', 'c', 'd']);
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-evaluator-error-'));
    try {
      const packPath = path.join(tmpRoot, 'test-pack');
      await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
      await writeFile(
        path.join(packPath, 'runtime', 'scope-density-stub.mjs'),
        "process.stdout.write('not-json');\n",
        'utf8'
      );
      parseOk(await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']));

      const blocked = await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      });
      const envelope = JSON.parse(blocked.stdout) as {
        ok: boolean;
        status: string;
        blocking: boolean;
        blocked_evaluator_refs: string[];
        evaluator_results: Array<{
          evaluator_ref: string;
          run_status: string;
          verdict: string | null;
          error?: { code: string };
        }>;
      };
      expect(envelope).toMatchObject({ ok: false, status: 'blocked', blocking: true });
      expect(envelope.blocked_evaluator_refs).toContain('test-pack/scope-density-stub');
      expect(envelope.evaluator_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            evaluator_ref: 'test-pack/scope-density-stub',
            run_status: 'error',
            verdict: null,
            error: expect.objectContaining({ code: 'JSON_PARSE' }),
          }),
        ])
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('policy_exceptions naming a non-checkpoint-open evaluator → INVALID_INPUT, path=policy_exceptions', async () => {
    const plan = await capturePlan(['a', 'b', 'c', 'd']);
    // Install bundled `js` so `js/api-signature-drift` is resolvable
    // (init does not auto-install packs). Without it,
    // the policy_exceptions validator returns "unknown evaluator"
    // before reaching the fires_at check this test is verifying.
    const addPackJs = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'js',
      '--yes',
      '--json',
    ]);
    expect(addPackJs.exitCode).toBe(0);
    // `js/api-signature-drift` fires at checkpoint-close. Inline
    // policy exceptions only resolve pre-append blocks
    // (checkpoint-open), so naming a checkpoint-close evaluator is
    // invalid regardless of whether its on_block contains
    // `acknowledge_policy_exception`.
    const r = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
      policy_exceptions: [{ evaluator: 'js/api-signature-drift', reason: 'unrelated' }],
    });
    expect(r.exitCode).toBe(1);
    const err = parseErr(r);
    expect(err.error.code).toBe('INVALID_INPUT');
    // Must report the right field for the agent's error UX.
    expect(err.error.path).toBe('policy_exceptions');
    expect(err.error.message).toMatch(/not a `fires_at: checkpoint-open` evaluator/);
  });

  it('policy_exceptions naming a checkpoint-close evaluator that DOES carry policy_exception opt-in → still rejected', async () => {
    // Regression for the scope bug: scoping must be by `phase`, not
    // by whether the spec opts into `resolution.policy_exception`.
    // The test-pack ships `cp-close-with-pe-stub` specifically for
    // this case — phase=checkpoint-close + policy_exception.enabled=true
    // — so the in-process discovery path resolves the ref and the gate
    // can apply the scope check.
    const plan = await capturePlan(['a', 'b', 'c', 'd']);
    await installTestPack(agent);
    const r = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
      policy_exceptions: [{ evaluator: 'test-pack/cp-close-with-pe-stub', reason: 'wrong hook' }],
    });
    expect(r.exitCode).toBe(1);
    const err = parseErr(r);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('policy_exceptions');
    expect(err.error.message).toMatch(/not a `fires_at: checkpoint-open` evaluator/);
  });

  it('policy_exceptions naming an unknown evaluator → INVALID_INPUT, path=policy_exceptions', async () => {
    const plan = await capturePlan(['a', 'b', 'c', 'd']);
    const r = await open({
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
      policy_exceptions: [{ evaluator: 'no-such-evaluator', reason: 'typo' }],
    });
    expect(r.exitCode).toBe(1);
    const err = parseErr(r);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('policy_exceptions');
    expect(err.error.message).toMatch(/unknown evaluator/);
  });

  it('plan smaller than min_plan_size: large declared scope passes (cadence guard does not apply)', async () => {
    // 3 plan steps; declare all 3 → fraction=1.0 but plan size < 4 → pass.
    const plan = await capturePlan(['a', 'b', 'c']);
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0], plan.step_ids[1], plan.step_ids[2]],
      })
    );
  });

  // ── three-outcome idempotency: soft_blocked / hard_rejected ────────

  it('soft_blocked replay returns cached envelope', async () => {
    // 5 plan steps; declare 4 (4/5 = 0.8 > 0.6 threshold + plan ≥ 4)
    // → core/checkpoint-scope-density blocks. Default params from the
    // bundled spec (max_fraction_of_plan: 0.6, min_plan_size: 4)
    // already trigger this; no override needed.
    const plan = await capturePlan(['s1', 's2', 's3', 's4', 's5']);
    const addPackCore = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPackCore.exitCode).toBe(0);

    const idempotencyKey = `soft-block-replay-${randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0], plan.step_ids[1], plan.step_ids[2], plan.step_ids[3]],
    };

    // First call: fresh evaluation → blocked envelope written + cached.
    const r1 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    const envelope1 = JSON.parse(r1.stdout) as Record<string, unknown>;
    expect(envelope1.ok).toBe(false);
    expect(envelope1.status).toBe('blocked');
    const evals1 = envelope1.evaluator_results as Array<{
      evaluator_ref: string;
      status: string;
    }>;
    expect(evals1.some((e) => e.evaluator_ref === 'core/checkpoint-scope-density')).toBe(true);

    // Verify a soft_blocked record exists with matching outcome.
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store1 = new Store(dbPath);
    const block1 = store1.getIdempotencyBlock({
      artifact_id: plan.artifact_id,
      idempotency_key: idempotencyKey,
      event_type: 'checkpoint_opened',
    });
    store1.close();
    expect(block1).not.toBeNull();
    expect(block1?.outcome).toBe('soft_blocked');

    // Second call: same key + same payload + matching evaluator
    // fingerprint → cached envelope replays verbatim.
    const r2 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    const envelope2 = JSON.parse(r2.stdout) as Record<string, unknown>;
    expect(envelope2).toEqual(envelope1);

    // Block record still present after replay.
    const store2 = new Store(dbPath);
    const block2 = store2.getIdempotencyBlock({
      artifact_id: plan.artifact_id,
      idempotency_key: idempotencyKey,
      event_type: 'checkpoint_opened',
    });
    store2.close();
    expect(block2).not.toBeNull();
    expect(block2?.outcome).toBe('soft_blocked');
  });

  it('soft_blocked invalidates on fingerprint drift', async () => {
    // 5 plan steps; declare 4 (4/5 = 0.8 > 0.6) → first call blocks
    // via core/checkpoint-scope-density default params.
    const plan = await capturePlan(['s1', 's2', 's3', 's4', 's5']);
    const addPackCore = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPackCore.exitCode).toBe(0);

    const idempotencyKey = `fingerprint-drift-${randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0], plan.step_ids[1], plan.step_ids[2], plan.step_ids[3]],
    };

    const r1 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    const envelope1 = JSON.parse(r1.stdout) as Record<string, unknown>;
    expect(envelope1.ok).toBe(false);
    expect(envelope1.status).toBe('blocked');

    // Add a params override in .orcaops/evaluators.yaml bumping
    // max_fraction_of_plan to 0.95 (preserves the existing packages[]
    // and trusted blocks). The runner re-loads config on the next
    // CLI invocation, the merged params shift the evaluator
    // fingerprint, the cached soft_blocked record's stored fingerprint
    // no longer matches → cache invalidates → re-evaluates → 4/5 = 0.8
    // < 0.95 → passes.
    const yamlPath = path.join(repo.path, '.orcaops', 'evaluators.yaml');
    const yamlBefore = await readFile(yamlPath, 'utf8');
    // Append the override under the existing evaluators block. The
    // file already has an `evaluators:` map populated by add-pack.
    const overrideBlock = [
      'core/checkpoint-scope-density:',
      '    enabled: true',
      '    params:',
      '      max_fraction_of_plan: 0.95',
      '      min_plan_size: 4',
    ].join('\n  ');
    // Replace any pre-existing core/checkpoint-scope-density entry to
    // ensure the override semantics hold. The entry has the canonical
    // shape `core/checkpoint-scope-density:\n    enabled: true`.
    const entryRegex =
      /core\/checkpoint-scope-density:\n {4}enabled: true(?:\n {4}severity: .*)?(?:\n {4}params:\n(?:.*\n)+?(?= {2}\S|$))?/;
    let yamlAfter: string;
    if (entryRegex.test(yamlBefore)) {
      yamlAfter = yamlBefore.replace(entryRegex, overrideBlock);
    } else {
      // Append under the existing evaluators block.
      yamlAfter = yamlBefore.replace(/^evaluators:\s*\n/m, `evaluators:\n  ${overrideBlock}\n`);
    }
    expect(yamlAfter).not.toBe(yamlBefore);
    await writeFile(yamlPath, yamlAfter, 'utf8');

    // Replay with same key + same payload — fingerprint changed, so
    // the cache misses; storage re-evaluates and now passes.
    const r2 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r2.exitCode).toBe(0);
    const envelope2 = parseOk<OkEnvelope & { n: number }>(r2);
    expect(envelope2.n).toBe(1);

    // The soft_blocked record was cleared on commit (transitioned to a
    // committed event in the log).
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store = new Store(dbPath);
    const block = store.getIdempotencyBlock({
      artifact_id: plan.artifact_id,
      idempotency_key: idempotencyKey,
      event_type: 'checkpoint_opened',
    });
    store.close();
    expect(block).toBeNull();
  });

  it('hard_rejected upgrade: overlap clears via abandon, retry succeeds', async () => {
    const plan = await capturePlan(['a', 'b']);

    // First open claims step 1.
    const o1 = parseOk<OkEnvelope & { n: number }>(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    expect(o1.n).toBe(1);

    // Second open with a NEW idempotency_key, declaring step 1 → overlap → hard_rejected.
    const idempotencyKey = `hard-reject-upgrade-${randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      artifact_id: plan.artifact_id,
      declared_step_ids: [plan.step_ids[0]],
    };

    const r1 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r1.exitCode).toBe(1);
    const err = parseErr(r1);
    expect(err.error.code).toBe('OPEN_CP_OVERLAP');

    // Verify a hard_rejected record exists.
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const storeBefore = new Store(dbPath);
    const blockBefore = storeBefore.getIdempotencyBlock({
      artifact_id: plan.artifact_id,
      idempotency_key: idempotencyKey,
      event_type: 'checkpoint_opened',
    });
    storeBefore.close();
    expect(blockBefore).not.toBeNull();
    expect(blockBefore?.outcome).toBe('hard_rejected');

    // Abandon cp 1 — releases step 1.
    parseOk(await abandon({ artifact_id: plan.artifact_id, n: 1, reason: 'rescope' }));

    // Retry the second open with SAME key + SAME payload. State has
    // cleared, so re-evaluation succeeds; hard_rejected → committed
    // upgrade clears the idempotency_blocks row.
    const r2 = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(r2.exitCode).toBe(0);
    const ok = parseOk<OkEnvelope & { n: number }>(r2);
    expect(ok.n).toBe(2);

    // idempotency_blocks row is gone (committed event supersedes).
    const storeAfter = new Store(dbPath);
    const blockAfter = storeAfter.getIdempotencyBlock({
      artifact_id: plan.artifact_id,
      idempotency_key: idempotencyKey,
      event_type: 'checkpoint_opened',
    });
    storeAfter.close();
    expect(blockAfter).toBeNull();

    // Verify the new checkpoint_opened event for n=2 with our key
    // exists in events.ndjson (the source-of-truth log).
    const eventsPath = path.join(
      repo.path,
      '.orcaops',
      'artifacts',
      plan.artifact_id,
      'events.ndjson'
    );
    const eventLog = await readFile(eventsPath, 'utf8');
    const eventRecords = eventLog
      .split('\n')
      .filter((l) => l.length > 0)
      .map(
        (l) => JSON.parse(l) as { type: string; idempotency_key: string; payload?: { n?: number } }
      );
    const upgraded = eventRecords.find(
      (e) => e.type === 'checkpoint_opened' && e.idempotency_key === idempotencyKey
    );
    expect(upgraded).toBeDefined();
    expect(upgraded?.payload?.n).toBe(2);
  });

  // ── thread.checkpoint counts closed cps only ─────────────────────────
  it('thread-status: only open / abandoned cps → thread.checkpoint stays "ready" (no closed cps to count)', async () => {
    const plan = await capturePlan(['s1', 's2']);
    // One open cp, one abandoned cp — neither should count toward
    // thread.checkpoint progress. Per the lifecycle spec, only
    // closed cps move the artifact forward.
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[1]],
      })
    );
    parseOk(await abandon({ artifact_id: plan.artifact_id, n: 2, reason: 'rescoped' }));

    const status = await agent.runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout) as {
      ok: boolean;
      artifacts: Array<{
        id: string;
        thread: Record<string, { status: string; count?: number }>;
      }>;
    };
    const a = statusJson.artifacts.find((x) => x.id === plan.artifact_id);
    expect(a).toBeDefined();
    // No closed cps — checkpoint progress is 'ready', not 'done'.
    expect(a!.thread.checkpoint.status).toBe('ready');
    expect(a!.thread.checkpoint.count).toBeUndefined();
  });

  it('thread-status: closed cps drive thread.checkpoint.count; open / abandoned cps do not', async () => {
    const plan = await capturePlan(['s1', 's2', 's3']);
    // 2 closed + 1 abandoned + 1 open. Only the 2 closed should
    // contribute to thread.checkpoint.count.
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[0]],
      })
    );
    parseOk(
      await close({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1',
        files_changed: ['src/a.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[1]],
      })
    );
    parseOk(
      await close({
        artifact_id: plan.artifact_id,
        n: 2,
        summary: 'cp2',
        files_changed: ['src/b.ts'],
        completed_step_ids: [plan.step_ids[1]],
      })
    );
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[2]],
      })
    );
    parseOk(await abandon({ artifact_id: plan.artifact_id, n: 3, reason: 'rescoped' }));
    // One more in-flight open (step 3 was just freed by abandon).
    parseOk(
      await open({
        artifact_id: plan.artifact_id,
        declared_step_ids: [plan.step_ids[2]],
      })
    );

    const status = await agent.runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout) as {
      ok: boolean;
      artifacts: Array<{
        id: string;
        thread: Record<string, { status: string; count?: number; latest_n?: number }>;
      }>;
    };
    const a = statusJson.artifacts.find((x) => x.id === plan.artifact_id);
    expect(a).toBeDefined();
    expect(a!.thread.checkpoint.status).toBe('done');
    expect(a!.thread.checkpoint.count).toBe(2);
    expect(a!.thread.checkpoint.latest_n).toBe(2);
  });

  // ── idempotency auto-mint, artifact_id autodetect, omitted-n close ─────────────

  it('auto-mints idempotency_key when omitted on open and close', async () => {
    const plan = await capturePlan(['a']);
    const o = parseOk<OkEnvelope & { n: number }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
        ),
      ])
    );
    expect(o.n).toBe(1);
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            n: 1,
            summary: 'cp1',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
  });

  it('autodetects artifact_id when exactly one artifact is active on the branch', async () => {
    const plan = await capturePlan(['a']);
    const o = parseOk<OkEnvelope & { n: number; artifact_id: string }>(
      // No artifact_id in the payload — resolves to the single active artifact.
      await open({ declared_step_ids: [plan.step_ids[0]] })
    );
    expect(o.artifact_id).toBe(plan.artifact_id);
    expect(o.n).toBe(1);
  });

  it('AMBIGUOUS_ARTIFACT with structured candidates[] when >1 active and no artifact_id', async () => {
    const planA = await capturePlan(['a']);
    const planB = await capturePlan(['b']); // second active artifact on the same branch
    const r = await open({ declared_step_ids: [planA.step_ids[0]] }); // no artifact_id
    expect(r.exitCode).toBe(1);
    const err = parseErr(r) as ErrEnvelope & {
      error: { candidates?: Array<{ id: string; label: string; state: string }> };
    };
    expect(err.error.code).toBe('AMBIGUOUS_ARTIFACT');
    expect(err.error.path).toBe('artifact_id');
    const ids = (err.error.candidates ?? []).map((c) => c.id).sort();
    expect(ids).toEqual([planA.artifact_id, planB.artifact_id].sort());
    // Friendly label present on every candidate (here, the plan label).
    expect(err.error.candidates?.every((c) => (c.label ?? '').length > 0)).toBe(true);
  });

  it('close with omitted n closes the single open checkpoint', async () => {
    const plan = await capturePlan(['a']);
    parseOk(await open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    const c = parseOk<OkEnvelope & { n: number; status: string }>(
      // No n — resolves to the single open cp.
      await close({
        artifact_id: plan.artifact_id,
        summary: 'cp1',
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    expect(c.n).toBe(1);
    expect(c.status).toBe('closed');
  });

  it('close with omitted n replays under the same key after no checkpoint remains open', async () => {
    const plan = await capturePlan(['a']);
    parseOk(await open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    const key = `close-replay-${randomUUID()}`;
    const payload = {
      idempotency_key: key,
      artifact_id: plan.artifact_id,
      summary: 'cp1',
      verification: [{ command: 'test fixture', exit_code: 0 }],
      completed_step_ids: [plan.step_ids[0]],
    };
    const first = parseOk<OkEnvelope & { n: number }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(payload)),
      ])
    );
    const replay = parseOk<OkEnvelope & { n: number; idempotency_status: string }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(payload)),
      ])
    );
    expect(replay.n).toBe(first.n);
    expect(replay.idempotency_status).toBe('replay');
  });

  it('AMBIGUOUS_CHECKPOINT with structured open_checkpoints[] when >1 open and n omitted', async () => {
    const plan = await capturePlan(['a', 'b']);
    parseOk(await open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    parseOk(await open({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[1]] }));
    const r = await close({
      artifact_id: plan.artifact_id,
      summary: 'x',
      completed_step_ids: [plan.step_ids[0]],
    }); // no n
    expect(r.exitCode).toBe(1);
    const err = parseErr(r) as ErrEnvelope & {
      error: { open_checkpoints?: Array<{ n: number; declared_step_ids: string[] }> };
    };
    expect(err.error.code).toBe('AMBIGUOUS_CHECKPOINT');
    expect(err.error.path).toBe('n');
    const ns = (err.error.open_checkpoints ?? []).map((c) => c.n).sort();
    expect(ns).toEqual([1, 2]);
  });

  it('close with omitted n and zero open checkpoints → INVALID_INPUT (path=n)', async () => {
    const plan = await capturePlan(['a']);
    const r = await close({
      artifact_id: plan.artifact_id,
      summary: 'x',
      completed_step_ids: [],
    }); // no open cp, no n
    expect(r.exitCode).toBe(1);
    const err = parseErr(r);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('n');
  });
});
