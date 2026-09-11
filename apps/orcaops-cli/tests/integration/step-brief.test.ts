import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath, readProjectArtifact } from '@orcaops/storage/history/database';

import type { readDatabaseStepBrief } from '../../src/lib/database-step.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Brief = ReturnType<typeof readDatabaseStepBrief> & { ok: true };
interface Failure {
  ok: false;
  error: {
    code: string;
    message: string;
    history_candidates?: Array<{ id: string; project_id: string; command: string }>;
  };
}
const legacyStep = 'original non-UUID step';
function agentFor(f: { main: string; root: string }, cwd = f.main) {
  return makeAgent({ cwd, env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' } });
}
async function brief(
  f: { main: string; root: string },
  stepId: string,
  flags: string[] = [],
  cwd = f.main
) {
  const raw = await agentFor(f, cwd).runRaw(['step', 'brief', stepId, '--json', ...flags]);
  return { exitCode: raw.exitCode, body: JSON.parse(raw.stdout) as Brief | Failure };
}
function ok(result: Awaited<ReturnType<typeof brief>>): Brief {
  expect(result.exitCode).toBe(0);
  expect(result.body.ok).toBe(true);
  return result.body as Brief;
}
function failed(result: Awaited<ReturnType<typeof brief>>, code: string): Failure['error'] {
  expect(result.exitCode).toBe(1);
  expect(result.body.ok).toBe(false);
  expect((result.body as Failure).error.code).toBe(code);
  return (result.body as Failure).error;
}
function steps(ids: string[], criteria = false) {
  return ids.map((step_id, index) => ({
    step_id,
    text: index === 0 ? 'implement middleware' : 'write docs',
    label: index === 0 ? 'Implement middleware' : 'Write docs',
    acceptance_criteria:
      criteria && index === 0
        ? [{ criterion_id: uuidv7(), text: 'limit-exceeded path tested' }]
        : [],
  }));
}
async function claimed(f: Awaited<ReturnType<typeof fixture>>) {
  const ids = [uuidv7(), uuidv7()];
  const plan = steps(ids, true);
  const criterionId = plan[0].acceptance_criteria[0].criterion_id;
  const artifactId = await f.capture(undefined, {
    steps: plan,
    touchedScope: ['payments'],
    nonGoals: [{ text: 'no auth changes', rationale: 'separate slice', source_refs: [] }],
  });
  await f.mutate(artifactId, { claim: ids[0] }, async (semantics) => {
    const head = f.registeredContext.binding.git_context.head_sha!;
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [ids[0]] },
      { idempotencyKey: uuidv7(), headSha: head }
    );
    if (!('checkpoint' in opened)) throw new Error('Fixture checkpoint did not open');
    return semantics.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: opened.checkpoint.n,
        head_sha: head,
        summary: 'middleware wired',
        files_changed: ['src/mw.ts'],
        completed_step_ids: [ids[0]],
        decisions: [],
        uncertainty: [],
        done_criteria: [{ criterion_id: criterionId, evidence: 'limit test green' }],
        verification: [{ command: 'test fixture', exit_code: 0 }],
      },
      { idempotencyKey: uuidv7() }
    );
  });
  return { artifactId, ids, criterionId };
}
function damage(f: Awaited<ReturnType<typeof fixture>>, artifactId: string) {
  const database = new Database(f.writer.databasePath);
  try {
    const triggers = database
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='artifact_events'"
      )
      .all() as Array<{ name: string; sql: string }>;
    database.pragma('foreign_keys = OFF');
    database.transaction(() => {
      for (const trigger of triggers)
        database.exec('DROP TRIGGER "' + trigger.name.replaceAll('"', '""') + '"');
      database
        .prepare(
          "UPDATE artifact_events SET record_bytes = CAST(record_bytes || ' ' AS BLOB) WHERE artifact_id=? AND ordinal=(SELECT MAX(ordinal) FROM artifact_events WHERE artifact_id=?)"
        )
        .run(artifactId, artifactId);
      for (const trigger of triggers) database.exec(trigger.sql);
    })();
  } finally {
    database.close();
  }
}

describe('orcaops step brief', { timeout: 30_000 }, () => {
  it('renders a claimed step with criterion-keyed evidence, guardrails and sibling claim states', async () => {
    const f = await fixture();
    const { artifactId, ids, criterionId } = await claimed(f);
    const before = await inventory(f.temporary);
    const out = ok(await brief(f, ids[0]));
    expect(out).toMatchObject({
      schema_version: 3,
      project_id: f.authority.projectId,
      artifact_id: artifactId,
      origin: null,
      step: {
        step_id: ids[0],
        label: 'Implement middleware',
        dropped_in_latest_revision: false,
        last_present_revision_n: 0,
      },
      claim_state: { state: 'claimed', checkpoint_n: 1 },
      related_closed_checkpoints: [
        {
          n: 1,
          summary: 'middleware wired',
          done_criteria: [{ criterion_id: criterionId, evidence: 'limit test green' }],
        },
      ],
      guardrails: {
        touched_scope: ['payments'],
        non_goals: [expect.objectContaining({ text: 'no auth changes' })],
      },
      siblings: [{ step_id: ids[1], label: 'Write docs', claim_state: { state: 'unclaimed' } }],
      candidates: [artifactId],
      source_version: { artifact: { generation: 2 }, execution: 2 },
      completeness: { complete: true },
    });
    expect(out.note).toBeUndefined();
    const human = await agentFor(f).runRaw(['step', 'brief', ids[0]]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`Step brief — Implement middleware (artifact ${artifactId})`);
    expect(human.stdout).toContain('claim state:  claimed by cp #1');
    expect(human.stdout).toContain('evidence: limit test green');
    expect(human.stdout).toContain('- Write docs: unclaimed');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('renders a dropped step from its last-present revision as informational-only', async () => {
    const f = await fixture();
    const { artifactId, ids, criterionId } = await claimed(f);
    const revision = {
      idempotency_key: uuidv7(),
      artifact_id: artifactId,
      label: 'step-brief-fixture (docs cut)',
      plan_steps: [
        {
          step_id: ids[0],
          text: 'implement middleware',
          label: 'Implement middleware',
          acceptance_criteria: [{ criterion_id: criterionId, text: 'limit-exceeded path tested' }],
        },
      ],
      touched_scope: ['payments'],
      non_goals: [],
      decisions: [],
      rationale: 'docs moved to a separate artifact',
      prior_plan_event_id: null,
      acknowledge_drops_completed_steps: [],
      acknowledge_criteria_changes: [],
    };
    await f.mutate(artifactId, revision, (semantics) =>
      semantics.revisePlan(revision, { idempotencyKey: revision.idempotency_key })
    );
    const before = await inventory(f.temporary);
    const out = ok(await brief(f, ids[1]));
    expect(out.step).toMatchObject({
      step_id: ids[1],
      label: 'Write docs',
      dropped_in_latest_revision: true,
      last_present_revision_n: 0,
    });
    expect(out.claim_state).toEqual({ state: 'not_claimable_dropped' });
    expect(out.note).toMatch(/informational-only/);
    expect(out.siblings.map((sibling) => sibling.step_id)).toEqual([ids[0]]);
    expect(out.source_version.artifact.generation).toBe(
      readProjectArtifact(f.writer, artifactId)!.revision.generation
    );
    const human = await agentFor(f).runRaw(['step', 'brief', ids[1]]);
    expect(human.stdout).toContain('DROPPED:      last present in revision 0');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('qualifies historical ambiguity and resolves --artifact among the containing artifacts only', async () => {
    const f = await fixture();
    const a = await f.capture(undefined, { steps: steps([legacyStep, uuidv7()]) });
    const b = await f.capture(undefined, { steps: steps([legacyStep]), reason: 'imported' });
    const unrelated = await f.capture();
    const before = await inventory(f.temporary);
    const ambiguous = failed(await brief(f, legacyStep), 'AMBIGUOUS_ARTIFACT');
    expect(ambiguous.history_candidates).toEqual(
      [a, b].sort().map((id) => ({
        id,
        project_id: f.authority.projectId,
        command: `orcaops step brief ${legacyStep} --artifact ${id} --project ${f.authority.projectId}`,
      }))
    );
    const imported = ok(await brief(f, legacyStep, ['--artifact', b]));
    expect(imported).toMatchObject({ artifact_id: b, origin: 'git-import' });
    const human = await agentFor(f).runRaw(['step', 'brief', legacyStep, '--artifact', b]);
    expect(human.stdout).toContain('origin:       imported from git history (synthesized)');
    expect(human.stdout).toContain(`candidates:   ${[a, b].sort().join(', ')} (selected ${b})`);
    const chosen = [a, b].sort()[0];
    const other = [a, b].sort()[1];
    const prefix = [...Array(chosen.length).keys()]
      .map((length) => chosen.slice(0, length + 1))
      .find((candidate) => !other.startsWith(candidate) && !unrelated.startsWith(candidate))!;
    expect(ok(await brief(f, legacyStep, ['--artifact', prefix])).artifact_id).toBe(chosen);
    const wrong = failed(await brief(f, legacyStep, ['--artifact', unrelated]), 'INVALID_INPUT');
    expect(wrong.message).toContain(`has no plan step "${legacyStep}"`);
    failed(await brief(f, '01890000-0000-7000-8000-000000000000'), 'INVALID_INPUT');
    failed(await brief(f, ''), 'INVALID_INPUT');
    // Commander rejects the retired option before the action runs and emits no JSON.
    const rejected = await agentFor(f).runRaw([
      'step',
      'brief',
      legacyStep,
      '--scope',
      'project',
      '--json',
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('decodes only the selected artifact and refuses missing derived membership without repair', async () => {
    const f = await fixture();
    const target = await f.capture();
    const stepId = readProjectArtifact(f.writer, target)!.thread.plan!.plan_steps[0].step_id;
    const damaged = await f.capture();
    damage(f, damaged);
    const before = await inventory(f.temporary);
    const show = await agentFor(f).runRaw(['show', damaged, '--json']);
    expect(show.exitCode).toBe(1);
    expect(JSON.parse(show.stdout).error.code).toBe('HISTORY_INTEGRITY_REQUIRED');
    expect(ok(await brief(f, stepId)).artifact_id).toBe(target);
    expect(await inventory(f.temporary)).toEqual(before);
    const raw = new Database(projectDatabasePath(f.authority));
    raw.prepare('DELETE FROM artifact_plan_step_history WHERE artifact_id=?').run(damaged);
    raw.close();
    const missing = await inventory(f.temporary);
    failed(await brief(f, stepId), 'HISTORY_INTEGRITY_REQUIRED');
    expect(await inventory(f.temporary)).toEqual(missing);
  });

  it('reads with explicit project qualification outside Git and reports missing history without initialization', async () => {
    const f = await fixture();
    const target = await f.capture();
    const stepId = readProjectArtifact(f.writer, target)!.thread.plan!.plan_steps[0].step_id;
    const outside = { main: f.temporary, root: f.root };
    expect(ok(await brief(outside, stepId, ['--project', f.authority.projectId])).artifact_id).toBe(
      target
    );
    failed(await brief(outside, stepId), 'PROJECT_REQUIRED');
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    failed(await brief(f, stepId), 'HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
