import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops list` time-window flags, end to end.
 *
 * Store-level interval-overlap semantics (incl. the backdated cases a live
 * repo can't produce) are pinned in
 * `packages/storage/src/store/list-windows.test.ts`; this file covers the
 * flag wiring: parse → validate → thread into the store call.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ListOk {
  ok: true;
  artifacts: Array<{ id: string }>;
}

function parseOk(r: CliResult): ListOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as ListOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

describe('orcaops list — time-window flags', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let artifactId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);

    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'list window fixture',
          label: 'list-window-fixture',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(r.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    artifactId = plan.artifact_id;
    // Leave a checkpoint OPEN: its interval [now, ∞) must overlap any window
    // whose upper bound is at/after now.
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function list(...flags: string[]): Promise<CliResult> {
    return agent.runRaw(['list', '--json', ...flags]);
  }

  it('--since / --until bound started_at (date-only = UTC day edges)', async () => {
    const included = parseOk(await list('--since', '1970-01-01'));
    expect(included.artifacts.map((a) => a.id)).toContain(artifactId);

    const excluded = parseOk(await list('--until', '1970-01-01'));
    expect(excluded.artifacts).toEqual([]);
  });

  it('an open checkpoint matches a today-only activity window (interval overlap, E2E)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const matched = parseOk(await list('--active-since', today, '--active-until', today));
    expect(matched.artifacts.map((a) => a.id)).toContain(artifactId);
  });

  it('a past activity window with no activity in it excludes the artifact', async () => {
    const excluded = parseOk(
      await list('--active-since', '1970-01-01', '--active-until', '1970-01-02')
    );
    expect(excluded.artifacts).toEqual([]);
  });

  it('an inverted window pair is rejected with INVALID_INPUT', async () => {
    const r = await list('--since', '2026-07-02', '--until', '2026-07-01');
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: false; error: { code: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
  });

  it('garbage input is rejected naming the flag', async () => {
    const r = await list('--active-since', 'yesterday');
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('--active-since');
  });
});
