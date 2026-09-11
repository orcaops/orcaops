import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

import { decode, restoreFixture, snapshot } from '../../storage/tests/database-fixture.mjs';

const candidate = fileURLToPath(new URL('../../../', import.meta.url));
const entrypoint = path.join(candidate, 'packages/review-engine/dist/run.js');
if (process.argv[2] === '--child') {
  const request = JSON.parse(process.argv[3]);
  const { runReview } = await import(entrypoint);
  const listeners = process.listenerCount('SIGINT');
  const Database = createRequire(path.join(candidate, 'packages/storage/package.json'))(
    'better-sqlite3'
  );
  const exec = Database.prototype.exec;
  let lateSignal = false;
  if (request.lateAbort)
    Database.prototype.exec = function (sql) {
      const operationId = request.argv[request.argv.indexOf('--operation-id') + 1];
      const ownsCommit =
        sql === 'COMMIT' &&
        this.inTransaction &&
        this.prepare('SELECT operation_id FROM operations WHERE operation_id=?').get(operationId);
      const result = exec.call(this, sql);
      if (ownsCommit) lateSignal = process.emit('SIGINT');
      return result;
    };
  const code = await runReview(request.argv, process.env, request.cwd, {
    packageRoot: path.join(candidate, 'packages/review-engine'),
    entrypointPath: entrypoint,
  });
  Database.prototype.exec = exec;
  process.send({ code, before: listeners, after: process.listenerCount('SIGINT'), lateSignal });
  process.disconnect();
} else {
  const f = await restoreFixture(
    candidate,
    fileURLToPath(
      new URL('../../storage/src/history/database/fixtures/semantic-review.json', import.meta.url)
    )
  );
  const { uuidv7 } = await import(path.join(candidate, 'packages/storage/dist/index.js'));
  let blocker;
  try {
    const original = decode(f.saved.semanticInput);
    const input = path.join(f.temporary, 'submission.json');
    await writeFile(input, original.submissionBytes);
    const operationId = uuidv7();
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
      'semantic-anchor-profile-v1',
      '--input',
      input,
      '--operation-id',
      operationId,
      '--json',
    ];
    const invoke = (cancel, lateAbort = false) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            '--child',
            JSON.stringify({ argv, cwd: f.temporary, lateAbort }),
          ],
          {
            env: {
              ...process.env,
              NODE_DISABLE_COMPILE_CACHE: '1',
              ORCAOPS_DATA_DIR: f.authority.resolvedRoot,
              ORCAOPS_ROOT: f.temporary,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          }
        );
        let stdout = '',
          stderr = '',
          detail = null,
          sent = false;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Public signal probe exceeded its bounded wait'));
        }, 20_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (cancel && !sent && stderr.includes('Waiting for review.semantic.submit')) {
            sent = true;
            child.kill('SIGINT');
          }
        });
        child.on('message', (message) => {
          detail = message;
        });
        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, stdout, stderr, detail, sent });
        });
      });
    const before = snapshot(f.Database, f.file);
    blocker = new f.Database(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const cancelled = await invoke(true);
    console.log(JSON.stringify({ phase: 'actual-public-SIGINT', ...cancelled }));
    assert.equal(cancelled.sent, true);
    assert.equal(cancelled.signal, null);
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.detail.code, 1);
    assert.equal(cancelled.detail.after, cancelled.detail.before);
    const error = JSON.parse(cancelled.stdout);
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.operation_id, operationId);
    assert.match(error.message, /original operation/i);
    assert.deepEqual(snapshot(f.Database, f.file), before);
    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = undefined;
    const retried = await invoke(false, true);
    console.log(JSON.stringify({ phase: 'original-retry-late-signal', ...retried }));
    assert.equal(retried.signal, null);
    assert.equal(retried.detail.code, 1);
    assert.equal(retried.detail.lateSignal, true);
    assert.equal(retried.detail.after, retried.detail.before);
    const accepted = JSON.parse(retried.stdout);
    assert.equal(accepted.status, 'VALID');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.history.status, 'UNAVAILABLE');
    assert.equal(accepted.history.code, 'CANCELLED');
    assert.equal(accepted.operation_id, operationId);
    assert.equal(accepted.replayed, false);
    const committed = snapshot(f.Database, f.file);
    assert.equal(committed.rows.operations.length, before.rows.operations.length + 1);
    const replay = await invoke(false);
    assert.equal(replay.detail.after, replay.detail.before);
    assert.equal(replay.detail.code, 0);
    assert.equal(JSON.parse(replay.stdout).replayed, true);
    assert.deepEqual(JSON.parse(replay.stdout).receipt, accepted.receipt);
    assert.deepEqual(snapshot(f.Database, f.file), committed);
    console.log(
      JSON.stringify({
        status: 'PASS',
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        entrypoint,
        operationId,
      })
    );
  } finally {
    if (blocker) {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    await f.cleanup();
  }
}
