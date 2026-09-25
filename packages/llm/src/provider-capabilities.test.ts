import { describe, expect, it } from 'vitest';

import * as packageExports from './index.js';
import {
  type NoToolCallResolution,
  PROVIDER_CAPABILITIES,
  resolveNoToolCall,
  resolveNoToolCallWithCapabilities,
} from './provider-capabilities.js';

/** No shipped provider runs without tools yet lacks effort or a spend cap; the rules still cover it. */
const BARE_NO_TOOL_PROVIDER = {
  ...PROVIDER_CAPABILITIES.claude,
  spendCap: 'none',
  supportsEffort: false,
} as const;

/** No shipped provider holds a hard spend ceiling either. */
const HARD_CEILING_PROVIDER = {
  ...PROVIDER_CAPABILITIES.claude,
  spendCap: 'hard_ceiling',
} as const;

function settingsOf(resolution: NoToolCallResolution) {
  if (resolution.status !== 'available') {
    throw new Error(`expected an available provider, got: ${JSON.stringify(resolution)}`);
  }
  return resolution.settings;
}

function refusalsOf(resolution: NoToolCallResolution) {
  if (resolution.status !== 'unavailable') {
    throw new Error(`expected a refusal, got: ${JSON.stringify(resolution)}`);
  }
  return resolution.refusals;
}

describe('PROVIDER_CAPABILITIES', () => {
  it('declares what the Claude adapter enforces and observes', () => {
    expect(PROVIDER_CAPABILITIES.claude).toEqual({
      enforcesNoToolExecution: true,
      spendCap: 'stops_after_exceeded',
      enforcesOutputTokenCap: false,
      reportsUsage: true,
      reportsCost: true,
      supportsEffort: true,
      supportsSystemPrompt: true,
      supportsStructuredOutput: true,
      readsInputFromStdin: true,
    });
  });

  it('declares what the restricted Codex adapter can observe and apply', () => {
    expect(PROVIDER_CAPABILITIES.codex).toEqual({
      enforcesNoToolExecution: false,
      spendCap: 'none',
      enforcesOutputTokenCap: false,
      reportsUsage: true,
      reportsCost: false,
      supportsEffort: true,
      supportsSystemPrompt: false,
      supportsStructuredOutput: true,
      readsInputFromStdin: true,
    });
  });

  it('cannot be edited at runtime', () => {
    expect(Object.isFrozen(PROVIDER_CAPABILITIES.codex)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CAPABILITIES.claude)).toBe(true);
  });
});

describe('resolveNoToolCall — provider availability', () => {
  it('makes Claude available with no tools and says plainly when nothing caps the call', () => {
    const settings = settingsOf(resolveNoToolCall({ provider: 'claude' }));
    expect(settings.toolAccess).toBe('none');
    expect(settings.spendCap).toEqual({ kind: 'none', inheritedCapDropped: null });
    expect(settings.outputTokenCap).toEqual({ kind: 'none' });
    expect(settings.capabilities).toBe(PROVIDER_CAPABILITIES.claude);
  });

  it('reports Codex unavailable because it cannot run without tools', () => {
    const resolution = resolveNoToolCall({ provider: 'codex' });
    const refusals = refusalsOf(resolution);
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['no_tool_execution']);
    expect(refusals[0]?.message).toMatch(/does not expose a supported control/);
    expect(refusals[0]?.message).toMatch(/\(claude\)/);
  });

  it('allows the explicitly weaker restricted policy only with Codex', () => {
    const settings = settingsOf(
      resolveNoToolCall({ provider: 'codex', toolAccess: 'codex_restricted' })
    );

    expect(settings.toolAccess).toBe('codex_restricted');
    expect(settings.capabilities.enforcesNoToolExecution).toBe(false);
  });

  it('refuses the restricted Codex policy with another provider', () => {
    const refusals = refusalsOf(
      resolveNoToolCall({ provider: 'claude', toolAccess: 'codex_restricted' })
    );

    expect(refusals.map((refusal) => refusal.capability)).toEqual(['tool_access']);
  });

  it('refuses an unknown tool-access policy', () => {
    const refusals = refusalsOf(
      resolveNoToolCall({ provider: 'codex', toolAccess: 'read_only' as never })
    );

    expect(refusals.map((refusal) => refusal.capability)).toEqual(['tool_access']);
  });

  it('never substitutes another provider for the one selected', () => {
    const resolution = resolveNoToolCall({
      provider: 'codex',
      inherited: { provider: 'claude', model: 'claude-model', effort: 'high', maxCostUsd: 0.5 },
    });
    expect(resolution.provider).toBe('codex');
    expect(resolution.status).toBe('unavailable');
    expect(resolution).not.toHaveProperty('settings');
  });

  it('lists every unavailable capability, not only the first', () => {
    const refusals = refusalsOf(
      resolveNoToolCall({
        provider: 'codex',
        explicitEffort: 'high',
        explicitMaxCostUsd: 0.25,
        maxOutputTokens: 2000,
      })
    );
    expect(refusals.map((refusal) => refusal.capability)).toEqual([
      'no_tool_execution',
      'spend_cap',
      'output_token_cap',
    ]);
  });
});

describe('resolveNoToolCall — caps', () => {
  it('refuses an output token cap the provider cannot enforce', () => {
    const refusals = refusalsOf(resolveNoToolCall({ provider: 'claude', maxOutputTokens: 4000 }));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.capability).toBe('output_token_cap');
    expect(refusals[0]?.message).toMatch(/would not be a guarantee/);
    expect(refusals[0]?.message).toMatch(/Remove the limit; no supported provider/);
  });

  it('refuses an explicit spend cap on a provider that stops only after the amount is exceeded', () => {
    const refusals = refusalsOf(
      resolveNoToolCall({ provider: 'claude', explicitMaxCostUsd: 0.05 })
    );
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['spend_cap']);
    expect(refusals[0]?.message).toMatch(
      /claude stops a call only after the amount is exceeded, so a single response can exceed the requested cap of \$0\.0500/
    );
    expect(refusals[0]?.message).toMatch(
      /Remove the cap; no supported provider holds a hard per-call spend ceiling/
    );
  });

  it('refuses an explicit spend cap on a provider that cannot limit spend at all', () => {
    const refusals = refusalsOf(resolveNoToolCall({ provider: 'codex', explicitMaxCostUsd: 0.05 }));
    const spendCap = refusals.find((refusal) => refusal.capability === 'spend_cap');
    expect(spendCap?.message).toMatch(/cannot limit what a call spends/);
    expect(spendCap?.message).toMatch(/cap of \$0\.0500 would not be a guarantee/);
  });

  it('refuses the explicit cap even when an inherited one could have been carried', () => {
    const refusals = refusalsOf(
      resolveNoToolCall({
        provider: 'claude',
        explicitMaxCostUsd: 0.05,
        inherited: { provider: 'claude', model: null, maxCostUsd: 0.5 },
      })
    );
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['spend_cap']);
  });

  it('carries an inherited spend cap as best effort, never as enforced', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: 'codex', model: null, maxCostUsd: 0.5 },
      })
    );
    expect(settings.spendCap).toEqual({ kind: 'best_effort', usd: 0.5, selection: 'inherited' });
  });

  it('floors a carried spend cap to the precision the provider receives, never raising it', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: 'claude', model: null, maxCostUsd: 0.12349 },
      })
    );
    expect(settings.spendCap).toEqual({ kind: 'best_effort', usd: 0.1234, selection: 'inherited' });
  });

  it('labels a cap enforced only on a provider that holds a hard ceiling', () => {
    const explicit = settingsOf(
      resolveNoToolCallWithCapabilities(
        { provider: 'claude', explicitMaxCostUsd: 0.05 },
        HARD_CEILING_PROVIDER
      )
    );
    const inherited = settingsOf(
      resolveNoToolCallWithCapabilities(
        { provider: 'claude', inherited: { provider: 'claude', model: null, maxCostUsd: 0.5 } },
        HARD_CEILING_PROVIDER
      )
    );
    expect(explicit.spendCap).toEqual({ kind: 'enforced', usd: 0.05, selection: 'explicit' });
    expect(inherited.spendCap).toEqual({ kind: 'enforced', usd: 0.5, selection: 'inherited' });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.00004])(
    'refuses a spend cap of %s instead of dropping it, explicit or inherited',
    (usd) => {
      for (const request of [
        { provider: 'claude', explicitMaxCostUsd: usd } as const,
        {
          provider: 'claude',
          inherited: { provider: null, model: null, maxCostUsd: usd },
        } as const,
      ]) {
        const refusals = refusalsOf(resolveNoToolCall(request));
        expect(refusals.map((refusal) => refusal.capability)).toEqual(['spend_cap']);
      }
    }
  );

  it.each([0, -5, 1.5, Number.NaN])('refuses an output token cap of %s', (tokens) => {
    const refusals = refusalsOf(resolveNoToolCall({ provider: 'claude', maxOutputTokens: tokens }));
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['output_token_cap']);
  });
});

describe('resolveNoToolCall — an unknown provider', () => {
  it('is refused in plain terms instead of throwing', () => {
    const resolution = resolveNoToolCall({ provider: 'gemini' as never });
    const refusals = refusalsOf(resolution);
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['provider']);
    expect(refusals[0]?.message).toMatch(/"gemini" is not a supported provider.*claude, codex/);
  });

  it.each(['toString', 'constructor', '', 42, null])('does not take %j for a provider', (value) => {
    expect(packageExports.isSupportedProvider(value)).toBe(false);
  });

  it('recognizes the shipped providers', () => {
    expect(packageExports.isSupportedProvider('claude')).toBe(true);
    expect(packageExports.isSupportedProvider('codex')).toBe(true);
  });
});

describe('resolveNoToolCall — effort', () => {
  it('applies an explicit effort the provider supports', () => {
    const settings = settingsOf(resolveNoToolCall({ provider: 'claude', explicitEffort: 'max' }));
    expect(settings.effort).toEqual({ selection: 'explicit', value: 'max' });
  });

  it('carries an inherited effort the provider supports', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: 'claude', model: null, effort: 'medium' },
      })
    );
    expect(settings.effort).toEqual({ selection: 'inherited', value: 'medium' });
  });

  it('applies an explicit Codex effort in restricted mode', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'codex',
        toolAccess: 'codex_restricted',
        explicitEffort: 'high',
      })
    );
    expect(settings.effort).toEqual({ selection: 'explicit', value: 'high' });
  });

  it('carries an inherited effort that Codex supports', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'codex',
        toolAccess: 'codex_restricted',
        inherited: { provider: 'claude', model: null, effort: 'high', maxCostUsd: 0.5 },
      })
    );
    expect(settings.effort).toEqual({ selection: 'inherited', value: 'high' });
  });
});

describe('resolveNoToolCall — inherited settings the provider cannot honour', () => {
  it('drops an inherited effort and an inherited spend cap, and reports both as dropped', () => {
    const settings = settingsOf(
      resolveNoToolCallWithCapabilities(
        {
          provider: 'claude',
          inherited: { provider: 'claude', model: null, effort: 'high', maxCostUsd: 0.5 },
        },
        BARE_NO_TOOL_PROVIDER
      )
    );
    expect(settings.effort).toEqual({
      selection: 'provider_default',
      value: null,
      inheritedEffortDropped: 'high',
    });
    expect(settings.spendCap).toEqual({ kind: 'none', inheritedCapDropped: 0.5 });
  });

  it('still refuses the same effort and spend cap when they are explicit', () => {
    const refusals = refusalsOf(
      resolveNoToolCallWithCapabilities(
        { provider: 'claude', explicitEffort: 'high', explicitMaxCostUsd: 0.5 },
        BARE_NO_TOOL_PROVIDER
      )
    );
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['effort', 'spend_cap']);
  });

  it('keeps the capability-injecting resolver out of the package exports', () => {
    expect(packageExports).not.toHaveProperty('resolveNoToolCallWithCapabilities');
    expect(packageExports).toHaveProperty('resolveNoToolCall');
  });
});

describe('resolveNoToolCall — model', () => {
  it('inherits the configured model when the workload runs on the provider it was configured for', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: 'claude', model: 'claude-configured' },
      })
    );
    expect(settings.model).toEqual({ selection: 'inherited', id: 'claude-configured' });
  });

  it('does not carry the configured model across a provider override', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: 'codex', model: 'gpt-configured' },
      })
    );
    expect(settings.model).toEqual({
      selection: 'provider_default',
      id: null,
      inheritedModelNotCarried: 'gpt-configured',
    });
  });

  it('does not carry a configured model when no evaluator provider resolves', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        inherited: { provider: null, model: 'orphan-model' },
      })
    );
    expect(settings.model.selection).toBe('provider_default');
  });

  it('uses an explicit workload model as given, even under a provider override', () => {
    const settings = settingsOf(
      resolveNoToolCall({
        provider: 'claude',
        explicitModel: 'claude-explicit',
        inherited: { provider: 'codex', model: 'gpt-configured' },
      })
    );
    expect(settings.model).toEqual({ selection: 'explicit', id: 'claude-explicit' });
  });

  it('labels the provider default when no model is configured anywhere', () => {
    const settings = settingsOf(resolveNoToolCall({ provider: 'claude' }));
    expect(settings.model).toEqual({
      selection: 'provider_default',
      id: null,
      inheritedModelNotCarried: null,
    });
  });

  it('refuses an empty explicit model instead of falling back to the default', () => {
    const refusals = refusalsOf(resolveNoToolCall({ provider: 'claude', explicitModel: '  ' }));
    expect(refusals.map((refusal) => refusal.capability)).toEqual(['model']);
  });
});
