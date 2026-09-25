import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  findProjectEvaluatorFindingRecurrence,
  readProjectArtifact,
  readProjectEvaluatorRunFindings,
  readProjectLifecycleCompletions,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import type { TrustCapability } from '../../src/lib/evaluator-grants.js';
import { fixture, grantEvaluatorPack } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const TEST_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-pack'
);
const CORE_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/evaluator-pack/dist/packs/core'
);
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

  it('retains what a producer found beside the run the pass appended', async () => {
    const f = await fixture();
    const id = await f.capture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/pass-fixture': true },
    });
    const agent = await usageAgent(f);
    const raw = await agent.runRaw([
      'capture',
      'run-evaluators',
      '--no-llm',
      '--invoked-by-agent',
      'claude-code',
      '--input',
      inputFile(JSON.stringify({ artifact_id: id, fires_at: 'post-plan' })),
    ]);
    expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    const parsed = JSON.parse(raw.stdout);
    // The count is the only thing the response gains, and no finding text is in it.
    expect(parsed.findings_retained).toBe(2);
    expect(raw.stdout).not.toContain('The captured plan states every step');

    const run = parsed.evaluator_results.find(
      (entry: { evaluator_ref: string }) => entry.evaluator_ref === 'test-pack/pass-fixture'
    );
    const retained = readProjectEvaluatorRunFindings(f.writer, run.run_id);
    expect(retained.status).toBe('established');
    if (retained.status !== 'established') throw new Error(retained.status);
    expect(retained.findings.map((finding) => finding.key)).toEqual(['fixture/plan-covered', null]);
    expect(retained.findings[0]!.title).toBe(
      'The captured plan states every step the fixture expects'
    );
    expect(retained.basis).toMatchObject({
      artifactId: id,
      evaluatorRef: 'test-pack/pass-fixture',
      evaluatorVersion: null,
      producerPayload: null,
    });
    expect(
      findProjectEvaluatorFindingRecurrence(f.writer, {
        artifactId: id,
        evaluatorRef: 'test-pack/pass-fixture',
        key: 'fixture/plan-covered',
      }).map((finding) => finding.runId)
    ).toEqual([run.run_id]);
  });

  it.each([
    ['a pack granted without the capability it needs', ['command_evaluators_present']],
    [
      'a filter this plan does not satisfy',
      ['command_evaluators_present', 'llm_evaluators_present'],
    ],
  ] as [string, TrustCapability[]][])(
    'retains nothing for a run whose producer was never asked: %s',
    async (_case, capabilities) => {
      const f = await fixture();
      const id = await f.capture();
      // `core/sensitive-scope-flag` is an LLM evaluator behind a scope filter the fixture plan does
      // not satisfy, so it is refused by consent under the narrower grant and skipped by its filter
      // under the wider one. Neither ever reaches a producer.
      await grantEvaluatorPack(f, {
        packageId: 'core',
        packRoot: CORE_PACK,
        enable: { 'core/sensitive-scope-flag': true },
        capabilities,
      });
      const agent = await usageAgent(f);
      const raw = await agent.runRaw([
        'capture',
        'run-evaluators',
        '--no-llm',
        '--invoked-by-agent',
        'claude-code',
        '--input',
        inputFile(JSON.stringify({ artifact_id: id, fires_at: 'post-plan' })),
      ]);
      expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
      const parsed = JSON.parse(raw.stdout);
      expect(parsed.findings_retained).toBeUndefined();

      const unasked = parsed.evaluator_results.find(
        (entry: { evaluator_ref: string }) => entry.evaluator_ref === 'core/sensitive-scope-flag'
      );
      expect(
        unasked.run_status === 'skipped' || unasked.error?.code === 'CONSENT_DENIED',
        JSON.stringify(unasked)
      ).toBe(true);
      // Nothing ran, so there is no basis to name and nothing was handed over: the run reads as
      // one nothing was retained for, and its own run status keeps saying why.
      expect(readProjectEvaluatorRunFindings(f.writer, unasked.run_id)).toEqual({
        status: 'not-retained',
      });
    }
  );
});
