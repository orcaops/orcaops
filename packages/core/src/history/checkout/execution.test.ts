import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { CapturePlanInputSchema, uuidv7 } from '@orcaops/storage';
import {
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import * as focusApi from '@orcaops/storage/history/database/execution-checkout';

import {
  type DatabaseCheckoutInput,
  prepareDatabaseCheckout,
  publishDatabaseCheckout,
} from './execution.js';
import { captureDatabasePlan } from '../capture/plan.js';
import * as contexts from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return (
    await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      timeout: 10_000,
    })
  ).stdout.trim();
}
async function register(cwd: string, root: string) {
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable checkout'],
    secretAllow: [],
  });
  return contexts.requireDatabaseExecutionContext({ cwd, root });
}
async function fixture(linkedOwner = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-checkout-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Original fixture');
  const root = path.join(directory, 'history');
  const main = await register(cwd, root);
  const linked = path.join(directory, 'linked');
  await git(cwd, 'worktree', 'add', '-qb', 'linked-topic', linked);
  const other = await register(linked, root);
  const owner = linkedOwner ? other : main;
  const handle = await openProjectDatabase({ authority: owner.authority, mode: 'writer' });
  handles.push(handle);
  const plan = await captureDatabasePlan(handle, owner, {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: uuidv7(),
      task: 'Preserve exact checkout identity',
      label: 'Checkout fixture',
      plan_steps: [{ text: 'Keep original selectors', label: 'Keep selectors' }],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled: false, excludePatterns: [] },
    secretAllow: [],
  });
  return { directory, cwd, root, linked, main, other, owner, handle, artifactId: plan.artifactId };
}
function request(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Partial<Extract<DatabaseCheckoutInput, { action: 'set' }>> = {}
): Extract<DatabaseCheckoutInput, { action: 'set' }> {
  const execution = readProjectExecution(f.handle, f.artifactId)!;
  return {
    action: 'set',
    artifactId: f.artifactId,
    expectedRevision: readProjectArtifact(f.handle, f.artifactId)!.revision,
    expectedExecutionVersion: execution.version,
    expectedBindingGeneration: execution.state.binding_generation,
    expectedBinding: execution.state.current_binding,
    shellKey: { kind: 'codex_session', value: 'original-session' },
    secretAllow: [],
    ...extra,
  };
}
function saved(handle: ProjectDatabase) {
  return handle.read((v) => ({
    operations: v.all('SELECT * FROM operations ORDER BY operation_id'),
    execution: v.all('SELECT * FROM execution_current'),
    focus: v.all('SELECT * FROM execution_focus_current'),
  }));
}
it('keeps focus passive with respect to binding and replays clear after a changed Git context', async () => {
  const f = await fixture();
  const input = request(f);
  const expected = readProjectExecution(f.handle, f.artifactId);
  const pending = prepareDatabaseCheckout(f.handle, f.main, input);
  input.artifactId = uuidv7();
  input.shellKey = { kind: 'codex_session', value: 'changed' };
  const first = await publishDatabaseCheckout(f.handle, await pending);
  expect(first).toMatchObject({
    artifactId: f.artifactId,
    binding: null,
    focus: { state: 'updated' },
  });
  expect(readProjectExecution(f.handle, f.artifactId)).toMatchObject({
    state: expected!.state,
    version: expected!.version,
    counters: {
      writeSequence: expected!.counters.writeSequence + 1,
      intentChangeCounter: expected!.counters.intentChangeCounter,
    },
  });
  await git(f.cwd, 'checkout', '-qb', 'later');
  const clear = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, f.main, {
      action: 'clear',
      shellKey: { kind: 'codex_session', value: 'original-session' },
      secretAllow: [],
    })
  );
  expect(clear.focus.state).toBe('cleared');
  const before = saved(f.handle);
  const revalidate = vi.spyOn(contexts, 'revalidateDatabaseExecutionContext');
  const retry = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, f.main, {
      action: 'replay',
      operationId: first.operationId,
      shellKey: { kind: 'codex_session', value: 'original-session' },
      secretAllow: [],
    })
  );
  expect(retry.focus.publication?.replayed).toBe(true);
  const clearRetry = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, f.main, {
      action: 'replay',
      operationId: clear.operationId,
      shellKey: { kind: 'codex_session', value: 'original-session' },
      secretAllow: [],
    })
  );
  expect(clearRetry.focus).toMatchObject({ state: 'cleared', publication: { replayed: true } });
  expect(revalidate).not.toHaveBeenCalled();
  expect(saved(f.handle)).toEqual(before);
}, 25_000);
it('requires deliberate handoff and refuses a changed original Git target before binding commit', async () => {
  const f = await fixture();
  const before = saved(f.handle);
  await expect(prepareDatabaseCheckout(f.handle, f.other, request(f))).rejects.toMatchObject({
    code: 'EXECUTION_BOUND_ELSEWHERE',
  });
  expect(saved(f.handle)).toEqual(before);
  const prepared = await prepareDatabaseCheckout(f.handle, f.other, request(f, { handoff: true }));
  await git(f.linked, 'checkout', '-qb', 'different-target');
  await expect(publishDatabaseCheckout(f.handle, prepared)).rejects.toMatchObject({
    code: 'EXECUTION_CONTEXT_CHANGED',
  });
  expect(saved(f.handle)).toEqual(before);
  const context = await contexts.requireDatabaseExecutionContext({ cwd: f.linked, root: f.root });
  const result = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, context, request(f, { handoff: true }))
  );
  expect(result.binding?.value.bindingGeneration).toBe(2);
  expect(result.focus.state).toBe('updated');
  expect(readProjectExecution(f.handle, f.artifactId)!.state.current_binding).toEqual(
    context.binding
  );
}, 25_000);
it('retains binding success and original retry selectors after an actual focus slot race', async () => {
  const f = await fixture();
  const prepared = await prepareDatabaseCheckout(f.handle, f.other, request(f, { handoff: true }));
  const publish = focusApi.publishProjectExecutionFocus;
  const spy = vi
    .spyOn(focusApi, 'publishProjectExecutionFocus')
    .mockImplementationOnce(async (handle, input, options) => {
      await publish(handle, {
        action: 'clear',
        operationId: uuidv7(),
        scope: input.scope,
        expectedSelection: input.expectedSelection,
        secretAllow: [],
      });
      return publish(handle, input, options);
    });
  const first = await publishDatabaseCheckout(f.handle, prepared);
  spy.mockRestore();
  expect(first).toMatchObject({
    binding: { replayed: false },
    focus: { state: 'failed', error: { code: 'STALE_CONTEXT' } },
  });
  expect(readProjectExecution(f.handle, f.artifactId)!.state.current_binding).toEqual(
    f.other.binding
  );
  const before = saved(f.handle);
  const revalidate = vi.spyOn(contexts, 'revalidateDatabaseExecutionContext');
  const retry = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, f.other, {
      action: 'replay',
      operationId: first.operationId,
      shellKey: { kind: 'codex_session', value: 'original-session' },
      secretAllow: [],
    })
  );
  expect(retry).toMatchObject({
    operationId: first.operationId,
    binding: { replayed: true },
    focus: {
      state: 'failed',
      operationId: first.focus.operationId,
      error: { code: 'STALE_CONTEXT' },
    },
  });
  expect(revalidate).not.toHaveBeenCalled();
  expect(saved(f.handle)).toEqual(before);
}, 25_000);
it('requires complete registered inventory and observes original owner absence before orphan recovery', async () => {
  const f = await fixture(true);
  const input = () =>
    request(f, { handoff: true, recoverOrphaned: true, reason: 'Disposable owner was removed' });
  const before = saved(f.handle);
  await expect(prepareDatabaseCheckout(f.handle, f.main, input())).rejects.toMatchObject({
    code: 'EXECUTION_RECOVERY_REQUIRED',
  });
  expect(saved(f.handle)).toEqual(before);
  await git(f.cwd, 'worktree', 'remove', f.linked);
  const unregistered = path.join(f.directory, 'unregistered');
  await git(f.cwd, 'worktree', 'add', '-qb', 'unregistered', unregistered);
  await expect(prepareDatabaseCheckout(f.handle, f.main, input())).rejects.toMatchObject({
    code: 'EXECUTION_RECOVERY_REQUIRED',
  });
  expect(saved(f.handle)).toEqual(before);
  await expect(prepareDatabaseCheckout(f.handle, f.main, input())).rejects.toThrow(unregistered);
  const prunable = path.join(f.directory, 'prunable');
  await git(f.cwd, 'worktree', 'add', '-qb', 'prunable', prunable);
  await rm(prunable, { recursive: true, force: true });
  await expect(prepareDatabaseCheckout(f.handle, f.main, input())).rejects.toThrow(prunable);
  await expect(prepareDatabaseCheckout(f.handle, f.main, input())).rejects.toThrow('prunable');
  await git(f.cwd, 'worktree', 'prune');
  await register(unregistered, f.root);
  const result = await publishDatabaseCheckout(
    f.handle,
    await prepareDatabaseCheckout(f.handle, f.main, input())
  );
  expect(result.focus.state).toBe('updated');
  expect(result.binding?.value.bindingGeneration).toBe(2);
  expect(readProjectExecution(f.handle, f.artifactId)!.state.binding_history.at(-1)?.action).toBe(
    'orphan_recovered'
  );
}, 30_000);
it('rejects forged preparation and malformed authored input before caller-owned reads', async () => {
  let reads = 0;
  const fake = {
    read() {
      reads++;
    },
  } as never;
  await expect(prepareDatabaseCheckout(fake, {} as never, null as never)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    publishDatabaseCheckout(fake, { kind: 'prepared-database-checkout' })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(reads).toBe(0);
});

it('rejects a newly registered worktree after preparing an orphan observation', async () => {
  const f = await fixture(true);
  await git(f.cwd, 'worktree', 'remove', f.linked);
  const prepared = await prepareDatabaseCheckout(
    f.handle,
    f.main,
    request(f, { handoff: true, recoverOrphaned: true, reason: 'Original owner was removed' })
  );
  const added = path.join(f.directory, 'added');
  await git(f.cwd, 'worktree', 'add', '-qb', 'added', added);
  await register(added, f.root);
  const before = saved(f.handle);
  await expect(publishDatabaseCheckout(f.handle, prepared)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(saved(f.handle)).toEqual(before);
}, 30_000);
it('retains the original registered target when the caller changes its context during preparation', async () => {
  const f = await fixture();
  const original = structuredClone(f.other);
  const pending = prepareDatabaseCheckout(f.handle, f.other, request(f, { handoff: true }));
  Object.assign(f.other.authority, { resolvedRoot: '/changed' });
  f.other.git.worktreeRoot = '/changed';
  f.other.binding!.git_context.branch = 'changed';
  const result = await publishDatabaseCheckout(f.handle, await pending);
  expect(result).toMatchObject({ binding: { replayed: false }, focus: { state: 'updated' } });
  expect(readProjectExecution(f.handle, f.artifactId)!.state.current_binding).toEqual(
    original.binding
  );
  const selected = f.handle.read((view) =>
    view.get<{ target: string }>(
      'SELECT payload_json AS target FROM operations WHERE operation_id=?',
      result.operationId
    )
  ).value!;
  expect(JSON.parse(selected.target).target).toEqual(original.binding);
}, 25_000);
