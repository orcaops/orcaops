import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import {
  decode,
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../storage/tests/database-fixture.mjs';
import { runReview } from '../run.js';
import * as runtime from '../runtimeIdentity.js';
import { SEMANTIC_ANCHOR_PROFILE } from '../semanticAnchors.js';
import { readDatabaseReview } from './reviews.js';
import { type StartDatabaseReviewRun, startDatabaseReviewRun } from './runs.js';
import {
  formatSemanticCommandOutput,
  semanticCommandOutputSchema,
} from './semantic-command-output.js';
import { executeDatabaseSemanticCommand } from './semantic-command.js';
import * as publisher from './semantic-publish.js';

vi.mock('../runtimeIdentity.js', async (original) => ({ ...(await original<typeof runtime>()) }));
vi.mock('./semantic-publish.js', async (original) => ({ ...(await original<typeof publisher>()) }));
vi.mock('@orcaops/storage/history/database', async (original) => ({
  ...(await original<typeof store>()),
}));
const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureFile = path.join(
  candidate,
  'packages/storage/src/history/database/fixtures/semantic-review.json'
);
const active: RestoredFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of active.splice(0)) await f.cleanup();
});
async function fixture() {
  const f = await restoreFixture(candidate, fixtureFile);
  active.push(f);
  const saved = JSON.parse(await readFile(fixtureFile, 'utf8'));
  const original = decode(saved.semanticInput) as {
    reviewId: string;
    runId: string;
    submissionBytes: Uint8Array;
  };
  const context = {
    env: { ORCAOPS_DATA_DIR: f.authority.resolvedRoot, ORCAOPS_ROOT: f.temporary },
    cwd: f.temporary,
    runtime: {
      packageRoot: path.join(candidate, 'packages/review-engine'),
      entrypointPath: path.join(candidate, 'packages/review-engine/dist/run.js'),
    },
  };
  const argv = [
    'review',
    'semantic-anchor-submit',
    '--project',
    f.authority.projectId,
    '--review',
    original.reviewId,
    '--run',
    original.runId,
    '--profile',
    SEMANTIC_ANCHOR_PROFILE,
    '--input',
    '-',
    '--operation-id',
    uuidv7(),
  ];
  const execute = (args = argv, bytes = original.submissionBytes) =>
    executeDatabaseSemanticCommand(args, context, { preparedBytes: bytes });
  return { ...f, original, context, argv, execute, saved };
}
async function anotherRun(f: Awaited<ReturnType<typeof fixture>>) {
  const original = decode(
    f.saved.requests.find((entry: { kind: string }) => entry.kind === 'review.run.start').input
  ) as StartDatabaseReviewRun;
  const current = (
    await readDatabaseReview({ authority: f.authority, reviewId: f.original.reviewId })
  ).value!.selection;
  return startDatabaseReviewRun({
    ...original,
    authority: f.authority,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(original.runBytes).toString()),
        run_id: 'later-run',
      }) + '\n'
    ),
    expected: {
      ...original.expected,
      currentRunId: current.current_run_id,
      runSelectionVersion: current.run_selection_version,
    },
  });
}

describe('installed-store semantic command', () => {
  it('publishes actual READY input through the public verb without a legacy review directory', async () => {
    const f = await fixture();
    const file = path.join(f.temporary, 'submission.json');
    await writeFile(file, f.original.submissionBytes);
    const argv = [...f.argv, '--json'];
    argv[argv.indexOf('--input') + 1] = file;
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    expect(await runReview(argv, f.context.env, f.context.cwd, f.context.runtime)).toBe(0);
    const result = JSON.parse(output.join(''));
    expect(result).toMatchObject({
      schema_version: 3,
      status: 'VALID',
      accepted: true,
      replayed: false,
      run_id: 'retained-account-run',
      receipt: {
        scope: 'ORIGINAL_OPERATION',
        committed_counters: { writeSequence: 12, intentChangeCounter: 1 },
      },
      history: { status: 'AVAILABLE' },
    });
    expect(result).not.toHaveProperty('manifest_path');
    expect(semanticCommandOutputSchema.safeParse(result).success).toBe(true);
    expect(semanticCommandOutputSchema.safeParse({ ...result, status: 'PENDING' }).success).toBe(
      false
    );
    expect(result.history.model.relativePath).toContain(result.receipt.result.modelPublicationId);
  }, 20_000);
  it('replays only the original committed result after newer run selection and missing evidence', async () => {
    const f = await fixture();
    const first = await f.execute();
    await anotherRun(f);
    const afterNewRun = snapshot(f.Database, f.file);
    const observe = vi.spyOn(runtime, 'observeReviewExecutableIdentity');
    const publish = vi.spyOn(publisher, 'publishDatabaseSemanticGeneration');
    const opened = vi.spyOn(store, 'openProjectDatabase');
    const historical = await f.execute();
    expect(historical).toMatchObject({
      run_id: f.original.runId,
      generation_id: first.generation_id,
      replayed: true,
      ok: true,
      receipt: first.receipt,
      history: { status: 'AVAILABLE' },
    });
    if (historical.history.status !== 'AVAILABLE') throw new Error('Expected original history');
    expect(historical.history.observed_counters.writeSequence).toBeGreaterThan(
      first.receipt.committed_counters.writeSequence
    );
    expect(snapshot(f.Database, f.file)).toEqual(afterNewRun);
    expect(afterNewRun.rows.review_selections[0].current_run_id).toBe('later-run');
    await rm(path.join(path.dirname(f.file), 'evidence'), { recursive: true });
    const before = snapshot(f.Database, f.file);
    const replay = await f.execute();
    expect(replay).toMatchObject({
      accepted: true,
      status: 'VALID',
      replayed: true,
      ok: false,
      receipt: first.receipt,
      history: { status: 'UNAVAILABLE' },
    });
    expect(replay.history).toHaveProperty('code');
    expect(replay.history).toHaveProperty('recovery');
    expect(formatSemanticCommandOutput(replay)).toContain('original receipt replay');
    if (replay.history.status === 'UNAVAILABLE') {
      expect(formatSemanticCommandOutput(replay)).toContain(replay.history.code);
      expect(formatSemanticCommandOutput(replay)).toContain(replay.history.recovery);
    }
    expect(observe).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(opened.mock.calls.every(([request]) => request.mode === 'reader')).toBe(true);
    expect(snapshot(f.Database, f.file)).toEqual(before);
    expect(before.rows.review_selections[0].current_run_id).toBe('later-run');
  }, 20_000);
  it('compares original authored payload and exact selectors before committed replay', async () => {
    const f = await fixture();
    await f.execute();
    const before = snapshot(f.Database, f.file);
    const publish = vi.spyOn(publisher, 'publishDatabaseSemanticGeneration');
    await expect(f.execute(f.argv, Buffer.from('{}'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const changed = [...f.argv];
    changed[changed.indexOf('--run') + 1] = 'different-run';
    await expect(f.execute(changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(f.execute([...f.argv, '--generation', uuidv7()])).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(snapshot(f.Database, f.file)).toEqual(before);
  }, 20_000);
  it('admits one exact repair while keeping the original rejected receipt historical', async () => {
    const f = await fixture();
    const bytes = Buffer.from('not JSON');
    const first = await f.execute(f.argv, bytes);
    expect(first).toMatchObject({ status: 'PENDING', accepted: false, attempt: 1 });
    const repair = [...f.argv, '--generation', first.generation_id];
    repair[repair.indexOf('--operation-id') + 1] = uuidv7();
    const accepted = await f.execute(repair);
    expect(accepted).toMatchObject({
      status: 'VALID',
      accepted: true,
      attempt: 2,
      generation_id: first.generation_id,
    });
    const before = snapshot(f.Database, f.file);
    const replay = await f.execute(f.argv, bytes);
    expect(replay).toMatchObject({
      status: 'PENDING',
      accepted: false,
      attempt: 1,
      replayed: true,
      receipt: first.receipt,
    });
    expect(replay.history).toMatchObject({ status: 'AVAILABLE', model: null });
    repair[repair.indexOf('--operation-id') + 1] = uuidv7();
    await expect(f.execute(repair)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  }, 20_000);
  it('rejects a real run change during preparation without retargeting or a receipt', async () => {
    const f = await fixture();
    const observe = runtime.observeReviewExecutableIdentity;
    vi.spyOn(runtime, 'observeReviewExecutableIdentity').mockImplementationOnce(async (...args) => {
      await anotherRun(f);
      return observe(...args);
    });
    await expect(f.execute()).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    const rows = snapshot(f.Database, f.file).rows;
    expect(rows.operations.some((row) => row.operation_id === f.argv.at(-1))).toBe(false);
    expect(rows.review_selections[0].current_run_id).toBe('later-run');
    expect(rows.review_semantic_generations).toHaveLength(0);
  }, 20_000);
  it.each([false, true])(
    'adopts only matching committed winners for simultaneous first calls (different content: %s)',
    async (different) => {
      const f = await fixture();
      const actual = publisher.publishDatabaseSemanticGeneration;
      let count = 0;
      let releaseBoth!: () => void;
      const both = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      let releaseWinner!: () => void;
      const winnerCommitted = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      vi.spyOn(publisher, 'publishDatabaseSemanticGeneration').mockImplementation(
        async (request, options) => {
          const first = ++count === 1;
          if (count === 2) releaseBoth();
          await both;
          if (!first) await winnerCommitted;
          try {
            return await actual(request, options);
          } finally {
            if (first) releaseWinner();
          }
        }
      );
      const calls = await Promise.allSettled([
        f.execute(),
        f.execute(f.argv, different ? Buffer.from('not JSON') : f.original.submissionBytes),
      ]);
      expect(count).toBe(2);
      const success = calls.filter((entry) => entry.status === 'fulfilled');
      expect(success).toHaveLength(different ? 1 : 2);
      if (different) {
        const rejected = calls.find((entry) => entry.status === 'rejected');
        expect(rejected?.reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      } else {
        expect(success.map((entry) => entry.value.replayed).sort()).toEqual([false, true]);
        expect(success[0]!.value.receipt).toEqual(success[1]!.value.receipt);
        expect(success[0]!.value.generation_id).toBe(success[1]!.value.generation_id);
      }
      const rows = snapshot(f.Database, f.file).rows;
      expect(rows.operations.filter((row) => row.operation_id === f.argv.at(-1))).toHaveLength(1);
      expect(rows.review_semantic_attempts).toHaveLength(1);
    },
    20_000
  );
  it('reports missing exact attempt history separately from an intact original receipt', async () => {
    const f = await fixture();
    const first = await f.execute();
    const db = new f.Database(f.file);
    try {
      db.pragma('foreign_keys=OFF');
      const triggers = db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='review_semantic_attempts'"
        )
        .all() as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
      db.prepare('DELETE FROM review_semantic_attempts WHERE revision_id=?').run(
        first.attempt_revision_id
      );
      for (const trigger of triggers) db.exec(trigger.sql);
    } finally {
      db.close();
    }
    const before = snapshot(f.Database, f.file);
    const publish = vi.spyOn(publisher, 'publishDatabaseSemanticGeneration');
    const replay = await f.execute();
    expect(replay).toMatchObject({
      accepted: true,
      status: 'VALID',
      replayed: true,
      ok: false,
      receipt: first.receipt,
      history: { status: 'UNAVAILABLE', code: 'HISTORY_INTEGRITY_REQUIRED' },
    });
    expect(publish).not.toHaveBeenCalled();
    expect(snapshot(f.Database, f.file)).toEqual(before);
  }, 20_000);
  it('refuses assembled runtime metadata before evidence or a writable handle', async () => {
    const f = await fixture();
    const before = snapshot(f.Database, f.file);
    const observe = runtime.observeReviewExecutableIdentity;
    vi.spyOn(runtime, 'observeReviewExecutableIdentity').mockImplementationOnce(
      async (...args) => ({ ...(await observe(...args)), buildCommit: 'ghp_' + 'a'.repeat(36) })
    );
    const opened = vi.spyOn(store, 'openProjectDatabase');
    const evidence = vi.spyOn(store, 'publishProjectEvidence');
    await expect(f.execute()).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(opened.mock.calls.every(([request]) => request.mode === 'reader')).toBe(true);
    expect(evidence).not.toHaveBeenCalled();
    expect(snapshot(f.Database, f.file)).toEqual(before);
  }, 20_000);
  it('refuses secrets before any scope or writable preparation and preserves original cancellation', async () => {
    const f = await fixture();
    const before = snapshot(f.Database, f.file);
    const opened = vi.spyOn(store, 'openProjectDatabase');
    await expect(
      f.execute(f.argv, Buffer.from(JSON.stringify({ ignored: 'ghp_' + 'a'.repeat(36) })))
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(opened).not.toHaveBeenCalled();
    const signal = new AbortController();
    const opts = { signal: signal.signal, preparedBytes: f.original.submissionBytes };
    const pending = executeDatabaseSemanticCommand(f.argv, f.context, opts);
    opts.signal = new AbortController().signal;
    signal.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
});
