import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import { createExecutionPin } from '@orcaops/storage/history/execution-focus';

import { publishProjectExecutionFocus } from '../../../../packages/storage/dist/history/database/execution-focus.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

function agent(f: { main: string; root: string }, cwd = f.main) {
  return makeAgent({
    cwd,
    env: {
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'resume-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
    },
  });
}
async function pin(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const state = readProjectExecution(f.writer, id)!;
  const shellKey = { kind: 'codex_session' as const, value: 'resume-session' };
  const value = createExecutionPin({
    authority: { ...f.authority, formatVersion: 1 },
    gitContext: f.context,
    shellKey,
    state: state.state,
    pinnedAt: '2026-09-01T00:00:00.000Z',
  });
  await publishProjectExecutionFocus(f.writer, {
    action: 'set',
    operationId: uuidv7(),
    expectedSelection: null,
    scope: {
      rootKey: f.authority.rootKey,
      projectId: f.authority.projectId,
      storeInstanceId: f.authority.storeInstanceId,
      repositoryInstanceId: f.authority.repositoryInstanceId,
      worktreeId: f.context.worktreeId!,
      shellKey,
    },
    pinBytes: Buffer.from(JSON.stringify(value)),
    expectedArtifactRevision: readProjectArtifact(f.writer, id)!.revision,
    expectedExecutionVersion: state.version,
    secretAllow: [],
  });
}
async function resume(f: { main: string; root: string }, flags: string[] = [], cwd = f.main) {
  const raw = await agent(f, cwd).runRaw(['resume', '--json', ...flags]);
  return { raw, result: JSON.parse(raw.stdout) };
}
describe('registered passive task resume', { timeout: 30_000 }, () => {
  it('uses exactly one eligible current-branch task and labels ambiguity instead of choosing latest', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { task: 'Original task' });
    await f.capture(undefined, { cwd: f.linked, task: 'Other worktree' });
    let before = await inventory(f.temporary);
    const unique = await resume(f);
    expect(unique.raw.exitCode, unique.raw.stderr).toBe(0);
    expect(unique.result).toMatchObject({
      schema_version: 3,
      resolved: true,
      artifact_id: id,
      resolution_via: 'unique',
      eligibility: { state: 'eligible' },
    });
    expect(unique.result.plan_event_id).toBe(
      readProjectArtifact(f.writer, id)!.thread.plan!.source_event_id
    );
    expect(unique.result.artifact.steps[0].step_id).toBe(
      readProjectArtifact(f.writer, id)!.thread.plan!.plan_steps[0].step_id
    );
    expect(unique.result.artifact).not.toHaveProperty('cached_at');
    expect(await inventory(f.temporary)).toEqual(before);
    const second = await f.capture(undefined, { task: 'Second original task' });
    before = await inventory(f.temporary);
    const ambiguous = await resume(f);
    expect(ambiguous.raw.exitCode).toBe(1);
    expect(ambiguous.result).toMatchObject({ resolved: false, reason: 'AMBIGUOUS_ARTIFACT' });
    expect(
      new Set(
        ambiguous.result.candidates
          .filter((candidate: { eligibility: { valid: boolean } }) => candidate.eligibility.valid)
          .map((candidate: { artifact_id: string }) => candidate.artifact_id)
      )
    ).toEqual(new Set([id, second]));
    expect(
      ambiguous.result.candidates.every(
        (candidate: { label: string; command: string }) =>
          candidate.label && candidate.command.includes('--project')
      )
    ).toBe(true);
    expect(ambiguous.result).not.toHaveProperty('default_candidate_id');
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('uses original contextual focus among multiple eligible tasks without writing a new pin', async () => {
    const f = await fixture();
    const first = await f.capture();
    await f.capture();
    await pin(f, first);
    const before = await inventory(f.temporary);
    const result = await resume(f);
    expect(result.raw.exitCode, result.raw.stderr).toBe(0);
    expect(result.result).toMatchObject({ artifact_id: first, resolution_via: 'pin' });
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('keeps completed focus and explicit imported evidence outside implicit task authority', async () => {
    const f = await fixture();
    const completed = await f.capture(undefined, { reason: 'completed' });
    const imported = await f.capture(undefined, { reason: 'imported' });
    await pin(f, completed);
    const before = await inventory(f.temporary);
    const implicit = await resume(f);
    expect(implicit.raw.exitCode).toBe(0);
    expect(implicit.result).toMatchObject({ resolved: false, reason: 'NO_ELIGIBLE_ARTIFACT' });
    const explicit = await resume(f, ['--artifact', imported, '--project', f.authority.projectId]);
    expect(explicit.raw.exitCode, explicit.raw.stderr).toBe(0);
    expect(explicit.result).toMatchObject({
      artifact_id: imported,
      resolution_via: 'explicit',
      eligibility: { state: 'ineligible' },
      artifact: { origin: { kind: 'git-import' } },
    });
    const done = await resume(f, ['--artifact', completed]);
    expect(done.result.artifact.is_complete).toBe(true);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('retains original checkpoint decisions and their alternatives in the resume prompt', async () => {
    const f = await fixture();
    const id = await f.capture();
    await f.mutate(id, { decision: 'token bucket' }, async (semantics) => {
      const plan = await semantics.readPlan(id);
      const opened = await semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      );
      if (!('checkpoint' in opened)) throw new Error('Checkpoint did not open');
      await semantics.writeCheckpointClosed(
        {
          artifact_id: id,
          n: opened.checkpoint.n,
          head_sha: f.context.headOid!,
          summary: 'Retained decision',
          files_changed: [],
          completed_step_ids: [],
          decisions: [
            {
              decision: 'token bucket',
              reason: 'avoids boundary burst',
              alternatives_considered: [
                { option: 'fixed window', rejected_because: 'boundary burst' },
              ],
            },
          ],
          uncertainty: [],
          done_criteria: [],
        },
        { idempotencyKey: uuidv7() }
      );
    });
    const before = await inventory(f.temporary);
    const result = await resume(f, ['--artifact', id]);
    expect(result.raw.exitCode, result.raw.stderr).toBe(0);
    expect(result.result.artifact.decisions).toEqual([
      {
        decision: 'token bucket',
        reason: 'avoids boundary burst',
        source: 'checkpoint',
        checkpoint: 1,
        alternatives_considered: [{ option: 'fixed window', rejected_because: 'boundary burst' }],
      },
    ]);
    expect(result.result.artifact.agent_prompt).toContain(
      'considered fixed window — rejected because boundary burst'
    );
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports historical missing rubrics from a fresh worktree', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { task: 'Resume historical rubric-free work' });
    await f.capture(undefined, { cwd: f.linked, task: 'Register the fresh worktree' });
    const before = await inventory(f.temporary);

    const structured = await resume(f, ['--artifact', id], f.linked);
    expect(structured.raw.exitCode, structured.raw.stderr).toBe(0);
    expect(structured.result.artifact.acceptance_criteria_coverage).toMatchObject({
      revision_n: 0,
      total: 1,
      covered: 0,
      missing: 1,
    });
    expect(structured.result.artifact.agent_prompt).toContain(
      'Recorded acceptance criteria: 0 of 1 steps'
    );
    expect(structured.result.artifact.agent_prompt).toContain(
      'Retained evidence — Read retained evidence (no recorded criteria)'
    );

    const rendered = await agent(f, f.linked).runRaw(['resume', '--artifact', id]);
    expect(rendered.exitCode, rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain('Recorded acceptance criteria: 0 of 1 steps');
    expect(rendered.stdout).toContain('criterion-level completion is unverified');
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('does not use SHA reachability or another branch binding as implicit task authority', async () => {
    const f = await fixture();
    const id = await f.capture();
    await git(f.main, ['checkout', '-b', 'empty-sibling']);
    const before = await inventory(f.temporary);
    expect((await resume(f)).result).toMatchObject({
      resolved: false,
      reason: 'NO_ELIGIBLE_ARTIFACT',
    });
    expect((await resume(f, ['--branch', 'main'])).result.resolved).toBe(false);
    const explicit = await resume(f, ['--artifact', id]);
    expect(explicit.result).toMatchObject({
      resolved: true,
      artifact_id: id,
      eligibility: { state: 'ineligible' },
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('distinguishes an empty registered project from an unknown exact identity', async () => {
    const f = await fixture();
    const before = await inventory(f.temporary);
    expect((await resume(f)).result).toMatchObject({
      resolved: false,
      reason: 'NO_ELIGIBLE_ARTIFACT',
      artifact: null,
    });
    const unknown = await resume(f, ['--artifact', uuidv7()]);
    expect(unknown.raw.exitCode).toBe(1);
    expect(unknown.result.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('refuses missing original history and retired mutating flags without restoring or initializing', async () => {
    const f = await fixture();
    const id = await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const missing = await resume(f, ['--artifact', id]);
    expect(missing.raw.exitCode).toBe(1);
    expect(missing.result.error.code).toBe('HISTORY_MISSING');
    const retired = await agent(f).runRaw(['resume', '--accept-default', '--json']);
    expect(retired.exitCode).toBe(1);
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
