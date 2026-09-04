import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type OkEnvelope, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * The one CLI-level test that executes an LLM evaluator end to end.
 *
 * Every other LLM assertion in the repo stops short of the boundary: the
 * runner tests inject a stub client, and the SDK harness never constructs one
 * at all. Neither can see discovery → trust → provider routing → prompt
 * submission → verdict recording, which is the path both shipped defects
 * lived on. A third-party evaluator used to receive a prompt missing the
 * context it declared, and a bare verdict token trailing the real one used to
 * decide the persisted verdict.
 *
 * A fake `claude` reached through ORCAOPS_CLAUDE_PATH records what orcaops
 * submitted and returns a scripted response, so both halves are observable
 * without a provider.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(here, '..', 'support', 'fake-claude.mjs');

const STEP_ONE = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
const CRITERION_ONE = '01HX0K8N6ZQF8M5R2V8DZ7T3C1';

interface EvalTestOk extends OkEnvelope {
  ok: true;
  run: { run_status: string; verdict?: string; body: string; provider?: string; model?: string };
}

describe('eval test — LLM evaluator through the CLI boundary', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let scratch: string;
  let recordPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    scratch = await mkdtemp(path.join(tmpdir(), 'orcaops-llm-wiring-'));
    recordPath = path.join(scratch, 'submitted.json');
    await chmod(FAKE_CLAUDE, 0o755);

    // Deliberately NOT a first-party name: the ref used to decide which
    // context sections the prompt carried, so a third-party one is the case
    // that silently lost its data.
    const packRoot = path.join(scratch, 'acme-pack');
    await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
    await mkdir(path.join(packRoot, 'prompts'), { recursive: true });
    await writeFile(
      path.join(packRoot, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: acme',
        'name: acme/pack',
        'version: 1.0.0',
        'description: third-party llm pack',
        'evaluator_dir: ./evaluators',
        'defaults:',
        '  timeout_ms: 30000',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(packRoot, 'prompts', 'delivery-audit.prompt.md'),
      'Grade the delivery against the rubric above.\n',
      'utf8'
    );
    await writeFile(
      path.join(packRoot, 'evaluators', 'delivery-audit.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: delivery-audit',
        'phase: pre-pr',
        'severity: warn',
        'description: third-party delivery grader',
        'engine:',
        '  kind: llm',
        '  prompt_file: prompts/delivery-audit.prompt.md',
        '  output_format: markdown',
        '  provider: claude',
        '  additional_context_sections:',
        '    - acceptance-criteria',
        '    - diff-boundary',
        'filters:',
        '  when_llm: required',
        '',
      ].join('\n'),
      'utf8'
    );

    // ORCAOPS_CLAUDE_PATH rides the agent env, which is what binary lookup and
    // availability detection read. The stub's own two variables must go on
    // process.env instead: the spawn env comes from buildClaudeEnv(), which
    // spreads the real process env and never sees the agent's. Each test file
    // gets its own fork, so the mutation stays contained.
    process.env.ORCAOPS_FAKE_CLAUDE_RECORD = recordPath;
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CLAUDE_PATH: FAKE_CLAUDE },
    });
    await agent.init({ noLlm: true });

    const configFile = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configFile, 'utf8')) as {
      llm?: Record<string, unknown>;
    };
    config.llm = { ...(config.llm ?? {}), tool: 'claude' };
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');

    const added = await agent.runRaw([
      'eval',
      'add-pack',
      packRoot,
      'acme',
      '--profile',
      'all',
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);
  });

  afterEach(async () => {
    delete process.env.ORCAOPS_FAKE_CLAUDE_RECORD;
    delete process.env.ORCAOPS_FAKE_CLAUDE_RESPONSE;
    await repo.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  /** Script the fake provider's next response. */
  function respondWith(body: string): void {
    process.env.ORCAOPS_FAKE_CLAUDE_RESPONSE = body;
  }

  async function runEvaluator(): Promise<EvalTestOk> {
    const fixture = {
      plan: {
        schema_version: 4,
        artifact_id: 'placeholder-overwritten-by-stamp',
        branch: 'main',
        base_sha: '0000000000000000000000000000000000000000',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'ship the suite',
        label: 'fixture plan',
        plan_steps: [
          {
            step_id: STEP_ONE,
            text: 'add the test suite',
            label: 'tests',
            acceptance_criteria: [{ criterion_id: CRITERION_ONE, text: 'suite has >= 42 tests' }],
          },
        ],
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
      },
      fires_at: 'pre-pr',
    };
    const fixturePath = path.join(repo.path, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture), 'utf8');

    const result = await agent.runRaw([
      'eval',
      'test',
      '--ref',
      'acme/delivery-audit',
      '--fixture',
      fixturePath,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as EvalTestOk;
  }

  async function submitted(): Promise<{ prompt: string; argv: string[] }> {
    return JSON.parse(await readFile(recordPath, 'utf8')) as { prompt: string; argv: string[] };
  }

  it('carries declared context out and the sentinel verdict back', async () => {
    // One invocation, because all three claims are about the same one: what
    // orcaops submitted, how it invoked the provider, and how it read the
    // response. The bare-line fallback and NO_VERDICT_LINE live in the parser
    // and runner unit tests — repeating them here would rebuild a repo, pack,
    // and grant to re-prove something already pinned.
    respondWith(
      [
        'Two criteria are under-delivered.',
        '',
        '```orcaops-verdict',
        'VIOLATION',
        '```',
        '',
        'For reference, a clean run ends with:',
        '',
        'PASS',
        '',
      ].join('\n')
    );

    const envelope = await runEvaluator();
    const { prompt, argv } = await submitted();

    // Declared sections reach the provider under a ref that names no
    // first-party evaluator — the case the old ref gate silently starved.
    expect(prompt).toContain('## Acceptance criteria (the rubric to verify per step)');
    expect(prompt).toContain(`[${CRITERION_ONE}] suite has >= 42 tests`);
    expect(prompt).toContain("## Diff boundary (THIS artifact's delta)");
    expect(prompt).not.toContain('## Delivered checkpoints');
    expect(prompt).toContain('Grade the delivery against the rubric above.');

    // The shared system prompt is installed on the invocation itself; it was
    // exported and documented as a default while reaching no provider at all.
    const flag = argv.indexOf('--system-prompt');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(argv[flag + 1]).toContain('orcaops-verdict');

    // The sentinel decides the persisted verdict despite the trailing bare
    // PASS, so the recorded verdict agrees with the recorded body.
    expect(envelope.run.run_status).toBe('completed');
    expect(envelope.run.verdict).toBe('violation');
    expect(envelope.run.body).toContain('VIOLATION');
  });
});
