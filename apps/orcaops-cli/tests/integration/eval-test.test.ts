import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type OkEnvelope, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface EvalTestOk extends OkEnvelope {
  ok: true;
  artifact_id: string;
  evaluator_ref: string;
  fixture: string;
  run: { run_status: string; verdict?: string };
  blocking: boolean;
}

const STEP_IDS = [
  '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
  '01HX0K8N6ZQF8M5R2V8DZ7T3LY',
  '01HX0K8N6ZQF8M5R2V8DZ7T3MZ',
  '01HX0K8N6ZQF8M5R2V8DZ7T3N0',
  '01HX0K8N6ZQF8M5R2V8DZ7T3P1',
] as const;

function fixturePlan(
  stepTexts: readonly string[] = ['implement', 'add unit tests', 'add e2e test']
) {
  return {
    schema_version: 4,
    artifact_id: 'placeholder-overwritten-by-stamp',
    branch: 'main',
    base_sha: '0000000000000000000000000000000000000000',
    agent: 'claude-code',
    agent_session_id: null,
    task: 'add a feature with tests',
    label: 'fixture plan',
    plan_steps: stepTexts.map((text, index) => ({
      step_id: STEP_IDS[index],
      text,
      label: `step ${index + 1}`,
      acceptance_criteria: [] as Array<{ criterion_id: string; text: string }>,
    })),
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-04-27T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${path.relative(root, absolute)}/`] = '<directory>';
        await walk(absolute);
      } else if (entry.isFile()) {
        snapshot[path.relative(root, absolute)] = (await readFile(absolute)).toString('base64');
      }
    }
  }
  await walk(root);
  return snapshot;
}

describe('orcaops eval test', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: path.join(repo.path, 'history-data') },
    });
    await agent.init({ noLlm: true });
    const addPack = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPack.exitCode).toBe(0);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function writeFixture(value: unknown, name = 'fixture.json'): Promise<string> {
    const fixturePath = path.join(repo.path, name);
    await writeFile(fixturePath, JSON.stringify(value), 'utf8');
    return fixturePath;
  }

  async function runFixture(fixturePath: string, ref = 'core/plan-mentions-tests') {
    return agent.runRaw([
      'eval',
      'test',
      '--ref',
      ref,
      '--fixture',
      fixturePath,
      '--no-llm',
      '--json',
    ]);
  }

  async function runFixtureHuman(fixturePath: string, ref: string) {
    return agent.runRaw(['eval', 'test', '--ref', ref, '--fixture', fixturePath, '--no-llm']);
  }

  /**
   * Register a path-source pack with one warn-severity command evaluator whose
   * runtime is `source`. A local pack, not a new entry in the shared test
   * fixture pack: what these cases need is a producer that emits exactly one
   * chosen envelope, including ones no shipped evaluator would ever produce.
   */
  async function addPackEmitting(packId: string, source: string): Promise<string> {
    const packRoot = path.join(repo.path, `${packId}-pack`);
    await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
    await mkdir(path.join(packRoot, 'runtime'), { recursive: true });
    await writeFile(
      path.join(packRoot, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: ' + packId,
        'name: ' + packId + '/pack',
        'version: 1.0.0',
        'description: local test pack',
        'evaluator_dir: ./evaluators',
        'defaults:',
        '  timeout_ms: 30000',
        '  env:',
        '    inherit:',
        '      - PATH',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(packRoot, 'runtime', 'emit.js'), source, 'utf8');
    await writeFile(
      path.join(packRoot, 'evaluators', 'emit.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: emit',
        'phase: post-plan',
        'severity: warn',
        'description: emits one chosen envelope',
        'engine:',
        '  kind: command',
        '  command: ["node", "./runtime/emit.js"]',
        '',
      ].join('\n'),
      'utf8'
    );
    const added = await agent.runRaw([
      'eval',
      'add-pack',
      `./${packId}-pack`,
      packId,
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);
    return `${packId}/emit`;
  }

  function emitEnvelope(envelope: unknown): string {
    return `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`;
  }

  it('runs pass and violation fixtures without changing the real store', async () => {
    const passingFixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });
    const storeRoot = path.join(repo.path, 'history-data');
    const before = await snapshotFiles(storeRoot);

    const first = await runFixture(passingFixture);
    expect(first.exitCode).toBe(0);
    const firstEnvelope = JSON.parse(first.stdout) as EvalTestOk;
    expect(firstEnvelope.run.verdict).toBe('pass');
    expect(firstEnvelope.artifact_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(await snapshotFiles(storeRoot)).toEqual(before);

    const second = await runFixture(passingFixture);
    expect(second.exitCode).toBe(0);
    const secondEnvelope = JSON.parse(second.stdout) as EvalTestOk;
    expect(secondEnvelope.artifact_id).not.toBe(firstEnvelope.artifact_id);
    expect(await snapshotFiles(storeRoot)).toEqual(before);

    const criteriaPlan = fixturePlan(['implement feature']);
    criteriaPlan.plan_steps[0].acceptance_criteria = [
      {
        criterion_id: STEP_IDS[4],
        text: 'the focused regression tests pass',
      },
    ];
    const criteriaFixture = await writeFixture(
      { plan: criteriaPlan, fires_at: 'post-plan' },
      'criteria-only.json'
    );
    const criteriaResult = await runFixture(criteriaFixture);
    expect(criteriaResult.exitCode).toBe(0);
    expect((JSON.parse(criteriaResult.stdout) as EvalTestOk).run.verdict).toBe('pass');
    expect(await snapshotFiles(storeRoot)).toEqual(before);

    const violatingFixture = await writeFixture(
      { plan: fixturePlan(['implement feature']), fires_at: 'post-plan' },
      'violation.json'
    );
    const violation = await runFixture(violatingFixture);
    expect(violation.exitCode).toBe(0);
    expect((JSON.parse(violation.stdout) as EvalTestOk).run.verdict).toBe('violation');
    expect(await snapshotFiles(storeRoot)).toEqual(before);
  });

  it('evaluates a fixture without recreating missing project history', async () => {
    const fixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });
    const historyRoot = path.join(repo.path, 'history-data');
    await rm(historyRoot, { recursive: true });

    const result = await runFixture(fixture);

    expect(result.exitCode, result.stdout).toBe(0);
    expect((JSON.parse(result.stdout) as EvalTestOk).run.verdict).toBe('pass');
    await expect(readdir(historyRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses secret fixture content before evaluator lookup without changing history', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const fixture = await writeFixture({
      plan: { ...fixturePlan(), task: secret },
      fires_at: 'post-plan',
    });
    const historyRoot = path.join(repo.path, 'history-data');
    const before = await snapshotFiles(historyRoot);

    const result = await runFixture(fixture, 'core/not-real');

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(await snapshotFiles(historyRoot)).toEqual(before);
  });

  it('leaves the real store unchanged when evaluator discovery or fixture setup fails', async () => {
    const validFixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });
    const storeRoot = path.join(repo.path, 'history-data');
    const before = await snapshotFiles(storeRoot);

    const missingEvaluator = await runFixture(validFixture, 'core/not-real');
    expect(missingEvaluator.exitCode).toBe(1);
    expect(missingEvaluator.stdout).toContain('EVALUATOR_NOT_FOUND');
    expect(await snapshotFiles(storeRoot)).toEqual(before);

    const invalidCheckpointFixture = await writeFixture(
      {
        plan: fixturePlan(),
        checkpoints: [
          {
            status: 'closed',
            artifact_id: 'placeholder-overwritten-by-stamp',
            n: 1,
            declared_step_ids: ['not-a-plan-step'],
            policy_exceptions: [],
            plan_revision_id: null,
            head_sha: '0000000000000000000000000000000000000000',
            summary: 'invalid scope fixture',
            files_changed: [],
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            completed_step_ids: [],
          },
        ],
        fires_at: 'checkpoint-close',
        checkpoint_n: 1,
      },
      'invalid-checkpoint.json'
    );
    const invalidCheckpoint = await runFixture(invalidCheckpointFixture);
    expect(invalidCheckpoint.exitCode).toBe(1);
    expect(await snapshotFiles(storeRoot)).toEqual(before);
  });

  it('gives a checkpoint-open evaluator a real verdict, not the vacuous pass', async () => {
    // core/checkpoint-scope-density is `phase: checkpoint-open, severity: block`.
    // While fixtures could only describe CLOSED checkpoints it had no
    // current_checkpoint to look at, so the only outcome it could reach was
    // its no-current-open-checkpoint pass — a green that proved nothing.
    const fixture = await writeFixture(
      {
        plan: fixturePlan([
          'implement',
          'add unit tests',
          'add e2e test',
          'wire it up',
          'document',
        ]),
        checkpoints: [
          {
            status: 'open',
            artifact_id: 'placeholder-overwritten-by-stamp',
            n: 1,
            // 4 of 5 steps in one beat — past the 0.6 fraction, and the plan
            // clears min_plan_size.
            declared_step_ids: [STEP_IDS[0], STEP_IDS[1], STEP_IDS[2], STEP_IDS[3]],
            policy_exceptions: [],
            plan_revision_id: null,
            head_sha: '0000000000000000000000000000000000000000',
          },
        ],
        fires_at: 'checkpoint-open',
        checkpoint_n: 1,
      },
      'open-checkpoint.json'
    );

    const result = await runFixture(fixture, 'core/checkpoint-scope-density');
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as EvalTestOk & {
      run: { raw?: { reason?: string } };
    };
    expect(envelope.run.run_status).toBe('completed');
    expect(envelope.run.verdict).toBe('violation');
    expect(envelope.run.raw?.reason).not.toBe('no-current-open-checkpoint');
  });

  describe('checkpoint_n must name exactly one checkpoint', () => {
    // Before these checks the reference silently degraded: an unresolvable
    // checkpoint_n fell through to a raw storage id, so a run either found no
    // current_checkpoint — and a checkpoint-open evaluator answered with its
    // vacuous no-open-checkpoint pass — or found a DIFFERENT checkpoint that
    // happened to carry that storage number.
    function openCheckpoint(n: number, stepIds: readonly string[]) {
      return {
        status: 'open',
        artifact_id: 'placeholder-overwritten-by-stamp',
        n,
        declared_step_ids: [...stepIds],
        policy_exceptions: [],
        plan_revision_id: null,
        head_sha: '0000000000000000000000000000000000000000',
      };
    }

    it('rejects a checkpoint_n naming no declared checkpoint', async () => {
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [openCheckpoint(1, [STEP_IDS[0]])],
          fires_at: 'checkpoint-open',
          checkpoint_n: 999,
        },
        'unresolvable-cp.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('INVALID_INPUT');
      expect(result.stdout).toContain('names no checkpoint in this fixture');
    });

    it('rejects a checkpoint_n that would resolve to a different checkpoint', async () => {
      // The fixture labels its only checkpoint 10, so storage assigns it 1.
      // Asking for 1 used to miss the map and fall through to storage 1 —
      // silently grading the checkpoint the fixture called 10.
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [openCheckpoint(10, [STEP_IDS[0]])],
          fires_at: 'checkpoint-open',
          checkpoint_n: 1,
        },
        'aliased-cp.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('names no checkpoint in this fixture');
    });

    it('rejects duplicate checkpoint numbers', async () => {
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [openCheckpoint(1, [STEP_IDS[0]]), openCheckpoint(1, [STEP_IDS[1]])],
          fires_at: 'checkpoint-open',
          checkpoint_n: 1,
        },
        'duplicate-cp.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('duplicate checkpoint n 1');
    });

    it('rejects an explicit checkpoint phase with no checkpoint_n', async () => {
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [openCheckpoint(1, [STEP_IDS[0]])],
          fires_at: 'checkpoint-open',
        },
        'no-cp-n.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('needs a checkpoint_n');
    });

    it('rejects a checkpoint phase inherited from the evaluator with no checkpoint_n', async () => {
      // fires_at omitted, so the phase comes from core/checkpoint-scope-density
      // itself — a case the schema cannot see and only the command can catch.
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [openCheckpoint(1, [STEP_IDS[0]])],
        },
        'inherited-phase.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('runs at checkpoint-open');
      expect(result.stdout).toContain('checkpoint_n');
    });

    it('rejects a checkpoint whose status does not match the phase', async () => {
      const fixture = await writeFixture(
        {
          plan: fixturePlan(),
          checkpoints: [
            {
              status: 'closed',
              artifact_id: 'placeholder-overwritten-by-stamp',
              n: 1,
              declared_step_ids: [STEP_IDS[0]],
              policy_exceptions: [],
              plan_revision_id: null,
              head_sha: '0000000000000000000000000000000000000000',
              summary: 'closed, but asked for at checkpoint-open',
              files_changed: [],
              decisions: [],
              uncertainty: [],
              done_criteria: [],
              verification: [{ command: 'test fixture', exit_code: 0 }],
              completed_step_ids: [STEP_IDS[0]],
            },
          ],
          fires_at: 'checkpoint-open',
          checkpoint_n: 1,
        },
        'status-mismatch.json'
      );
      const result = await runFixture(fixture, 'core/checkpoint-scope-density');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('is closed, but checkpoint-open needs an open checkpoint');
    });
  });

  it('rejects a fixture that pairs a summary with an open checkpoint', async () => {
    // Storage refuses to finalize an artifact with checkpoints still open.
    // Catch it at parse time so the author reads a fixture-shaped message.
    const fixture = await writeFixture(
      {
        plan: fixturePlan(),
        checkpoints: [
          {
            status: 'open',
            artifact_id: 'placeholder-overwritten-by-stamp',
            n: 1,
            declared_step_ids: [STEP_IDS[0]],
            policy_exceptions: [],
            plan_revision_id: null,
            head_sha: '0000000000000000000000000000000000000000',
          },
        ],
        summary: {
          schema_version: 1,
          artifact_id: 'placeholder-overwritten-by-stamp',
          outcome: 'shipped',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: '0000000000000000000000000000000000000000',
          ts: '2026-04-27T00:00:00.000Z',
        },
        fires_at: 'pre-pr',
      },
      'summary-with-open-cp.json'
    );

    const result = await runFixture(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('INVALID_INPUT');
    expect(result.stdout).toContain('fixture.summary');
    expect(result.stdout).toContain('open checkpoint');
  });

  it('reports a discovery failure rather than claiming the evaluator does not exist', async () => {
    // A pack that fails to load shrinks the discovered set. Answering
    // EVALUATOR_NOT_FOUND there sends the user to fix a typo in a ref that is
    // spelled correctly, and never mentions the broken pack.
    // Register a VALID path-source pack (add-pack refuses a broken one), then
    // corrupt its spec so the failure happens where users actually hit it:
    // at discovery, after the pack is already configured.
    const packRoot = path.join(repo.path, 'local-pack');
    const specPath = path.join(packRoot, 'evaluators', 'always-info.eval.yaml');
    await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
    await mkdir(path.join(packRoot, 'runtime'), { recursive: true });
    await writeFile(
      path.join(packRoot, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: local',
        'name: local/pack',
        'version: 1.0.0',
        'description: local test pack',
        'evaluator_dir: ./evaluators',
        'defaults:',
        '  timeout_ms: 30000',
        '  env:',
        '    inherit:',
        '      - PATH',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(packRoot, 'runtime', 'always-info.js'),
      "process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v2', verdict: 'info', body: 'INFO' }));\n",
      'utf8'
    );
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: always-info',
        'phase: post-plan',
        'severity: info',
        'description: always emits info',
        'engine:',
        '  kind: command',
        '  command: ["node", "./runtime/always-info.js"]',
        '',
      ].join('\n'),
      'utf8'
    );
    const added = await agent.runRaw([
      'eval',
      'add-pack',
      './local-pack',
      'local',
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);

    await writeFile(specPath, 'schema: orcaops.evaluator/v1\nid: [unterminated\n', 'utf8');

    const validFixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });
    const result = await runFixture(validFixture, 'local/always-info');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('EVALUATOR_DISCOVERY_FAILED');
    expect(result.stdout).not.toContain('EVALUATOR_NOT_FOUND');
    expect(result.stdout).toContain('orcaops doctor');
  });

  it('still reports EVALUATOR_NOT_FOUND for a healthy pack while another is broken', async () => {
    // A namespaced ref cannot live in some other pack, so `local`'s breakage
    // says nothing about whether core/not-real exists. Reporting a discovery
    // failure here sent the user hunting for a correctly-spelled ref.
    const packRoot = path.join(repo.path, 'local-pack');
    const specPath = path.join(packRoot, 'evaluators', 'always-info.eval.yaml');
    await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
    await mkdir(path.join(packRoot, 'runtime'), { recursive: true });
    await writeFile(
      path.join(packRoot, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: local',
        'name: local/pack',
        'version: 1.0.0',
        'description: local test pack',
        'evaluator_dir: ./evaluators',
        'defaults:',
        '  timeout_ms: 30000',
        '  env:',
        '    inherit:',
        '      - PATH',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(packRoot, 'runtime', 'always-info.js'),
      "process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v2', verdict: 'info', body: 'INFO' }));\n",
      'utf8'
    );
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: always-info',
        'phase: post-plan',
        'severity: info',
        'description: always emits info',
        'engine:',
        '  kind: command',
        '  command: ["node", "./runtime/always-info.js"]',
        '',
      ].join('\n'),
      'utf8'
    );
    const added = await agent.runRaw([
      'eval',
      'add-pack',
      './local-pack',
      'local',
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);
    await writeFile(specPath, 'schema: orcaops.evaluator/v1\nid: [unterminated\n', 'utf8');

    const validFixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });

    // Missing ref in the HEALTHY pack: the broken one is irrelevant to it.
    const healthy = await runFixture(validFixture, 'core/not-real');
    expect(healthy.exitCode).toBe(1);
    expect(healthy.stdout).toContain('EVALUATOR_NOT_FOUND');
    expect(healthy.stdout).not.toContain('EVALUATOR_DISCOVERY_FAILED');

    // The broken pack's own ref still reports the load failure.
    const broken = await runFixture(validFixture, 'local/always-info');
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout).toContain('EVALUATOR_DISCOVERY_FAILED');

    // And a healthy pack stays grantable while the other is broken.
    const trusted = await agent.runRaw(['eval', 'trust', 'core', '--yes', '--json']);
    expect(trusted.exitCode).toBe(0);
  });

  it('prints an example fixture that parses and runs end to end', async () => {
    const printed = await agent.runRaw(['eval', 'test', '--print-example-fixture', '--json']);
    expect(printed.exitCode).toBe(0);
    const { fixture } = JSON.parse(printed.stdout) as { fixture: unknown };

    const fixturePath = await writeFixture(fixture, 'from-example.json');
    const result = await runFixture(fixturePath, 'core/checkpoint-scope-density');
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as EvalTestOk;
    expect(envelope.run.run_status).toBe('completed');
  });

  it('refuses --print-example-fixture combined with a run', async () => {
    const result = await agent.runRaw([
      'eval',
      'test',
      '--print-example-fixture',
      '--ref',
      'core/plan-mentions-tests',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('INVALID_INPUT');
  });

  it('names the missing options when neither --ref nor --fixture is given', async () => {
    const result = await agent.runRaw(['eval', 'test', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('--ref');
    expect(result.stdout).toContain('--fixture');
    expect(result.stdout).toContain('--print-example-fixture');
  });

  it('rejects malformed fixtures before evaluator discovery', async () => {
    const malformedFixture = await writeFixture({
      plan: { schema_version: 4, artifact_id: 'malformed' },
    });
    const storeRoot = path.join(repo.path, 'history-data');
    const before = await snapshotFiles(storeRoot);

    const result = await runFixture(malformedFixture, 'core/not-real');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('INVALID_INPUT');
    expect(result.stdout).toContain('fixture.plan');
    expect(result.stdout).not.toContain('EVALUATOR_NOT_FOUND');
    expect(await snapshotFiles(storeRoot)).toEqual(before);
  });

  describe('what the evaluator established', () => {
    const CRITERION_ID = '019e0000-0000-7000-8000-0000000000c1';

    it('shows established findings in both renderings', async () => {
      const ref = await addPackEmitting(
        'established',
        emitEnvelope({
          schema: 'orcaops.evaluator_result/v2',
          verdict: 'violation',
          body: 'VIOLATION\n\nOne criterion is under-delivered.',
          findings: [
            {
              key: `criterion/${CRITERION_ID}`,
              title: 'The criterion asks for 42 fixture tests; the delivery has 2',
              detail: 'Counted the cases under tests/expiry/.',
              locations: [
                { kind: 'acceptance-criterion', criterion_id: CRITERION_ID },
                { kind: 'file', path: 'tests/expiry/session.test.ts', start_line: 1, end_line: 40 },
              ],
              conclusion: 'contradicted',
            },
          ],
        })
      );
      const fixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });

      const json = await runFixture(fixture, ref);
      expect(json.exitCode).toBe(0);
      const envelope = JSON.parse(json.stdout) as EvalTestOk & {
        findings: { status: string; record?: { findings: { key?: string }[] } };
      };
      expect(envelope.run.verdict).toBe('violation');
      expect(envelope.findings.status).toBe('established');
      expect(envelope.findings.record?.findings[0]?.key).toBe(`criterion/${CRITERION_ID}`);

      const human = await runFixtureHuman(fixture, ref);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('findings (1):');
      expect(human.stdout).toContain('The criterion asks for 42 fixture tests');
      expect(human.stdout).toContain('conclusion: contradicted');
      expect(human.stdout).toContain(`acceptance-criterion ${CRITERION_ID}`);
      expect(human.stdout).toContain('tests/expiry/session.test.ts:1-40');
      expect(human.stdout).toContain('Counted the cases under tests/expiry/.');
    });

    it('says findings were offered and could not be read, and keeps the verdict', async () => {
      // A blank title is the shape the schema refuses. The author has to learn
      // that from the output; a run that silently showed nothing would read as
      // "my evaluator found nothing" and send them looking in the wrong place.
      const ref = await addPackEmitting(
        'unreadable',
        emitEnvelope({
          schema: 'orcaops.evaluator_result/v2',
          verdict: 'violation',
          body: 'VIOLATION\n\nSomething drifted.',
          findings: [{ title: '   ' }],
        })
      );
      const fixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });

      const json = await runFixture(fixture, ref);
      expect(json.exitCode).toBe(0);
      const envelope = JSON.parse(json.stdout) as EvalTestOk & {
        findings: { status: string; record?: { detail: string; source: string } };
      };
      // The verdict, the run status and the gate are untouched.
      expect(envelope.run.verdict).toBe('violation');
      expect(envelope.run.run_status).toBe('completed');
      expect(envelope.blocking).toBe(false);
      expect(envelope.findings.status).toBe('unreadable');
      expect(envelope.findings.record?.source).toBe('envelope');
      expect(envelope.findings.record?.detail).toContain('title');

      const human = await runFixtureHuman(fixture, ref);
      expect(human.stdout).toContain('findings: offered, but could not be read');
      expect(human.stdout).toContain('title');
    });

    it('reports the bound that cut a producer down, without costing it the verdict', async () => {
      const ref = await addPackEmitting(
        'bounded',
        [
          'const findings = Array.from({ length: 101 }, (_, i) => ({ title: `finding ${i}` }));',
          "process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v2', " +
            "verdict: 'violation', body: 'VIOLATION', findings }));",
          '',
        ].join('\n')
      );
      const fixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });

      const json = await runFixture(fixture, ref);
      expect(json.exitCode).toBe(0);
      const envelope = JSON.parse(json.stdout) as EvalTestOk & {
        findings: {
          status: string;
          record?: { findings: unknown[]; notice?: { findings_dropped: number } };
        };
      };
      expect(envelope.run.verdict).toBe('violation');
      expect(envelope.findings.status).toBe('established');
      expect(envelope.findings.record?.findings).toHaveLength(100);
      expect(envelope.findings.record?.notice?.findings_dropped).toBe(1);

      const human = await runFixtureHuman(fixture, ref);
      expect(human.stdout).toContain('findings (100):');
      expect(human.stdout).toContain('bounds applied: 1 finding(s) dropped');
    });

    it('says nothing at all when the evaluator offered no findings', async () => {
      // Absence is not malformation: an evaluator that never mentions findings
      // produces it, so it must not read as a failure or as an empty result.
      const ref = await addPackEmitting(
        'silent',
        emitEnvelope({
          schema: 'orcaops.evaluator_result/v2',
          verdict: 'pass',
          body: 'PASS\n\nNothing to report.',
        })
      );
      const fixture = await writeFixture({ plan: fixturePlan(), fires_at: 'post-plan' });

      const json = await runFixture(fixture, ref);
      const envelope = JSON.parse(json.stdout) as EvalTestOk & { findings: { status: string } };
      expect(envelope.findings).toEqual({ status: 'none' });

      const human = await runFixtureHuman(fixture, ref);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).not.toContain('findings');
    });
  });
});
