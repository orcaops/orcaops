import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SummaryAlreadyCapturedError } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { finish as runFinishInProcess } from '../../src/commands/finish.js';
import * as databaseDigest from '../../src/lib/database-digest.js';
import * as existingCapture from '../../src/lib/database-existing-capture.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, grantEvaluatorPack, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops finish` on the project database. It is the pre-PR pass and the summary in
 * one invocation, so what these prove is the seam between them: the pass pauses before
 * anything is summarized, an acceptance names the marker it was offered against, and a
 * summary only lands once the pass has let it through.
 *
 * Ported by meaning from the file-authority `tests/integration/finish-pause.test.ts`,
 * whose fixture was `orcaops init` plus a file-authority capture.
 */
const TEST_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-pack'
);
type Fixture = Awaited<ReturnType<typeof fixture>>;

function finishEnv(f: Fixture) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'finish-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
  };
}
function agent(f: Fixture) {
  return makeAgent({ cwd: f.main, timeoutMs: 120_000, env: finishEnv(f) });
}

afterEach(() => vi.restoreAllMocks());

const summaryBody = (extra: Record<string, unknown> = {}) => ({
  idempotency_key: `finish-${randomUUID()}`,
  outcome: 'the work is done',
  tests_written: [],
  tests_run: [],
  open_items: [],
  deferred_decisions: [],
  ...extra,
});

async function finish(f: Fixture, body: Record<string, unknown>) {
  const raw = await agent(f).runRaw([
    'finish',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}

const summaryOf = (f: Fixture, id: string) => readProjectArtifact(f.writer, id)!.thread.summary;

describe('registered database finish', { timeout: 180_000 }, () => {
  it('pauses on a pre-PR warning, then summarizes once the warning is accepted', async () => {
    const f = await fixture();
    const id = await f.capture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/pre-pr-warn-stub': true },
    });

    const paused = await finish(f, summaryBody());
    expect(paused.raw.exitCode, paused.raw.stdout + paused.raw.stderr).toBe(0);
    expect(paused.result).toMatchObject({
      ok: true,
      artifact_id: id,
      status: 'needs_attention',
      acceptance_allowed: true,
    });
    const reviewId = paused.result.review_id as string;
    expect(reviewId).toBeTruthy();
    // The pause carries no finalization: no summary event, no digest, no completed_at.
    for (const key of ['summary_event_id', 'finalization_status', 'digest', 'completed_at'])
      expect(paused.result, key).not.toHaveProperty(key);
    // And nothing is summarized while a warning stands.
    expect(summaryOf(f, id)).toBeNull();

    const accepted = await finish(
      f,
      summaryBody({
        accepted_warnings: (paused.result.accepted_warnings as Record<string, unknown>[]).map(
          (warning) => ({ ...warning, reason: 'reviewed and accepted' })
        ),
      })
    );
    expect(accepted.raw.exitCode, accepted.raw.stdout + accepted.raw.stderr).toBe(0);
    expect(accepted.result).toMatchObject({
      ok: true,
      artifact_id: id,
      review_id: reviewId,
      idempotency_status: 'created',
      capture_status: 'committed',
    });
    expect(summaryOf(f, id)?.outcome).toBe('the work is done');
  });

  it('refuses an acceptance that names no live review', async () => {
    const f = await fixture();
    const id = await f.capture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/pre-pr-warn-stub': true },
    });
    const paused = await finish(f, summaryBody());
    expect(paused.result.status).toBe('needs_attention');

    const stale = await finish(
      f,
      summaryBody({
        accepted_warnings: (paused.result.accepted_warnings as Record<string, unknown>[]).map(
          (warning) => ({
            ...warning,
            review_id: '01999999-9999-7000-8000-0000000000ff',
            reason: 'forged',
          })
        ),
      })
    );
    expect(stale.result.ok).toBe(false);
    expect(stale.result.error.code).toBe('INVALID_INPUT');
    expect(stale.result.error.message).toMatch(/missing or stale/u);
    expect(summaryOf(f, id)).toBeNull();
  });

  it('stops at a blocking pre-PR evaluator without summarizing', async () => {
    const f = await fixture();
    const id = await f.capture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/strict-stub': true },
    });
    const blocked = await finish(f, summaryBody());
    expect(blocked.raw.exitCode, blocked.raw.stdout + blocked.raw.stderr).toBe(0);
    expect(blocked.result).toMatchObject({ artifact_id: id, status: 'blocked', blocking: true });
    for (const key of ['summary_event_id', 'finalization_status', 'digest', 'completed_at'])
      expect(blocked.result, key).not.toHaveProperty(key);
    expect(summaryOf(f, id)).toBeNull();
  });

  it('refuses while a checkpoint is open, naming it, and never records the pass', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    const opened = await agent(f).runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `cp-${randomUUID()}`,
          artifact_id: id,
          declared_step_ids: [plan.plan_steps[0]!.step_id],
        })
      ),
    ]);
    expect(opened.exitCode, opened.stdout + opened.stderr).toBe(0);

    const refused = await finish(f, summaryBody());
    expect(refused.result.ok).toBe(false);
    expect(refused.result.error.code).toBe('INVALID_INPUT');
    expect(refused.result.error.message).toMatch(/Cannot run finish while 1 open checkpoint/u);
    expect(summaryOf(f, id)).toBeNull();
  });

  it('replays a repeated finish by its idempotency key instead of summarizing twice', async () => {
    const f = await fixture();
    const id = await f.capture();
    // The replay names the artifact: once the first finish summarizes it, it is no
    // longer the branch's active artifact, so a bare re-run has nothing to auto-select.
    const body = summaryBody({ artifact_id: id });
    const first = await finish(f, body);
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    expect(first.result.idempotency_status).toBe('created');

    const replay = await finish(f, body);
    expect(replay.raw.exitCode, replay.raw.stdout + replay.raw.stderr).toBe(0);
    expect(replay.result).toMatchObject({
      artifact_id: id,
      idempotency_status: 'replay',
      completed_at: first.result.completed_at,
      usage: { state: 'skipped', reason: 'replay' },
    });
    // Only one summary exists, and it is the first — the replay wrote nothing.
    expect(summaryOf(f, id)?.outcome).toBe('the work is done');

    // A finish with a fresh key over the already-summarized artifact is the
    // summary's own already-captured refusal, not a second summary.
    const bare = await finish(f, summaryBody({ artifact_id: id, outcome: 'again' }));
    expect(bare.result.ok).toBe(false);
    expect(bare.result.error.code).toBe('SUMMARY_ALREADY_CAPTURED');
    expect(summaryOf(f, id)?.outcome).toBe('the work is done');
  });

  it('leaves the whole authoritative inventory unchanged when a finish replays', async () => {
    const f = await fixture();
    const id = await f.capture();
    const body = summaryBody({ artifact_id: id });
    const first = await finish(f, body);
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    expect(first.result.idempotency_status).toBe('created');

    const before = await inventory(f.root);
    const replay = await finish(f, body);
    expect(replay.raw.exitCode, replay.raw.stdout + replay.raw.stderr).toBe(0);
    expect(replay.result).toMatchObject({
      artifact_id: id,
      idempotency_status: 'replay',
      completed_at: first.result.completed_at,
      // A replay writes nothing — no focus row, no usage row...
      focus: { state: 'skipped', reason: 'replay' },
      usage: { state: 'skipped', reason: 'replay' },
      // ...but the digest render is a pure read, so a replay still renders it.
      finalization_status: 'finalized',
      digest: { status: 'current', artifact_id: id },
    });
    // The digest render on replay moved no operation, counter, focus or usage row.
    expect(await inventory(f.root)).toEqual(before);
  });

  it('renders the completed artifact digest through the same path as `orcaops digest`', async () => {
    const f = await fixture();
    const id = await f.capture();
    const done = await finish(f, summaryBody({ artifact_id: id }));
    expect(done.raw.exitCode, done.raw.stdout + done.raw.stderr).toBe(0);
    expect(done.result).toMatchObject({
      finalization_status: 'finalized',
      digest: { status: 'current', artifact_id: id },
    });
    expect(done.result.digest.markdown).toContain(`# digest — \`main\` / \`${id}\``);
    const standalone = await agent(f).runRaw(['digest', '--artifact', id, '--json']);
    expect(standalone.exitCode, standalone.stdout + standalone.stderr).toBe(0);
    expect((JSON.parse(standalone.stdout) as { markdown: string }).markdown).toBe(
      done.result.digest.markdown
    );
  });

  it('keeps the committed summary when the digest render fails', async () => {
    const f = await fixture();
    const id = await f.capture();
    vi.spyOn(databaseDigest, 'renderDatabaseArtifactDigest').mockRejectedValue(
      new Error('digest render failed for test')
    );

    const controller = new AbortController();
    const result = (await runInInvocationContext({ cwd: f.main, env: finishEnv(f) }, () =>
      runFinishInProcess(
        { noLlm: true, input: inputFile(JSON.stringify(summaryBody({ artifact_id: id }))) },
        controller.signal
      )
    )) as Record<string, unknown>;

    // A digest render that throws degrades to a repair pointer; it never undoes the write.
    expect(result).toMatchObject({
      artifact_id: id,
      idempotency_status: 'created',
      capture_status: 'committed',
      finalization_status: 'finalized_without_digest',
      digest: { status: 'failed', action: `orcaops digest --artifact ${id}` },
    });
    expect(summaryOf(f, id)?.outcome).toBe('the work is done');
  });

  it('refuses rather than summarizing an artifact overtaken between the checks and the summary', async () => {
    const f = await fixture();
    const checked = await f.capture();
    let overtaking: string | null = null;
    const real = existingCapture.captureDatabaseExisting;
    // Between the pre-PR checks and the summary write, another worker completes the
    // checked artifact and starts a fresh one — the branch's single active artifact is
    // now a DIFFERENT id. The summary must still land on the checked artifact.
    vi.spyOn(existingCapture, 'captureDatabaseExisting').mockImplementation(
      async (kind, prepared, signal, preselectedArtifactId) => {
        if (overtaking === null) {
          await f.mutate(checked, { outcome: 'overtaken' }, (semantics) =>
            semantics.writeSummary({
              schema_version: 1,
              artifact_id: checked,
              outcome: 'overtaken',
              tests_written: [],
              tests_run: [],
              open_items: [],
              deferred_decisions: [],
              head_sha: f.context.headOid!,
              ts: '2026-09-06T00:00:00.000Z',
            })
          );
          overtaking = await f.capture();
        }
        return real(kind, prepared, signal, preselectedArtifactId);
      }
    );

    const controller = new AbortController();
    const error = await runInInvocationContext({ cwd: f.main, env: finishEnv(f) }, () =>
      runFinishInProcess(
        { noLlm: true, input: inputFile(JSON.stringify(summaryBody())) },
        controller.signal
      )
    ).then(
      () => null,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(SummaryAlreadyCapturedError);
    // The overtaking artifact was never summarized, and the checked artifact keeps the
    // concurrent worker's summary — finish did not clobber either.
    expect(summaryOf(f, overtaking!)).toBeNull();
    expect(summaryOf(f, checked)?.outcome).toBe('overtaken');
  });
});
