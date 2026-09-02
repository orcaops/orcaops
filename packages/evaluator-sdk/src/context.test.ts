import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCAOPS_CONTEXT_PATH_ENV, readEvaluatorContext } from './context.js';

function fixtureContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KA',
    evaluator_ref: 'test/sdk',
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
  };
}

describe('readEvaluatorContext', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'orcaops-sdk-context-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('throws when ORCAOPS_CONTEXT_PATH is unset', () => {
    expect(() => readEvaluatorContext({ env: {} })).toThrow(/ORCAOPS_CONTEXT_PATH is unset/);
  });

  it('throws with the path when the file is unreadable', () => {
    const ghost = path.join(scratch, 'no-such-file.json');
    expect(() => readEvaluatorContext({ env: { [ORCAOPS_CONTEXT_PATH_ENV]: ghost } })).toThrow(
      /Failed to read evaluator context at .*no-such-file\.json/
    );
  });

  it('throws when the file contents are not valid JSON', async () => {
    const ctxPath = path.join(scratch, 'bad.json');
    await writeFile(ctxPath, '{ not json', 'utf8');
    expect(() => readEvaluatorContext({ env: { [ORCAOPS_CONTEXT_PATH_ENV]: ctxPath } })).toThrow(
      /not valid JSON/
    );
  });

  it('throws when the JSON parses but fails schema validation', async () => {
    const ctxPath = path.join(scratch, 'wrong-shape.json');
    await writeFile(ctxPath, JSON.stringify({ schema: 'not-the-right-thing' }), 'utf8');
    expect(() => readEvaluatorContext({ env: { [ORCAOPS_CONTEXT_PATH_ENV]: ctxPath } })).toThrow();
  });

  it('returns the parsed + validated context on the happy path', async () => {
    const ctxPath = path.join(scratch, 'ctx.json');
    await writeFile(ctxPath, JSON.stringify(fixtureContext()), 'utf8');
    const ctx = readEvaluatorContext({ env: { [ORCAOPS_CONTEXT_PATH_ENV]: ctxPath } });
    expect(ctx.evaluator_ref).toBe('test/sdk');
    expect(ctx.phase).toBe('post-plan');
    expect(ctx.plan.plan_steps).toHaveLength(1);
  });

  it('honors the readFile override (test injection)', () => {
    const ctx = readEvaluatorContext({
      env: { [ORCAOPS_CONTEXT_PATH_ENV]: '/whatever' },
      readFile: () => JSON.stringify(fixtureContext({ evaluator_ref: 'injected/ref' })),
    });
    expect(ctx.evaluator_ref).toBe('injected/ref');
  });
});
