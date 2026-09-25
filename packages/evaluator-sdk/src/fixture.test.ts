import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';

import { ORCAOPS_CONTEXT_PATH_ENV } from './context.js';
import { runFixture, RunFixtureError } from './fixture.js';

function fixtureContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KA',
    evaluator_ref: 'test/runfixture',
    phase: 'post-plan',
    artifact_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KB',
    checkpoint_n: null,
    repo: {
      root: '/tmp/repo',
      branch: 'main',
      base_sha: 'sha-base',
      head_sha: 'sha-head',
    },
    plan: {
      task: 't',
      label: 'l',
      branch: 'main',
      base_sha: 'sha-base',
      agent: null,
      agent_session_id: null,
      plan_steps: [
        {
          step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KC',
          text: 'step',
          label: 'step',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      started_at: '2026-04-26T12:00:00.000Z',
    },
    prior_plan: null,
    source_plan: null,
    current_checkpoint: null,
    closed_checkpoints: [],
    open_checkpoints: [],
    abandoned_checkpoints: [],
    summary: null,
    changed_files: [],
    params: {},
    ...overrides,
  } as EvaluatorContext;
}

describe('runFixture', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'orcaops-fixture-test-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('spawns the subprocess, reads ORCAOPS_CONTEXT_PATH, and parses the envelope', async () => {
    // Tiny pack-style runtime: reads context, emits a PASS envelope.
    const runtime = path.join(scratch, 'runtime.cjs');
    await writeFile(
      runtime,
      `
      const fs = require('fs');
      const ctx = JSON.parse(fs.readFileSync(process.env.${ORCAOPS_CONTEXT_PATH_ENV}, 'utf8'));
      process.stdout.write(JSON.stringify({
        schema: 'orcaops.evaluator_result/v2',
        verdict: 'pass',
        body: 'PASS\\n\\nref=' + ctx.evaluator_ref,
      }));
      `,
      'utf8'
    );
    const result = await runFixture({
      command: [process.execPath, runtime],
      cwd: scratch,
      context: fixtureContext(),
    });
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.body).toContain('ref=test/runfixture');
    expect(result.exitCode).toBe(0);
  });

  it('throws RunFixtureError when the subprocess exits non-zero', async () => {
    const runtime = path.join(scratch, 'crash.cjs');
    await writeFile(runtime, `process.stderr.write('crashy'); process.exit(2);`, 'utf8');
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(RunFixtureError);
  });

  it('throws when the subprocess produces no stdout', async () => {
    const runtime = path.join(scratch, 'empty.cjs');
    await writeFile(runtime, `// no output`, 'utf8');
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(/produced no stdout/);
  });

  it('throws when stdout is not valid JSON', async () => {
    const runtime = path.join(scratch, 'bad-json.cjs');
    await writeFile(runtime, `process.stdout.write('not json');`, 'utf8');
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when stdout is JSON but not a valid envelope', async () => {
    const runtime = path.join(scratch, 'wrong-shape.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v2', verdict: 'nope', body: 'x' }));`,
      'utf8'
    );
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(/schema validation/);
  });

  it('tells an author to upgrade when the runtime emits a superseded envelope', async () => {
    // A pack built against the old SDK fails here rather than in production,
    // and with the one wording the runner would have used.
    const runtime = path.join(scratch, 'old-protocol.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v1', verdict: 'pass', body: 'x' }));`,
      'utf8'
    );
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(/unsupported protocol[\s\S]*@orcaops\/evaluator-sdk/);
  });

  it('parses the findings an envelope carries', async () => {
    const runtime = path.join(scratch, 'with-findings.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({
        schema: 'orcaops.evaluator_result/v2',
        verdict: 'violation',
        body: 'VIOLATION',
        findings: [{ key: 'rule/one', title: 'what it found' }],
      }));`,
      'utf8'
    );
    const result = await runFixture({
      command: [process.execPath, runtime],
      cwd: scratch,
      context: fixtureContext(),
    });
    expect(result.envelope.findings).toEqual([{ key: 'rule/one', title: 'what it found' }]);
  });

  it('throws on a malformed finding, naming the field', async () => {
    const runtime = path.join(scratch, 'bad-finding.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({
        schema: 'orcaops.evaluator_result/v2',
        verdict: 'violation',
        body: 'VIOLATION',
        findings: [{ title: 'a statement', conclusion: 'supported' }],
      }));`,
      'utf8'
    );
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
      })
    ).rejects.toThrow(/findings\.0\.conclusion/);
  });

  it('forwards optional metrics + raw fields through the envelope', async () => {
    const runtime = path.join(scratch, 'rich.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({
        schema: 'orcaops.evaluator_result/v2',
        verdict: 'violation',
        body: 'V',
        raw: { found: 3 },
        metrics: { lines: 117 },
      }));`,
      'utf8'
    );
    const result = await runFixture({
      command: [process.execPath, runtime],
      cwd: scratch,
      context: fixtureContext(),
    });
    expect(result.envelope.verdict).toBe('violation');
    expect(result.envelope.raw).toEqual({ found: 3 });
    expect(result.envelope.metrics).toEqual({ lines: 117 });
  });

  it('user-supplied env cannot override ORCAOPS_CONTEXT_PATH', async () => {
    // If a user-supplied env entry shadowed our context path, the
    // runtime would read whatever the user pointed at. The harness
    // must win: ORCAOPS_CONTEXT_PATH is always the temp file the
    // harness wrote.
    const runtime = path.join(scratch, 'ctx-path.cjs');
    await writeFile(
      runtime,
      `process.stdout.write(JSON.stringify({
        schema: 'orcaops.evaluator_result/v2',
        verdict: 'info',
        body: 'INFO\\n\\nctx-path-tail=' + process.env.${ORCAOPS_CONTEXT_PATH_ENV}.split('/').pop(),
      }));`,
      'utf8'
    );
    const result = await runFixture({
      command: [process.execPath, runtime],
      cwd: scratch,
      context: fixtureContext(),
      env: { [ORCAOPS_CONTEXT_PATH_ENV]: '/wrong/path' },
    });
    expect(result.envelope.body).toContain('ctx-path-tail=context.json');
  });

  it('reports a TIMEOUT as a timeout, and SIGKILLs a runtime that ignores SIGTERM', async () => {
    // Before the shared primitive, runFixture only ever sent SIGTERM and had
    // no escalation, so a SIGTERM-ignoring runtime hung forever; and because
    // a killed process reports exitCode null, a timeout surfaced as the
    // misleading "produced no stdout (envelope missing)".
    const runtime = path.join(scratch, 'stubborn.cjs');
    await writeFile(
      runtime,
      `process.on('SIGTERM', () => {});\nsetInterval(() => {}, 50);\n`,
      'utf8'
    );
    const started = Date.now();
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
        timeoutMs: 200,
      })
    ).rejects.toThrow(/exceeded its 200ms timeout/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('surfaces a cancellation distinctly from a timeout', async () => {
    const runtime = path.join(scratch, 'slow.cjs');
    await writeFile(runtime, `setInterval(() => {}, 50);\n`, 'utf8');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
        timeoutMs: 30_000,
        signal: controller.signal,
      })
    ).rejects.toThrow(/was canceled/);
  }, 20_000);

  it('bounds runaway output instead of reading it unbounded', async () => {
    const runtime = path.join(scratch, 'flood.cjs');
    await writeFile(
      runtime,
      `const chunk = 'x'.repeat(64 * 1024);\nfor (let i = 0; i < 200; i++) process.stdout.write(chunk);\n`,
      'utf8'
    );
    await expect(
      runFixture({
        command: [process.execPath, runtime],
        cwd: scratch,
        context: fixtureContext(),
        maxOutputBytes: 4096,
      })
    ).rejects.toThrow(/output cap/);
  }, 20_000);
});
