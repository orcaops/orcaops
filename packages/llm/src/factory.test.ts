import { action, run } from 'effection';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deterministicClient } from './deterministic.js';
import { buildLLMClient, type LLMClientConfig, makeRoutingClient } from './factory.js';
import type { EvaluateOptions, EvaluateResult, LLMClient } from './types.js';

const baseConfig: LLMClientConfig = {
  tool: 'auto',
  model: null,
  effort: 'medium',
  default_max_cost_usd: 0.5,
};

describe('buildLLMClient', () => {
  it('returns the deterministic client when noLlm is set', async () => {
    const client = await run(() => buildLLMClient(baseConfig, { noLlm: true }));
    expect(client).toBe(deterministicClient);
  });

  it('returns the deterministic client when tool is "none"', async () => {
    const client = await run(() => buildLLMClient({ ...baseConfig, tool: 'none' }));
    expect(client).toBe(deterministicClient);
  });

  it('returns the override when provided', async () => {
    const fake = { evaluate: () => undefined } as never;
    const client = await run(() => buildLLMClient(baseConfig, { override: fake }));
    expect(client).toBe(fake);
  });

  it('keeps an explicitly configured missing provider without falling back', async () => {
    const client = await run(() =>
      buildLLMClient(
        { ...baseConfig, tool: 'claude' },
        {
          env: {
            ...process.env,
            ORCAOPS_CLAUDE_PATH: '/orcaops-definitely-missing-claude',
            ORCAOPS_CODEX_PATH: process.execPath,
          },
        }
      )
    );
    expect(client.defaultProvider).toBe('claude');
    expect(client.isProviderAvailable?.('claude')).toBe(false);
    expect(client.isProviderAvailable?.('codex')).toBe(true);
  });

  it('keeps an inconclusive auto-detected provider runnable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-factory-unverified-'));
    const claude = path.join(root, 'claude-hang');
    try {
      await writeFile(claude, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n", {
        mode: 0o755,
      });
      const client = await run(() =>
        buildLLMClient(baseConfig, {
          env: {
            PATH: '/usr/bin:/bin',
            ORCAOPS_CLAUDE_PATH: claude,
            ORCAOPS_CODEX_PATH: path.join(root, 'missing-codex'),
          },
        })
      );

      expect(client).not.toBe(deterministicClient);
      expect(client.defaultProvider).toBe('claude');
      expect(client.isProviderAvailable?.('claude')).toBe(true);
      expect(client.isProviderAvailable?.('codex')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('LLMClient.isDeterministic', () => {
  it('is true on the deterministicClient (gates when_llm: required evaluators off)', () => {
    expect(deterministicClient.isDeterministic).toBe(true);
  });

  it('is false on the routing client built with a real default tool', () => {
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: { isDeterministic: false } as unknown as LLMClient,
      buildAlt: () => ({ isDeterministic: false }) as unknown as LLMClient,
    });
    expect(router.isDeterministic).toBe(false);
  });
});

describe('deterministicClient.evaluate', () => {
  it('returns an unavailable-provider error and zero duration', async () => {
    const result = await run(() => deterministicClient.evaluate({ prompt: 'anything' }));
    expect(result.body.startsWith('ERROR')).toBe(true);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(result.model).toBeNull();
    expect(result.durationMs).toBe(0);
  });
});

describe('makeRoutingClient', () => {
  /**
   * Build a stub client that records every evaluate call and returns
   * a result whose `model` field encodes which client served it.
   */
  function stubClient(tag: string): {
    client: LLMClient;
    calls: EvaluateOptions[];
    altBuilds: number;
  } {
    const calls: EvaluateOptions[] = [];
    return {
      calls,
      altBuilds: 0,
      client: {
        isDeterministic: false,
        defaultProvider: 'claude',
        evaluate: (opts) =>
          action<EvaluateResult>((resolve) => {
            calls.push(opts);
            const result: EvaluateResult = {
              body: `PASS\n\nfrom ${tag}`,
              model: tag,
              durationMs: 0,
              sessionId: tag,
            };
            resolve(result);
            return () => {};
          }),
      },
    };
  }

  it('routes evaluate() to the default client when no provider override is set', async () => {
    const claudeStub = stubClient('claude');
    const codexStub = stubClient('codex');
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: claudeStub.client,
      buildAlt: () => codexStub.client,
    });
    const result = await run(() => router.evaluate({ prompt: 'x' }));
    expect(result.model).toBe('claude');
    expect(claudeStub.calls).toHaveLength(1);
    expect(codexStub.calls).toHaveLength(0);
  });

  it('routes evaluate() to the alt client when provider override differs', async () => {
    const claudeStub = stubClient('claude');
    const codexStub = stubClient('codex');
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: claudeStub.client,
      buildAlt: () => codexStub.client,
    });
    const result = await run(() => router.evaluate({ prompt: 'x', provider: 'codex' }));
    expect(result.model).toBe('codex');
    expect(claudeStub.calls).toHaveLength(0);
    expect(codexStub.calls).toHaveLength(1);
  });

  it('caches the alt client across calls (buildAlt invoked once)', async () => {
    const claudeStub = stubClient('claude');
    const codexStub = stubClient('codex');
    let alt = 0;
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: claudeStub.client,
      buildAlt: () => {
        alt++;
        return codexStub.client;
      },
    });
    await run(() => router.evaluate({ prompt: 'x', provider: 'codex' }));
    await run(() => router.evaluate({ prompt: 'y', provider: 'codex' }));
    expect(alt).toBe(1);
    expect(codexStub.calls).toHaveLength(2);
  });

  it('matching the default tool with provider override hits the default (no alt build)', async () => {
    const claudeStub = stubClient('claude');
    let altCalls = 0;
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: claudeStub.client,
      buildAlt: () => {
        altCalls++;
        return claudeStub.client;
      },
    });
    await run(() => router.evaluate({ prompt: 'x', provider: 'claude' }));
    expect(altCalls).toBe(0);
  });

  it('does not build or fall back when the selected provider is unavailable', async () => {
    const claudeStub = stubClient('claude');
    let altCalls = 0;
    const router = makeRoutingClient({
      defaultTool: 'claude',
      defaultClient: claudeStub.client,
      availability: { claude: true, codex: false },
      buildAlt: () => {
        altCalls++;
        return stubClient('codex').client;
      },
    });
    const result = await run(() => router.evaluate({ prompt: 'x', provider: 'codex' }));
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(result.model).toBeNull();
    expect(altCalls).toBe(0);
    expect(claudeStub.calls).toHaveLength(0);
  });
});
