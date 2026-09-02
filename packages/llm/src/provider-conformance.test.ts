import { run } from 'effection';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateOneShot as evaluateClaude } from './claude-code/one-shot.js';
import { evaluateOneShot as evaluateCodex } from './codex/one-shot.js';
import { deterministicClient } from './deterministic.js';
import type { EvaluateResult } from './types.js';

const PUBLIC_RESULT_KEYS = [
  'body',
  'model',
  'tokens',
  'costUsd',
  'durationMs',
  'sessionId',
  'error',
] as const;

type PublicResultKey = (typeof PUBLIC_RESULT_KEYS)[number];
type PublicKeysAreExact =
  Exclude<keyof EvaluateResult, PublicResultKey> extends never
    ? Exclude<PublicResultKey, keyof EvaluateResult> extends never
      ? true
      : false
    : false;

const PUBLIC_KEYS_ARE_EXACT: PublicKeysAreExact = true;

function expectPublicResult(result: EvaluateResult): void {
  expect(PUBLIC_KEYS_ARE_EXACT).toBe(true);
  expect(result).not.toHaveProperty('raw');
  expect(
    Object.keys(result).every((key) => PUBLIC_RESULT_KEYS.includes(key as PublicResultKey))
  ).toBe(true);
  expect(result).toMatchObject({
    body: expect.any(String),
    durationMs: expect.any(Number),
    sessionId: expect.any(String),
  });
  expect(result.model === null || typeof result.model === 'string').toBe(true);
}

describe('EvaluateResult provider conformance', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-llm-conformance-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('matches Claude success and cancellation results', async () => {
    const binPath = path.join(root, 'claude');
    const body = JSON.stringify({ schema: 'result', ok: true });
    const event = JSON.stringify({
      type: 'result',
      result: body,
      total_cost_usd: 0.01,
      usage: { input_tokens: 4, output_tokens: 2 },
      modelUsage: {
        'claude-sonnet-4-6[1m]': { canonicalModel: 'claude-sonnet-4-6', provider: 'firstParty' },
      },
      is_error: false,
    });
    await writeFile(binPath, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${event}'\n`, {
      mode: 0o755,
    });

    const success = await run(() =>
      evaluateClaude({ binPath }, { prompt: 'return json', outputSchema: { type: 'object' } })
    );
    expectPublicResult(success);
    expect(success.body).toBe(body);
    expect(success.tokens).toEqual({ in: 4, out: 2 });
    expect(success.costUsd).toBe(0.01);
    expect(success.model).toBe('claude-sonnet-4-6[1m]');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(() =>
      evaluateClaude({ binPath }, { prompt: 'x', signal: controller.signal })
    );
    expectPublicResult(cancelled);
    expect(cancelled.error?.code).toBe('CANCELLED');
    expect(cancelled.model).toBeNull();
  });

  it('matches Codex success and cancellation results', async () => {
    const binPath = path.join(root, 'codex');
    const body = JSON.stringify({ schema: 'result', ok: true });
    await writeFile(
      binPath,
      `#!/bin/sh\nout=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--output-last-message' ]; then\n    shift\n    out="$1"\n  fi\n  shift\ndone\ncat >/dev/null\nprintf '%s' '${body}' > "$out"\n`,
      { mode: 0o755 }
    );

    const success = await run(() =>
      evaluateCodex(
        { binPath, scratchParentDir: root },
        { prompt: 'return json', outputSchema: { type: 'object' } }
      )
    );
    expectPublicResult(success);
    expect(success.body).toBe(body);
    expect(success.model).toBeNull();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(() =>
      evaluateCodex({ binPath, scratchParentDir: root }, { prompt: 'x', signal: controller.signal })
    );
    expectPublicResult(cancelled);
    expect(cancelled.error?.code).toBe('CANCELLED');
    expect(cancelled.model).toBeNull();
  });

  it('matches the deterministic unavailable and cancellation results', async () => {
    const unavailable = await run(() => deterministicClient.evaluate({ prompt: 'x' }));
    expectPublicResult(unavailable);
    expect(unavailable.error?.code).toBe('TOOL_NOT_FOUND');
    expect(unavailable.model).toBeNull();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(() =>
      deterministicClient.evaluate({ prompt: 'x', signal: controller.signal })
    );
    expectPublicResult(cancelled);
    expect(cancelled.error?.code).toBe('CANCELLED');
    expect(cancelled.model).toBeNull();
  });
});
