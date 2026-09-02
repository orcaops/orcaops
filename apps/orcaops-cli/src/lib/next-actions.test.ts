import { describe, expect, it } from 'vitest';

import type { CliContext } from './context.js';
import { appendNextActions } from './next-actions.js';

// Most paths under test don't touch ctx; the never-throws case uses a stub.
const unusedCtx = {} as unknown as CliContext;

describe('appendNextActions', () => {
  it('checkpoint-open rejection envelope → a remediation template from the envelope', async () => {
    const out = (await appendNextActions(unusedCtx, {
      ok: false,
      status: 'blocked',
      gate_audit: { runs: [], dispositions: [] },
      artifact_id: 'A',
      declared_step_ids: ['s1', 's2'],
      blocked_evaluator_refs: ['core/scope-density'],
    })) as Record<string, unknown>;
    const na = out.next_actions as { verb: string; command: string }[];
    expect(na).toHaveLength(1);
    expect(na[0].verb).toBe('checkpoint-open');
    expect(na[0].command).toContain('--input -');
    expect(na[0].command).toContain('policy_exceptions:');
    expect(na[0].command).toContain('core/scope-density');
    expect(na[0].command).toContain('<smaller-step-subset>');
    // The rejected scope must not appear as a runnable value.
    expect(na[0].command).not.toContain('s1');
  });

  it('a result without artifact_id is returned unchanged (no next_actions)', async () => {
    const out = await appendNextActions(unusedCtx, { ok: true, hello: 'world' });
    expect(out).toEqual({ ok: true, hello: 'world' });
  });

  it('never throws — a failing snapshot yields next_actions: [] rather than an exception', async () => {
    const throwingCtx = {
      store: {
        readArtifact: async () => {
          throw new Error('boom');
        },
        store: {},
      },
      repo: { getHeadSha: async () => 'h' },
      repoRoot: '/nope',
      config: {},
      // gates joined CliContext with the approval-track next-action; without
      // it the cloud check throws before the snapshot fallback can yield [].
      gates: { cloud: false },
    } as unknown as CliContext;
    const out = (await appendNextActions(throwingCtx, { artifact_id: 'A', ok: true })) as Record<
      string,
      unknown
    >;
    expect(out.next_actions).toEqual([]);
    expect(out.ok).toBe(true);
  });
});
