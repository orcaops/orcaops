import Database from 'better-sqlite3';
import { expect } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { fixture, git } from './database-history.js';
import { makeAgent } from '../support/test-agent.js';

export async function insightFixture(root?: string) {
  const f = await fixture(root);
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_ROOT: f.main, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const id = await f.capture(undefined, {
    ts: '2026-01-01T00:00:00.000Z',
    decisions: [
      { decision: 'Use retained records', reason: 'Keep original provenance', revision_n: 0 },
    ],
  });
  return { ...f, agent, id };
}
export async function closeWithFindings(
  f: Awaited<ReturnType<typeof insightFixture>>,
  artifactId = f.id,
  complete = false
) {
  const verification = complete ? await git(f.main, ['rev-parse', '--is-inside-work-tree']) : null;
  await f.mutate(artifactId, { summary: 'Finished retained work' }, async (semantics) => {
    const plan = (await semantics.readPlan(artifactId))!;
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [plan.plan_steps[0].step_id] },
      { idempotencyKey: uuidv7(), headSha: plan.base_sha! }
    );
    if (!('checkpoint' in opened)) throw new Error('Checkpoint did not open');
    await semantics.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: opened.checkpoint.n,
        summary: 'Finished retained work',
        head_sha: plan.base_sha!,
        files_changed: ['src/retained.ts'],
        completed_step_ids: complete ? [plan.plan_steps[0].step_id] : [],
        done_criteria: [],
        verification: verification
          ? [
              {
                command: 'git rev-parse --is-inside-work-tree',
                exit_code: 0,
                output_digest: verification.stdout.trim(),
              },
            ]
          : [],
        decisions: [
          { decision: 'Use checkpoint evidence', reason: 'Explain the implementation choice' },
        ],
        uncertainty: complete ? [] : ['Confirm future integration'],
      },
      { idempotencyKey: uuidv7() }
    );
  });
}
export async function summarize(
  f: Awaited<ReturnType<typeof insightFixture>>,
  artifactId = f.id,
  complete = false
) {
  await f.mutate(artifactId, { outcome: 'Retained result' }, (semantics) =>
    semantics.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'Retained result',
      tests_written: [],
      tests_run: [],
      open_items: complete ? [] : ['Still owed'],
      deferred_decisions: complete ? [] : ['Deferred choice'],
      head_sha: f.registeredContext.binding.git_context.head_sha!,
      ts: '2026-09-01T00:00:00.000Z',
    })
  );
}
export function parseOk(result: { exitCode: number; stdout: string; stderr: string }) {
  expect(result.exitCode, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toMatchObject({ ok: true, schema_version: 3 });
  return parsed;
}
export function damageArtifact(
  f: Awaited<ReturnType<typeof insightFixture>>,
  artifactId = f.id,
  removeTail = false
) {
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
      if (removeTail)
        database
          .prepare(
            'DELETE FROM artifact_events WHERE artifact_id=? AND ordinal=(SELECT MAX(ordinal) FROM artifact_events WHERE artifact_id=?)'
          )
          .run(artifactId, artifactId);
      else
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
