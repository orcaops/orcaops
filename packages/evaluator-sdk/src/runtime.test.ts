import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';

import { ORCAOPS_CONTEXT_PATH_ENV } from './context.js';
import { pass } from './result.js';
import { runIfDispatched } from './runtime.js';

const SAMPLE_CONTEXT: EvaluatorContext = {
  schema: 'orcaops.evaluator_context/v1',
  run_id: '019e0000-0000-7000-8000-000000000000',
  evaluator_ref: 'demo/runtime-test',
  phase: 'post-plan',
  artifact_id: '019e0000-0000-7000-8000-000000000001',
  checkpoint_n: null,
  repo: { root: '/repo', branch: 'main', base_sha: 'deadbeef', head_sha: 'cafebabe' },
  plan: {
    task: 'runtime test',
    label: 'runtime test',
    branch: 'main',
    base_sha: 'deadbeef',
    agent: 'claude-code',
    agent_session_id: null,
    plan_steps: [],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    started_at: '2026-05-13T00:00:00.000Z',
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
};

describe('runIfDispatched', () => {
  let tmpRoot: string;
  let prevEnv: string | undefined;
  let stdoutChunks: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-sdk-runtime-'));
    prevEnv = process.env[ORCAOPS_CONTEXT_PATH_ENV];
    delete process.env[ORCAOPS_CONTEXT_PATH_ENV];
    stdoutChunks = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (prevEnv === undefined) {
      delete process.env[ORCAOPS_CONTEXT_PATH_ENV];
    } else {
      process.env[ORCAOPS_CONTEXT_PATH_ENV] = prevEnv;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeContext(): string {
    const ctxPath = path.join(tmpRoot, 'ctx.json');
    writeFileSync(ctxPath, JSON.stringify(SAMPLE_CONTEXT));
    return ctxPath;
  }

  it('is a no-op when ORCAOPS_CONTEXT_PATH is unset', () => {
    const check = vi.fn(() => pass('PASS'));
    runIfDispatched(check);
    expect(check).not.toHaveBeenCalled();
    expect(stdoutChunks).toEqual([]);
  });

  it('runs the check + writes the result when ORCAOPS_CONTEXT_PATH is set', async () => {
    process.env[ORCAOPS_CONTEXT_PATH_ENV] = writeContext();
    const check = vi.fn((ctx: EvaluatorContext) => pass(`PASS\n\nphase=${ctx.phase}`));
    runIfDispatched(check);
    await new Promise((r) => setImmediate(r));
    expect(check).toHaveBeenCalledTimes(1);
    expect(stdoutChunks.length).toBe(1);
    const written = JSON.parse(stdoutChunks[0]) as { verdict: string; body: string };
    expect(written.verdict).toBe('pass');
    expect(written.body).toContain('phase=post-plan');
  });

  it('awaits an async check before writing the result', async () => {
    process.env[ORCAOPS_CONTEXT_PATH_ENV] = writeContext();
    let resolved = false;
    const check = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
      return pass('PASS\n\nasync ok');
    });
    runIfDispatched(check);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
    expect(stdoutChunks.length).toBe(1);
    expect(JSON.parse(stdoutChunks[0]).body).toContain('async ok');
  });
});
