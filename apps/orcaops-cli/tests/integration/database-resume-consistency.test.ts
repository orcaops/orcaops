import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryOverview } from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';

import { publishProjectExecutionFocus } from '../../../../packages/storage/dist/history/database/execution-focus.js';
import { resolveDatabaseHistoryCommandContext } from '../../src/lib/database-history-context.js';
import { readDatabaseResume } from '../../src/lib/database-resume.js';
import { readDatabaseShowTarget } from '../../src/lib/database-show.js';
import { fixture } from '../helpers/database-history.js';

async function context(f: Awaited<ReturnType<typeof fixture>>) {
  return resolveDatabaseHistoryCommandContext({
    profile: 'resume',
    cwd: f.main,
    checkoutRoot: f.main,
    dataRoot: f.root,
    env: {},
  });
}
describe('retained resume selection', { timeout: 30_000 }, () => {
  it('rejects an intervening publication instead of retargeting its original task selection', async () => {
    const f = await fixture();
    const id = await f.capture();
    const c = await context(f);
    const original = Database.prototype.exec;
    let publication: ReturnType<typeof publishProjectExecutionFocus> | undefined;
    let changed = false;
    const observing = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const result = original.call(this, sql);
      if (!changed && sql === 'COMMIT') {
        changed = true;
        publication = publishProjectExecutionFocus(f.writer, {
          action: 'clear',
          operationId: uuidv7(),
          expectedSelection: null,
          secretAllow: [],
          scope: {
            rootKey: f.authority.rootKey,
            projectId: f.authority.projectId,
            storeInstanceId: f.authority.storeInstanceId,
            repositoryInstanceId: f.authority.repositoryInstanceId,
            worktreeId: f.context.worktreeId!,
            shellKey: { kind: 'codex_session', value: 'intervening-session' },
          },
        });
      }
      return result;
    });
    try {
      await expect(readDatabaseResume(c, {}, {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
      expect(changed).toBe(true);
      expect((await publication)?.replayed).toBe(false);
      observing.mockRestore();
      expect(await readDatabaseResume(c, { artifact: id }, {})).toMatchObject({
        resolved: true,
        artifact_id: id,
      });
    } finally {
      observing.mockRestore();
      c.scope.close();
    }
  });
  it('renders one genuine selected overview without resolving or reading SQLite again', async () => {
    const f = await fixture();
    const id = await f.capture();
    const c = await context(f);
    const target = resolveDatabaseHistoryOverview(c.scope, id);
    const original = structuredClone(target);
    const calls = vi.spyOn(Database.prototype, 'exec');
    try {
      const rendered = await readDatabaseShowTarget(c, target);
      expect(rendered.artifact.id).toBe(id);
      expect(rendered.artifact.source_version).toEqual(target.artifact.revision);
      expect(calls.mock.calls.filter(([sql]) => /^BEGIN/iu.test(sql))).toEqual([]);
      expect(structuredClone(target)).toEqual(original);
    } finally {
      calls.mockRestore();
      c.scope.close();
    }
  });
});
