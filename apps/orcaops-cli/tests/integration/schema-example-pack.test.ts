import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { SCHEMA_EXAMPLES } from '../../src/commands/eval/schema-examples.js';
import { grantsFilePath } from '../../src/lib/evaluator-grants.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * The exemplars must FORM A WORKING PACK, not merely parse.
 *
 * This exists because they once didn't. A field run pasted them and hit two
 * walls in sequence — `timeout_ms` (optional in the schema, required by the pack
 * resolver across spec ∪ manifest defaults) and `env.inherit: [PATH]`
 * (production builds the subprocess env from an allowlist, starting empty). Both
 * files parsed cleanly against their schemas the entire time, so the per-file
 * contract tests stayed green while the shipped example could not run.
 *
 * The two regression cases below strip each fix back out, so neither defect can
 * return quietly.
 */
describe('the emitted exemplars form a runnable pack', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let packPath: string;
  let fixturePath: string;

  /**
   * The runtime deliberately imports nothing. A temp pack outside the workspace
   * cannot resolve `@orcaops/evaluator-sdk`, and importing it would test module
   * resolution rather than the thing under test: spawn, env policy, and envelope
   * parsing.
   */
  const RUNTIME = `process.stdout.write(JSON.stringify({
  schema: 'orcaops.evaluator_result/v1',
  verdict: 'pass',
  body: 'PASS\\n\\nthe exemplar pack dispatched',
}));
`;

  /** Materialize the pack from the EMITTED bytes, optionally mutated. */
  async function writePack(mutate: (spec: string) => string = (s) => s): Promise<void> {
    await mkdir(path.join(packPath, 'evaluators'), { recursive: true });
    await mkdir(path.join(packPath, 'runtime'), { recursive: true });
    await writeFile(path.join(packPath, 'package.yaml'), SCHEMA_EXAMPLES.manifest, 'utf8');
    await writeFile(
      path.join(packPath, 'evaluators', 'plan-has-budget.eval.yaml'),
      mutate(SCHEMA_EXAMPLES.spec),
      'utf8'
    );
    await writeFile(path.join(packPath, 'runtime', 'plan-has-budget.js'), RUNTIME, 'utf8');
  }

  async function register(): Promise<{ exitCode: number; stdout: string }> {
    return agent.runRaw(['eval', 'add-pack', packPath, 'my-pack', '--disabled', '--dev', '--yes']);
  }

  async function runIt(): Promise<{ exitCode: number; stdout: string }> {
    // `fires_at` omitted on purpose: eval test falls back to the evaluator's own
    // phase, which is how an author reaches any phase the fixture cannot name.
    return agent.runRaw([
      'eval',
      'test',
      '--ref',
      'my-pack/plan-has-budget',
      '--fixture',
      fixturePath,
      '--no-llm',
      '--json',
    ]);
  }

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    await rm(grantsFilePath(), { force: true });
    packPath = path.join(repo.path, 'exemplar-pack');

    const printed = await agent.runRaw(['eval', 'test', '--print-example-fixture', '--json']);
    const { fixture } = JSON.parse(printed.stdout) as { fixture: Record<string, unknown> };
    delete fixture.checkpoints;
    delete fixture.checkpoint_n;
    delete fixture.fires_at;
    fixturePath = path.join(repo.path, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture), 'utf8');
  });

  afterEach(async () => {
    await rm(grantsFilePath(), { force: true });
    await repo.cleanup();
  });

  it('assembles into a pack that discovers and dispatches', async () => {
    await writePack();
    expect((await register()).exitCode).toBe(0);

    const result = await runIt();
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { run: { run_status: string; verdict?: string } };
    // Not "it resolved" — it actually spawned and returned a verdict.
    expect(body.run.run_status).toBe('completed');
    expect(body.run.verdict).toBe('pass');
  });

  it('regression: without timeout_ms the pack resolves no evaluator', async () => {
    await writePack((spec) => spec.replace(/\n {2}timeout_ms: \d+/, ''));
    expect((await register()).exitCode).toBe(0);

    const result = await runIt();
    expect(result.exitCode).toBe(1);
    // Optional in the schema, required by the resolver — so the spec is valid
    // and the pack is still unusable. That gap is the whole point of this file.
    expect(result.stdout).toContain('timeout_ms');
  });

  it('regression: without env.inherit PATH the runtime cannot spawn', async () => {
    await writePack((spec) => spec.replace(/\n {2}env:\n(?:.*\n)*? {6}- PATH/, ''));
    expect((await register()).exitCode).toBe(0);

    const result = await runIt();
    const body = JSON.parse(result.stdout) as {
      run: { run_status: string; error?: { code?: string } };
    };
    // Production builds the env from an allowlist; `runFixture` inherits the
    // ambient one, which is exactly why the SDK loop cannot catch this.
    expect(body.run.run_status).toBe('error');
    expect(body.run.error?.code).toBe('SPAWN_ERROR');
  });
});
