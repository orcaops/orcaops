import { describe, expect, it } from 'vitest';

import {
  describeProcessingGrants,
  evaluateProcessingConsent,
  evaluateProcessingConsentByGrantId,
  type ProcessingConsentRequest,
  type ProcessingGrant,
  ProcessingGrantSchema,
  ProcessingGrantsFileSchema,
  type ProcessingLimits,
} from './knowledge-processing-consent.js';

const GRANT: ProcessingGrant = {
  grant_id: '0b0e4c1e-6f0a-4a57-9d52-3f3c1f1f7a01',
  capability: 'capture_content_llm_processing',
  project_id: 'project-a',
  provider: 'claude',
  processor_contract: 'knowledge-processor/1',
  source_scope: { admitted_after_sequence: 40, backlog: 'excluded' },
  disclosed: {
    provider: 'claude',
    tool_access: 'none',
    model: { selection: 'provider_default' },
    limits: {
      max_cost_usd_per_call: 'none',
      max_cost_usd_per_day: 2.5,
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    },
    paused_backlog_count: 3,
  },
  granted_at: '2026-01-01T00:00:00.000Z',
};

const OTHER_IDS = ['1c8f1d06-5a0b-4c55-8d0e-0d7d3a1b2c02', '2d9a2e17-6b1c-4d66-9e1f-1e8e4b2c3d03'];

function request(overrides: Partial<ProcessingConsentRequest> = {}): ProcessingConsentRequest {
  return {
    grants: [GRANT],
    problems: [],
    project_id: 'project-a',
    provider: 'claude',
    processor_contract: 'knowledge-processor/1',
    effective_tool_access: 'none',
    effective_limits: GRANT.disclosed.limits,
    job: { admitted_sequence: 41 },
    ...overrides,
  };
}

function denialReason(overrides: Partial<ProcessingConsentRequest>): string {
  const decision = evaluateProcessingConsent(request(overrides));
  if (decision.ok) throw new Error('expected a denial');
  expect(decision.code).toBe('CONSENT_DENIED');
  expect(decision.message.length).toBeGreaterThan(0);
  return decision.reason;
}

describe('evaluateProcessingConsent', () => {
  it('covers a job admitted after the grant began and names the grant', () => {
    expect(evaluateProcessingConsent(request())).toEqual({ ok: true, grant_id: GRANT.grant_id });
  });

  it('binds consent to the exact tool-access policy', () => {
    expect(denialReason({ effective_tool_access: 'codex_restricted' })).toBe('other_tool_access');
    const restricted = {
      ...GRANT,
      provider: 'codex' as const,
      disclosed: {
        ...GRANT.disclosed,
        provider: 'codex' as const,
        tool_access: 'codex_restricted' as const,
      },
    };
    expect(
      evaluateProcessingConsent(
        request({
          grants: [restricted],
          provider: 'codex',
          effective_tool_access: 'codex_restricted',
        })
      )
    ).toEqual({ ok: true, grant_id: GRANT.grant_id });
  });

  it('treats a legacy grant with no tool-access field as strict no-tool consent', () => {
    const legacy = structuredClone(GRANT) as unknown as {
      disclosed: Record<string, unknown>;
    };
    delete legacy.disclosed.tool_access;
    expect(evaluateProcessingConsent(request({ grants: [legacy] }))).toEqual({
      ok: true,
      grant_id: GRANT.grant_id,
    });
    const legacyCodex = {
      ...legacy,
      provider: 'codex',
      disclosed: { ...legacy.disclosed, provider: 'codex' },
    };
    expect(
      evaluateProcessingConsent(
        request({
          grants: [legacyCodex],
          provider: 'codex',
          effective_tool_access: 'codex_restricted',
        })
      )
    ).toMatchObject({ ok: false, reason: 'other_tool_access' });
  });

  it('treats a job admitted at the boundary sequence as backlog', () => {
    expect(denialReason({ job: { admitted_sequence: 40 } })).toBe('backlog_not_included');
    expect(denialReason({ job: { admitted_sequence: 0 } })).toBe('backlog_not_included');
  });

  it('covers backlog only when the grant includes it', () => {
    const including = {
      ...GRANT,
      source_scope: { admitted_after_sequence: 40, backlog: 'included' as const },
    };
    for (const admitted_sequence of [0, 40, 41]) {
      expect(
        evaluateProcessingConsent(request({ grants: [including], job: { admitted_sequence } }))
      ).toEqual({ ok: true, grant_id: GRANT.grant_id });
    }
  });

  it('treats a sequence that is not a whole number as backlog', () => {
    for (const admitted_sequence of [Number.NaN, 41.5, Number.POSITIVE_INFINITY]) {
      expect(denialReason({ job: { admitted_sequence } })).toBe('backlog_not_included');
    }
  });

  it('denies with no grant when the store holds none', () => {
    expect(denialReason({ grants: [] })).toBe('no_grant');
  });

  it('never treats evaluator grants as covering processing', () => {
    const evaluatorGrants = [
      {
        kind: 'fingerprint',
        package_id: 'core',
        source_fingerprint: 'a'.repeat(64),
        capabilities: [
          'command_evaluators_present',
          'llm_evaluators_present',
          'file_reading_llm_evaluator_present',
        ],
        granted_at: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'workspace-dev',
        package_id: 'project-a',
        resolved_path: '/packs/project-a',
        capabilities: ['llm_evaluators_present', 'file_reading_llm_evaluator_present'],
        granted_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    expect(denialReason({ grants: evaluatorGrants })).toBe('no_grant');
  });

  it('ignores entries that are not valid processing grants instead of throwing', () => {
    const lookalike = { ...GRANT, source_scope: undefined };
    const otherCapability = { ...GRANT, capability: 'llm_evaluators_present' };
    expect(denialReason({ grants: [null, 42, 'grant', lookalike, otherCapability] })).toBe(
      'no_grant'
    );
  });

  it('denies a revoked grant', () => {
    expect(denialReason({ grants: [{ ...GRANT, revoked_at: '2026-02-01T00:00:00.000Z' }] })).toBe(
      'revoked'
    );
  });

  it('denies another project, provider or processor contract', () => {
    expect(denialReason({ project_id: 'project-b' })).toBe('other_project');
    expect(denialReason({ provider: 'codex' })).toBe('other_provider');
    expect(denialReason({ processor_contract: 'knowledge-processor/2' })).toBe(
      'other_processor_contract'
    );
  });

  it('reports no grant when the only near misses are revoked', () => {
    const revoked = { ...GRANT, revoked_at: '2026-02-01T00:00:00.000Z' };
    expect(denialReason({ grants: [revoked], provider: 'codex' })).toBe('no_grant');
    expect(denialReason({ grants: [revoked], project_id: 'project-b' })).toBe('no_grant');
  });

  it('denies on any store problem even when a grant would cover the job', () => {
    expect(
      denialReason({
        problems: [{ code: 'store_permissions_widened', message: 'mode 644.' }],
      })
    ).toBe('store_unreadable_or_unsafe');
  });

  it('lets only the newest entry for a binding speak for it', () => {
    const earlierWider = {
      ...GRANT,
      source_scope: { admitted_after_sequence: 10, backlog: 'included' as const },
    };
    const newerNarrower = { ...GRANT, grant_id: OTHER_IDS[0] };
    expect(
      denialReason({ grants: [earlierWider, newerNarrower], job: { admitted_sequence: 20 } })
    ).toBe('backlog_not_included');

    const newerRevoked = { ...newerNarrower, revoked_at: '2026-02-01T00:00:00.000Z' };
    expect(denialReason({ grants: [earlierWider, newerRevoked] })).toBe('revoked');
  });

  it('denies when any grant id repeats, even beside a grant that would cover the job', () => {
    const wide = { ...GRANT, grant_id: '7a0f5d0e-2b0e-4c55-8a8e-0c1d6a3b9f10' };
    const revoked = { ...GRANT, revoked_at: '2026-02-01T00:00:00.000Z' };
    expect(denialReason({ grants: [wide, revoked, revoked] })).toBe('store_unreadable_or_unsafe');
    expect(denialReason({ grants: [GRANT, { ...GRANT, project_id: 'project-b' }] })).toBe(
      'store_unreadable_or_unsafe'
    );
    expect(describeProcessingGrants([wide, revoked, revoked]).some((entry) => entry.in_force)).toBe(
      false
    );
  });

  it('leaves its input untouched', () => {
    const grants = [structuredClone(GRANT)];
    const before = JSON.stringify(grants);
    evaluateProcessingConsent(request({ grants }));
    expect(JSON.stringify(grants)).toBe(before);
  });
});

describe('evaluateProcessingConsentByGrantId', () => {
  it('does not let another valid grant rescue the revoked grant retained by an attempt', () => {
    const replacement = { ...GRANT, grant_id: OTHER_IDS[0]! };
    const revoked = { ...GRANT, revoked_at: '2026-01-02T00:00:00.000Z' };
    expect(
      evaluateProcessingConsentByGrantId({
        ...request({ grants: [revoked, replacement] }),
        grant_id: GRANT.grant_id,
      })
    ).toMatchObject({ ok: false, reason: 'revoked' });
    expect(
      evaluateProcessingConsentByGrantId({
        ...request({ grants: [revoked, replacement] }),
        grant_id: replacement.grant_id,
      })
    ).toEqual({ ok: true, grant_id: replacement.grant_id });
  });
});

describe('limits in force against the limits disclosed', () => {
  const DISCLOSED: ProcessingLimits = {
    max_cost_usd_per_call: { usd: 0.5, holds: 'ceiling' },
    max_cost_usd_per_day: 2.5,
    max_calls_per_hour: 60,
    max_input_bytes: 131_072,
    max_output_bytes: 65_536,
  };
  const granted = { ...GRANT, disclosed: { ...GRANT.disclosed, limits: DISCLOSED } };

  function decideUnder(effective: Partial<ProcessingLimits>, grant: ProcessingGrant = granted) {
    return evaluateProcessingConsent(
      request({
        grants: [grant],
        effective_limits: { ...grant.disclosed.limits, ...effective },
      })
    );
  }

  const LOOSER_AND_TIGHTER: [keyof ProcessingLimits, number | 'none', number][] = [
    ['max_cost_usd_per_day', 2.6, 2.4],
    ['max_cost_usd_per_day', 'none', 0],
    ['max_calls_per_hour', 61, 59],
    ['max_input_bytes', 131_073, 131_071],
    ['max_output_bytes', 65_537, 65_535],
  ];

  it.each(LOOSER_AND_TIGHTER)('denies a looser %s (%s) and names both values', (name, looser) => {
    const decision = decideUnder({ [name]: looser });
    expect(decision).toMatchObject({
      ok: false,
      code: 'CONSENT_DENIED',
      reason: 'limits_wider_than_disclosed',
    });
    if (decision.ok) throw new Error('expected a denial');
    expect(decision.message).toContain(`${name} is ${looser} but ${DISCLOSED[name]} was disclosed`);
    expect(decision.message).toMatch(/new grant/);
  });

  it.each(LOOSER_AND_TIGHTER)('covers an equal or tighter %s', (name, _looser, tighter) => {
    expect(decideUnder({ [name]: tighter })).toEqual({ ok: true, grant_id: GRANT.grant_id });
    expect(decideUnder({})).toEqual({ ok: true, grant_id: GRANT.grant_id });
  });

  it('names every loosened limit and leaves out the ones that held', () => {
    const decision = decideUnder({ max_calls_per_hour: 120, max_cost_usd_per_day: 'none' });
    if (decision.ok) throw new Error('expected a denial');
    expect(decision.message).toContain('max_cost_usd_per_day is none but 2.5 was disclosed');
    expect(decision.message).toContain('max_calls_per_hour is 120 but 60 was disclosed');
    expect(decision.message).not.toContain('max_input_bytes');
  });

  const PER_CALL_CAPS: [string, ProcessingLimits['max_cost_usd_per_call'], boolean][] = [
    ['a larger ceiling', { usd: 0.51, holds: 'ceiling' }, false],
    ['no cap', 'none', false],
    ['the same amount held only as best effort', { usd: 0.5, holds: 'best_effort' }, false],
    ['a smaller amount held only as best effort', { usd: 0.1, holds: 'best_effort' }, false],
    ['the same ceiling', { usd: 0.5, holds: 'ceiling' }, true],
    ['a smaller ceiling', { usd: 0.49, holds: 'ceiling' }, true],
  ];

  it.each(PER_CALL_CAPS)(
    'judges %s against a disclosed per-call ceiling',
    (_name, cap, covered) => {
      const decision = decideUnder({ max_cost_usd_per_call: cap });
      expect(decision.ok).toBe(covered);
      if (decision.ok) return;
      expect(decision.reason).toBe('limits_wider_than_disclosed');
      expect(decision.message).toContain('but 0.5 (a ceiling) was disclosed');
    }
  );

  it('covers a ceiling, or a smaller best-effort amount, under a disclosed best-effort amount', () => {
    const bestEffort = {
      ...granted,
      disclosed: {
        ...granted.disclosed,
        limits: {
          ...DISCLOSED,
          max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' as const },
        },
      },
    };
    const under = (cap: ProcessingLimits['max_cost_usd_per_call']) =>
      decideUnder({ max_cost_usd_per_call: cap }, bestEffort).ok;
    expect(under({ usd: 0.5, holds: 'ceiling' })).toBe(true);
    expect(under({ usd: 0.4, holds: 'best_effort' })).toBe(true);
    expect(under({ usd: 0.6, holds: 'best_effort' })).toBe(false);
    expect(under('none')).toBe(false);
  });

  it('accepts any spend cap when the person was shown that there is none', () => {
    const uncapped = {
      ...granted,
      disclosed: {
        ...granted.disclosed,
        limits: {
          ...DISCLOSED,
          max_cost_usd_per_call: 'none' as const,
          max_cost_usd_per_day: 'none' as const,
        },
      },
    };
    for (const cap of ['none', 0, 1_000] as const) {
      const perCall = cap === 'none' ? cap : { usd: cap, holds: 'best_effort' as const };
      expect(
        decideUnder({ max_cost_usd_per_call: perCall, max_cost_usd_per_day: cap }, uncapped)
      ).toEqual({ ok: true, grant_id: GRANT.grant_id });
    }
  });

  it('denies limits it cannot compare', () => {
    for (const effective_limits of [
      { ...DISCLOSED, max_calls_per_hour: Number.NaN },
      { ...DISCLOSED, max_input_bytes: undefined },
      undefined,
    ]) {
      expect(
        evaluateProcessingConsent(
          request({
            grants: [granted],
            effective_limits: effective_limits as unknown as ProcessingLimits,
          })
        )
      ).toMatchObject({ ok: false, reason: 'limits_wider_than_disclosed' });
    }
  });

  it('reports a revoked grant before its limits, and loosened limits before backlog', () => {
    const loosened = { ...DISCLOSED, max_calls_per_hour: 61 };
    expect(
      denialReason({
        grants: [{ ...granted, revoked_at: '2026-02-01T00:00:00.000Z' }],
        effective_limits: loosened,
      })
    ).toBe('revoked');
    expect(
      denialReason({
        grants: [granted],
        effective_limits: loosened,
        job: { admitted_sequence: 1 },
      })
    ).toBe('limits_wider_than_disclosed');
  });
});

describe('describeProcessingGrants', () => {
  it('marks only the unrevoked governing grant of each binding as in force', () => {
    const shadowed = { ...GRANT };
    const governing = { ...GRANT, grant_id: OTHER_IDS[0] };
    const revokedElsewhere = {
      ...GRANT,
      grant_id: OTHER_IDS[1],
      project_id: 'project-b',
      revoked_at: '2026-02-01T00:00:00.000Z',
    };
    expect(
      describeProcessingGrants([shadowed, governing, revokedElsewhere]).map((entry) => [
        entry.grant.grant_id,
        entry.in_force,
      ])
    ).toEqual([
      [GRANT.grant_id, false],
      [OTHER_IDS[0], true],
      [OTHER_IDS[1], false],
    ]);
    expect(
      describeProcessingGrants([shadowed, governing, revokedElsewhere], {
        project_id: 'project-b',
      }).map((entry) => entry.grant.grant_id)
    ).toEqual([OTHER_IDS[1]]);
  });
});

describe('processing grant format', () => {
  it('accepts a number or an explicit none for each spend cap', () => {
    expect(ProcessingGrantSchema.safeParse(GRANT).success).toBe(true);
    const unstated = structuredClone(GRANT) as { disclosed: { limits: Record<string, unknown> } };
    delete unstated.disclosed.limits.max_cost_usd_per_call;
    expect(ProcessingGrantSchema.safeParse(unstated).success).toBe(false);
  });

  it('rejects an unknown field, capability, provider or backlog choice', () => {
    for (const invalid of [
      { ...GRANT, note: 'extra' },
      { ...GRANT, capability: 'llm_evaluators_present' },
      { ...GRANT, provider: 'gemini', disclosed: { ...GRANT.disclosed, provider: 'gemini' } },
      { ...GRANT, source_scope: { admitted_after_sequence: 40 } },
      { ...GRANT, source_scope: { admitted_after_sequence: -1, backlog: 'excluded' } },
      { ...GRANT, disclosed: { ...GRANT.disclosed, provider: 'codex' } },
    ]) {
      expect(ProcessingGrantSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects a file of another version', () => {
    expect(ProcessingGrantsFileSchema.safeParse({ v: 1, grants: [GRANT] }).success).toBe(true);
    expect(ProcessingGrantsFileSchema.safeParse({ v: 2, grants: [GRANT] }).success).toBe(false);
  });

  it('rejects a file that repeats a grant id', () => {
    const sameIdOtherProject = { ...GRANT, project_id: 'project-b' };
    expect(
      ProcessingGrantsFileSchema.safeParse({ v: 1, grants: [GRANT, sameIdOtherProject] }).success
    ).toBe(false);
  });
});
