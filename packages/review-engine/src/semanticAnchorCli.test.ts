import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { readDatabaseReview } from './database/reviews.js';
import { readDatabaseReviewFinalization } from './database/run-finalization-read.js';
import { prepareDatabaseReviewRunInputs } from './database/run-inputs.js';
import { type StartDatabaseReviewRun, startDatabaseReviewRun } from './database/runs.js';
import { executeDatabaseSemanticCommand } from './database/semantic-command.js';
import { prepareDatabaseSemanticGeneration } from './database/semantic-preparation.js';
import { readDatabaseSemanticGeneration } from './database/semantic-read.js';
import { runReview } from './run.js';
import { SEMANTIC_ANCHOR_PROFILE } from './semanticAnchors.js';
import { canonicalJsonSha256 } from './submissionNormalization.js';
import {
  decode,
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../storage/tests/database-fixture.mjs';

vi.mock('@orcaops/storage/history/database', async (original) => ({
  ...(await original<typeof store>()),
}));
const candidate = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureFile = path.join(
  candidate,
  'packages/storage/src/history/database/fixtures/semantic-review.json'
);
const active: RestoredFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of active.splice(0)) await f.cleanup();
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const f = await restoreFixture(candidate, fixtureFile);
  active.push(f);
  const saved = JSON.parse(await readFile(fixtureFile, 'utf8')) as {
    semanticInput: unknown;
    requests: { kind: string; input: unknown }[];
    evidence: { relativePath: string }[];
  };
  const original = decode(saved.semanticInput) as { reviewId: string; runId: string };
  const context = {
    cwd: f.temporary,
    env: { ORCAOPS_DATA_DIR: f.authority.resolvedRoot, ORCAOPS_ROOT: f.temporary },
    runtime: {
      packageRoot: path.join(candidate, 'packages/review-engine'),
      entrypointPath: path.join(candidate, 'packages/review-engine/dist/run.js'),
    },
  };
  const target = { authority: f.authority, reviewId: original.reviewId, runId: original.runId };
  const final = (await readDatabaseReviewFinalization(target)).value!;
  const prepared = await prepareDatabaseSemanticGeneration({
    ...target,
    generationId: uuidv7(),
    expected: {
      revisionId: final.revisionId,
      version: final.version,
      runSelectionVersion: final.selection.run_selection_version,
    },
    submissionBytes: bytes({ schema_version: 3, dispositions: [] }),
    secretAllow: [],
  });
  expect(prepared.catalog.items).toHaveLength(1);
  expect(prepared.catalog.blocks).toHaveLength(1);
  const block = prepared.catalog.blocks[0]!;
  const range = (rows: typeof block.add) =>
    rows.length ? { start: rows[0]!.ref, end: rows.at(-1)!.ref } : null;
  const valid = {
    schema_version: 3,
    dispositions: [
      {
        item: prepared.catalog.items[0]!.alias,
        disposition: 'ANCHORED',
        targets: [
          {
            block: block.alias,
            scope: 'FOCUS',
            focus: { delete: range(block.delete), add: range(block.add) },
          },
        ],
      },
    ],
  };
  const invalid = {
    schema_version: 3,
    dispositions: [
      {
        item: 'i99999',
        disposition: 'ASSESSED_UNANCHORED',
        targets: [],
      },
    ],
  };
  const argv = (operationId = uuidv7(), generationId?: string) => [
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
    operationId,
    ...(generationId ? ['--generation', generationId] : []),
  ];
  const execute = (value: Uint8Array = bytes(valid), args = argv(), options = {}) =>
    executeDatabaseSemanticCommand(args, context, { ...options, preparedBytes: value });
  const read = (generationId?: string) =>
    readDatabaseSemanticGeneration({ ...target, ...(generationId ? { generationId } : {}) });
  const publicSubmit = async (value: Uint8Array, args = argv()) => {
    const file = path.join(f.temporary, 'submission.json');
    await writeFile(file, value);
    const selected = [...args, '--json'];
    selected[selected.indexOf('--input') + 1] = file;
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    try {
      const code = await runReview(selected, context.env, context.cwd, context.runtime);
      return { code, result: JSON.parse(output.join('')) };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  };
  return {
    ...f,
    saved,
    original,
    prepared,
    block,
    valid,
    invalid,
    target,
    argv,
    execute,
    read,
    publicSubmit,
  };
}

describe('semantic submission through canonical review history', () => {
  it.each([false, true])(
    'retains exact submission lineage and resolved focus (wrapped: %s)',
    async (wrapped) => {
      const f = await fixture();
      const raw = bytes(wrapped ? JSON.stringify(f.valid) : f.valid);
      const { code, result } = await f.publicSubmit(raw);
      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: 'VALID',
        accepted: true,
        attempt: 1,
        run_id: 'retained-account-run',
        history: { status: 'AVAILABLE', warnings: [] },
      });
      const value = (await f.read(result.generation_id)).value!;
      const event = value.attempts[0]!.event;
      expect(event).toMatchObject({
        schema_version: 3,
        profile_source: 'CALLER_DECLARED',
        declared_profile: SEMANTIC_ANCHOR_PROFILE,
        normalization: wrapped ? 'JSON_STRING_UNWRAPPED' : 'CLEAN_JSON',
        raw_submission_sha256: sha256(raw),
        normalized_submission_sha256: canonicalJsonSha256(f.valid),
        normalized_submission: f.valid,
        accepted: true,
      });
      expect(event).not.toHaveProperty('raw_submission');
      expect(event.runtime_identity).not.toBeNull();
      expect(value.attempts[0]!.operation.payload).not.toHaveProperty('normalized_submission');
      expect(value.attempts[0]!.operation.payload).not.toHaveProperty('submissionBytes');
      const item = value.model!.value.items[0]!;
      expect(item.disposition).toBe('ANCHORED');
      if (item.disposition !== 'ANCHORED') throw new Error('Expected anchored retained item');
      expect(item.targets[0]).toMatchObject({
        block: {
          block_key: f.block.block_key,
          old_file: f.block.old_file,
          new_file: f.block.new_file,
        },
        scope: 'FOCUS',
        focus_status: 'ACCEPTED',
        focus_diagnostic_code: null,
      });
      for (const side of ['add', 'delete'] as const) {
        const rows = f.block[side];
        expect(item.targets[0]!.focus![side]).toEqual(
          rows.length
            ? {
                start_line: rows[0]!.line,
                end_line: rows.at(-1)!.line,
                line_hashes: rows.map((row) => row.line_hash),
              }
            : null
        );
      }
    }
  );
  it('retains omitted items without inventing an assessed disposition', async () => {
    const f = await fixture();
    const result = await f.execute(bytes({ schema_version: 3, dispositions: [] }));
    const value = (await f.read(result.generation_id)).value!;
    expect(value.model!.value.items).toHaveLength(1);
    expect(value.model!.value.items[0]).toMatchObject({ disposition: 'NO_ANCHOR_PROPOSED' });
    expect(value.attempts[0]!.event.normalized_submission).toEqual({
      schema_version: 3,
      dispositions: [],
    });
  });
  it('rejects recursive wrapping and preserves the previous accepted selection', async () => {
    const f = await fixture();
    const previous = await f.execute();
    const { code, result } = await f.publicSubmit(bytes(JSON.stringify(JSON.stringify(f.valid))));
    expect(code).toBe(1);
    expect(result).toMatchObject({ accepted: false, status: 'PENDING', attempt: 1 });
    const rejected = (await f.read(result.generation_id)).value!;
    expect(rejected.attempts[0]!.event).toMatchObject({
      normalization: 'JSON_STRING_UNWRAPPED',
      accepted: false,
    });
    expect(rejected.attempts[0]!.event.diagnostics.length).toBeGreaterThan(0);
    expect(rejected.terminal).toBeNull();
    expect((await f.read()).value!.generationId).toBe(previous.generation_id);
  });
  it('drops invalid focus geometry without losing the accepted block or granting repair', async () => {
    const f = await fixture();
    const invalidFocus = structuredClone(f.valid);
    invalidFocus.dispositions[0]!.targets[0]!.focus.add = { start: 'A99999', end: 'A99999' };
    const { code, result } = await f.publicSubmit(bytes(invalidFocus));
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'VALID', attempt: 1, accepted: true });
    const value = (await f.read(result.generation_id)).value!;
    expect(value.attempts[0]!.event.has_focus_warnings).toBe(true);
    const item = value.model!.value.items[0]!;
    if (item.disposition !== 'ANCHORED') throw new Error('Expected retained block association');
    expect(item.targets[0]).toMatchObject({
      block: { block_key: f.block.block_key },
      focus: null,
      focus_status: 'REJECTED_INVALID',
    });
    await expect(
      f.execute(bytes(f.valid), f.argv(uuidv7(), result.generation_id))
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  });
  it.each([false, true])(
    'settles one repair while preserving prior selection on rejection (valid: %s)',
    async (valid) => {
      const f = await fixture();
      const previous = await f.execute();
      const pending = await f.execute(bytes(f.invalid));
      expect(pending).toMatchObject({ status: 'PENDING', accepted: false });
      expect((await f.read()).value!.generationId).toBe(previous.generation_id);
      const { code, result } = await f.publicSubmit(
        bytes(valid ? f.valid : f.invalid),
        f.argv(uuidv7(), pending.generation_id)
      );
      expect(code).toBe(valid ? 0 : 1);
      expect(result).toMatchObject({ status: valid ? 'VALID' : 'REJECTED', attempt: 2 });
      const value = (await f.read(result.generation_id)).value!;
      expect(value.attempts).toHaveLength(2);
      expect(value.terminal!.manifest.status).toBe(valid ? 'VALID' : 'REJECTED');
      expect((await f.read()).value!.generationId).toBe(
        valid ? result.generation_id : previous.generation_id
      );
      const before = snapshot(f.Database, f.file);
      await expect(
        f.execute(bytes(f.valid), f.argv(uuidv7(), result.generation_id))
      ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
      expect(snapshot(f.Database, f.file)).toEqual(before);
    }
  );
  it('waits for the actual writer, cancels without settlement and retries the original identity', async () => {
    const f = await fixture();
    const args = f.argv();
    const before = snapshot(f.Database, f.file);
    const blocker = new f.Database(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const controller = new AbortController();
    const waits: store.ProjectWait[] = [];
    try {
      await expect(
        f.execute(bytes(f.valid), args, {
          signal: controller.signal,
          onWait(wait: store.ProjectWait) {
            waits.push(wait);
            controller.abort();
          },
        })
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(waits.length).toBeGreaterThan(0);
      expect(snapshot(f.Database, f.file)).toEqual(before);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    const result = await f.execute(bytes(f.valid), args);
    expect(result).toMatchObject({ status: 'VALID', replayed: false, operation_id: args.at(-1) });
  });
  it.each(['review_semantic_attempts', 'review_semantic_terminals', 'review_semantic_current'])(
    'rolls back a late %s failure and retries only once',
    async (table) => {
      const f = await fixture();
      const previous = await f.execute();
      const before = snapshot(f.Database, f.file);
      const args = f.argv();
      const original = f.Database.prototype.prepare;
      let triggered = false;
      const spy = vi.spyOn(f.Database.prototype, 'prepare').mockImplementation(function (
        this: InstanceType<typeof f.Database>,
        sql: string
      ) {
        if (/^(INSERT INTO|UPDATE)/.test(sql) && sql.includes(table)) {
          triggered = true;
          throw new f.Database.SqliteError('Injected full storage', 'SQLITE_FULL');
        }
        return original.call(this, sql);
      });
      await expect(f.execute(bytes(f.valid), args)).rejects.toMatchObject({
        code: 'TRANSACTION_FAILED',
      });
      spy.mockRestore();
      expect(triggered).toBe(true);
      expect(snapshot(f.Database, f.file)).toEqual(before);
      expect((await f.read()).value!.generationId).toBe(previous.generation_id);
      const result = await f.execute(bytes(f.valid), args);
      expect(result.status).toBe('VALID');
      expect((await f.execute(bytes(f.valid), args)).receipt).toEqual(result.receipt);
      expect(snapshot(f.Database, f.file).rows.operations.length).toBe(
        before.rows.operations.length + 1
      );
    }
  );
  it('preserves rejected repair history and prior selection across required model evidence failure', async () => {
    const f = await fixture();
    const previous = await f.execute();
    const pending = await f.execute(bytes(f.invalid));
    const before = snapshot(f.Database, f.file);
    const args = f.argv(uuidv7(), pending.generation_id);
    const publish = vi
      .spyOn(store, 'publishProjectEvidence')
      .mockRejectedValueOnce(
        new store.ProjectDatabaseError(
          'TRANSACTION_FAILED',
          'Injected required model evidence failure'
        )
      );
    await expect(f.execute(bytes(f.valid), args)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
    });
    expect(publish).toHaveBeenCalledOnce();
    publish.mockRestore();
    expect(snapshot(f.Database, f.file)).toEqual(before);
    expect((await f.read(pending.generation_id)).value!.attempts).toHaveLength(1);
    expect((await f.read()).value!.generationId).toBe(previous.generation_id);
    const result = await f.execute(bytes(f.valid), args);
    expect(result).toMatchObject({ status: 'VALID', attempt: 2 });
    expect((await f.execute(bytes(f.valid), args)).receipt).toEqual(result.receipt);
  });
  it.each([
    'diff.patch',
    'forensic-input-v1.json',
    'semantic-anchor-input-v4.json',
    'story-review-model-v4.json',
  ])('refuses damaged immutable %s before opening a writer', async (name) => {
    const f = await fixture();
    const member = [...f.saved.evidence]
      .reverse()
      .find((entry: { relativePath: string }) => entry.relativePath.endsWith('/' + name));
    expect(member, name).toBeDefined();
    if (!member) throw new Error('Required retained fixture member is missing');
    const file = path.join(path.dirname(f.file), 'evidence', member.relativePath);
    const retained = await readFile(file);
    await writeFile(file, Buffer.concat([retained, Buffer.from(' ')]));
    const before = snapshot(f.Database, f.file);
    const writer = vi.spyOn(store, 'openProjectDatabase');
    await expect(f.execute()).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
  it('refuses an actual unfinalized current run without adding semantic history', async () => {
    const f = await fixture();
    const original = decode(
      f.saved.requests.find((entry) => entry.kind === 'review.run.start')!.input
    ) as StartDatabaseReviewRun;
    const selected = (
      await readDatabaseReview({ authority: f.authority, reviewId: f.original.reviewId })
    ).value!.selection;
    // A new run prepares its own inputs from the retained floor, as the command does; the
    // recorded run's pinned inputs predate the knowledge the projection now carries.
    const run = JSON.parse(Buffer.from(original.runBytes).toString()) as {
      created_at: string;
    };
    const {
      currentRunId: _run,
      runSelectionVersion: _version,
      ...floorExpected
    } = original.expected;
    const fresh = await prepareDatabaseReviewRunInputs({
      authority: f.authority,
      reviewId: original.reviewId,
      expected: floorExpected,
      policy: original.policy,
      generatedAt: run.created_at,
      secretAllow: original.secretAllow,
    });
    await startDatabaseReviewRun({
      ...original,
      authority: f.authority,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      publicationId: uuidv7(),
      runBytes: bytes({ ...run, run_id: 'unfinalized-run', input_shas: fresh.inputShas }),
      inputs: fresh.members,
      expected: {
        ...original.expected,
        currentRunId: selected.current_run_id,
        runSelectionVersion: selected.run_selection_version,
      },
    });
    const args = f.argv();
    args[args.indexOf('--run') + 1] = 'unfinalized-run';
    const before = snapshot(f.Database, f.file);
    const writer = vi.spyOn(store, 'openProjectDatabase');
    await expect(f.execute(bytes(f.valid), args)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
  it('reports retained source corruption after acceptance without rewriting the original receipt', async () => {
    const f = await fixture();
    const originalArgs = f.argv();
    const accepted = await f.execute(bytes(f.valid), originalArgs);
    const member = f.saved.evidence.find((entry) =>
      entry.relativePath.endsWith('/forensic-input-v1.json')
    )!;
    const file = path.join(path.dirname(f.file), 'evidence', member.relativePath);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(' ')]));
    const before = snapshot(f.Database, f.file);
    const writer = vi.spyOn(store, 'openProjectDatabase');
    await expect(f.read(accepted.generation_id)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    const replay = await f.execute(bytes(f.valid), originalArgs);
    expect(replay).toMatchObject({
      replayed: true,
      receipt: accepted.receipt,
      history: { status: 'UNAVAILABLE', code: 'HISTORY_INTEGRITY_REQUIRED' },
    });
    expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
  it.each(['historical-semantic-input', 'different-run'])(
    'refuses a damaged terminal record (%s)',
    async (damage) => {
      const f = await fixture();
      const originalArgs = f.argv();
      const accepted = await f.execute(bytes(f.valid), originalArgs);
      const db = new f.Database(f.file);
      try {
        const trigger = db
          .prepare("SELECT sql FROM sqlite_schema WHERE name='review_run_finalizations_no_update'")
          .get() as { sql: string };
        const row = db
          .prepare('SELECT record_bytes FROM review_run_finalizations WHERE run_id=?')
          .get(f.original.runId) as { record_bytes: Buffer };
        const value = JSON.parse(row.record_bytes.toString());
        if (damage === 'historical-semantic-input') value.semantic_anchor_input.schema_version = 3;
        else value.run_id = 'different-terminal-run';
        const modified = bytes(value);
        db.exec('DROP TRIGGER review_run_finalizations_no_update');
        db.prepare(
          'UPDATE review_run_finalizations SET record_bytes=?,record_hash=? WHERE run_id=?'
        ).run(modified, sha256(modified), f.original.runId);
        db.exec(trigger.sql);
      } finally {
        db.close();
      }
      const before = snapshot(f.Database, f.file);
      const writer = vi.spyOn(store, 'openProjectDatabase');
      await expect(f.execute()).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
      expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
      expect(snapshot(f.Database, f.file)).toEqual(before);
      const replay = await f.execute(bytes(f.valid), originalArgs);
      expect(replay).toMatchObject({
        replayed: true,
        receipt: accepted.receipt,
        history: { status: 'UNAVAILABLE', code: 'HISTORY_INTEGRITY_REQUIRED' },
      });
      expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
      expect(snapshot(f.Database, f.file)).toEqual(before);
    }
  );
  it.each(['profile', 'size'])('reports invalid public %s without publication', async (kind) => {
    const f = await fixture();
    const args = f.argv();
    if (kind === 'profile') args[args.indexOf('--profile') + 1] = 'unknown-profile';
    const before = snapshot(f.Database, f.file);
    const writer = vi.spyOn(store, 'openProjectDatabase');
    const result = await f.publicSubmit(
      kind === 'size' ? Buffer.alloc(128_001, ' ') : bytes(f.valid),
      args
    );
    expect(result.code).toBe(2);
    expect(result.result.ok).toBe(false);
    expect(writer.mock.calls.every(([input]) => input.mode === 'reader')).toBe(true);
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
  it('publishes the canonical verb and repair selector in general and command help', async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    expect(await runReview(['review', '--help'], {}, candidate)).toBe(0);
    expect(output.join('')).toContain('semantic-anchor-submit');
    output.length = 0;
    expect(await runReview(['review', 'semantic-anchor-submit', '--help'], {}, candidate)).toBe(0);
    for (const flag of [
      '--review',
      '--run',
      '--project',
      '--profile',
      '--input',
      '--generation',
      '--operation-id',
    ])
      expect(output.join('')).toContain(flag);
    expect(output.join('')).not.toContain('semantic-anchor-start');
  });
});
