import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Append-only plan revision e2e — full-supersede payloads, six
 * validation gates, and the optimistic-concurrency token on cp-open.
 *
 * Spec: `packages/storage/src/artifacts/store.ts:revisePlan`.
 *
 * Coverage:
 *   - happy path: capture → revise (add step) → cp on new step
 *   - three-outcome idempotency: replay, conflict, fresh
 *   - ARTIFACT_FINALIZED after summary (pre-pr-check does NOT finalize)
 *   - PLAN_REVISION_OPEN_CP_CONFLICT when revising would drop a live
 *     cp's declared step
 *   - PLAN_REVISION_UNACKNOWLEDGED_DROPS for closed-cp completion drops
 *   - acknowledge_drops_completed_steps unblocks closed-cp drops
 *   - STALE_PLAN_REVISION on cp-open with a stale token
 *   - reorder-only: step_ids preserved, ordinals shift
 *   - rewrite-only: text changes, step_lineage marks `rewritten`
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OkEnvelope {
  ok: true;
  [k: string]: unknown;
}
interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string; path?: string };
}

function parseOk<T = OkEnvelope>(r: CliResult): T {
  if (r.exitCode !== 0) {
    throw new Error(
      `expected exitCode=0, got ${r.exitCode}\n--- STDOUT ---\n${r.stdout}\n--- STDERR ---\n${r.stderr}`
    );
  }
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  if (!parsed.ok) {
    throw new Error(`expected ok envelope, got: ${r.stdout}`);
  }
  return parsed as T;
}

function parseErr(r: CliResult): ErrEnvelope {
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(false);
  return parsed as ErrEnvelope;
}

interface PlanStepResponse {
  step_id: string;
  idx: number;
  text: string;
}

interface CapturePlanResponse extends OkEnvelope {
  artifact_id: string;
  branch: string;
  revision_n: number;
  plan_event_id: string;
  plan_steps: PlanStepResponse[];
}

interface CapturePlanReviseResponse extends OkEnvelope {
  artifact_id: string;
  revision_n: number;
  plan_event_id: string;
  plan_steps: PlanStepResponse[];
  step_lineage: {
    added: string[];
    dropped: string[];
    unchanged: string[];
    rewritten: Array<{ step_id: string; prior_text_hash: string }>;
  };
}

async function capturePlan(
  agent: ReturnType<typeof makeAgent>,
  plan_step_texts: string[],
  opts: { non_goals?: string[]; touched_scope?: string[] } = {}
): Promise<CapturePlanResponse> {
  await agent.runRaw(['init', '--json', '--no-llm']);
  const plan_steps = plan_step_texts.map((text, idx) => ({ text, label: `s${idx + 1}` }));
  const r = await agent.runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `plan-${randomUUID()}`,
        task: 'plan-revision e2e',
        label: 'plan-revision-e2e',
        plan_steps,
        non_goals: opts.non_goals ?? [],
        touched_scope: opts.touched_scope ?? [],
      })
    ),
  ]);
  return parseOk<CapturePlanResponse>(r);
}

async function revise(
  agent: ReturnType<typeof makeAgent>,
  payload: Record<string, unknown>
): Promise<CliResult> {
  return agent.runRaw([
    'capture',
    'plan',
    'revise',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `revise-${randomUUID()}`,
        label: 'revise-label',
        ...payload,
      })
    ),
  ]);
}

async function reviseWithKey(
  agent: ReturnType<typeof makeAgent>,
  key: string,
  payload: Record<string, unknown>
): Promise<CliResult> {
  return agent.runRaw([
    'capture',
    'plan',
    'revise',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify({ idempotency_key: key, label: 'revise-label', ...payload })),
  ]);
}

async function open(
  agent: ReturnType<typeof makeAgent>,
  payload: Record<string, unknown>
): Promise<CliResult> {
  return agent.runRaw([
    'capture',
    'checkpoint',
    'open',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `open-${randomUUID()}`,
        ...payload,
      })
    ),
  ]);
}

async function close(
  agent: ReturnType<typeof makeAgent>,
  payload: Record<string, unknown>
): Promise<CliResult> {
  return agent.runRaw([
    'capture',
    'checkpoint',
    'close',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `close-${randomUUID()}`,
        verification: [{ command: 'test fixture', exit_code: 0 }],
        ...payload,
      })
    ),
  ]);
}

async function abandon(
  agent: ReturnType<typeof makeAgent>,
  payload: Record<string, unknown>
): Promise<CliResult> {
  return agent.runRaw([
    'capture',
    'checkpoint',
    'abandon',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `abandon-${randomUUID()}`,
        ...payload,
      })
    ),
  ]);
}

describe('plan revision e2e', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('happy path: capture → revise (add step) → cp on new step', async () => {
    const cap = await capturePlan(agent, ['step a', 'step b']);
    expect(cap.revision_n).toBe(0);
    expect(cap.plan_steps).toHaveLength(2);
    const [aId, bId] = cap.plan_steps.map((s) => s.step_id);
    expect(aId).toMatch(/^[0-9a-f]{8}-/);
    expect(aId).not.toBe(bId);

    const rv = parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'discovered we also need a third step',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'step a', label: 's1' },
          { step_id: bId, text: 'step b', label: 's2' },
          { text: 'step c added', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(rv.revision_n).toBe(1);
    expect(rv.plan_steps).toHaveLength(3);
    expect(rv.step_lineage.added).toHaveLength(1);
    expect(rv.step_lineage.dropped).toEqual([]);
    expect(rv.step_lineage.unchanged.sort()).toEqual([aId, bId].sort());
    const cId = rv.step_lineage.added[0];
    expect(rv.plan_steps[2].step_id).toBe(cId);

    // Open cp on the newly-added step_id; close should claim it.
    const o = parseOk<OkEnvelope & { n: number }>(
      await open(agent, { artifact_id: cap.artifact_id, declared_step_ids: [cId] })
    );
    parseOk(
      await close(agent, {
        artifact_id: cap.artifact_id,
        n: o.n,
        summary: 'did c',
        completed_step_ids: [cId],
      })
    );
  });

  it('three-outcome idempotency: replay → same payload, conflict → different payload', async () => {
    const cap = await capturePlan(agent, ['a', 'b']);
    const [aId, bId] = cap.plan_steps.map((s) => s.step_id);
    const key = `revise-key-${randomUUID()}`;

    const first = parseOk<CapturePlanReviseResponse>(
      await reviseWithKey(agent, key, {
        artifact_id: cap.artifact_id,
        rationale: 'add c',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: bId, text: 'b', label: 's2' },
          { text: 'c', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(first.revision_n).toBe(1);

    // Same key + same payload → replay (revision_n unchanged).
    const replay = parseOk<OkEnvelope & { revision_n: number; idempotency_status: string }>(
      await reviseWithKey(agent, key, {
        artifact_id: cap.artifact_id,
        rationale: 'add c',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: bId, text: 'b', label: 's2' },
          { text: 'c', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(replay.idempotency_status).toBe('replay');
    expect(replay.revision_n).toBe(1);

    // Same key + DIFFERENT payload → IDEMPOTENCY_CONFLICT.
    const conflict = parseErr(
      await reviseWithKey(agent, key, {
        artifact_id: cap.artifact_id,
        rationale: 'add c',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: bId, text: 'b', label: 's2' },
          { text: 'c REWRITTEN', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('replays the matched revision and conflicts on every semantic revision input', async () => {
    const cap = await capturePlan(agent, ['a']);
    const aId = cap.plan_steps[0].step_id;
    const firstKey = `revise-exact-${randomUUID()}`;
    const firstPayload = {
      artifact_id: cap.artifact_id,
      label: 'first revision',
      agent_session_id: 'session-one',
      rationale: 'first revision rationale',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: ['first-scope'],
      non_goals: [],
      acknowledge_criteria_changes: [],
    };
    const first = parseOk<CapturePlanReviseResponse>(
      await reviseWithKey(agent, firstKey, firstPayload)
    );
    expect(first.revision_n).toBe(1);

    const second = parseOk<CapturePlanReviseResponse>(
      await reviseWithKey(agent, `revise-later-${randomUUID()}`, {
        ...firstPayload,
        label: 'second revision',
        rationale: 'second revision rationale',
        touched_scope: ['second-scope'],
      })
    );
    expect(second.revision_n).toBe(2);

    const replay = parseOk<OkEnvelope & { revision_n: number; plan_event_id: string }>(
      await reviseWithKey(agent, firstKey, firstPayload)
    );
    expect(replay.revision_n).toBe(1);
    expect(replay.plan_event_id).toBe(first.plan_event_id);

    for (const changed of [
      { ...firstPayload, label: 'changed label' },
      { ...firstPayload, agent_session_id: 'session-two' },
      { ...firstPayload, acknowledge_criteria_changes: ['criterion-change'] },
    ]) {
      const conflict = parseErr(await reviseWithKey(agent, firstKey, changed));
      expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('does not let an older revision completion marker mask an incomplete newer revision', async () => {
    const cap = await capturePlan(agent, ['a']);
    const aId = cap.plan_steps[0].step_id;
    const firstKey = `first-${randomUUID()}`;
    const firstPayload = {
      artifact_id: cap.artifact_id,
      rationale: 'first revision',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: ['first'],
      non_goals: [],
    };
    const first = parseOk<CapturePlanReviseResponse>(
      await reviseWithKey(agent, firstKey, firstPayload)
    );
    expect(first.revision_n).toBe(1);

    const secondKey = `second-${randomUUID()}`;
    const secondPayload = {
      artifact_id: cap.artifact_id,
      rationale: 'second revision',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: ['second'],
      non_goals: [],
    };
    const second = parseOk<CapturePlanReviseResponse>(
      await reviseWithKey(agent, secondKey, secondPayload)
    );
    expect(second.revision_n).toBe(2);

    const cache = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      cache.db
        .prepare(
          `DELETE FROM evaluator_lifecycles
           WHERE artifact_id = ? AND fires_at = 'post-plan-revision' AND cp_n = 2`
        )
        .run(cap.artifact_id);
    } finally {
      cache.close();
    }

    const replay = parseOk<OkEnvelope & { message: string }>(
      await reviseWithKey(agent, secondKey, secondPayload)
    );
    expect(replay.message).toContain('missing post-event evaluator work was resumed');

    const afterReplay = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      afterReplay.db
        .prepare(
          `DELETE FROM evaluator_lifecycles
           WHERE artifact_id = ? AND fires_at = 'post-plan-revision' AND cp_n = 1`
        )
        .run(cap.artifact_id);
    } finally {
      afterReplay.close();
    }
    const historical = parseOk<OkEnvelope & { message: string; idempotency_status: string }>(
      await reviseWithKey(agent, firstKey, firstPayload)
    );
    expect(historical.idempotency_status).toBe('replay');
    expect(historical.message).toContain('historical evaluator completion is unavailable');
  });

  it('replays an inherited agent session without an event-only intent field', async () => {
    const cap = await capturePlan(agent, ['a']);
    const aId = cap.plan_steps[0].step_id;
    parseOk(
      await reviseWithKey(agent, `set-session-${randomUUID()}`, {
        artifact_id: cap.artifact_id,
        agent_session_id: 'session-one',
        rationale: 'set the session',
        prior_plan_event_id: null,
        plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
        touched_scope: [],
        non_goals: [],
      })
    );
    const key = `inherit-session-${randomUUID()}`;
    const payload = {
      artifact_id: cap.artifact_id,
      rationale: 'inherit the session',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: ['inherited'],
      non_goals: [],
    };
    const created = parseOk<CapturePlanReviseResponse>(await reviseWithKey(agent, key, payload));
    const replay = parseOk<OkEnvelope & { revision_n: number; idempotency_status: string }>(
      await reviseWithKey(agent, key, payload)
    );
    expect(replay.revision_n).toBe(created.revision_n);
    expect(replay.idempotency_status).toBe('replay');
  });

  it('clears an inherited agent session with explicit null and replays it', async () => {
    const cap = await capturePlan(agent, ['a']);
    const aId = cap.plan_steps[0].step_id;
    parseOk(
      await reviseWithKey(agent, `set-session-${randomUUID()}`, {
        artifact_id: cap.artifact_id,
        agent_session_id: 'session-one',
        rationale: 'set the session',
        prior_plan_event_id: null,
        plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
        touched_scope: [],
        non_goals: [],
      })
    );
    const key = `clear-session-${randomUUID()}`;
    const payload = {
      artifact_id: cap.artifact_id,
      agent_session_id: null,
      rationale: 'clear the session',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: [],
      non_goals: [],
    };
    const created = parseOk<CapturePlanReviseResponse>(await reviseWithKey(agent, key, payload));
    const replay = parseOk<OkEnvelope & { revision_n: number; idempotency_status: string }>(
      await reviseWithKey(agent, key, payload)
    );
    expect(replay.revision_n).toBe(created.revision_n);
    expect(replay.idempotency_status).toBe('replay');

    const projectedPlan = JSON.parse(
      await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', cap.artifact_id, 'plan.json'),
        'utf8'
      )
    ) as { agent_session_id: string | null };
    expect(projectedPlan.agent_session_id).toBeNull();
    const events = (
      await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', cap.artifact_id, 'events.ndjson'),
        'utf8'
      )
    )
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { type: string; idempotency_key: string; payload: object }
      );
    const event = events.find(
      (item) => item.type === 'plan_revised' && item.idempotency_key === key
    );
    expect(event?.payload).not.toHaveProperty('agent_session_id_intent');
  });

  it('keeps an omitted session stable across hard-rejected retries', async () => {
    const cap = await capturePlan(agent, ['a', 'b']);
    const [aId, bId] = cap.plan_steps.map((step) => step.step_id);
    parseOk(
      await open(agent, {
        artifact_id: cap.artifact_id,
        declared_step_ids: [bId],
      })
    );
    const key = `blocked-inherit-${randomUUID()}`;
    const payload = {
      artifact_id: cap.artifact_id,
      rationale: 'drop the open step',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: aId, text: 'a', label: 's1' }],
      touched_scope: [],
      non_goals: [],
    };
    expect(parseErr(await reviseWithKey(agent, key, payload)).error.code).toBe(
      'PLAN_REVISION_OPEN_CP_CONFLICT'
    );

    parseOk(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        agent_session_id: 'session-two',
        rationale: 'change only the session',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: bId, text: 'b', label: 's2' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(parseErr(await reviseWithKey(agent, key, payload)).error.code).toBe(
      'PLAN_REVISION_OPEN_CP_CONFLICT'
    );
  });

  it('PLAN_REVISION_OPEN_CP_CONFLICT when dropping a step a live cp declares; abandon then succeeds', async () => {
    const cap = await capturePlan(agent, ['a', 'b', 'c']);
    const [aId, bId, cId] = cap.plan_steps.map((s) => s.step_id);

    const o = parseOk<OkEnvelope & { n: number }>(
      await open(agent, { artifact_id: cap.artifact_id, declared_step_ids: [bId] })
    );

    const blocked = parseErr(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'try to drop b',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: cId, text: 'c', label: 's2' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(blocked.error.code).toBe('PLAN_REVISION_OPEN_CP_CONFLICT');
    expect(blocked.error.message).toContain(bId);

    // Abandon the cp; the revision should now succeed.
    parseOk(
      await abandon(agent, {
        artifact_id: cap.artifact_id,
        n: o.n,
        reason: 'reverting to drop step b',
      })
    );

    const ok = parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'now we can drop b',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: cId, text: 'c', label: 's2' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(ok.step_lineage.dropped).toEqual([bId]);
  });

  it('PLAN_REVISION_UNACKNOWLEDGED_DROPS for closed-cp completion drops; ack unblocks', async () => {
    const cap = await capturePlan(agent, ['a', 'b']);
    const [aId, bId] = cap.plan_steps.map((s) => s.step_id);

    const o = parseOk<OkEnvelope & { n: number }>(
      await open(agent, { artifact_id: cap.artifact_id, declared_step_ids: [aId] })
    );
    parseOk(
      await close(agent, {
        artifact_id: cap.artifact_id,
        n: o.n,
        summary: 'finished a',
        completed_step_ids: [aId],
      })
    );

    // Try to drop a (which is closed-cp-claimed) without ack.
    const blocked = parseErr(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'a is no longer needed',
        prior_plan_event_id: null,
        plan_steps: [{ step_id: bId, text: 'b', label: 's1' }],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(blocked.error.code).toBe('PLAN_REVISION_UNACKNOWLEDGED_DROPS');

    // Now with explicit ack: succeeds.
    const ok = parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'a is no longer needed; archiving completion record',
        prior_plan_event_id: null,
        plan_steps: [{ step_id: bId, text: 'b', label: 's1' }],
        touched_scope: [],
        non_goals: [],
        acknowledge_drops_completed_steps: [aId],
      })
    );
    expect(ok.step_lineage.dropped).toEqual([aId]);
  });

  it('capture plan surfaces a top-level plan_event_id that cp-open accepts as plan_revision_id', async () => {
    const cap = await capturePlan(agent, ['a', 'b']);
    expect(typeof cap.plan_event_id).toBe('string');
    expect(cap.plan_event_id.length).toBeGreaterThan(0);
    const opened = parseOk<{ status: string }>(
      await open(agent, {
        artifact_id: cap.artifact_id,
        declared_step_ids: [cap.plan_steps[0].step_id],
        plan_revision_id: cap.plan_event_id,
      })
    );
    expect(opened.status).toBe('open');
  });

  it('STALE_PLAN_REVISION on cp-open when plan_revision_id is stale', async () => {
    const cap = await capturePlan(agent, ['a', 'b']);
    const [aId, bId] = cap.plan_steps.map((s) => s.step_id);
    const initialEventId = (
      JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as {
        artifacts: Array<{ id: string }>;
      }
    ).artifacts[0].id;
    void initialEventId;

    // Capture a token before the revision. The capture-plan envelope
    // carries plan_event_id top-level, so no resume round-trip is needed.
    const staleToken = cap.plan_event_id;
    expect(staleToken).toBeTruthy();

    // Revise (advances the latest plan_event_id).
    parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'add c',
        prior_plan_event_id: staleToken,
        plan_steps: [
          { step_id: aId, text: 'a', label: 's1' },
          { step_id: bId, text: 'b', label: 's2' },
          { text: 'c', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );

    // Open a cp passing the now-stale token: rejected.
    const stale = parseErr(
      await open(agent, {
        artifact_id: cap.artifact_id,
        declared_step_ids: [aId],
        plan_revision_id: staleToken,
      })
    );
    expect(stale.error.code).toBe('STALE_PLAN_REVISION');
  });

  it('reorder-only: step_ids preserved, ordinals shift, lineage marks unchanged', async () => {
    const cap = await capturePlan(agent, ['a', 'b', 'c']);
    const [aId, bId, cId] = cap.plan_steps.map((s) => s.step_id);

    const ok = parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'reorder: c first, then a, then b',
        prior_plan_event_id: null,
        plan_steps: [
          { step_id: cId, text: 'c', label: 's1' },
          { step_id: aId, text: 'a', label: 's2' },
          { step_id: bId, text: 'b', label: 's3' },
        ],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(ok.plan_steps.map((s) => s.step_id)).toEqual([cId, aId, bId]);
    expect(ok.plan_steps.map((s) => s.idx)).toEqual([1, 2, 3]);
    expect(ok.step_lineage.unchanged.sort()).toEqual([aId, bId, cId].sort());
    expect(ok.step_lineage.added).toEqual([]);
    expect(ok.step_lineage.dropped).toEqual([]);
    expect(ok.step_lineage.rewritten).toEqual([]);
  });

  it('rewrite-only: same step_id, new text, lineage marks rewritten with prior_text_hash', async () => {
    const cap = await capturePlan(agent, ['original a']);
    const [aId] = cap.plan_steps.map((s) => s.step_id);

    const ok = parseOk<CapturePlanReviseResponse>(
      await revise(agent, {
        artifact_id: cap.artifact_id,
        rationale: 'clarified a',
        prior_plan_event_id: null,
        plan_steps: [{ step_id: aId, text: 'original a — refined', label: 's1' }],
        touched_scope: [],
        non_goals: [],
      })
    );
    expect(ok.step_lineage.rewritten).toHaveLength(1);
    expect(ok.step_lineage.rewritten[0].step_id).toBe(aId);
    expect(ok.step_lineage.rewritten[0].prior_text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.step_lineage.added).toEqual([]);
    expect(ok.step_lineage.dropped).toEqual([]);
  });
});
