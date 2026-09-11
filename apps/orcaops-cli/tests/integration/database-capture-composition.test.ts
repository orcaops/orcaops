import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';
import { SecretInPayloadError, uuidv7 } from '@orcaops/storage';
import { readProjectArtifact, readProjectUsage } from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';

import {
  prepareDatabaseCapture,
  resolveDatabaseCaptureContext,
  selectDatabaseCaptureArtifact,
} from '../../src/lib/database-capture-context.js';
import { appendDatabaseCaptureEvents } from '../../src/lib/database-capture-events.js';
import {
  clearDatabaseCaptureFocus,
  focusDatabaseCapture,
} from '../../src/lib/database-capture-focus.js';
import {
  publishDatabaseLifecycleCompletion,
  readDatabaseLifecycleCompletion,
} from '../../src/lib/database-evaluators.js';
import { stampDatabaseUsage } from '../../src/lib/database-usage-stamp.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'capture-session';
function environment(f: Fixture, session = SESSION) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: session,
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
  };
}
function inContext<T>(f: Fixture, fn: () => Promise<T>, env = environment(f)) {
  return runInInvocationContext({ cwd: f.main, env }, fn);
}
async function status(f: Fixture) {
  const raw = await makeAgent({ cwd: f.main, env: environment(f) }).runRaw(['status', '--json']);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as {
    artifacts: Array<{ id: string; thread: Record<string, { status: string }> }>;
  };
}
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
afterEach(() => vi.unstubAllEnvs());

describe('shared SQLite capture composition', { timeout: 30_000 }, () => {
  it('refuses raw and assembled secrets before any writer opens and leaves history unchanged', async () => {
    const f = await fixture();
    await f.capture();
    const secret = 'ghp_' + 'a'.repeat(36);
    const before = await inventory(f.temporary);
    await expect(
      inContext(f, () => prepareDatabaseCapture({ parse: () => ({ text: secret }) }))
    ).rejects.toBeInstanceOf(SecretInPayloadError);
    await expect(
      inContext(f, () =>
        prepareDatabaseCapture({
          parse: () => ({ text: 'clean' }),
          assemble: (raw) => ({ ...raw, baseline: { branch: secret } }),
        })
      )
    ).rejects.toBeInstanceOf(SecretInPayloadError);
    const prepared = await inContext(f, () =>
      prepareDatabaseCapture({ parse: () => ({ text: 'clean' }) })
    );
    prepared.context.close();
    expect(prepared.context.registered.authority).toEqual(f.authority);
    expect(prepared.context.binding.worktree_id).toBe(f.context.worktreeId);
    expect(prepared.secretWarnings).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('selects the single active artifact on the branch and labels ambiguity', async () => {
    const f = await fixture();
    const unknown = uuidv7();
    expect(() =>
      selectDatabaseCaptureArtifact(f.writer, { explicitId: unknown, branch: 'main' })
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_ARTIFACT' }));
    expect(() => selectDatabaseCaptureArtifact(f.writer, { branch: 'main' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    const first = await f.capture();
    await f.capture(undefined, { reason: 'completed' });
    expect(selectDatabaseCaptureArtifact(f.writer, { branch: 'main' })).toEqual({
      artifactId: first,
      via: 'single-active',
    });
    const second = await f.capture();
    let ambiguous: unknown;
    try {
      selectDatabaseCaptureArtifact(f.writer, { branch: 'main' });
    } catch (cause) {
      ambiguous = cause;
    }
    expect(ambiguous).toMatchObject({ code: 'AMBIGUOUS_ARTIFACT' });
    const details = (ambiguous as { details?: { candidates?: Array<{ id: string }> } }).details;
    expect(details?.candidates?.map((c) => c.id).sort()).toEqual([first, second].sort());
    expect(selectDatabaseCaptureArtifact(f.writer, { explicitId: second, branch: 'main' })).toEqual(
      {
        artifactId: second,
        via: 'explicit',
      }
    );
  });

  it('appends evaluator runs as retained events and surfaces explicit completion through status', async () => {
    const f = await fixture();
    const id = await f.capture();
    const context = await inContext(f, () => resolveDatabaseCaptureContext());
    try {
      const run: EvaluatorRunPayload = {
        schema: 'orcaops.evaluator_run/v1',
        run_id: uuidv7(),
        artifact_id: id,
        evaluator_ref: 'test-pack/plan-stub',
        package_id: 'test-pack',
        evaluator_id: 'plan-stub',
        phase: 'post-plan',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'pass',
        body: 'PASS\n\nseeded for test',
        ts: '2026-09-05T00:00:01.000Z',
      };
      const appended = await appendDatabaseCaptureEvents({
        handle: f.writer,
        binding: context.binding,
        artifactId: id,
        operationId: uuidv7(),
        authoredPayload: { runs: [run] },
        secretAllow: [],
        explicitTarget: true,
        evaluate: async (semantics) => {
          await semantics.writeEvaluatorRunPayload(id, run, { idempotencyKey: uuidv7() });
          return 'appended';
        },
      });
      expect(appended.value).toBe('appended');
      expect(appended.publication?.value.eventIds).toHaveLength(1);
      expect(
        readProjectArtifact(f.writer, id)!.thread.evaluatorLog?.runs.map((entry) => entry.run_id)
      ).toContain(run.run_id);
      expect((await status(f)).artifacts[0].thread['eval-plan'].status).toBe('ready');
      const key = { firesAt: 'post-plan' as const, cpN: 0 };
      const first = await publishDatabaseLifecycleCompletion(f.writer, {
        artifactId: id,
        key,
        triggeredAt: '2026-09-05T00:00:02.000Z',
        command: 'test',
        secretAllow: [],
        mode: 'once',
      });
      expect(first).toMatchObject({ state: 'published', selection: { version: 1 } });
      const repeated = await publishDatabaseLifecycleCompletion(f.writer, {
        artifactId: id,
        key,
        triggeredAt: '2026-09-05T00:00:03.000Z',
        command: 'test',
        secretAllow: [],
        mode: 'once',
      });
      expect(repeated).toEqual({ state: 'replayed', selection: first.selection });
      const replaced = await publishDatabaseLifecycleCompletion(f.writer, {
        artifactId: id,
        key,
        triggeredAt: '2026-09-05T00:00:04.000Z',
        command: 'test',
        secretAllow: [],
        mode: 'replace',
      });
      expect(replaced).toMatchObject({ state: 'published', selection: { version: 2 } });
      expect(readDatabaseLifecycleCompletion(f.writer, id, key)?.record).toMatchObject({
        fires_at: 'post-plan',
        cp_n: 0,
        triggered_at: '2026-09-05T00:00:04.000Z',
      });
      expect((await status(f)).artifacts[0].thread['eval-plan'].status).toBe('done');
    } finally {
      context.close();
    }
  });

  it('stamps usage once per stable key and reports an unavailable session honestly', async () => {
    const f = await fixture();
    const id = await f.capture();
    const sessionId = `sess-${randomUUID()}`;
    const base = path.join(f.temporary, 'claude-config');
    await writeTranscript(base, sessionId);
    vi.stubEnv('CLAUDE_CONFIG_DIR', base);
    const env = {
      ...environment(f, ''),
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CONFIG_DIR: base,
    };
    const descriptor = {
      lifecycle_event: 'plan',
      artifactId: id,
      baselineHint: 'prior_same_artifact' as const,
      asOf: new Date().toISOString(),
      stableEventId: 'stamp-1',
    };
    const stamp = () =>
      stampDatabaseUsage(f.writer, {
        descriptor,
        invokingAgent: 'claude-code',
        env,
        cwd: f.main,
        secretAllow: [],
      });
    expect(await stamp()).toMatchObject({ state: 'committed', usage_source: 'available' });
    const usage = readProjectUsage(f.writer)!;
    expect(usage.events.map((event) => event.record.idempotency_key)).toEqual(['stamp-1']);
    expect(await stamp()).toEqual({ state: 'replayed', usage_source: 'available' });
    expect(readProjectUsage(f.writer)!.revision).toEqual(usage.revision);
    const linked = await stampDatabaseUsage(f.writer, {
      descriptor,
      invokingAgent: 'claude-code',
      env,
      cwd: f.main,
      secretAllow: [],
      sourcePlanLinks: [
        {
          canonical_ref_id: 'local:abc',
          artifact_id: id,
          linked_at: '2026-09-05T00:00:00.000Z',
          idempotency_key: 'link-1',
        },
      ],
    });
    expect(linked).toMatchObject({ state: 'committed' });
    expect(readProjectUsage(f.writer)!.events.map((event) => event.record.type)).toEqual([
      'agent_usage_snapshot_recorded',
      'source_plan_linked',
    ]);
    expect(
      await stampDatabaseUsage(f.writer, {
        descriptor: { ...descriptor, stableEventId: 'stamp-2' },
        invokingAgent: 'other',
        env: environment(f, ''),
        cwd: f.main,
        secretAllow: [],
      })
    ).toEqual({ state: 'unavailable', usage_source: 'unavailable', reason: 'session_unavailable' });
  });

  it('sets session focus after capture and clears it only for the focused artifact', async () => {
    const f = await fixture();
    const a = await f.capture();
    const b = await f.capture();
    const context = await inContext(f, () => resolveDatabaseCaptureContext());
    try {
      const scope = {
        rootKey: f.authority.rootKey,
        projectId: f.authority.projectId,
        storeInstanceId: f.authority.storeInstanceId,
        repositoryInstanceId: f.authority.repositoryInstanceId,
        worktreeId: f.context.worktreeId!,
        shellKey: { kind: 'codex_session' as const, value: SESSION },
      };
      const common = {
        registered: context.registered,
        shellKey: context.shellKey,
        secretAllow: [],
      };
      expect(await focusDatabaseCapture(f.writer, { ...common, artifactId: a })).toMatchObject({
        state: 'updated',
        displaced_artifact_id: null,
        read_only: false,
      });
      expect(readProjectExecutionFocus(f.writer, scope)).toMatchObject({
        status: 'present',
        pin: { artifact_id: a },
      });
      expect(await clearDatabaseCaptureFocus(f.writer, { ...common, artifactId: b })).toEqual({
        state: 'not_requested',
      });
      expect(readProjectExecutionFocus(f.writer, scope)).toMatchObject({ pin: { artifact_id: a } });
      expect(await clearDatabaseCaptureFocus(f.writer, { ...common, artifactId: a })).toMatchObject(
        {
          state: 'cleared',
        }
      );
      expect(readProjectExecutionFocus(f.writer, scope).status).toBe('cleared');
      expect(
        await focusDatabaseCapture(f.writer, {
          ...common,
          shellKey: { kind: 'none' },
          artifactId: a,
        })
      ).toEqual({ state: 'not_requested' });
    } finally {
      context.close();
    }
  });
});
