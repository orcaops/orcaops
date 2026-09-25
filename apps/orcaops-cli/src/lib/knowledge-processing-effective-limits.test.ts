import { describe, expect, it } from 'vitest';

import { type EffectiveProcessingLimits, resolveKnowledgeProcessing } from '@orcaops/core';
import {
  measurePreparedInputRequest,
  PROVIDER_CAPABILITIES,
  resolveNoToolCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import { type Config, resolveConfig } from '@orcaops/storage';

import {
  evaluateProcessingConsent,
  type ProcessingGrant,
  type ProcessingLimits,
} from './knowledge-processing-consent.js';

function effectiveLimits(
  processing: Partial<Config['knowledge_processing']>
): EffectiveProcessingLimits {
  const resolution = resolveKnowledgeProcessing({
    config: resolveConfig({ knowledge_processing: { enabled: true, ...processing } }),
    source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
    providerAvailability: { claude: 'present', codex: 'absent' },
    llm: {
      capabilities: PROVIDER_CAPABILITIES,
      selectDefaultProvider,
      resolveNoToolCall,
      measurePreparedInputRequest,
    },
  });
  if (resolution.status !== 'ready') throw new Error('expected processing to be ready');
  return resolution.configuration.limits;
}

function grantDisclosing(limits: ProcessingLimits): ProcessingGrant {
  return {
    grant_id: '0b0e4c1e-6f0a-4a57-9d52-3f3c1f1f7a01',
    capability: 'capture_content_llm_processing',
    project_id: 'project-a',
    provider: 'claude',
    processor_contract: 'knowledge-processor/1',
    source_scope: { admitted_after_sequence: 0, backlog: 'excluded' },
    disclosed: {
      provider: 'claude',
      tool_access: 'none',
      model: { selection: 'provider_default' },
      limits,
      paused_backlog_count: 0,
    },
    granted_at: '2026-01-01T00:00:00.000Z',
  };
}

function decide(granted: ProcessingLimits, inForce: ProcessingLimits) {
  return evaluateProcessingConsent({
    grants: [grantDisclosing(granted)],
    problems: [],
    project_id: 'project-a',
    provider: 'claude',
    processor_contract: 'knowledge-processor/1',
    effective_tool_access: 'none',
    effective_limits: inForce,
    job: { admitted_sequence: 1 },
  });
}

describe('the effective processing limits', () => {
  it('are the limits the consent decision compares, handed over unchanged', () => {
    const limits: ProcessingLimits = effectiveLimits({});
    expect(limits.max_cost_usd_per_call).toEqual({ usd: 0.5, holds: 'best_effort' });
    expect(decide(limits, limits)).toMatchObject({ ok: true });
  });

  it('deny consent once configuration drops the per-call amount a person was shown', () => {
    const shown = effectiveLimits({});
    const loosened = effectiveLimits({ max_cost_usd_per_call: 'none' });
    expect(decide(shown, loosened)).toMatchObject({
      ok: false,
      reason: 'limits_wider_than_disclosed',
    });
  });

  it('keep consent when configuration tightens a limit', () => {
    const shown = effectiveLimits({});
    const tightened = effectiveLimits({ max_calls_per_hour: 10 });
    expect(decide(shown, tightened)).toMatchObject({ ok: true });
  });
});
