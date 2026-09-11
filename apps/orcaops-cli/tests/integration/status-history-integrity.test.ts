import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { HistoryScopeError, type HistorySelector } from '@orcaops/project-scope/history';
import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath, readProjectArtifact } from '@orcaops/storage/history/database';

import { publishProjectLifecycleCompletion } from '../../../../packages/storage/dist/history/database/capture-lifecycles.js';
import { createDatabaseStatusAction } from '../../src/commands/status.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

afterEach(() => vi.restoreAllMocks());

it('keeps unavailable imported counts unknown outside a selected project', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const action = createDatabaseStatusAction({
    openContext: async () => {
      throw new HistoryScopeError('PROJECT_REQUIRED', 'Select original project');
    },
  });
  await action({ json: true });
  const result = JSON.parse(String(stdout.mock.calls[0][0]));
  expect(result.history.complete).toBe(false);
  expect(result.imported_artifacts.count).toBeNull();
  expect(result.imported_artifacts.known_count).toBe(0);
});

it('retains copied selectors and JSON preference while context resolution is pending', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  let reject!: (error: Error) => void;
  const openContext = vi.fn(
    (_selector: HistorySelector, _env: NodeJS.ProcessEnv) =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      })
  );
  const action = createDatabaseStatusAction({ openContext });
  const options = { project: uuidv7(), branch: 'original', json: true };
  const original = { ...options };
  const pending = action(options);
  options.project = uuidv7();
  options.branch = 'later';
  options.json = false;
  reject(new HistoryScopeError('PROJECT_REQUIRED', 'Original target unavailable'));
  await expect(pending).rejects.toMatchObject({ code: 1 });
  expect(openContext.mock.calls[0][0]).toEqual({
    scope: undefined,
    projectId: original.project,
    branch: 'original',
  });
  expect(JSON.parse(String(stdout.mock.calls[0][0])).error.code).toBe('PROJECT_REQUIRED');
});

for (const remove of [false, true]) {
  it(
    remove
      ? 'reports retained lifecycle receipts whose selected history has disappeared'
      : 'reads a retained lifecycle completion without altering its history',
    async () => {
      const f = await fixture();
      const artifactId = await f.capture();
      const bytes = Buffer.from(' {"fires_at":"pre-pr","cp_n":0,"triggered_at":"original time"}\n');
      const operationId = uuidv7();
      await publishProjectLifecycleCompletion(
        f.writer,
        {
          artifactId,
          operationId,
          revisionId: uuidv7(),
          artifactRevision: readProjectArtifact(f.writer, artifactId)!.revision,
          expectedSelection: null,
          source: {
            identity: 'Original lifecycle',
            locator: 'sqlite:evaluator_lifecycles#0',
            revisionId: null,
            eventId: null,
            operationId: null,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          bytes,
        },
        { secretAllow: [] }
      );
      if (remove) {
        const db = new Database(projectDatabasePath(f.authority));
        const triggers = db
          .prepare(
            "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('artifact_lifecycle_current','artifact_lifecycle_revisions')"
          )
          .all() as { name: string; sql: string }[];
        for (const trigger of triggers)
          db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
        db.exec('DELETE FROM artifact_lifecycle_current; DELETE FROM artifact_lifecycle_revisions');
        for (const trigger of triggers) db.exec(trigger.sql);
        expect(
          db.prepare('SELECT operation_id FROM operations WHERE operation_id=?').get(operationId)
        ).toBeTruthy();
        db.close();
      }
      const before = await inventory(f.temporary);
      const run = await makeAgent({
        cwd: f.main,
        env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['status', '--json']);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(await inventory(f.temporary)).toEqual(before);
      expect(result.history.complete).toBe(!remove);
      if (remove) {
        expect(result.history.issues).toContainEqual(
          expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
        );
        expect(result.eligible_tasks).toEqual([]);
      } else
        expect(result.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual([
          artifactId,
        ]);
    },
    30_000
  );
}
