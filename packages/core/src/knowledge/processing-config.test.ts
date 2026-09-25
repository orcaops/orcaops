import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  measurePreparedInputRequest,
  type NoToolCallResolution,
  PROVIDER_CAPABILITIES,
  type ProviderProbeSnapshot,
  resolveNoToolCall,
  runPreparedInputCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import {
  type Config,
  KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS,
  KNOWLEDGE_PROCESSING_PROVIDERS,
  resolveConfig,
} from '@orcaops/storage';

import { smallestProcessableInputBytes } from './interpretation/request.js';
import {
  describeProcessingModel,
  type EffectiveProcessingConfiguration,
  type KnowledgeProcessingResolution,
  type LlmCapabilitySurface,
  type ProcessingConfigSource,
  type ProcessingPauseCode,
  resolveKnowledgeProcessing,
} from './processing-config.js';

const shippedLlm: LlmCapabilitySurface = {
  capabilities: PROVIDER_CAPABILITIES,
  selectDefaultProvider,
  resolveNoToolCall,
  measurePreparedInputRequest,
};

/**
 * No shipped provider holds a hard per-call ceiling, so the ceiling rules are
 * reached through a surface whose claude does. Everything but the spend cap is
 * still decided by the shipped resolution.
 */
const ceilingLlm: LlmCapabilitySurface = {
  capabilities: {
    ...PROVIDER_CAPABILITIES,
    claude: { ...PROVIDER_CAPABILITIES.claude, spendCap: 'hard_ceiling' },
  },
  measurePreparedInputRequest,
  selectDefaultProvider,
  resolveNoToolCall: (request) => {
    const withoutSpend = resolveNoToolCall({
      ...request,
      explicitMaxCostUsd: undefined,
      inherited: request.inherited && { ...request.inherited, maxCostUsd: undefined },
    });
    if (withoutSpend.status === 'unavailable') return withoutSpend;
    const usd = request.explicitMaxCostUsd ?? request.inherited?.maxCostUsd;
    return {
      ...withoutSpend,
      settings: {
        ...withoutSpend.settings,
        spendCap:
          usd === undefined
            ? { kind: 'none', inheritedCapDropped: null }
            : {
                kind: 'enforced',
                usd,
                selection: request.explicitMaxCostUsd === undefined ? 'inherited' : 'explicit',
              },
      },
    };
  },
};

const BOTH_PRESENT: ProviderProbeSnapshot = { claude: 'present', codex: 'present' };
const SOURCE: ProcessingConfigSource = { kind: 'worktree', path: '/repo/.orcaops/config.json' };

function resolve(
  partial: {
    llm?: Partial<Config['llm']>;
    knowledge_processing?: Partial<Config['knowledge_processing']>;
  },
  options: {
    availability?: ProviderProbeSnapshot;
    llm?: LlmCapabilitySurface;
    source?: ProcessingConfigSource;
  } = {}
): KnowledgeProcessingResolution {
  return resolveKnowledgeProcessing({
    config: resolveConfig(partial),
    source: options.source ?? SOURCE,
    providerAvailability: options.availability ?? BOTH_PRESENT,
    llm: options.llm ?? shippedLlm,
  });
}

function enabled(
  processing: Partial<Config['knowledge_processing']> = {},
  llm: Partial<Config['llm']> = {}
): Parameters<typeof resolve>[0] {
  return { llm, knowledge_processing: { enabled: true, ...processing } };
}

function ready(resolution: KnowledgeProcessingResolution): EffectiveProcessingConfiguration {
  if (resolution.status !== 'ready') {
    throw new Error(`expected ready, got paused: ${JSON.stringify(resolution.reasons)}`);
  }
  return resolution.configuration;
}

function pauseCodes(resolution: KnowledgeProcessingResolution): ProcessingPauseCode[] {
  if (resolution.status !== 'paused') throw new Error('expected a paused resolution');
  return resolution.reasons.map((reason) => reason.code);
}

function pauseMessage(resolution: KnowledgeProcessingResolution, code: ProcessingPauseCode) {
  if (resolution.status !== 'paused') throw new Error('expected a paused resolution');
  const reason = resolution.reasons.find((candidate) => candidate.code === code);
  if (reason === undefined) throw new Error(`no ${code} reason`);
  return reason;
}

describe('the configurable providers', () => {
  it('are exactly the providers the llm capability surface declares', () => {
    expect([...KNOWLEDGE_PROCESSING_PROVIDERS].sort()).toEqual(
      Object.keys(PROVIDER_CAPABILITIES).sort()
    );
  });
});

describe('paused knowledge processing', () => {
  it('is paused as disabled by default, naming the governing file', () => {
    const resolution = resolve({});
    expect(resolution).toMatchObject({ status: 'paused', source: SOURCE, provider: null });
    expect(pauseCodes(resolution)).toEqual(['disabled']);
    expect(pauseMessage(resolution, 'disabled')).toMatchObject({
      setting: 'knowledge_processing.enabled',
      message: expect.stringContaining(SOURCE.path),
    });
  });

  it('says that no configuration file exists when none governs the worktree', () => {
    const resolution = resolve(
      {},
      { source: { kind: 'none', path: '/repo/.orcaops/config.json' } }
    );
    expect(pauseMessage(resolution, 'disabled').message).toMatch(/no orcaops configuration file/);
  });

  it('describes llm.tool none without claiming whether processing is enabled', () => {
    const resolution = resolve(enabled({ provider: 'claude' }, { tool: 'none' }));
    expect(pauseCodes(resolution)).toEqual(['llm_tool_none']);
    expect(pauseMessage(resolution, 'llm_tool_none')).toMatchObject({
      setting: 'llm.tool',
      message: expect.stringContaining(
        'turns off every model call, so knowledge processing cannot run with these settings.'
      ),
    });
  });

  it('is paused when auto detection finds no provider', () => {
    const resolution = resolve(enabled(), {
      availability: { claude: 'absent', codex: 'absent' },
    });
    expect(resolution).toMatchObject({ status: 'paused', provider: null });
    expect(pauseCodes(resolution)).toEqual(['provider_unavailable']);
  });

  it('says the provider could not be verified when nothing was checked', () => {
    const resolution = resolve(enabled(), { availability: {} as ProviderProbeSnapshot });
    expect(resolution).toMatchObject({ status: 'paused', provider: null });
    expect(pauseCodes(resolution)).toEqual(['provider_unverified']);
    expect(pauseMessage(resolution, 'provider_unverified').message).toMatch(
      /could not be verified: no completed check for claude, codex/
    );
  });

  it('says only the unchecked provider could not be verified when the other is absent', () => {
    const resolution = resolve(enabled(), {
      availability: { codex: 'absent' } as ProviderProbeSnapshot,
    });
    expect(pauseCodes(resolution)).toEqual(['provider_unverified']);
    expect(pauseMessage(resolution, 'provider_unverified').message).toMatch(
      /no completed check for claude\./
    );
  });

  it('is paused as unsupported, without throwing, for a provider outside the capability table', () => {
    const claudeUndeclared: LlmCapabilitySurface = {
      ...shippedLlm,
      capabilities: { codex: PROVIDER_CAPABILITIES.codex } as LlmCapabilitySurface['capabilities'],
      resolveNoToolCall: (request): NoToolCallResolution => ({
        status: 'unavailable',
        provider: request.provider,
        refusals: [{ capability: 'provider', message: 'claude is not a supported provider.' }],
      }),
    };
    const resolution = resolve(enabled({ provider: 'claude', max_cost_usd_per_day: 5 }), {
      llm: claudeUndeclared,
    });
    expect(resolution).toMatchObject({ status: 'paused', provider: 'claude' });
    expect(pauseCodes(resolution)).toEqual(['provider_unsupported']);
    expect(pauseMessage(resolution, 'provider_unsupported').setting).toBe(
      'knowledge_processing.provider'
    );
  });

  it('is paused as unsupported even when the call resolution vouches for the undeclared provider', () => {
    const vouching: LlmCapabilitySurface = {
      ...shippedLlm,
      capabilities: { codex: PROVIDER_CAPABILITIES.codex } as LlmCapabilitySurface['capabilities'],
    };
    const resolution = resolve(enabled({ provider: 'claude' }), { llm: vouching });
    expect(pauseCodes(resolution)).toEqual(['provider_unsupported']);
    expect(pauseMessage(resolution, 'provider_unsupported').message).toMatch(
      /claude is not a provider whose capabilities are declared \(codex\)/
    );
  });

  it('is paused when the named provider is absent, and never substitutes the present one', () => {
    const resolution = resolve(enabled({ provider: 'claude' }), {
      availability: { claude: 'absent', codex: 'present' },
    });
    expect(resolution).toMatchObject({ status: 'paused', provider: 'claude' });
    expect(pauseCodes(resolution)).toEqual(['provider_unavailable']);
    expect(pauseMessage(resolution, 'provider_unavailable')).toMatchObject({
      setting: 'knowledge_processing.provider',
      message: expect.stringContaining('No other provider is used'),
    });
  });

  it('is paused while the provider could not be confirmed installed', () => {
    const resolution = resolve(enabled(), {
      availability: { claude: 'unverified', codex: 'absent' },
    });
    expect(resolution).toMatchObject({ status: 'paused', provider: 'claude' });
    expect(pauseCodes(resolution)).toEqual(['provider_unverified']);
  });

  it('is paused on a provider that cannot enforce no-tool execution', () => {
    const resolution = resolve(enabled({ provider: 'codex' }));
    expect(resolution).toMatchObject({ status: 'paused', provider: 'codex' });
    expect(pauseCodes(resolution)).toEqual(['no_tool_execution_unenforced']);
    expect(pauseMessage(resolution, 'no_tool_execution_unenforced').message).toMatch(
      /^knowledge_processing\.tool_access: codex cannot run with every tool disabled/
    );
  });

  it('attributes the missing no-tool mode to the tool-access policy', () => {
    const resolution = resolve(enabled({}, { tool: 'codex' }));
    expect(pauseMessage(resolution, 'no_tool_execution_unenforced').setting).toBe(
      'knowledge_processing.tool_access'
    );
  });

  it('allows Codex only when its restricted tool-access policy is explicit', () => {
    const configuration = ready(
      resolve(enabled({ provider: 'codex', tool_access: 'codex_restricted' }))
    );
    expect(configuration.toolAccess).toBe('codex_restricted');
    expect(configuration.callRequest.toolAccess).toBe('codex_restricted');
  });

  it('resolves the restricted Codex profile without unsupported caps', () => {
    const configuration = ready(
      resolve(
        enabled(
          {
            provider: 'codex',
            tool_access: 'codex_restricted',
            effort: 'medium',
            max_attempts: 1,
            max_cost_usd_per_call: 'none',
          },
          { tool: 'codex' }
        )
      )
    );
    expect(configuration).toMatchObject({
      provider: { id: 'codex', selection: 'explicit' },
      toolAccess: 'codex_restricted',
      effort: { selection: 'explicit', value: 'medium' },
      maxAttempts: 1,
      limits: {
        max_cost_usd_per_call: 'none',
        max_cost_usd_per_day: 'none',
      },
      outputTokenCap: { kind: 'none' },
    });
  });

  it('refuses the Codex-restricted policy with another provider', () => {
    const resolution = resolve(enabled({ provider: 'claude', tool_access: 'codex_restricted' }));
    expect(pauseCodes(resolution)).toEqual(['tool_access_unsupported']);
    expect(pauseMessage(resolution, 'tool_access_unsupported').setting).toBe(
      'knowledge_processing.tool_access'
    );
  });

  it('applies an explicit effort to restricted Codex processing', () => {
    const configuration = ready(
      resolve(enabled({ provider: 'codex', tool_access: 'codex_restricted', effort: 'high' }))
    );
    expect(configuration.effort).toEqual({ selection: 'explicit', value: 'high' });
  });

  it('is paused by an explicit per-call cap the provider cannot hold as a ceiling', () => {
    const resolution = resolve(enabled({ max_cost_usd_per_call: 0.25 }));
    expect(pauseCodes(resolution)).toEqual(['per_call_cap_unenforceable']);
    expect(pauseMessage(resolution, 'per_call_cap_unenforceable')).toMatchObject({
      setting: 'knowledge_processing.max_cost_usd_per_call',
      message: expect.stringMatching(/only after the amount is exceeded/),
    });
  });

  it('is paused by an inherited cap too small to pass, naming the llm setting', () => {
    const resolution = resolve(enabled({}, { default_max_cost_usd: 0.00001 }));
    expect(pauseCodes(resolution)).toEqual(['per_call_cap_unenforceable']);
    expect(pauseMessage(resolution, 'per_call_cap_unenforceable').setting).toBe(
      'llm.default_max_cost_usd'
    );
  });

  it('is paused by a daily budget when no call ceiling can be reserved against it', () => {
    const resolution = resolve(enabled({ max_cost_usd_per_day: 5 }));
    expect(pauseCodes(resolution)).toEqual(['daily_budget_unenforceable']);
    expect(pauseMessage(resolution, 'daily_budget_unenforceable')).toMatchObject({
      setting: 'knowledge_processing.max_cost_usd_per_day',
      message: expect.stringMatching(
        /reserving each call's hard ceiling.*only after its amount is exceeded.*limits calls, not dollars/s
      ),
    });
  });

  it('reports the per-call and the daily refusal together', () => {
    const resolution = resolve(enabled({ max_cost_usd_per_call: 0.25, max_cost_usd_per_day: 5 }));
    expect(pauseCodes(resolution)).toEqual([
      'per_call_cap_unenforceable',
      'daily_budget_unenforceable',
    ]);
  });

  it('is paused by a daily budget on a ceiling-holding provider with no per-call ceiling set', () => {
    const resolution = resolve(
      enabled({ max_cost_usd_per_call: 'none', max_cost_usd_per_day: 5 }),
      { llm: ceilingLlm }
    );
    expect(pauseCodes(resolution)).toEqual(['daily_budget_unenforceable']);
    expect(pauseMessage(resolution, 'daily_budget_unenforceable').message).toMatch(
      /no per-call ceiling is set/
    );
  });

  it('is paused by a daily budget smaller than one call may cost', () => {
    const resolution = resolve(enabled({ max_cost_usd_per_call: 2, max_cost_usd_per_day: 1 }), {
      llm: ceilingLlm,
    });
    expect(pauseCodes(resolution)).toEqual(['daily_budget_below_per_call_cap']);
  });

  it('is paused by an output token limit the provider cannot enforce', () => {
    const resolution = resolve(enabled({ max_output_tokens: 4_096 }));
    expect(pauseCodes(resolution)).toEqual(['output_token_cap_unenforceable']);
    expect(pauseMessage(resolution, 'output_token_cap_unenforceable').setting).toBe(
      'knowledge_processing.max_output_tokens'
    );
  });

  it('returns a value for every unsupported combination at once and never throws', () => {
    const resolution = resolve(
      enabled({
        provider: 'codex',
        effort: 'max',
        max_cost_usd_per_call: 1,
        max_cost_usd_per_day: 2,
        max_output_tokens: 10,
      }),
      { availability: { claude: 'present', codex: 'unverified' } }
    );
    expect(pauseCodes(resolution)).toEqual([
      'provider_unverified',
      'no_tool_execution_unenforced',
      'per_call_cap_unenforceable',
      'output_token_cap_unenforceable',
      'daily_budget_unenforceable',
    ]);
  });
});

describe('an input cap below the floor', () => {
  const floor = smallestProcessableInputBytes({
    provider: 'claude',
    measure: { measurePreparedInputRequest },
  });

  it('pauses the workload naming the floor rather than refusing one capture at a time', () => {
    const resolution = resolve(enabled({ max_input_bytes: 20_000 }));

    expect(pauseCodes(resolution)).toEqual(['input_cap_below_floor']);
    const reason = pauseMessage(resolution, 'input_cap_below_floor');
    expect(reason.setting).toBe('knowledge_processing.max_input_bytes');
    expect(reason.message).toContain(String(floor));
    expect(reason.message).toContain('20000');
  });

  it('runs at the floor itself, so the number named is one a person can set', () => {
    expect(ready(resolve(enabled({ max_input_bytes: floor }))).limits.max_input_bytes).toBe(floor);
    expect(pauseCodes(resolve(enabled({ max_input_bytes: floor - 1 })))).toEqual([
      'input_cap_below_floor',
    ]);
  });

  it('leaves the schema minimum where it is, so an older configuration still loads', () => {
    expect(
      resolveConfig(enabled({ max_input_bytes: 1024 })).knowledge_processing.max_input_bytes
    ).toBe(1024);
    expect(pauseCodes(resolve(enabled({ max_input_bytes: 1024 })))).toEqual([
      'input_cap_below_floor',
    ]);
  });

  it('is the floor the configuration guide states beside the setting', async () => {
    const guide = await readFile(
      fileURLToPath(new URL('../../../../apps/docs/content/configuration.md', import.meta.url)),
      'utf8'
    );
    expect(guide).toContain(`is **${floor} bytes** on \`claude\``);
  });
});

describe('the effective processing configuration', () => {
  it('resolves the defaults of an enabled section on the inherited provider', () => {
    const configuration = ready(resolve(enabled()));
    expect(configuration).toMatchObject({
      source: SOURCE,
      provider: { id: 'claude', selection: 'inherited' },
      model: { selection: 'provider_default', id: null },
      effort: { selection: 'inherited', value: 'medium' },
      outputTokenCap: { kind: 'none' },
      timeoutMs: 300_000,
      maxAttempts: 3,
      idleExitMs: 30_000,
    });
    expect(configuration.limits).toEqual({
      max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' },
      max_cost_usd_per_day: 'none',
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    });
  });

  it('carries an inherited per-call amount as best effort and says it is not a cap', () => {
    const configuration = ready(resolve(enabled({}, { default_max_cost_usd: 0.2 })));
    expect(configuration.limits.max_cost_usd_per_call).toEqual({ usd: 0.2, holds: 'best_effort' });
    expect(configuration.notices.map((notice) => notice.code)).toEqual([
      'per_call_cap_best_effort',
      'no_daily_budget',
    ]);
    expect(configuration.notices[0]?.message).toMatch(/best effort, not a cap/);
  });

  it('reports an unset cap as no cap, and a call-count limit as not a dollar limit', () => {
    const configuration = ready(resolve(enabled({ max_cost_usd_per_call: 'none' })));
    expect(configuration.limits.max_cost_usd_per_call).toBe('none');
    expect(configuration.limits.max_cost_usd_per_day).toBe('none');
    expect(configuration.notices.map((notice) => notice.code)).toEqual([
      'no_per_call_cap',
      'no_daily_budget',
    ]);
    expect(configuration.notices[1]?.message).toMatch(/limits calls, not dollars/);
  });

  it('holds an explicit per-call amount as a ceiling where the provider can', () => {
    const configuration = ready(
      resolve(enabled({ max_cost_usd_per_call: 0.25, max_cost_usd_per_day: 5 }), {
        llm: ceilingLlm,
      })
    );
    expect(configuration.limits.max_cost_usd_per_call).toEqual({ usd: 0.25, holds: 'ceiling' });
    expect(configuration.limits.max_cost_usd_per_day).toBe(5);
    expect(configuration.notices).toEqual([]);
  });

  it('names the provider as explicit when the section selects it', () => {
    const configuration = ready(resolve(enabled({ provider: 'claude' }, { tool: 'codex' })));
    expect(configuration.provider).toEqual({ id: 'claude', selection: 'explicit' });
  });
});

describe('the call timeout', () => {
  const acceptance = async (timeoutMs: number): Promise<string> => {
    const configuration = ready(
      resolve(enabled({ timeout_ms: KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS }))
    );
    // Already cancelled, so the llm call validates the request and resolves its
    // capabilities, then stops before it creates a directory or a process.
    const result = await runPreparedInputCall({
      ...configuration.callRequest,
      preparedInput: 'prepared text',
      instructions: 'Answer with one word.',
      maxInputBytes: configuration.limits.max_input_bytes,
      maxOutputBytes: configuration.limits.max_output_bytes,
      timeoutMs,
      signal: AbortSignal.abort(),
    });
    if (result.status !== 'failed') throw new Error('a cancelled call cannot complete');
    expect(result.providerStarted).toBe(false);
    return result.code;
  };

  it('at its smallest legal value is a request the llm call accepts', async () => {
    const configuration = ready(
      resolve(enabled({ timeout_ms: KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS }))
    );
    expect(configuration.timeoutMs).toBe(KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS);
    expect(await acceptance(configuration.timeoutMs)).toBe('CANCELLED');
  });

  it('leaves at least three quarters of its smallest legal window to the answer', async () => {
    // The llm call refuses a deadline inside the time it reserves for stopping
    // the provider, so the longest refused deadline measures that reserve.
    let reserveMs = 0;
    for (let ms = 100; ms < KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS; ms += 100) {
      if ((await acceptance(ms)) === 'INVALID_REQUEST') reserveMs = ms;
    }
    expect(reserveMs).toBeGreaterThan(0);
    expect(reserveMs * 4).toBeLessThanOrEqual(KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS);
  });
});

describe('inheritance across a provider override', () => {
  it('carries llm.model to the provider llm.tool resolves to', () => {
    const configuration = ready(resolve(enabled({}, { tool: 'claude', model: 'claude-opus' })));
    expect(configuration.model).toEqual({ selection: 'inherited', id: 'claude-opus' });
  });

  it('leaves llm.model behind when the workload overrides the provider, and says so', () => {
    const configuration = ready(
      resolve(enabled({ provider: 'claude' }, { tool: 'codex', model: 'gpt-5-codex' }))
    );
    expect(configuration.model).toEqual({
      selection: 'provider_default',
      id: null,
      inheritedModelNotCarried: 'gpt-5-codex',
    });
    expect(configuration.notices.map((notice) => notice.code)).toContain(
      'inherited_model_not_carried'
    );
  });

  it('leaves the model to the provider when asked to, even where llm.model would be carried', () => {
    const configuration = ready(
      resolve(enabled({ model: 'provider_default' }, { tool: 'claude', model: 'claude-opus' }))
    );
    expect(configuration.model).toEqual({
      selection: 'provider_default',
      id: null,
      inheritedModelNotCarried: null,
    });
    expect(configuration.notices.map((notice) => notice.code)).not.toContain(
      'inherited_model_not_carried'
    );
    expect(configuration.configurationIdentity).not.toBe(
      ready(resolve(enabled({}, { tool: 'claude', model: 'claude-opus' }))).configurationIdentity
    );
  });

  it('uses an explicit model exactly as given under any provider', () => {
    const configuration = ready(
      resolve(enabled({ provider: 'claude', model: 'gpt-5-codex' }, { tool: 'codex' }))
    );
    expect(configuration.model).toEqual({ selection: 'explicit', id: 'gpt-5-codex' });
  });

  it('carries llm.effort across the override when the provider supports effort', () => {
    const configuration = ready(
      resolve(enabled({ provider: 'claude' }, { tool: 'codex', effort: 'high' }))
    );
    expect(configuration.effort).toEqual({ selection: 'inherited', value: 'high' });
  });

  it('drops an inherited effort the provider cannot apply and reports it, without pausing on it', () => {
    const resolution = resolve(enabled({ provider: 'codex' }, { effort: 'high' }));
    expect(pauseCodes(resolution)).not.toContain('effort_unsupported');

    const effortless: LlmCapabilitySurface = {
      ...shippedLlm,
      resolveNoToolCall: (request) => {
        const resolved = resolveNoToolCall(request);
        if (resolved.status === 'unavailable') return resolved;
        return {
          ...resolved,
          settings: {
            ...resolved.settings,
            effort: { selection: 'provider_default', value: null, inheritedEffortDropped: 'high' },
          },
        };
      },
    };
    const configuration = ready(resolve(enabled({}, { effort: 'high' }), { llm: effortless }));
    expect(configuration.effort.value).toBeNull();
    expect(configuration.notices.map((notice) => notice.code)).toContain(
      'inherited_effort_dropped'
    );
  });
});

describe('describeProcessingModel', () => {
  it('tells a provider default from a model orcaops selects, and says which key selected it', () => {
    const explicit = ready(resolve(enabled({ model: 'claude-opus' }))).model;
    const inherited = ready(resolve(enabled({}, { tool: 'claude', model: 'claude-opus' }))).model;
    const providerDefault = ready(resolve(enabled())).model;

    expect(describeProcessingModel(explicit)).toBe(
      'claude-opus (selected by knowledge_processing.model)'
    );
    expect(describeProcessingModel(inherited)).toBe('claude-opus (selected by llm.model)');
    expect(describeProcessingModel(providerDefault)).toBe(
      "the provider's default model (orcaops selects none)"
    );
  });
});

describe('the configuration identity', () => {
  const identity = (partial: Parameters<typeof resolve>[0], llm = shippedLlm): string =>
    ready(resolve(partial, { llm })).configurationIdentity;

  it('is a SHA-256 hex digest', () => {
    expect(identity(enabled())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same whatever order the configuration keys were written in', () => {
    const forward = identity({
      llm: { tool: 'claude', effort: 'high' },
      knowledge_processing: { enabled: true, timeout_ms: 60_000, max_attempts: 2 },
    });
    const backward = identity({
      knowledge_processing: { max_attempts: 2, timeout_ms: 60_000, enabled: true },
      llm: { effort: 'high', tool: 'claude' },
    });
    expect(backward).toBe(forward);
  });

  it('is the same wherever an unchanged value comes from', () => {
    const inherited = identity(enabled({}, { tool: 'claude', model: 'claude-opus' }));
    const explicit = identity(enabled({ provider: 'claude', model: 'claude-opus' }));
    expect(explicit).toBe(inherited);

    const elsewhere = ready(
      resolve(enabled(), { source: { kind: 'common', path: '/repo/.git/orcaops/config.json' } })
    ).configurationIdentity;
    expect(elsewhere).toBe(identity(enabled()));
  });

  it.each([
    ['model', enabled({ model: 'claude-opus' })],
    ['effort', enabled({ effort: 'high' })],
    ['tool_access', enabled({ provider: 'codex', tool_access: 'codex_restricted' })],
    ['timeout_ms', enabled({ timeout_ms: 60_000 })],
    ['max_attempts', enabled({ max_attempts: 2 })],
    ['max_calls_per_hour', enabled({ max_calls_per_hour: 30 })],
    ['max_input_bytes', enabled({ max_input_bytes: 65_536 })],
    ['max_output_bytes', enabled({ max_output_bytes: 32_768 })],
    ['max_cost_usd_per_call', enabled({ max_cost_usd_per_call: 'none' })],
    ['the inherited per-call amount', enabled({}, { default_max_cost_usd: 0.1 })],
    ['idle_exit_ms', enabled({ idle_exit_ms: 10_000 })],
  ])('changes when %s changes', (_label, changed) => {
    expect(identity(changed)).not.toBe(identity(enabled()));
  });

  it('changes with the provider when everything else is equal', () => {
    const everyProviderReady: LlmCapabilitySurface = {
      capabilities: {
        claude: PROVIDER_CAPABILITIES.claude,
        codex: PROVIDER_CAPABILITIES.claude,
      },
      measurePreparedInputRequest,
      selectDefaultProvider,
      resolveNoToolCall: (request): NoToolCallResolution => ({
        status: 'available',
        provider: request.provider,
        settings: {
          provider: request.provider,
          toolAccess: 'none',
          model: { selection: 'provider_default', id: null, inheritedModelNotCarried: null },
          effort: { selection: 'provider_default', value: null, inheritedEffortDropped: null },
          spendCap: { kind: 'none', inheritedCapDropped: null },
          outputTokenCap: { kind: 'none' },
          capabilities: PROVIDER_CAPABILITIES.claude,
        },
      }),
    };
    const onClaude = ready(resolve(enabled({ provider: 'claude' }), { llm: everyProviderReady }));
    const onCodex = ready(resolve(enabled({ provider: 'codex' }), { llm: everyProviderReady }));
    expect({ ...onCodex, provider: onClaude.provider, callRequest: onClaude.callRequest }).toEqual({
      ...onClaude,
      configurationIdentity: onCodex.configurationIdentity,
    });
    expect(onCodex.configurationIdentity).not.toBe(onClaude.configurationIdentity);
  });

  it('changes when a ceiling replaces a best-effort amount of the same size', () => {
    const bestEffort = identity(enabled({}, { default_max_cost_usd: 0.5 }));
    const ceiling = identity(enabled({}, { default_max_cost_usd: 0.5 }), ceilingLlm);
    expect(ceiling).not.toBe(bestEffort);
  });

  it('changes when a daily budget is added', () => {
    const without = identity(enabled({ max_cost_usd_per_call: 1 }), ceilingLlm);
    const withBudget = identity(
      enabled({ max_cost_usd_per_call: 1, max_cost_usd_per_day: 5 }),
      ceilingLlm
    );
    expect(withBudget).not.toBe(without);
  });
});
