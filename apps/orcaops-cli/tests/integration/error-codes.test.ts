import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('CLI error code remaps', () => {
  let repo: TempRepo;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath }).runRaw(['init', '--no-llm']);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('LOCK_TIMEOUT: runCapture remaps ArtifactLockTimeoutError to the public code', async () => {
    // Unit-level remap test. The CLI lock budget is 10s by default
    // (per ArtifactLock's DEFAULT_ACQUIRE_TIMEOUT_MS); driving a real
    // timeout through a CLI subprocess would slow the suite. Instead
    // we exercise the remap path directly — the integration coverage
    // for locks themselves lives in packages/storage/src/locks.test.ts.
    const { ArtifactLockTimeoutError } = await import('@orcaops/storage');
    const { runCapture } = await import('../../src/lib/run-capture.js');
    const { CliExit } = await import('../../src/io/exit.js');

    let captured = '';
    let exitCode: number | undefined;
    const origWrite = process.stdout.write.bind(process.stdout);
    // process.stdout is global — restore in finally. emitError throws
    // CliExit rather than calling process.exit, so we catch the
    // throw to observe the would-be exit code.
    process.stdout.write = (data: string | Uint8Array): boolean => {
      captured += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      return true;
    };
    try {
      await runCapture(async () => {
        throw new ArtifactLockTimeoutError('artifact-id', 200);
      });
    } catch (err) {
      if (err instanceof CliExit) {
        exitCode = err.code;
      } else {
        throw err;
      }
    } finally {
      process.stdout.write = origWrite;
    }
    expect(exitCode).toBe(1);
    const env = JSON.parse(captured) as { ok: false; error: { code: string; message: string } };
    expect(env.error.code).toBe('LOCK_TIMEOUT');
    expect(env.error.message).toMatch(/artifact-id/);
  });

  it('IDEMPOTENCY_PENDING: runCapture remaps PlanIdempotencyPendingError keeping path + remedy', async () => {
    const { PlanIdempotencyPendingError } = await import('@orcaops/storage');
    const { runCapture } = await import('../../src/lib/run-capture.js');
    const { CliExit } = await import('../../src/io/exit.js');

    let captured = '';
    let exitCode: number | undefined;
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: string | Uint8Array): boolean => {
      captured += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      return true;
    };
    try {
      await runCapture(async () => {
        throw new PlanIdempotencyPendingError('pending-key', 'artifact-id');
      });
    } catch (err) {
      if (err instanceof CliExit) {
        exitCode = err.code;
      } else {
        throw err;
      }
    } finally {
      process.stdout.write = origWrite;
    }
    expect(exitCode).toBe(1);
    const env = JSON.parse(captured) as {
      ok: false;
      error: { code: string; path?: string; message: string };
    };
    expect(env.error.code).toBe('IDEMPOTENCY_PENDING');
    expect(env.error.path).toBe('idempotency_key');
    expect(env.error.message).toBe(
      'idempotency key "pending-key" is reserved by a capture that has not published a plan ' +
        'in the cache (artifact artifact-id: in flight, failed before publishing, or awaiting ' +
        'projection recovery). Run `orcaops rebuild`, then retry `orcaops capture plan` with ' +
        'the same idempotency key. If it remains pending, run `orcaops doctor`; use a fresh ' +
        'key only after confirming that no plan was published and no capture is still running.'
    );
  });
});
