import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';
import { dispatchOne } from '@orcaops/evaluator-runner';
import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  openProjectDatabase,
  type ProjectDatabaseError,
  readProjectArtifact,
  readProjectEvaluatorRunFindings,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';
import { createTempRepo } from '@orcaops/test-harness';

import { createDatabaseEvalRunAction } from '../../src/commands/eval/run.js';
import { CliExit } from '../../src/io/exit.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, grantEvaluatorPack } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const TEST_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-pack'
);
const SESSION = 'eval-run-session';
type Fixture = Awaited<ReturnType<typeof fixture>>;

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
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}

function focusScope(f: Fixture) {
  return {
    rootKey: f.authority.rootKey,
    projectId: f.authority.projectId,
    storeInstanceId: f.authority.storeInstanceId,
    repositoryInstanceId: f.authority.repositoryInstanceId,
    worktreeId: f.context.worktreeId!,
    shellKey: { kind: 'codex_session' as const, value: SESSION },
  };
}

async function enablePassEvaluator(f: Fixture) {
  await grantEvaluatorPack(f, {
    packageId: 'test-pack',
    packRoot: TEST_PACK,
    enable: { 'test-pack/pass-fixture': true, 'test-pack/api-stub': true },
  });
}

async function runEval(f: Fixture, artifactId?: string, ref = 'test-pack/pass-fixture') {
  return agent(f).runRaw([
    'eval',
    'run',
    '--ref',
    ref,
    ...(artifactId ? ['--artifact', artifactId] : []),
    '--no-llm',
    '--json',
  ]);
}

async function directEval(
  f: Fixture,
  action: ReturnType<typeof createDatabaseEvalRunAction>,
  artifactId: string,
  ref = 'test-pack/pass-fixture'
) {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(
      runInInvocationContext(
        {
          cwd: f.main,
          env: {
            ...process.env,
            ORCAOPS_ROOT: f.main,
            ORCAOPS_DATA_DIR: f.root,
            ORCAOPS_DISABLE_DRAIN: '1',
          },
        },
        () => action({ ref, artifact: artifactId, noLlm: true })
      )
    ).rejects.toBeInstanceOf(CliExit);
    return stderr.mock.calls.map(([value]) => String(value)).join('');
  } finally {
    stderr.mockRestore();
  }
}

describe('orcaops eval run with database history', { timeout: 180_000 }, () => {
  it('records one evaluator event on an explicit completed artifact without changing execution or focus', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const artifactId = await f.capture(undefined, { reason: 'completed' });
    const beforeExecution = readProjectExecution(f.writer, artifactId)!;
    const beforeFocus = readProjectExecutionFocus(f.writer, focusScope(f));

    const result = await runEval(f, artifactId);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/pass-fixture',
      run: { run_status: 'completed', verdict: 'pass' },
      blocking: false,
    });
    const retained = readProjectArtifact(f.writer, artifactId)!;
    expect(retained.thread.evaluatorLog?.runs).toHaveLength(1);
    expect(retained.thread.evaluatorLog?.runs[0]).toMatchObject({
      evaluator_ref: 'test-pack/pass-fixture',
      verdict: 'pass',
    });
    expect(retained.thread.summary?.outcome).toBe('Completed fixture');
    const afterExecution = readProjectExecution(f.writer, artifactId)!;
    expect({ state: afterExecution.state, version: afterExecution.version }).toEqual({
      state: beforeExecution.state,
      version: beforeExecution.version,
    });
    const afterFocus = readProjectExecutionFocus(f.writer, focusScope(f));
    expect({ status: afterFocus.status, selection: afterFocus.selection }).toEqual({
      status: beforeFocus.status,
      selection: beforeFocus.selection,
    });
  });

  it('defaults to the latest project artifact by started_at', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const latest = await f.capture(undefined, { ts: '2026-09-06T00:00:00.000Z' });
    const older = await f.capture(undefined, { ts: '2026-09-04T00:00:00.000Z' });

    const result = await runEval(f);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).artifact_id).toBe(latest);
    expect(readProjectArtifact(f.writer, latest)!.thread.evaluatorLog?.runs).toHaveLength(1);
    expect(readProjectArtifact(f.writer, older)!.thread.evaluatorLog?.runs).toEqual([]);
  });

  it('does not initialize missing project history', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, 'missing-data');
      const result = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['eval', 'run', '--ref', 'test-pack/pass-fixture', '--no-llm', '--json']);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('GIT_CONTEXT_UNAVAILABLE');
      await expect(mkdir(dataRoot)).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a result when the selected artifact advances before append', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const artifactId = await f.capture();
    const concurrentRun: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: uuidv7(),
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/concurrent',
      package_id: 'test-pack',
      evaluator_id: 'concurrent',
      phase: 'post-plan',
      severity: 'info',
      run_status: 'completed',
      verdict: 'pass',
      body: 'PASS\n\nConcurrent retained event.',
      ts: new Date().toISOString(),
    };
    let failure: unknown;
    const action = createDatabaseEvalRunAction({
      openWriter: openProjectDatabase,
      dispatch: dispatchOne,
      listenForInterrupt: () => () => undefined,
      append: async (writer, input, options) => {
        await f.mutate(artifactId, { concurrentRun }, (semantics) =>
          semantics.writeEvaluatorRunPayload(artifactId, concurrentRun, {
            idempotencyKey: uuidv7(),
          })
        );
        try {
          return await appendProjectArtifactEvents(writer, input, options);
        } catch (cause) {
          failure = cause;
          throw cause;
        }
      },
    });

    await directEval(f, action, artifactId);
    expect((failure as ProjectDatabaseError).code).toBe('STALE_CONTEXT');
    expect(
      readProjectArtifact(f.writer, artifactId)!.thread.evaluatorLog?.runs.map(
        (entry) => entry.evaluator_ref
      )
    ).toEqual(['test-pack/concurrent']);
  });

  it('refuses a secret-bearing evaluator result before opening a writer', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const artifactId = await f.capture();
    const before = readProjectArtifact(f.writer, artifactId)!.revision;
    let writerOpened = false;
    const action = createDatabaseEvalRunAction({
      openWriter: async (input) => {
        writerOpened = true;
        return openProjectDatabase(input);
      },
      append: appendProjectArtifactEvents,
      dispatch: async () => ({
        run: {
          schema: 'orcaops.evaluator_run/v1',
          run_id: uuidv7(),
          artifact_id: artifactId,
          evaluator_ref: 'test-pack/pass-fixture',
          package_id: 'test-pack',
          evaluator_id: 'pass-fixture',
          phase: 'post-plan',
          severity: 'info',
          run_status: 'completed',
          verdict: 'pass',
          body: `ghp_${'A'.repeat(36)}`,
          ts: new Date().toISOString(),
        },
        findings: { status: 'none' },
      }),
      listenForInterrupt: () => () => undefined,
    });

    const stderr = await directEval(f, action, artifactId);
    expect(stderr).toContain('SECRET_IN_PAYLOAD');
    expect(writerOpened).toBe(false);
    expect(readProjectArtifact(f.writer, artifactId)!.revision).toEqual(before);
  });

  it('forwards cancellation and emits one named wait without retaining the prepared event', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const artifactId = await f.capture();
    const before = readProjectArtifact(f.writer, artifactId)!.revision;
    let interrupt: (() => void) | undefined;
    let listenerReleased = false;
    let failure: unknown;
    const action = createDatabaseEvalRunAction({
      openWriter: openProjectDatabase,
      dispatch: dispatchOne,
      listenForInterrupt: (listener) => {
        interrupt = listener;
        return () => {
          listenerReleased = true;
        };
      },
      append: async (writer, input, options) => {
        options?.onWait?.({ operation: 'artifact.append', reason: 'admission', attempt: 1 });
        options?.onWait?.({
          operation: 'artifact.append',
          reason: 'transaction-retry',
          attempt: 2,
        });
        interrupt?.();
        try {
          return await appendProjectArtifactEvents(writer, input, options);
        } catch (cause) {
          failure = cause;
          throw cause;
        }
      },
    });

    const stderr = await directEval(f, action, artifactId);
    expect((failure as ProjectDatabaseError).code).toBe('CANCELLED');
    expect(stderr.match(/Waiting to record the evaluator run/g)).toHaveLength(1);
    expect(listenerReleased).toBe(true);
    expect(readProjectArtifact(f.writer, artifactId)!.revision).toEqual(before);
  });

  it('preserves checkpoint phase validation before persistence', async () => {
    const f = await fixture();
    await enablePassEvaluator(f);
    const artifactId = await f.capture();
    const before = readProjectArtifact(f.writer, artifactId)!.revision;

    const result = await runEval(f, artifactId, 'test-pack/api-stub');
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'checkpoint',
    });
    expect(readProjectArtifact(f.writer, artifactId)!.revision).toEqual(before);
  });

  it('retains what the producer found in the append that recorded the run', async () => {
    const f = await fixture();
    const artifactId = await f.capture();
    await enablePassEvaluator(f);

    const result = await runEval(f, artifactId);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.findings_retained).toBe(2);
    expect(result.stdout).not.toContain('The captured plan states every step');

    const retained = readProjectEvaluatorRunFindings(f.writer, parsed.run.run_id);
    expect(retained.status).toBe('established');
    if (retained.status !== 'established') throw new Error(retained.status);
    expect(retained.findings.map((finding) => finding.key)).toEqual(['fixture/plan-covered', null]);
    expect(retained.basis).toMatchObject({
      artifactId,
      evaluatorRef: 'test-pack/pass-fixture',
      evaluatorVersion: null,
      producerPayload: null,
    });
  });
});
