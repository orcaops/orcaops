import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoundedSubprocessRequest,
  BoundedSubprocessResult,
} from '@orcaops/evaluator-protocol/subprocess';

import { runPreparedInputCall } from './prepared-input-call.js';

/**
 * A process that survives SIGKILL cannot be staged with a real subprocess, so
 * this one file substitutes the subprocess primitive to report that outcome.
 */
const subprocess = vi.hoisted(() => ({
  requests: [] as BoundedSubprocessRequest[],
  result: null as BoundedSubprocessResult | null,
}));

vi.mock('@orcaops/evaluator-protocol/subprocess', () => ({
  runBoundedSubprocess: (request: BoundedSubprocessRequest) => {
    subprocess.requests.push(request);
    return Promise.resolve(subprocess.result);
  },
}));

function stopped(overrides: Partial<BoundedSubprocessResult>): BoundedSubprocessResult {
  return {
    exit_code: null,
    signal: null,
    stdout: '',
    stderr: '',
    duration_ms: 1_400,
    killed_reason: 'timeout',
    spawn_error: null,
    hard_killed: true,
    termination_confirmed: false,
    ...overrides,
  };
}

const CALL = {
  provider: 'claude',
  preparedInput: 'captured text',
  instructions: 'answer in JSON',
  maxInputBytes: 4096,
  maxOutputBytes: 4096,
  timeoutMs: 120_000,
  env: { ORCAOPS_CLAUDE_PATH: process.execPath },
} as const;

beforeEach(() => {
  subprocess.requests.length = 0;
});

describe('runPreparedInputCall — a provider that could not be confirmed stopped', () => {
  it('says the timed-out provider may still be running', async () => {
    subprocess.result = stopped({ killed_reason: 'timeout' });

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'TIMEOUT',
      providerStarted: true,
      terminationConfirmed: false,
      hardKilled: true,
      usage: null,
      costUsd: null,
    });
    expect(result.status === 'failed' && result.message).toMatch(
      /not confirmed stopped and may still be running/
    );
  });

  it('says the cancelled provider may still be running', async () => {
    subprocess.result = stopped({ killed_reason: 'canceled', hard_killed: false });

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'CANCELLED',
      terminationConfirmed: false,
      hardKilled: false,
    });
  });

  it('keeps the usage a provider reported before it had to be stopped', async () => {
    const reported = JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'late answer',
      usage: { input_tokens: 10, output_tokens: 4 },
      total_cost_usd: 0.002,
    });
    subprocess.result = stopped({ stdout: `${reported}\n`, termination_confirmed: true });

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'TIMEOUT',
      usage: { in: 10, out: 4 },
      costUsd: 0.002,
    });
    expect(result).not.toHaveProperty('body');
  });
});

describe('runPreparedInputCall — an unexpected exception', () => {
  const unreadable = null as unknown as string;

  it('does not claim the provider stopped when it threw with no subprocess result', async () => {
    subprocess.result = null;

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'PROVIDER_ERROR',
      providerStarted: true,
      terminationConfirmed: false,
      hardKilled: false,
      usage: null,
      costUsd: null,
    });
    expect(result.status === 'failed' && result.message).toMatch(
      /not confirmed stopped and may still be running/
    );
  });

  it('keeps an unconfirmed stop unconfirmed when reading the output then throws', async () => {
    subprocess.result = stopped({ stdout: unreadable, termination_confirmed: false });

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'PROVIDER_ERROR',
      providerStarted: true,
      terminationConfirmed: false,
      hardKilled: true,
    });
  });

  it('reports a confirmed stop as confirmed when reading the output then throws', async () => {
    subprocess.result = stopped({
      stdout: unreadable,
      killed_reason: null,
      exit_code: 0,
      hard_killed: false,
      termination_confirmed: true,
    });

    const result = await runPreparedInputCall(CALL);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'PROVIDER_ERROR',
      providerStarted: true,
      terminationConfirmed: true,
      hardKilled: false,
    });
    expect(result.status === 'failed' && result.message).not.toMatch(/not confirmed stopped/);
  });
});

describe('runPreparedInputCall — the limits handed to the subprocess', () => {
  it('signals the provider early enough for the grace, the kill, and its confirmation to fit the deadline', async () => {
    subprocess.result = stopped({});

    await runPreparedInputCall(CALL);

    const [request] = subprocess.requests;
    expect(request?.killGraceMs).toBe(1_000);
    expect(request?.timeoutMs).toBeLessThanOrEqual(120_000 - 1_000 - 600);
    expect(request?.timeoutMs).toBeGreaterThan(120_000 - 1_000 - 600 - 1_000);
  });

  it('bounds the collected stream by the answer limit, so no line can grow past it', async () => {
    subprocess.result = stopped({});

    await runPreparedInputCall({ ...CALL, maxOutputBytes: 1_000 });

    expect(subprocess.requests[0]?.maxOutputBytes).toBe(1_000 * 6 + 256 * 1024);
  });
});
