import {
  ArtifactLock,
  ArtifactLockLeaseLostError,
  ArtifactLockTimeoutError,
} from '@orcaops/storage/locks';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runtime = globalThis.Bun === undefined ? 'node' : 'bun';
const root = await mkdtemp(path.join(tmpdir(), `orcaops-${runtime}-lock-`));
const locksDir = path.join(root, 'locks');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('lock runtime probe timed out');
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
  }
}

async function rejectsWith(promise, ErrorType) {
  const error = await promise.then(
    () => null,
    (reason) => reason
  );
  assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, received ${String(error)}`);
}

try {
  const heartbeatGate = deferred();
  const heartbeatEntered = deferred();
  const heartbeatHolder = new ArtifactLock({
    locksDir,
    heartbeatIntervalMs: 10,
    retryIntervalMs: 5,
    staleThresholdMs: 80,
  });
  const heartbeatOperation = heartbeatHolder.withLock('heartbeat', async () => {
    heartbeatEntered.resolve();
    await heartbeatGate.promise;
  });
  await heartbeatEntered.promise;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  const heartbeatContender = new ArtifactLock({
    locksDir,
    acquireTimeoutMs: 50,
    retryIntervalMs: 5,
    staleThresholdMs: 80,
  });
  await rejectsWith(
    heartbeatContender.withLock('heartbeat', async () => undefined),
    ArtifactLockTimeoutError
  );
  heartbeatGate.resolve();
  await heartbeatOperation;

  const predecessorGate = deferred();
  const predecessorEntered = deferred();
  const takeoverLock = new ArtifactLock({
    locksDir,
    retryIntervalMs: 5,
    staleThresholdMs: 80,
  });
  const predecessor = takeoverLock.withLock('takeover', async () => {
    predecessorEntered.resolve();
    await predecessorGate.promise;
  });
  await predecessorEntered.promise;
  const takeoverPath = takeoverLock.lockPathFor('takeover');
  const past = new Date(Date.now() - 1_000);
  await utimes(takeoverPath, past, past);

  const successorGate = deferred();
  let successorEntered = false;
  const successor = takeoverLock.withLock('takeover', async () => {
    successorEntered = true;
    await successorGate.promise;
  });
  await waitFor(() => successorEntered);
  predecessorGate.resolve();
  await predecessor;
  assert.equal((await stat(takeoverPath)).isDirectory(), true);
  successorGate.resolve();
  await successor;

  const lostGate = deferred();
  const lostEntered = deferred();
  const lostLock = new ArtifactLock({
    locksDir,
    heartbeatIntervalMs: 10,
    staleThresholdMs: 100,
  });
  const lostOperation = lostLock.withLock('lost-lease', async () => {
    lostEntered.resolve();
    await lostGate.promise;
  });
  await lostEntered.promise;
  const lostPath = lostLock.lockPathFor('lost-lease');
  await rm(lostPath, { recursive: true });
  await mkdir(lostPath);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
  lostGate.resolve();
  await rejectsWith(lostOperation, ArtifactLockLeaseLostError);

  globalThis.console.log(
    `${runtime}: review lock heartbeat, takeover, and lost-lease checks passed`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
