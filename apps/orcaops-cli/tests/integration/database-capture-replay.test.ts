import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * A replay is a READ of the retained receipt. Returning the original result must not
 * append an operation, advance the project write sequence or intent counter, or move the
 * session focus — the resources contract says a no-op replay changes no counter.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'replay-session';
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: SESSION,
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: `${f.temporary}/state`,
    },
  });
}
/** Every authoritative row a replay must leave alone. */
function inventory(f: Fixture) {
  return f.writer.read((view) => ({
    operations: view.all(
      'SELECT operation_id, operation_kind, committed_write_sequence, committed_intent_counter FROM operations ORDER BY operation_id'
    ),
    counters: view.all('SELECT * FROM project_counters'),
    focusCurrent: view.all(
      'SELECT scope_json, operation_id, version FROM execution_focus_current ORDER BY scope_json'
    ),
    // pin_bytes is a BLOB the read boundary refuses to materialize; its hash identifies it.
    focusRecords: view.all(
      'SELECT operation_id, scope_json, pin_hash FROM execution_focus_records ORDER BY operation_id'
    ),
  })).value;
}
async function run(
  f: Fixture,
  verb: string[],
  body: Record<string, unknown>,
  flags = ['--no-llm']
) {
  const raw = await agent(f).runRaw([
    'capture',
    ...verb,
    ...flags,
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}

describe('registered database capture replay', { timeout: 240_000 }, () => {
  it('replays capture plan without writing anything', async () => {
    const f = await fixture();
    const body = {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'replay writes nothing',
      label: 'Replay subject',
      plan_steps: [{ text: 'do it', label: 'Do it' }],
      touched_scope: [],
      non_goals: [],
    };
    const first = await run(f, ['plan'], body);
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    const before = inventory(f);
    const replay = await run(f, ['plan'], body);
    expect(replay.raw.exitCode, replay.raw.stdout + replay.raw.stderr).toBe(0);
    expect(replay.result).toMatchObject({
      artifact_id: first.result.artifact_id,
      idempotency_status: 'replay',
      focus: { state: 'skipped', reason: 'replay' },
      usage: { state: 'skipped', reason: 'replay' },
    });
    expect(replay.result.plan_event_id).toBe(first.result.plan_event_id);
    expect(inventory(f)).toEqual(before);

    const conflict = await run(f, ['plan'], { ...body, label: 'A different label' });
    expect(conflict.raw.exitCode).toBe(1);
    expect(conflict.result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(inventory(f)).toEqual(before);
  });

  it('replays a revision, a summary and the checkpoint verbs without writing', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    const step = plan.plan_steps[0].step_id;
    const cases: Array<{
      name: string;
      verb: string[];
      body: Record<string, unknown>;
      flags?: string[];
    }> = [
      {
        name: 'plan revise',
        verb: ['plan', 'revise'],
        body: {
          idempotency_key: `revise-${randomUUID()}`,
          artifact_id: id,
          label: 'Replayed revision',
          rationale: 'exercise the replay',
          prior_plan_event_id: null,
          plan_steps: [
            { step_id: step, text: 'Read retained evidence', label: 'Retained evidence' },
          ],
          touched_scope: [],
          non_goals: [],
        },
      },
      {
        name: 'checkpoint open',
        verb: ['checkpoint', 'open'],
        body: {
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: id,
          declared_step_ids: [step],
        },
      },
      {
        name: 'checkpoint close',
        verb: ['checkpoint', 'close'],
        body: {
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: id,
          n: 1,
          summary: 'Replayed close',
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        },
      },
      {
        name: 'checkpoint abandon',
        verb: ['checkpoint', 'abandon'],
        body: {
          idempotency_key: `abandon-${randomUUID()}`,
          artifact_id: id,
          n: 2,
          reason: 'Replayed abandon',
        },
        flags: [],
      },
      {
        name: 'summary',
        verb: ['summary'],
        body: { idempotency_key: `sum-${randomUUID()}`, artifact_id: id, outcome: 'shipped' },
        flags: [],
      },
    ];
    for (const entry of cases) {
      if (entry.name === 'checkpoint abandon') {
        const opened = await run(f, ['checkpoint', 'open'], {
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: id,
          declared_step_ids: [step],
        });
        expect(opened.raw.exitCode, `${entry.name} setup: ${opened.raw.stdout}`).toBe(0);
      }
      const first = await run(f, entry.verb, entry.body, entry.flags ?? ['--no-llm']);
      expect(first.raw.exitCode, `${entry.name}: ${first.raw.stdout + first.raw.stderr}`).toBe(0);
      const before = inventory(f);
      const replay = await run(f, entry.verb, entry.body, entry.flags ?? ['--no-llm']);
      expect(replay.raw.exitCode, `${entry.name} replay: ${replay.raw.stdout}`).toBe(0);
      expect(replay.result.idempotency_status, entry.name).toBe('replay');
      expect(inventory(f), entry.name).toEqual(before);
    }
  });

  it('conflicts on a different payload under a known key without writing', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    const key = `revise-${randomUUID()}`;
    const body = (label: string) => ({
      idempotency_key: key,
      artifact_id: id,
      label,
      rationale: 'exercise the conflict',
      prior_plan_event_id: null,
      plan_steps: [
        {
          step_id: plan.plan_steps[0].step_id,
          text: 'Read retained evidence',
          label: 'Retained evidence',
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    const first = await run(f, ['plan', 'revise'], body('Original'));
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    const before = inventory(f);
    const conflict = await run(f, ['plan', 'revise'], body('A different label'));
    expect(conflict.raw.exitCode).toBe(1);
    expect(conflict.result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(inventory(f)).toEqual(before);
    expect(uuidv7()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
