import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  readProjectArtifact,
  readProjectLifecycleCompletions,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A minimal coding-agent transcript, so the usage source has something real to read. */
async function writeTranscript(base: string, sessionId: string) {
  const dir = path.join(base, 'projects', 'proj');
  await mkdir(dir, { recursive: true });
  const line = (n: number) =>
    JSON.stringify({
      type: 'assistant',
      sessionId,
      requestId: `req-${n}`,
      uuid: `uuid-${n}`,
      isSidechain: false,
      timestamp: '2024-01-01T00:00:00.000Z',
      message: {
        id: `msg-${n}`,
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100 * n,
          output_tokens: 40 * n,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  await writeFile(path.join(dir, `${sessionId}.jsonl`), `${line(1)}\n${line(2)}\n`, 'utf8');
}

async function usageAgent(f: Fixture) {
  const sessionId = `sess-${randomUUID()}`;
  const configDir = path.join(f.temporary, 'claude-config');
  await writeTranscript(configDir, sessionId);
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CONFIG_DIR: configDir,
      CODEX_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}

describe('registered database evaluator passes', { timeout: 120_000 }, () => {
  it('re-runs a lifecycle, retains its runs and replaces the completion', async () => {
    const f = await fixture();
    const id = await f.capture();
    const agent = await usageAgent(f);
    const run = (body: Record<string, unknown>) =>
      agent.runRaw([
        'capture',
        'run-evaluators',
        '--no-llm',
        '--invoked-by-agent',
        'claude-code',
        '--input',
        inputFile(JSON.stringify(body)),
      ]);
    const first = await run({ artifact_id: id, fires_at: 'post-plan' });
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      artifact_id: id,
      fires_at: 'post-plan',
      blocking: false,
      lifecycle: { status: 'published' },
      cloud_sync: { status: 'skipped', reason: 'drain_disabled' },
    });
    // The fixture repository configures no evaluator pack, so the pass has no runs to
    // append; the completion receipt is published regardless, which is the point.
    expect(parsed.evaluator_results).toEqual([]);
    const completion = readProjectLifecycleCompletions(f.writer, id).records[0];
    expect(completion.record).toMatchObject({ fires_at: 'post-plan', cp_n: 0 });
    expect(completion.selection?.version).toBe(1);

    const second = await run({ artifact_id: id, fires_at: 'post-plan' });
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);
    // An explicit re-run retains a further observation rather than erasing the first.
    expect(readProjectLifecycleCompletions(f.writer, id).records[0].selection?.version).toBe(2);

    const unknown = await run({ artifact_id: uuidv7(), fires_at: 'post-plan' });
    expect(JSON.parse(unknown.stdout).error.code).toBe('UNKNOWN_ARTIFACT');
    const missingN = await run({ artifact_id: id, fires_at: 'checkpoint-close' });
    expect(JSON.parse(missingN.stdout).error).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'checkpoint_n',
    });
  });

  it('refuses a pre-PR pass under an open checkpoint, then marks it and stamps usage each time', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    const agent = await usageAgent(f);
    // An explicit empty payload: the in-process harness has no stdin for the bare form.
    const check = () =>
      agent.runRaw([
        'capture',
        'pre-pr-check',
        '--no-llm',
        '--invoked-by-agent',
        'claude-code',
        '--input',
        inputFile('{}'),
      ]);
    await f.mutate(id, { open: true }, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      )
    );
    const blocked = await check();
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout).error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(JSON.parse(blocked.stdout).error.message).toMatch(/open checkpoint/i);
    expect(readProjectLifecycleCompletions(f.writer, id).records).toEqual([]);
    expect(readProjectUsage(f.writer)).toBeNull();

    await f.mutate(id, { abandon: true }, (semantics) =>
      semantics.writeCheckpointAbandoned(
        { artifact_id: id, n: 1, reason: 'released for the pre-PR pass' },
        { idempotencyKey: uuidv7() }
      )
    );
    const passed = await check();
    expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0);
    const first = JSON.parse(passed.stdout);
    expect(first).toMatchObject({
      artifact_id: id,
      blocking: false,
      pre_pr_outcome: 'passed',
      usage: { state: 'committed' },
    });
    expect(first.review_id).toMatch(/^[0-9a-f-]{36}$/);
    const marked = readProjectArtifact(f.writer, id)!;
    expect(
      marked.thread.events.filter((event) => event.record.type === 'pre_pr_checked').length
    ).toBe(1);
    expect(readProjectLifecycleCompletions(f.writer, id).records[0].record).toMatchObject({
      fires_at: 'pre-pr',
      cp_n: 0,
    });
    expect(readProjectUsage(f.writer)!.events.length).toBe(1);

    const again = await check();
    expect(again.exitCode, again.stdout + again.stderr).toBe(0);
    const second = JSON.parse(again.stdout);
    expect(second.review_id).not.toBe(first.review_id);
    expect(second.usage.state).toBe('committed');
    // A fresh discriminator per invocation, so a repeated pass never freezes usage.
    expect(readProjectUsage(f.writer)!.events.length).toBe(2);
  });
});
