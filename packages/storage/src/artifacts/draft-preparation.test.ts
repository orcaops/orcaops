import { afterEach, expect, it, vi } from 'vitest';

import {
  type ArtifactDraftResult,
  type ArtifactDraftSemantics,
  prepareArtifactDraft,
} from './draft-preparation.js';
import { VerificationRequiredError } from './errors.js';
import type { EventWithPayload } from '../events/rebuilders.js';
import { digest, recordChecksum } from '../history/event-integrity.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { PlanInputSchema } from '../schema/plan.js';
import { Store } from '../store/sqlite.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../text/secret-guard.js';

const guard = vi.hoisted(() => ({ forbidden: false, calls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            if (guard.forbidden) {
              guard.calls.push(key);
              throw new Error(`Unexpected filesystem call: ${key}`);
            }
            return (value as (...args: unknown[]) => unknown)(...args);
          }
        : value,
    ])
  );
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            if (guard.forbidden) {
              guard.calls.push(key);
              throw new Error(`Unexpected filesystem call: ${key}`);
            }
            return (value as (...args: unknown[]) => unknown)(...args);
          }
        : value,
    ])
  );
});
vi.mock('../locks.js', () => ({
  ArtifactLock: class {
    constructor() {
      throw new Error('Unexpected lock construction');
    }
  },
}));
vi.mock('./store.js', () => {
  throw new Error('Draft imported the disk-capable artifact store');
});

afterEach(() => {
  guard.forbidden = false;
  guard.calls = [];
  vi.restoreAllMocks();
});
function fixture() {
  const artifactId = uuidv7(),
    stepId = uuidv7();
  const plan = PlanInputSchema.parse({
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain exact authored work',
    label: 'Retained work',
    plan_steps: [
      { step_id: stepId, text: 'Preserve history', label: 'History', acceptance_criteria: [] },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-05T09:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  });
  const input = {
    artifactId,
    priorEvents: [] as EventWithPayload[],
    authoredPayload: plan,
    secretAllow: [] as string[],
    idempotencyBlocks: [],
  };
  return { artifactId, stepId, plan, input };
}
function retained(result: ArtifactDraftResult<unknown>): EventWithPayload[] {
  return result.events.map((event) => ({
    record: event.record,
    payload: JSON.parse(event.payloadBytes.toString('utf8')),
  }));
}
async function planned() {
  const f = fixture();
  const first = await prepareArtifactDraft(f.input, (s) =>
    s.writePlan(f.plan, { idempotencyKey: 'plan' })
  );
  expect(first.evaluation.kind).toBe('returned');
  return { ...f, input: { ...f.input, priorEvents: retained(first) }, first };
}

it('prepares plan, open and selected reads with all application filesystem calls and locks forbidden', async () => {
  const f = fixture();
  guard.forbidden = true;
  const result = await prepareArtifactDraft(f.input, async (s) => {
    expect(Object.keys(s)).not.toContain('store');
    for (const key of [
      'deleteArtifact',
      'close',
      'withArtifactLock',
      'withArtifactEventBatch',
      'lock',
    ])
      expect(key in s).toBe(false);
    const plan = await s.writePlan(f.plan, { idempotencyKey: 'plan' });
    const open = await s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      { idempotencyKey: 'open', headSha: 'b'.repeat(40) }
    );
    expect(await s.readPlan(f.artifactId)).toMatchObject({
      source_event_id: plan.event_id,
      plan_steps: f.plan.plan_steps,
    });
    expect(await s.readCheckpoint(f.artifactId, 1)).toMatchObject({
      open_plan_revision_event_id: plan.event_id,
    });
    return open;
  });
  expect(result.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'created' } });
  expect(result.events.map((e) => e.record.type)).toEqual(['plan_captured', 'checkpoint_opened']);
  expect(guard.calls).toEqual([]);
});

it('preserves original replay identity without evaluating again or proposing new events', async () => {
  const f = await planned();
  const opened = await prepareArtifactDraft(f.input, (s) =>
    s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      { idempotencyKey: 'open', headSha: 'b'.repeat(40) }
    )
  );
  const prior = [...f.input.priorEvents, ...retained(opened)];
  const evaluatorContext = vi.fn(() => {
    throw new Error('Replay evaluated again');
  });
  const replay = await prepareArtifactDraft({ ...f.input, priorEvents: prior }, (s) =>
    s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      { idempotencyKey: 'open', headSha: 'b'.repeat(40), evaluatorContext }
    )
  );
  expect(replay.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'replay' } });
  expect(replay.events).toEqual([]);
  expect(replay.idempotencyChanges).toEqual([]);
  expect(evaluatorContext).not.toHaveBeenCalled();
  expect(prior.at(-1)!.record.event_id).toBe(opened.events[0].record.event_id);
});

it('retains verification refusal and proposed rejected-attempt evidence without publishable events', async () => {
  const f = await planned();
  const opened = await prepareArtifactDraft(f.input, (s) =>
    s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      { idempotencyKey: 'open', headSha: 'b'.repeat(40) }
    )
  );
  const input = { ...f.input, priorEvents: [...f.input.priorEvents, ...retained(opened)] };
  const close = {
    artifact_id: f.artifactId,
    n: 1,
    summary: 'Preserved',
    files_changed: [],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    completed_step_ids: [f.stepId],
    head_sha: 'b'.repeat(40),
  };
  const rejected = await prepareArtifactDraft(input, (s) =>
    s.writeCheckpointClosed(close, { idempotencyKey: 'close' })
  );
  expect(rejected.evaluation.kind).toBe('threw');
  if (rejected.evaluation.kind === 'threw')
    expect(rejected.evaluation.error).toBeInstanceOf(VerificationRequiredError);
  expect(rejected.events).toEqual([]);
  expect(rejected.idempotencyChanges).not.toEqual([]);
  const valid = await prepareArtifactDraft(input, (s) =>
    s.writeCheckpointClosed(
      { ...close, verification: [{ command: 'verify', exit_code: 0 }] },
      { idempotencyKey: 'verified' }
    )
  );
  expect(valid.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'created' } });
});

it('keeps sidecar and event bytes bound to their original minted identities', async () => {
  const f = fixture();
  f.plan.task = 'Retained reasoning '.repeat(1000);
  const result = await prepareArtifactDraft(f.input, (s) =>
    s.writePlan(f.plan, { idempotencyKey: 'large' })
  );
  const event = result.events[0];
  expect(event.sidecar).not.toBeNull();
  expect(event.sidecar!.relativePath).toBe(`sidecars/${event.record.event_id}.json`);
  expect('sidecar_sha256' in event.record).toBe(true);
  if (!('sidecar_sha256' in event.record)) throw new Error('Expected sidecar record');
  expect(digest(event.sidecar!.bytes)).toBe(event.record.sidecar_sha256);
  const { checksum, ...base } = event.record;
  expect(recordChecksum(base)).toBe(checksum);
  expect(JSON.parse(event.eventBytes.toString('utf8'))).toEqual(event.record);
  f.plan.task = 'Changed afterward';
  expect(JSON.parse(event.payloadBytes.toString('utf8')).task).not.toBe(f.plan.task);
});

it('reconstructs exact open-time plan revision and preserves authored step and criterion identities', async () => {
  const f = await planned();
  const original = f.first.events[0].record.event_id;
  const revised = await prepareArtifactDraft(f.input, (s) =>
    s.revisePlan(
      {
        idempotency_key: 'revision',
        artifact_id: f.artifactId,
        label: 'Revised',
        plan_steps: f.plan.plan_steps,
        touched_scope: [],
        non_goals: [],
        decisions: [],
        rationale: 'Clarify scope',
        prior_plan_event_id: original,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'revision' }
    )
  );
  expect(revised.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'created' } });
  await prepareArtifactDraft(
    { ...f.input, priorEvents: [...f.input.priorEvents, ...retained(revised)] },
    async (s) => {
      expect(await s.readPlan(f.artifactId)).toMatchObject({
        revision_n: 1,
        plan_steps: f.plan.plan_steps,
      });
      expect(await s.resolveOpenRevisionPlanStrict(f.artifactId, original)).toMatchObject({
        kind: 'resolved',
        plan: { revision_n: 0, source_event_id: original },
      });
    }
  );
});

it('invalidates an escaped facade in a later preparation without exposing its query store', async () => {
  const f = await planned();
  let escaped!: ArtifactDraftSemantics;
  await prepareArtifactDraft(f.input, async (s) => {
    escaped = s;
  });
  await prepareArtifactDraft(f.input, async (s) => {
    await expect(escaped.readPlan(f.artifactId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await s.readPlan(f.artifactId)).not.toBeNull();
  });
});

it('rejects refused authored content before constructing the derived query store', async () => {
  const f = fixture();
  const spy = vi.spyOn(Store.prototype as any, 'migrate');
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  await expect(
    prepareArtifactDraft({ ...f.input, authoredPayload: { token: secret } }, async () => null)
  ).rejects.toBeInstanceOf(SecretInPayloadError);
  expect(spy).not.toHaveBeenCalled();
});

it('retains blocking evaluator history and allows summary only after the matching gate clears', async () => {
  const f = await planned();
  const payload = {
    schema: 'orcaops.evaluator_run/v1' as const,
    run_id: 'check:original',
    artifact_id: f.artifactId,
    evaluator_ref: 'test/retention',
    package_id: 'test',
    evaluator_id: 'retention',
    phase: 'pre-pr' as const,
    severity: 'block' as const,
    run_status: 'completed' as const,
    verdict: 'violation' as const,
    body: 'Required evidence is missing',
    ts: '2026-09-05T09:01:00.000Z',
  };
  const gate = await prepareArtifactDraft(f.input, (s) =>
    s.writeEvaluatorRunPayload(f.artifactId, payload)
  );
  const input = { ...f.input, priorEvents: [...f.input.priorEvents, ...retained(gate)] };
  const summary = {
    schema_version: 1 as const,
    artifact_id: f.artifactId,
    outcome: 'History retained',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: 'b'.repeat(40),
    ts: '2026-09-05T09:03:00.000Z',
  };
  const blocked = await prepareArtifactDraft(input, (s) => s.writeSummary(summary));
  expect(blocked.evaluation).toMatchObject({ kind: 'threw', error: { code: 'BLOCKED' } });
  expect(blocked.events).toEqual([]);
  const cleared = await prepareArtifactDraft(input, async (s) => {
    await s.writeEvaluatorRunPayload(f.artifactId, {
      ...payload,
      run_id: 'check:cleared',
      verdict: 'pass',
      ts: '2026-09-05T09:02:00.000Z',
    });
    return s.writeSummary(summary);
  });
  expect(cleared.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'created' } });
  await prepareArtifactDraft(
    { ...input, priorEvents: [...input.priorEvents, ...retained(cleared)] },
    async (s) => {
      expect(await s.readArtifact(f.artifactId)).toMatchObject({ state: 'summarized' });
      expect((await s.readEvaluatorLog(f.artifactId))!.runs.map((r) => r.run_id)).toEqual([
        'check:original',
        'check:cleared',
      ]);
    }
  );
});

it('returns no proposed events when a later semantic operation fails after a draft append', async () => {
  const f = fixture();
  const cause = new Error('Outside preparation failed');
  const result = await prepareArtifactDraft(f.input, async (s) => {
    await s.writePlan(f.plan);
    throw cause;
  });
  expect(result.evaluation).toEqual({ kind: 'threw', error: cause });
  expect(result.events).toEqual([]);
});

it('refuses a different artifact target without proposing events', async () => {
  const f = fixture();
  guard.forbidden = true;
  const result = await prepareArtifactDraft(f.input, (semantics) =>
    semantics.writePlan({ ...f.plan, artifact_id: uuidv7() })
  );
  expect(result.evaluation).toMatchObject({
    kind: 'threw',
    error: expect.objectContaining({ message: expect.stringContaining('another target') }),
  });
  expect(result.events).toEqual([]);
  expect(guard.calls).toEqual([]);
});

it('refuses a foreign attempt scope before constructing the derived store', async () => {
  const f = fixture();
  const spy = vi.spyOn(Store.prototype as any, 'migrate');
  await expect(
    prepareArtifactDraft(
      {
        ...f.input,
        idempotencyBlocks: [
          {
            artifact_id: uuidv7(),
            event_type: 'checkpoint_opened',
            idempotency_key: 'foreign',
          } as any,
        ],
      },
      async () => null
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(spy).not.toHaveBeenCalled();
});

it('does not expose an unfinished callback mutation as a successful preparation', async () => {
  const f = await planned();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prepareArtifactDraft(f.input, async (s) => {
    void s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      {
        idempotencyKey: 'open',
        headSha: 'b'.repeat(40),
        evaluatorContext: async () => ({
          fingerprint: 'c'.repeat(64),
          validatePolicyExceptions() {},
          preAppend: async () => {
            await gate;
            return { ok: true as const };
          },
        }),
      }
    );
  });
  release();
  await expect(pending).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('replays a retained soft block without rerunning its evaluator and clears it when the fingerprint changes', async () => {
  const f = await planned();
  const open = { artifact_id: f.artifactId, declared_step_ids: [f.stepId] };
  const envelope = { ok: false, error: { code: 'BLOCKED', message: 'Scope needs review' } };
  const preAppend = vi.fn(async () => ({ ok: false as const, envelope }));
  const options = {
    idempotencyKey: 'blocked-open',
    headSha: 'b'.repeat(40),
    evaluatorContext: async () => ({
      fingerprint: 'c'.repeat(64),
      validatePolicyExceptions() {},
      preAppend,
    }),
  };
  const blocked = await prepareArtifactDraft(f.input, (s) =>
    s.writeCheckpointOpened(open, options)
  );
  expect(blocked.evaluation).toMatchObject({
    kind: 'returned',
    value: { outcome: 'blocked', idempotencyOutcome: 'created' },
  });
  expect(blocked.events).toEqual([]);
  const blocks = blocked.idempotencyChanges.flatMap((change) =>
    change.after ? [change.after] : []
  );
  expect(blocks).toHaveLength(1);
  const input = { ...f.input, idempotencyBlocks: blocks };
  const replay = await prepareArtifactDraft(input, (s) => s.writeCheckpointOpened(open, options));
  expect(replay.evaluation).toMatchObject({
    kind: 'returned',
    value: { outcome: 'blocked', idempotencyOutcome: 'replay' },
  });
  expect(preAppend).toHaveBeenCalledOnce();
  expect(replay.idempotencyChanges).toEqual([]);
  const accepted = await prepareArtifactDraft(input, (s) =>
    s.writeCheckpointOpened(open, {
      ...options,
      evaluatorContext: async () => ({
        fingerprint: 'd'.repeat(64),
        validatePolicyExceptions() {},
        preAppend: async () => ({ ok: true as const }),
      }),
    })
  );
  expect(accepted.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'created' } });
  expect(accepted.events).toHaveLength(1);
  expect(accepted.idempotencyChanges).toEqual([{ before: blocks[0], after: null }]);
});

it('keeps the derived database and SQLite temporary storage entirely in memory', () => {
  guard.forbidden = true;
  const store = new Store(':memory:');
  try {
    expect(store.db.pragma('temp_store', { simple: true })).toBe(2);
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(store.db.pragma('database_list')).toEqual([{ seq: 0, name: 'main', file: '' }]);
    expect(guard.calls).toEqual([]);
  } finally {
    store.close();
  }
});

function blockedOptions(message: string, fields: Record<string, string> = {}) {
  return {
    idempotencyKey: 'open',
    headSha: 'b'.repeat(40),
    evaluatorContext: async () => ({
      fingerprint: 'c'.repeat(64),
      validatePolicyExceptions() {},
      preAppend: async () => ({
        ok: false as const,
        envelope: { ok: false, error: { code: 'BLOCKED', message, ...fields } },
      }),
    }),
  };
}

it('refuses evaluator-produced secrets in newly publishable attempt rows without filesystem writes', async () => {
  const f = await planned();
  const token = 'ghp_' + 'q'.repeat(36);
  guard.forbidden = true;
  await expect(
    prepareArtifactDraft(f.input, (s) =>
      s.writeCheckpointOpened(
        { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
        blockedOptions(token)
      )
    )
  ).rejects.toBeInstanceOf(SecretInPayloadError);
  expect(guard.calls).toEqual([]);
});

it('honors an exact allowed token for a newly produced blocked attempt', async () => {
  const f = await planned();
  const token = 'ghp_' + 'q'.repeat(36);
  const result = await prepareArtifactDraft({ ...f.input, secretAllow: [token] }, (s) =>
    s.writeCheckpointOpened(
      { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
      blockedOptions(token)
    )
  );
  expect(result.evaluation).toMatchObject({ kind: 'returned', value: { outcome: 'blocked' } });
  expect(result.events).toEqual([]);
  expect(result.idempotencyChanges).toHaveLength(1);
  expect(result.idempotencyChanges[0].after!.envelope).toContain(token);
});

it('replays retained blocked content without reauthoring unchanged attempt rows', async () => {
  const f = await planned();
  const token = 'ghp_' + 'q'.repeat(36);
  const open = { artifact_id: f.artifactId, declared_step_ids: [f.stepId] };
  const first = await prepareArtifactDraft({ ...f.input, secretAllow: [token] }, (s) =>
    s.writeCheckpointOpened(open, blockedOptions(token))
  );
  const original = first.idempotencyChanges[0].after!;
  const replay = await prepareArtifactDraft({ ...f.input, idempotencyBlocks: [original] }, (s) =>
    s.writeCheckpointOpened(open, blockedOptions(token))
  );
  expect(replay.evaluation).toMatchObject({
    kind: 'returned',
    value: { outcome: 'blocked', idempotencyOutcome: 'replay' },
  });
  expect(replay.events).toEqual([]);
  expect(replay.idempotencyChanges).toEqual([]);
  expect(original.envelope).toContain(token);
});

it.each([
  { location: 'value', code: 0 },
  { location: 'key', code: 0 },
  { location: 'value', code: 8 },
  { location: 'key', code: 8 },
])(
  'refuses a new envelope $location containing an escaped control character $code',
  async ({ location, code }) => {
    const f = await planned();
    const token = 'ghp_' + 'q'.repeat(36);
    const split = token.slice(0, 12) + String.fromCharCode(code) + token.slice(12);
    const message = location === 'value' ? split : 'Scope needs review';
    const fields = location === 'key' ? { [split]: 'safe' } : {};
    expect(() => assertNoSecretsInPayload({ message, ...fields }, [])).toThrow(
      SecretInPayloadError
    );
    guard.forbidden = true;
    await expect(
      prepareArtifactDraft(f.input, (s) =>
        s.writeCheckpointOpened(
          { artifact_id: f.artifactId, declared_step_ids: [f.stepId] },
          blockedOptions(message, fields)
        )
      )
    ).rejects.toBeInstanceOf(SecretInPayloadError);
    expect(guard.calls).toEqual([]);
  }
);

it.each(['key', 'value'])(
  'preserves exact allowed envelope bytes and historical replay for an escaped %s',
  async (location) => {
    const f = await planned();
    const token = 'ghp_' + 'q'.repeat(36);
    const split = token.slice(0, 12) + String.fromCharCode(0) + token.slice(12);
    const message = location === 'value' ? split : 'Scope needs review';
    const fields = location === 'key' ? { [split]: 'safe' } : {};
    expect(() => assertNoSecretsInPayload({ message, ...fields }, [token])).toThrow(
      SecretInPayloadError
    );
    expect(() => assertNoSecretsInPayload({ message, ...fields }, [token, split])).not.toThrow();
    const expected = JSON.stringify({ ok: false, error: { code: 'BLOCKED', message, ...fields } });
    const open = { artifact_id: f.artifactId, declared_step_ids: [f.stepId] };
    const first = await prepareArtifactDraft({ ...f.input, secretAllow: [token, split] }, (s) =>
      s.writeCheckpointOpened(open, blockedOptions(message, fields))
    );
    const original = first.idempotencyChanges[0].after!;
    expect(original.envelope).toBe(expected);
    const replay = await prepareArtifactDraft({ ...f.input, idempotencyBlocks: [original] }, (s) =>
      s.writeCheckpointOpened(open, blockedOptions(message, fields))
    );
    expect(replay.evaluation).toMatchObject({
      kind: 'returned',
      value: { outcome: 'blocked', idempotencyOutcome: 'replay' },
    });
    expect(replay.idempotencyChanges).toEqual([]);
    expect(original.envelope).toBe(expected);
  }
);
