import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('--input <path> flag', () => {
  let repo: TempRepo;
  let inputDir: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    inputDir = await mkdtemp(path.join(tmpdir(), 'orcaops-input-'));
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reads JSON from --input <file> for capture plan', async () => {
    const file = path.join(inputDir, 'plan.json');
    await writeFile(
      file,
      JSON.stringify({
        idempotency_key: 'k-input-1',
        task: 'thing from file',
        label: 'thing-from-file',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
      }),
      'utf8'
    );
    const res = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', file]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; artifact_id: string };
    expect(out.ok).toBe(true);
    expect(out.artifact_id).toBeDefined();
  });

  it('--input on capture summary closes a planned artifact', async () => {
    const planFile = path.join(inputDir, 'plan.json');
    await writeFile(
      planFile,
      JSON.stringify({
        idempotency_key: 'k-input-2',
        task: 't',
        label: 'lbl-2',
        plan_steps: [{ text: 's', label: 's1' }],
        touched_scope: [],
      }),
      'utf8'
    );
    const planRes = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', planFile]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    const summaryFile = path.join(inputDir, 'summary.json');
    await writeFile(
      summaryFile,
      JSON.stringify({
        idempotency_key: 'k-input-3',
        artifact_id: plan.artifact_id,
        outcome: 'shipped from file',
      }),
      'utf8'
    );
    const sumRes = await agent.runRaw(['capture', 'summary', '--input', summaryFile]);
    expect(sumRes.exitCode).toBe(0);
    const out = JSON.parse(sumRes.stdout) as { ok: boolean; artifact_id: string };
    expect(out.ok).toBe(true);
    expect(out.artifact_id).toBe(plan.artifact_id);
  });

  it('returns NO_INPUT for a missing --input file', async () => {
    const missing = path.join(inputDir, 'never-existed.json');
    const res = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', missing]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; path?: string } };
    expect(env.error.code).toBe('NO_INPUT');
    expect(env.error.path).toBe('input');
  });

  it('returns INVALID_INPUT for a malformed --input file', async () => {
    const malformed = path.join(inputDir, 'broken.json');
    await writeFile(malformed, '{ not valid json', 'utf8');
    const res = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', malformed]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('returns NO_INPUT for an empty --input file', async () => {
    const empty = path.join(inputDir, 'empty.json');
    await writeFile(empty, '   \n  ', 'utf8');
    const res = await agent.runRaw(['capture', 'plan', '--no-llm', '--input', empty]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('NO_INPUT');
  });

  it('the retired --json payload alias is rejected as an unknown option', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--json',
      JSON.stringify({ idempotency_key: 'k2', task: 't2' }),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/unknown option/);
  });

  it('the retired --yaml payload alias is rejected as an unknown option', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--yaml',
      JSON.stringify({ idempotency_key: 'k-yaml-inline', task: 't via the yaml alias' }),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/unknown option/);
  });

  it('rejects the in-process stdin form (--input -) fast instead of hanging', async () => {
    await expect(agent.runRaw(['capture', 'plan', '--input', '-'])).rejects.toThrow(/stdin/i);
  });
});
