import { describe, expect, it } from 'vitest';

import {
  type EffectiveProcessingConfiguration,
  PROCESSING_PROCESSOR_CONTRACT,
  resolveKnowledgeProcessing,
} from '@orcaops/core';
import {
  measurePreparedInputRequest,
  PROVIDER_CAPABILITIES,
  resolveNoToolCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import { resolveConfig } from '@orcaops/storage';

import type { ProcessingBacklog } from './knowledge-processing-queue.js';
import {
  compareProcessingExecutionTerms,
  draftProcessingDisclosure,
  processingExecutionTerms,
} from './knowledge-processing-terms.js';
import { ErrorCodes } from '../io/errors.js';

const NOTHING_ADMITTED: ProcessingBacklog = { paused_jobs: 0, latest_admitted_sequence: null };

function configuration(
  overrides: Partial<EffectiveProcessingConfiguration> = {}
): EffectiveProcessingConfiguration {
  return {
    source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
    provider: { id: 'claude', selection: 'inherited' },
    toolAccess: 'none',
    model: { selection: 'provider_default', id: null, inheritedModelNotCarried: null },
    effort: { selection: 'provider_default', value: null, inheritedEffortDropped: null },
    limits: {
      max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' },
      max_cost_usd_per_day: 'none',
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    },
    outputTokenCap: { kind: 'none' },
    callRequest: { provider: 'claude' },
    timeoutMs: 120_000,
    maxAttempts: 3,
    idleExitMs: 30_000,
    notices: [],
    configurationIdentity: 'a'.repeat(64),
    ...overrides,
  };
}

function draft(
  overrides: Partial<EffectiveProcessingConfiguration> = {},
  backlog: ProcessingBacklog = NOTHING_ADMITTED,
  includeBacklog = false
) {
  return draftProcessingDisclosure({
    project_id: 'project-a',
    configuration: configuration(overrides),
    backlog,
    include_backlog: includeBacklog,
  });
}

const textOf = (...args: Parameters<typeof draft>): string => draft(...args).text;

function execution(overrides: Partial<EffectiveProcessingConfiguration> = {}) {
  return processingExecutionTerms({
    projectId: 'project-a',
    job: {
      jobId: 'job-a',
      source: { kind: 'capture_event', event_id: 'event-a' },
      processorContract: PROCESSING_PROCESSOR_CONTRACT,
    },
    worktreeRoot: '/repo',
    configuration: configuration(overrides),
  });
}

describe('execution-bound terms', () => {
  it('requires new permission to widen a saved two-minute call to the five-minute default', () => {
    const frozen = execution({ timeoutMs: 120_000 });
    const current = execution({ timeoutMs: resolveConfig({}).knowledge_processing.timeout_ms });
    expect(current.timeout_ms).toBe(300_000);
    expect(compareProcessingExecutionTerms({ frozen, current, phase: 'dispatch' })).toEqual({
      ok: false,
      changed: ['timeout_ms'],
    });
  });

  it('accepts tighter dispatch bounds and looser active settings without widening the call', () => {
    const frozen = execution();
    const tighter = execution({
      limits: { ...configuration().limits, max_output_bytes: 1024 },
      timeoutMs: 60_000,
    });
    expect(
      compareProcessingExecutionTerms({ frozen, current: tighter, phase: 'dispatch' })
    ).toEqual({ ok: true });
    expect(compareProcessingExecutionTerms({ frozen, current: tighter, phase: 'active' })).toEqual({
      ok: false,
      changed: ['limits.max_output_bytes', 'timeout_ms'],
    });
    expect(
      compareProcessingExecutionTerms({ frozen: tighter, current: frozen, phase: 'active' })
    ).toEqual({ ok: true });
    const schedulingTighter = execution({
      limits: {
        ...configuration().limits,
        max_cost_usd_per_day: 1,
        max_calls_per_hour: 1,
      },
      maxAttempts: 1,
    });
    expect(
      compareProcessingExecutionTerms({ frozen, current: schedulingTighter, phase: 'active' })
    ).toEqual({ ok: true });
  });

  it('refuses changed execution identity and looser pre-dispatch bounds', () => {
    const frozen = execution();
    const current = execution({
      provider: { id: 'codex', selection: 'explicit' },
      limits: { ...configuration().limits, max_output_bytes: 100_000 },
    });
    expect(compareProcessingExecutionTerms({ frozen, current, phase: 'dispatch' })).toMatchObject({
      ok: false,
      changed: expect.arrayContaining(['provider', 'limits.max_output_bytes']),
    });
  });
});

describe('the terms shown before consent', () => {
  it('names the provider, the model, what is sent, and what the provider is denied', () => {
    const text = textOf();

    expect(text).toContain('Provider: claude, run on this machine.');
    expect(text).toContain("Model: the provider's default model (orcaops selects none).");
    expect(text).toContain('What is sent: prepared captured content');
    expect(text).toContain('the project history a job is allowed to read');
    expect(text).toContain('Tool access: none.');
    expect(text).toContain('The provider cannot read this repository, run commands');
  });

  it('discloses the Codex restricted policy and its residual risk', () => {
    const text = textOf({
      provider: { id: 'codex', selection: 'explicit' },
      toolAccess: 'codex_restricted',
      callRequest: { provider: 'codex', toolAccess: 'codex_restricted' },
    });

    expect(text).toContain('Tool access: Codex restricted.');
    expect(text).toContain('60 worker attempts per hour across this project database');
    expect(text).toContain('deny-root sandbox with only minimal');
    expect(text).toContain('command network access is disabled');
    expect(text).toContain('but not every tool is absent');
    expect(text).toContain('Observed tool use discards the answer');
    expect(text).toContain('event stream is not a complete');
    expect(text).toContain('not a no-tool guarantee');
    expect(text).toMatch(/residual platform and\s+provider risks remain/);
    expect(text).toContain('continuation model requests after a denied tool action');
    expect(text).toContain('counts worker processes, not underlying model or HTTP requests');
    expect(text).toContain('transport retries are zero');
    expect(text).toContain('Codex CLI 0.154.0 or newer is required');
    expect(text).toContain('profile is verified on macOS');
    expect(text).toMatch(
      /\$CODEX_HOME\/AGENTS\.override\.md or AGENTS\.md instructions may also be sent/
    );
    expect(text).toContain('not modify those files or authentication');
    expect(text).toContain('bounds Orcaops-supplied instructions, prepared payload and schema');
    expect(text).toMatch(/not\s+Codex-added base or global context/);
    expect(text).toContain('not a total prompt-size limit');
  });

  it('says which setting picked a model orcaops chose', () => {
    expect(textOf({ model: { selection: 'explicit', id: 'a-model' } })).toContain(
      'Model: a-model (selected by knowledge_processing.model).'
    );
    expect(textOf({ model: { selection: 'inherited', id: 'a-model' } })).toContain(
      'Model: a-model (selected by llm.model).'
    );
  });

  it('states every effective limit', () => {
    const text = textOf({ outputTokenCap: { kind: 'enforced', tokens: 4_096 } });

    expect(text).toContain('60 calls per hour across this project database');
    expect(text).toContain('3 attempts per job, and every attempt is a paid call');
    expect(text).toContain('120000 ms for one call');
    expect(text).toContain('131072 bytes of prepared input per call');
    expect(text).toContain('65536 response bytes kept per call');
    expect(text).toContain('4096 generated tokens per call');
  });

  it('calls a per-call amount the provider holds a ceiling', () => {
    const text = textOf({
      limits: {
        ...configuration().limits,
        max_cost_usd_per_call: { usd: 0.25, holds: 'ceiling' },
        max_cost_usd_per_day: 4,
      },
    });

    expect(text).toContain('$0.25 per call, a hard ceiling: no call costs more');
    expect(text).toContain('$4 per day across this project database, reserved before each call');
    expect(text).not.toContain('a call-count limit is not a dollar limit');
  });

  it('calls a per-call amount the provider only stops after best effort', () => {
    const text = textOf();

    expect(text).toContain('$0.5 per call, best effort and not a cap');
    expect(text).toContain('claude stops a call only after the amount is exceeded');
    expect(text).toContain('so one response can cost more');
  });

  it('says plainly when a dollar limit is absent, and that a call count is not one', () => {
    const text = textOf({
      limits: {
        ...configuration().limits,
        max_cost_usd_per_call: 'none',
        max_cost_usd_per_day: 'none',
      },
    });

    expect(text).toContain('no per-call dollar cap applies');
    expect(text).toContain('no daily dollar budget applies');
    expect(text).toContain('a call-count limit is not a dollar limit');
  });

  it('defaults to captures from now on and says so when the backlog is asked for', () => {
    expect(textOf()).toContain('Existing captures: not sent.');
    expect(textOf()).toContain('This grant covers only captures admitted from now on');
    expect(textOf({}, NOTHING_ADMITTED, true)).toContain('Existing captures: sent.');
  });

  it('says which history is never sent and what a restored backup brings back, whichever backlog choice was made', () => {
    for (const includeBacklog of [false, true]) {
      const text = textOf({}, NOTHING_ADMITTED, includeBacklog);
      expect(text).toContain(
        'Seeded, imported and converted history is never sent, and replaying a capture queues ' +
          'nothing new.'
      );
      expect(text).toContain(
        'Restoring a backup queues nothing new either, but the jobs saved in it come back as ' +
          'they were and are sent if this grant covers them.'
      );
      expect(text).not.toMatch(/restored[^.]*never sent/i);
    }
  });

  it('says how many admitted jobs are waiting', () => {
    expect(textOf()).toContain(
      'Already waiting: nothing has been admitted for processing yet, so no job is waiting.'
    );
    expect(textOf({}, { paused_jobs: 3, latest_admitted_sequence: 40 })).toContain(
      'Already waiting: 3 jobs are admitted and waiting.'
    );
    expect(textOf({}, { paused_jobs: 1, latest_admitted_sequence: 40 })).toContain(
      'Already waiting: 1 job is admitted and waiting.'
    );
  });

  it('bounds the settings to this project database and nothing else', () => {
    const text = textOf();

    expect(text).toContain('govern knowledge processing on this machine’s project database');
    expect(text).toContain('do not cover evaluator calls, other clones, or other machines');
  });

  it('carries an inherited setting the provider drops into the same disclosure', () => {
    expect(
      textOf({
        notices: [
          {
            code: 'inherited_model_not_carried',
            message: 'llm.model "x" is not passed to claude.',
          },
          { code: 'no_daily_budget', message: 'No daily dollar budget applies.' },
        ],
      })
    ).toContain('llm.model "x" is not passed to claude.');
  });
});

describe('the grant the terms bind', () => {
  it('records exactly the provider, model, limits and waiting count that were shown', () => {
    const { terms } = draft({}, { paused_jobs: 2, latest_admitted_sequence: 40 });

    expect(terms).toEqual({
      project_id: 'project-a',
      provider: 'claude',
      processor_contract: PROCESSING_PROCESSOR_CONTRACT,
      source_scope: { admitted_after_sequence: 40, backlog: 'excluded' },
      disclosed: {
        tool_access: 'none',
        model: { selection: 'provider_default' },
        limits: configuration().limits,
        paused_backlog_count: 2,
      },
    });
  });

  it('records the backlog choice that was shown', () => {
    expect(
      draft({}, { paused_jobs: 2, latest_admitted_sequence: 40 }, true).terms.source_scope
    ).toEqual({ admitted_after_sequence: 40, backlog: 'included' });
  });

  it('bounds a from-now-on grant at zero only when nothing has ever been admitted', () => {
    expect(draft().terms.source_scope).toEqual({
      admitted_after_sequence: 0,
      backlog: 'excluded',
    });
  });

  it('refuses a from-now-on grant whose boundary the database cannot name', () => {
    expect(() => draft({}, { paused_jobs: 2, latest_admitted_sequence: null })).toThrow(
      /cannot .*say which admission sequence/s
    );
    try {
      draft({}, { paused_jobs: 2, latest_admitted_sequence: null });
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.RECOVERY_REQUIRED);
    }
  });
});

describe('the resolved configuration the terms are built from', () => {
  it('is handed over unchanged, so the grant binds what the workload would run', () => {
    const resolution = resolveKnowledgeProcessing({
      config: resolveConfig({ knowledge_processing: { enabled: true } }),
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

    const { terms, text } = draftProcessingDisclosure({
      project_id: 'project-a',
      configuration: resolution.configuration,
      backlog: NOTHING_ADMITTED,
      include_backlog: false,
    });

    expect(terms.disclosed.limits).toEqual(resolution.configuration.limits);
    expect(terms.provider).toBe('claude');
    expect(text).toContain('$0.5 per call, best effort and not a cap');
  });
});
