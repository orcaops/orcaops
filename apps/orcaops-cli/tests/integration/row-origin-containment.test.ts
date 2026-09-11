import Database from 'better-sqlite3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const invalidId = '../../victim-artifact';

describe('refusal of invalid retained artifact identities', { timeout: 60_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let marker: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    f = await fixture();
    marker = path.join(f.temporary, 'victim-artifact', 'marker.txt');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, 'survives');
    agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });

  async function poisonStoredIdentity() {
    const artifactId = await f.capture();
    const raw = new Database(f.writer.databasePath, { fileMustExist: true });
    try {
      raw.pragma('foreign_keys = OFF');
      const trigger = raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_revisions_no_update'")
        .get() as { sql: string };
      raw.transaction(() => {
        raw.exec('DROP TRIGGER artifact_revisions_no_update');
        for (const table of [
          'artifacts',
          'artifact_revisions',
          'artifact_metadata',
          'artifact_query_metadata',
          'artifact_branches',
        ])
          raw
            .prepare(`UPDATE ${table} SET artifact_id=? WHERE artifact_id=?`)
            .run(invalidId, artifactId);
        raw.exec(trigger.sql);
      })();
    } finally {
      raw.close();
    }
  }

  it('lineage refuses a traversing identity from a stored query row before any write', async () => {
    await poisonStoredIdentity();
    const before = await inventory(f.temporary);
    const result = await agent.runRaw(['lineage', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'HISTORY_INTEGRITY_REQUIRED' },
    });
    expect(await inventory(f.temporary)).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe('survives');
  });

  it('capture summary refuses a traversing identity discovered on the current branch', async () => {
    await poisonStoredIdentity();
    const before = await inventory(f.temporary);
    const result = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'invalid-discovered-target',
          outcome: 'Attempted summary',
        })
      ),
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'HISTORY_INTEGRITY_REQUIRED' },
    });
    expect(await inventory(f.temporary)).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe('survives');
  });

  it('capture summary refuses a traversing explicit identity before any write', async () => {
    await f.capture();
    const before = await inventory(f.temporary);
    const result = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'invalid-summary-target',
          artifact_id: invalidId,
          outcome: 'Attempted summary',
        })
      ),
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_ARTIFACT' },
    });
    expect(await inventory(f.temporary)).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe('survives');
  });
});
