import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baselineRefName } from '@orcaops/core';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Routing regressions for the `capture plan` command tree, exercised
 * in-process over the real Commander tree that buildProgram() ships (the
 * spawn-level tier lives in tests/smoke). This set pins every behavior a
 * command-tree rewrite must preserve: bare-parent capture, revise routing,
 * option placement (--root/--no-llm/--invoked-by-agent/--source-plan), the
 * block commands' BOOLEAN --json (which shares a name with the retired
 * value-taking capture alias), pass-through delegation, and help output.
 */
describe('capture plan command routing (in-process command tree)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const planFile = (over: Record<string, unknown> = {}): string =>
    inputFile(
      JSON.stringify({
        task: 'routing regression task',
        label: 'routing regression',
        plan_steps: [{ text: 'step one', label: 's1' }],
        touched_scope: [],
        ...over,
      })
    );

  interface PlanOk {
    ok: true;
    artifact_id: string;
    plan_event_id: string;
    revision_n: number;
    plan_steps: Array<{ step_id: string; text: string; label: string }>;
  }

  it('bare `capture plan --input <file>` runs the initial capture', async () => {
    const res = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', planFile()]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as PlanOk;
    expect(env.ok).toBe(true);
    expect(env.artifact_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.plan_steps[0].step_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the retired explicit `plan capture` subverb is rejected', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      'capture',
      '--no-llm',
      '--input',
      planFile(),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/too many arguments|unknown command/);
  });

  it('`plan revise` routes its own input and supersedes the step set', async () => {
    const cap = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', planFile()]);
    const plan = JSON.parse(cap.stdout) as PlanOk;
    const res = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          label: 'routing regression revised',
          rationale: 'routing regression: prove revise routes independently',
          prior_plan_event_id: plan.plan_event_id,
          plan_steps: [
            { step_id: plan.plan_steps[0].step_id, text: 'step one', label: 's1' },
            { text: 'step two', label: 's2' },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as PlanOk;
    expect(env.ok).toBe(true);
    expect(env.revision_n).toBe(1);
    expect(env.plan_steps).toHaveLength(2);
  });

  it('rejects --source-plan on `plan revise` as an unknown option', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--source-plan',
      'does-not-matter.md',
      '--input',
      planFile(),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/unknown option/);
  });

  it('accepts --source-plan on the bare parent and pins the file', async () => {
    const sourcePlan = path.join(repo.path, 'slice-plan.md');
    await writeFile(sourcePlan, '# the plan\n\ndo the thing\n', 'utf8');
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      sourcePlan,
      '--input',
      planFile(),
    ]);
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as PlanOk).ok).toBe(true);
  });

  it('--root after the subcommand captures into the explicit root from a foreign cwd', async () => {
    const outside = await createTempRepo({ initialBranch: 'main' });
    try {
      const foreign = makeAgent({ cwd: outside.path });
      const res = await foreign.runRaw([
        'capture',
        'plan',
        '--root',
        repo.path,
        '--no-llm',
        '--input',
        planFile({ task: 'rooted capture', label: 'rooted capture' }),
      ]);
      expect(res.exitCode).toBe(0);
      const env = JSON.parse(res.stdout) as PlanOk;
      // The artifact must land in the --root repo, not the cwd repo.
      const shown = await agent.runRaw(['show', env.artifact_id, '--json']);
      expect(shown.exitCode).toBe(0);
    } finally {
      await outside.cleanup();
    }
  });

  it('--invoked-by-agent is accepted on the bare parent capture', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--invoked-by-agent',
      'claude-code',
      '--input',
      planFile(),
    ]);
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as PlanOk).ok).toBe(true);
  });

  it('block acknowledge/dismiss --json stays a BOOLEAN and never swallows the next flag', async () => {
    // `--json` here shares a name with the retired value-taking capture
    // alias. If it ever became value-taking, it would swallow `--artifact`
    // and commander would fail with a missing-required error instead of the
    // action's typed envelope.
    for (const verb of ['acknowledge', 'dismiss']) {
      const res = await agent.runRaw([
        'block',
        verb,
        '--json',
        '--artifact',
        'no-such-artifact',
        '--evaluator',
        'core/does-not-exist',
        '--reason',
        'routing regression',
      ]);
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
      expect(env.ok).toBe(false);
      expect(typeof env.error.code).toBe('string');
    }
  });

  it('review delegation forwards unknown flags verbatim into the engine', async () => {
    const res = await agent.runRaw(['review', 'data', '--branch', 'main', '--weird-unknown-flag']);
    // Discriminating: the ENGINE names the forwarded flag in its own error
    // wording. Without pass-through, commander rejects with "unknown option"
    // before the engine ever runs — and this assertion fails.
    expect(res.stdout + res.stderr).toMatch(/unknown argument\(s\): --weird-unknown-flag/);
    expect(res.stderr).not.toMatch(/unknown option/);
  });

  it('watch spawns its binary with the pass-through argv verbatim', async () => {
    const { mkdtemp, readFile: readF, writeFile: writeF, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-stub-'));
    const argsOut = path.join(dir, 'argv.json');
    const stub = path.join(dir, 'watch-stub.js');
    await writeF(
      stub,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.ARGS_OUT, JSON.stringify(process.argv.slice(2)));\n`,
      'utf8'
    );
    await chmod(stub, 0o755);
    const watchAgent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_WATCH_BIN: stub, ARGS_OUT: argsOut },
    });
    const res = await watchAgent.runRaw(['watch', '--weird-flag', 'value', '--json']);
    expect(res.exitCode).toBe(0);
    // Byte-for-byte forwarding: unknown flags reach the child untouched.
    expect(JSON.parse(await readF(argsOut, 'utf8'))).toEqual(['--weird-flag', 'value', '--json']);
  });

  it('rejects payload options placed BEFORE the revise subverb instead of dropping them', async () => {
    // Under positional options the parent would otherwise silently consume
    // a misplaced --no-llm/--input and revise would run without them.
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      'revise',
      '--input',
      planFile(),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/after 'revise'/);
  });

  it('`capture plan --help` lists the revise subcommand', async () => {
    const res = await agent.runRaw(['capture', 'plan', '--help']);
    expect(res.stdout + res.stderr).toMatch(/revise/);
  });

  it('a malformed payload through the bare parent renders the typed envelope', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile('{definitely not yaml: ['),
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('capture plan — the baseline snapshot honours capture.exclude', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('keeps an excluded file out of the ref the first command of a task pins', async () => {
    // The baseline is captured by `capture plan` — the FIRST orcaops command of
    // every task — and pinned to a durable ref reachable from no branch. Every
    // checkpoint path threaded the excludes; this one was called with no options
    // at all, so `.env` was blobbed into that ref, disclosed nowhere, on every
    // task in every repo. The checkout disclosure is checkpoint-scoped and never
    // sees a baseline.
    await writeFile(path.join(repo.path, '.env'), 'DEPLOY_TOKEN=must-not-be-blobbed\n', 'utf8');
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'ordinary task',
          label: 'ordinary task',
          plan_steps: [{ text: 'do the work', label: 'do work' }],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    const { artifact_id: artifactId } = JSON.parse(res.stdout) as { artifact_id: string };

    const entries = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', `${baselineRefName(artifactId)}^{tree}`],
      { cwd: repo.path, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);

    expect(entries).not.toContain('.env');
    // Control: the ref is a real tree of this worktree, not an empty one.
    expect(entries).toContain('src.ts');
  });
});
