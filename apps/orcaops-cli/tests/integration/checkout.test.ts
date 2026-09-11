import { access, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import { initializeUnboundExecution } from '@orcaops/storage/history/execution';

import { readProjectExecutionFocus } from '../../../../packages/storage/dist/history/database/execution-focus.js';
import {
  prepareExecutionRecords,
  settleExecutionRecords,
} from '../../../../packages/storage/dist/history/database/execution-records.js';
import { runProjectOperation } from '../../../../packages/storage/dist/history/database/transactions.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

function agent(f: Awaited<ReturnType<typeof fixture>>, cwd = f.main, session = 'checkout-session') {
  return makeAgent({
    cwd,
    env: {
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_SESSION_ID: session,
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
      ORCAOPS_ROOT: cwd,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
    },
  });
}
async function checkout(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  cwd = f.main,
  session = 'checkout-session'
) {
  const raw = await agent(f, cwd, session).runRaw(['checkout', ...args, '--json']);
  return { raw, result: JSON.parse(raw.stdout) };
}
function focus(f: Awaited<ReturnType<typeof fixture>>, session = 'checkout-session') {
  return readProjectExecutionFocus(f.writer, {
    rootKey: f.authority.rootKey,
    projectId: f.authority.projectId,
    repositoryInstanceId: f.authority.repositoryInstanceId,
    storeInstanceId: f.authority.storeInstanceId,
    worktreeId: f.context.worktreeId!,
    shellKey: { kind: 'codex_session', value: session },
  });
}
async function retainUnbound(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  reason: 'legacy_unknown' | 'imported'
) {
  const operationId = uuidv7();
  const state = initializeUnboundExecution({
    artifactId: id,
    operationId,
    reason,
    ts: '2026-09-05T00:00:00.000Z',
  });
  const prepared = prepareExecutionRecords({
    state,
    artifactRevision: readProjectArtifact(f.writer, id)!.revision,
    previous: null,
    operationId,
    secretAllow: [],
  });
  await runProjectOperation(
    f.writer,
    {
      operationId,
      kind: 'execution.initialize',
      target: { artifactId: id },
      payload: {},
      expectedState: null,
      intentChange: false,
    },
    (tx) => settleExecutionRecords(tx, prepared)
  );
}
describe('registered database checkout', { timeout: 30_000 }, () => {
  it('retains exact focus and clear replay without file pins, displacement events or ownership changes', async () => {
    const f = await fixture();
    const first = await f.capture();
    const second = await f.capture();
    const original = readProjectArtifact(f.writer, first)!;
    const execution = readProjectExecution(f.writer, first)!;
    const set = await checkout(f, [first, '--project', f.authority.projectId]);
    expect(set.raw.exitCode, set.raw.stdout + set.raw.stderr).toBe(0);
    expect(set.result).toMatchObject({
      schema_version: 3,
      action: 'focused',
      artifact_id: first,
      binding: { state: 'unchanged' },
      shell_key: { kind: 'codex_session' },
    });
    expect(set.result).not.toHaveProperty('pin_file');
    await expect(access(f.temporary + '/unused-state')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(focus(f)).toMatchObject({ status: 'present', pin: { artifact_id: first } });
    await checkout(f, [second]);
    expect(readProjectArtifact(f.writer, first)!.thread.events).toEqual(original.thread.events);
    expect(readProjectExecution(f.writer, first)!.state).toEqual(execution.state);
    const before = await inventory(f.temporary);
    const replay = await checkout(f, ['--operation-id', set.result.operation_id]);
    expect(replay.raw.exitCode, replay.raw.stderr).toBe(0);
    expect(replay.result.focus.publication.replayed).toBe(true);
    expect(replay.result).toMatchObject({ action: 'replayed', focus: { state: 'replayed' } });
    expect(focus(f)).toMatchObject({ status: 'present', pin: { artifact_id: second } });
    expect(await inventory(f.temporary)).toEqual(before);
    await git(f.main, ['checkout', '-qb', 'changed-context']);
    const clear = await checkout(f, ['--clear']);
    expect(clear.raw.exitCode, clear.raw.stderr).toBe(0);
    expect(focus(f)).toMatchObject({ status: 'cleared' });
    const cleared = await inventory(f.temporary);
    expect(
      (await checkout(f, ['--operation-id', clear.result.operation_id])).result.focus.publication
        .replayed
    ).toBe(true);
    expect(await inventory(f.temporary)).toEqual(cleared);
    expect((await checkout(f, ['--clear'])).result.action).toBe('cleared');
  });
  it('requires explicit handoff and replays its original distinct binding and focus identities', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { cwd: f.linked });
    const before = await inventory(f.temporary);
    expect((await checkout(f, [id])).result.error.code).toBe('EXECUTION_BOUND_ELSEWHERE');
    expect(await inventory(f.temporary)).toEqual(before);
    const handoff = await checkout(f, [id, '--handoff', '--reason', 'Continue in this worktree']);
    expect(handoff.raw.exitCode, handoff.raw.stderr).toBe(0);
    expect(handoff.result.binding.state).toBe('committed');
    expect(handoff.result.operation_id).not.toBe(handoff.result.focus_operation_id);
    expect(readProjectExecution(f.writer, id)!.state.current_binding?.worktree_id).toBe(
      f.context.worktreeId
    );
    const retained = await inventory(f.temporary);
    expect(
      (await checkout(f, ['--operation-id', handoff.result.operation_id])).result.binding.replayed
    ).toBe(true);
    expect(await inventory(f.temporary)).toEqual(retained);
    await f.mutate(id, { open: true }, async (semantics) => {
      const plan = await semantics.readPlan(id);
      return semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      );
    });
    const open = await inventory(f.temporary);
    expect((await checkout(f, [id, '--handoff'], f.linked)).result.error.code).toBe(
      'OPEN_CHECKPOINTS'
    );
    expect(await inventory(f.temporary)).toEqual(open);
  });
  it('first-binds an explicitly selected retained unbound task with exact selectors', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { reason: 'legacy_unknown' });
    await retainUnbound(f, id, 'legacy_unknown');
    const before = readProjectExecution(f.writer, id)!;
    const result = await checkout(f, [id]);
    expect(result.raw.exitCode, result.raw.stdout + result.raw.stderr).toBe(0);
    const after = readProjectExecution(f.writer, id)!;
    expect(after.version).toBe(before.version + 1);
    expect(after.state.binding_generation).toBe(before.state.binding_generation + 1);
    expect(after.state.binding_history.at(-1)?.action).toBe('first_bind');
    expect(result.result.binding.state).toBe('committed');
  });
  it('allows explicit completed and imported focus without treating them as implicit tasks', async () => {
    const f = await fixture();
    const completed = await f.capture(undefined, { reason: 'completed' });
    const imported = await f.capture(undefined, { reason: 'imported' });
    await retainUnbound(f, imported, 'imported');
    for (const id of [completed, imported]) {
      const execution = readProjectExecution(f.writer, id)!;
      const result = await checkout(f, [id]);
      expect(result.raw.exitCode, result.raw.stdout + result.raw.stderr).toBe(0);
      expect(result.result.binding.state).toBe('unchanged');
      expect(readProjectExecution(f.writer, id)!.state).toEqual(execution.state);
      const resume = await agent(f).runRaw(['resume', '--json']);
      expect(JSON.parse(resume.stdout).resolved).toBe(false);
    }
  });
  it('isolates sessions and refuses invalid inputs, unknown targets and secrets before publication', async () => {
    const f = await fixture();
    const id = await f.capture();
    await checkout(f, [id]);
    expect(focus(f, 'other')).toMatchObject({ status: 'absent' });
    const before = await inventory(f.temporary);
    for (const args of [
      [],
      [id, '--clear'],
      ['--operation-id', uuidv7(), id],
      [id, '--recover-orphaned'],
    ]) {
      const result = await checkout(f, args);
      expect(result.result.error.code).toBe('INVALID_INPUT');
    }
    expect((await checkout(f, [uuidv7()])).result.error.code).toBe('UNKNOWN_ARTIFACT');
    expect((await checkout(f, [id], f.main, '')).result.error.code).toBe('NO_SHELL_KEY');
    const refused = await checkout(f, [id, '--handoff', '--reason', 'ghp_' + 'a'.repeat(36)]);
    expect(refused.result.error.code).toBe('SECRET_IN_PAYLOAD');
    expect(refused.raw.stdout).not.toContain('ghp_' + 'a'.repeat(36));
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('does not initialize a replacement when the expected database is missing', async () => {
    const f = await fixture();
    const id = await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const result = await checkout(f, [id]);
    expect(result.result.error.code).toBe('HISTORY_MISSING');
    expect(result.raw.exitCode).toBe(1);
    await expect(access(projectDatabasePath(f.authority))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
