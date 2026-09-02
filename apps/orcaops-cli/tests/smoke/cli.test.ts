import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempRepo,
  injectIdempotencyKeyInJson,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/smoke/cli.test.ts → ../../bin/orcaops.js
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], opts: { cwd: string; stdin?: string }): Promise<CliResult> {
  const transformedStdin =
    args[0] === 'capture' && opts.stdin !== undefined
      ? injectIdempotencyKeyInJson(opts.stdin)
      : opts.stdin;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    if (transformedStdin !== undefined) {
      child.stdin.write(transformedStdin);
    }
    child.stdin.end();
  });
}

/**
 * Smoke surface for the orcaops CLI binary. These tests deliberately
 * spawn `bin/orcaops.js` so they observe behavior that only the real
 * process exposes:
 *   - stdin pipes (`--input -`)
 *   - exit codes from the real `process.exit`
 *   - the full end-to-end binary works
 *
 * Every other CLI test belongs in `tests/integration/cli.test.ts` (in-process).
 */
describe('orcaops CLI (smoke: real spawn)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
  });

  it('init → capture plan → 2 checkpoints → pre-pr-check → summary → status reflects truth', async () => {
    // Disable the drain so the SPAWNED binary runs with no cloud I/O (inherited via
    // process.env / vi.stubEnv). No login seed needed: the binary mints real snapshot
    // refs regardless of auth state, and with no credentials on disk the
    // drain has nothing to send even if DISABLE_DRAIN failed to reach the child.
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');

    // init with --no-llm so the test doesn't shell out to claude.
    // init does not auto-install packs; we add-pack
    // @orcaops/evaluator-pack core after init so the capture flow
    // below exercises the deterministic-pack evaluators.
    const initResult = await runCli(['init', '--scope', 'project', '--json', '--no-llm'], {
      cwd: repo.path,
    });
    expect(initResult.exitCode).toBe(0);
    const init = JSON.parse(initResult.stdout) as Record<string, unknown>;
    expect(init.ok).toBe(true);
    expect(init.config_path).toBe('.orcaops/config.json');

    const addPackResult = await runCli(
      ['eval', 'add-pack', '@orcaops/evaluator-pack', 'core', '--yes', '--json'],
      { cwd: repo.path }
    );
    expect(addPackResult.exitCode).toBe(0);

    // capture plan via --json
    const planResult = await runCli(
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: 'add rate limiting to /api/charge',
            plan_steps: [
              { text: 'Redis middleware', label: 's1' },
              { text: 'mount on /api/charge', label: 's2' },
              { text: 'tests', label: 's3' },
            ],
            touched_scope: ['payments'],
          })
        ),
      ],
      { cwd: repo.path }
    );
    expect(planResult.exitCode).toBe(0);
    const plan = JSON.parse(planResult.stdout) as {
      ok: boolean;
      artifact_id: string;
      evaluator_results: unknown[];
      plan_steps: Array<{ step_id: string; idx: number; text: string }>;
    };
    expect(plan.ok).toBe(true);
    expect(plan.artifact_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    // Post-plan evaluators remain represented when --no-llm is used;
    // LLM evaluators are explicitly skipped rather than assigned a verdict.
    expect(plan.evaluator_results.length).toBeGreaterThan(0);
    const artifactId = plan.artifact_id;

    // capture checkpoint 1 via stdin (open → close lifecycle)
    const cp1Open = await runCli(['capture', 'checkpoint', 'open', '--no-llm'], {
      cwd: repo.path,
      stdin: JSON.stringify({
        artifact_id: artifactId,
        declared_step_ids: [plan.plan_steps[0].step_id],
      }),
    });
    expect(cp1Open.exitCode).toBe(0);
    const cp1 = await runCli(['capture', 'checkpoint', 'close', '--no-llm'], {
      cwd: repo.path,
      stdin: JSON.stringify({
        artifact_id: artifactId,
        n: 1,
        summary: 'wired Redis middleware',
        files_changed: ['src/middleware/rateLimiter.ts'],
      }),
    });
    expect(cp1.exitCode).toBe(0);
    expect((JSON.parse(cp1.stdout) as Record<string, unknown>).ok).toBe(true);

    // Spawned-binary capture coverage: the seeded login lets the real process mint the
    // checkpoint's snapshot refs — the only end-to-end path that exercises the gate in a
    // spawned binary rather than in-process.
    const snapRefs = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/orcaops/snap/'],
      { cwd: repo.path, encoding: 'utf8' }
    );
    expect(snapRefs).toContain(`refs/orcaops/snap/${artifactId}/1/close`);

    // capture checkpoint 2 via stdin (open → close lifecycle)
    const cp2Open = await runCli(['capture', 'checkpoint', 'open', '--no-llm'], {
      cwd: repo.path,
      stdin: JSON.stringify({
        artifact_id: artifactId,
        declared_step_ids: [plan.plan_steps[1].step_id],
      }),
    });
    expect(cp2Open.exitCode).toBe(0);
    const cp2 = await runCli(['capture', 'checkpoint', 'close', '--no-llm'], {
      cwd: repo.path,
      stdin: JSON.stringify({
        artifact_id: artifactId,
        n: 2,
        summary: 'mounted route',
        files_changed: ['src/app.ts'],
      }),
    });
    expect(cp2.exitCode).toBe(0);

    // pre-pr-check
    const prePr = await runCli(
      [
        'capture',
        'pre-pr-check',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId })),
      ],
      { cwd: repo.path }
    );
    expect(prePr.exitCode).toBe(0);
    expect((JSON.parse(prePr.stdout) as Record<string, unknown>).ok).toBe(true);

    // A BARE pre-pr-check (no --json, no stdin) autodetects the single
    // active artifact instead of failing NO_INPUT. runCli ends stdin, so the
    // child reads empty stdin → allowEmpty → {} → autodetect.
    const prePrBare = await runCli(['capture', 'pre-pr-check', '--no-llm'], { cwd: repo.path });
    expect(prePrBare.exitCode).toBe(0);
    const bareEnv = JSON.parse(prePrBare.stdout) as { ok: boolean; artifact_id: string };
    expect(bareEnv.ok).toBe(true);
    expect(bareEnv.artifact_id).toBe(artifactId);

    // capture summary
    const summary = await runCli(
      [
        'capture',
        'summary',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: artifactId,
            outcome: 'shipped rate limiter',
            tests_written: ['tests/x.test.ts'],
            open_items: ['ttl strategy for multi-region'],
          })
        ),
      ],
      { cwd: repo.path }
    );
    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summary.stdout)).toMatchObject({
      ok: true,
      finalization_status: 'finalized',
      digest: { status: 'current' },
    });

    // status --json reflects everything
    const status = await runCli(['status', '--json'], { cwd: repo.path });
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout) as {
      ok: boolean;
      branch: string;
      artifacts: Array<{
        id: string;
        state: string;
        thread: Record<string, { status: string; count?: number }>;
        capture_health: string;
      }>;
    };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.branch).toBe('main');
    expect(statusJson.artifacts).toHaveLength(1);
    const a = statusJson.artifacts[0];
    expect(a.id).toBe(artifactId);
    expect(a.state).toBe('summarized');
    expect(a.thread.plan.status).toBe('done');
    expect(a.thread['eval-plan'].status).toBe('done');
    expect(a.thread.checkpoint.status).toBe('done');
    expect(a.thread.checkpoint.count).toBe(2);
    expect(a.thread['eval-cp'].status).toBe('done');
    expect(a.thread['eval-pr'].status).toBe('done');
    expect(a.thread.summary.status).toBe('done');
    expect(a.capture_health).toBe('ok');

    // The summary already rendered and indexed the digest. The standalone
    // command remains a read/repair path and returns that reviewer view.
    const digestResult = await runCli(['digest', '--artifact', artifactId], {
      cwd: repo.path,
    });
    expect(digestResult.exitCode).toBe(0);
    expect(digestResult.stdout).toContain(`# digest — \`main\` / \`${artifactId}\``);
    expect(digestResult.stdout).toContain('add rate limiting to /api/charge');

    // Doctor returns clean post-cycle. A successful capture
    // cycle should not leave any failed checks.
    const doctorResult = await runCli(['doctor', '--json'], { cwd: repo.path });
    // Doctor exit 0 on pass or warn; only failures exit 1. Warnings
    // are tolerated (e.g., LLM tool may not be on PATH in CI).
    expect(doctorResult.exitCode).toBe(0);
    const doctorJson = JSON.parse(doctorResult.stdout) as {
      checks: Array<{ name: string; status: string }>;
    };
    // No `fail` checks after a complete cycle.
    const failingChecks = doctorJson.checks.filter((c) => c.status === 'fail');
    expect(failingChecks).toEqual([]);

    // Assert ≥1 evaluator fired at each capture phase.
    // The expected-fire matrix:
    //   post-plan         — plan-mentions-tests + sensitive-scope-flag
    //   checkpoint-open   — checkpoint-scope-density (no-violation
    //                       since the plan has 3 steps; this evaluator
    //                       fires regardless and produces a pass)
    //   checkpoint-close  — non-goals-info / scope-creep-detect / etc.
    //   pre-pr            — plan-conformance-pre-pr (skipped under --no-llm)
    // Read the artifact's full evaluator runs via `orcaops show --json`.
    const showResult = await runCli(['show', artifactId, '--json'], { cwd: repo.path });
    expect(showResult.exitCode).toBe(0);
    const showJson = JSON.parse(showResult.stdout) as {
      artifact?: { evaluator_log?: { runs?: Array<{ phase: string }> } };
    };
    const phases = new Set((showJson.artifact?.evaluator_log?.runs ?? []).map((r) => r.phase));
    expect(phases).toContain('post-plan');
    expect(phases).toContain('checkpoint-open');
    expect(phases).toContain('checkpoint-close');
    expect(phases).toContain('pre-pr');
    // ~15 real binary spawns; 30s (the smoke default) times out on a loaded
    // 2-core CI runner.
  }, 120_000);

  it('fresh init creates no evaluators.yaml and reports "no packs configured"', async () => {
    const initResult = await runCli(['init', '--scope', 'project', '--json', '--no-llm'], {
      cwd: repo.path,
    });
    expect(initResult.exitCode).toBe(0);

    // .orcaops/evaluators.yaml should NOT exist after init.
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(repo.path, '.orcaops', 'evaluators.yaml'))).toBe(false);
    expect(existsSync(path.join(repo.path, '.orcaops', 'evaluators'))).toBe(false);

    // eval list reports "no packs configured".
    const listResult = await runCli(['eval', 'list', '--json'], { cwd: repo.path });
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { ok: boolean; evaluators: unknown[] };
    expect(list.ok).toBe(true);
    expect(list.evaluators).toEqual([]);
  });

  it('finish refuses an open checkpoint, then closes a clean artifact with a current digest', async () => {
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    await runCli(['init', '--scope', 'project', '--json', '--no-llm'], { cwd: repo.path });
    await runCli(['eval', 'add-pack', '@orcaops/evaluator-pack', 'core', '--yes', '--json'], {
      cwd: repo.path,
    });
    const plan = JSON.parse(
      (
        await runCli(
          [
            'capture',
            'plan',
            '--no-llm',
            '--input',
            inputFile(
              JSON.stringify({
                task: 'finish smoke',
                label: 'finish-smoke',
                plan_steps: [{ text: 'ship it', label: 'ship-it' }],
              })
            ),
          ],
          { cwd: repo.path }
        )
      ).stdout
    ) as { artifact_id: string; plan_steps: Array<{ step_id: string }> };
    await runCli(
      [
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            declared_step_ids: [plan.plan_steps[0]!.step_id],
          })
        ),
      ],
      { cwd: repo.path }
    );
    const finishInput = inputFile(
      JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped in one finish call' })
    );
    const refused = await runCli(['finish', '--no-llm', '--input', finishInput], {
      cwd: repo.path,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    await runCli(
      [
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            n: 1,
            summary: 'shipped',
            completed_step_ids: [plan.plan_steps[0]!.step_id],
            verification: [{ command: 'smoke', exit_code: 0 }],
          })
        ),
      ],
      { cwd: repo.path }
    );
    const finished = await runCli(['finish', '--no-llm', '--input', finishInput], {
      cwd: repo.path,
    });
    expect(finished.exitCode).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({
      ok: true,
      finalization_status: 'finalized',
      digest: { status: 'current' },
    });
  }, 120_000);

  it('eval add-pack creates evaluators.yaml + populates packages[] + enables deterministic evaluators', async () => {
    await runCli(['init', '--scope', 'project', '--json', '--no-llm'], { cwd: repo.path });
    const addPackResult = await runCli(
      ['eval', 'add-pack', '@orcaops/evaluator-pack', 'core', '--yes', '--json'],
      { cwd: repo.path }
    );
    expect(addPackResult.exitCode).toBe(0);
    const result = JSON.parse(addPackResult.stdout) as {
      ok: boolean;
      pack: { id: string; source: { kind: string }; pack_root: string };
      evaluators_enabled: string[];
      evaluators_disabled: string[];
      config_created: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.pack.id).toBe('core');
    expect(result.pack.source.kind).toBe('bundled');
    expect(result.config_created).toBe(true);
    expect(result.evaluators_enabled).toHaveLength(9);

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(repo.path, '.orcaops', 'evaluators.yaml'))).toBe(true);
  });

  it('returns a JSON error envelope (never stack trace) on invalid input — exit 1 from the real process', async () => {
    await runCli(['init', '--scope', 'project', '--json', '--no-llm'], { cwd: repo.path });
    const result = await runCli(['capture', 'plan', '--input', inputFile('{invalid json')], {
      cwd: repo.path,
    });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(result.stderr).toBe('');
  });

  it('capture plan rejects a missing idempotency_key with INVALID_INPUT', async () => {
    // idempotency_key is required end-to-end. The shared
    // transformer auto-fills only on `undefined`; an explicit empty
    // string passes through so Zod's `min(1)` can reject it. The smoke
    // surface here proves the real binary exits 1 on this rejection.
    await runCli(['init', '--scope', 'project', '--json', '--no-llm'], { cwd: repo.path });
    const result = await runCli(
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: '',
            task: 't',
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ],
      { cwd: repo.path }
    );
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; path?: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('idempotency_key');
  });

  it('the retired --json payload alias is rejected as an unknown option', async () => {
    const planRes = await runCli(['capture', 'plan', '--no-llm', '--json', '-'], {
      cwd: repo.path,
    });
    expect(planRes.exitCode).not.toBe(0);
    expect(planRes.stderr).toMatch(/unknown option/);
  });
});
