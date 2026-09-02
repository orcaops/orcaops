import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { withCleanSession } from '../support/test-helpers.js';

/**
 * Row-origin id containment, driven through the production read paths.
 *
 * The U0 sweep proved SQLite-row artifact ids reach write and delete sinks:
 * gc's candidate scan feeds deleteArtifact's recursive rm, sync's
 * branch-lineage pass feeds appendBranchLineage, and the single-active
 * resolver feeds capture writes. These tests poison the ROW — the way a
 * corrupted or attacker-written cache would — and drive each real command,
 * so they fail if any of those paths ever stops flowing through the
 * validating sink (not merely if the sink itself keeps validating).
 */

const EVIL_ROW_ID = '../../victim-artifact';
const UNREACHABLE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('row-origin id refusal at the production paths', () => {
  let repo: TempRepo;
  let victimDir: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const init = makeAgent({ cwd: repo.path, env: withCleanSession({}) });
    await init.init({ noLlm: true });
    // Where `<artifacts.path>/<EVIL_ROW_ID>` would land if the id were ever
    // joined into a path: plant a marker to prove nothing touches it.
    victimDir = path.join(repo.path, 'victim-artifact');
    await mkdir(victimDir, { recursive: true });
    await writeFile(path.join(victimDir, 'marker.txt'), 'survives', 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function agent(): ReturnType<typeof makeAgent> {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ ORCAOPS_DISABLE_DRAIN: '1' }),
    });
  }

  /** Poison the cache the way corruption would: raw rows, no API validation. */
  async function seedPoisonedRow(): Promise<void> {
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      store.store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: EVIL_ROW_ID,
        branch: 'main',
        task: 'poisoned row',
        agent: 'claude',
        base_sha: UNREACHABLE_SHA,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: null,
        status: 'active',
      });
      store.store.db
        .prepare(
          `INSERT OR REPLACE INTO lineage_by_latest_sha (artifact_id, latest_lineage_sha, branch_name)
           VALUES (?, ?, ?)`
        )
        .run(EVIL_ROW_ID, UNREACHABLE_SHA, 'main');
      // The single-active resolver lists by lineage_branches, not by the
      // latest-sha index — poison both, as a real lineage write would.
      store.store.db
        .prepare(`INSERT OR REPLACE INTO lineage_branches (artifact_id, branch_name) VALUES (?, ?)`)
        .run(EVIL_ROW_ID, 'main');
    } finally {
      store.close();
    }
  }

  it('gc --apply refuses uncertain artifact state without deleting the candidate', async () => {
    await seedPoisonedRow();
    const res = await agent().runRaw(['gc', '--apply', '--json']);
    expect(res.exitCode).not.toBe(0);
    const env = JSON.parse(res.stdout) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(env.error.code).toBe('GC_STORAGE_UNCERTAIN');
    expect(env.error.message).toContain('artifact_state_inspection');
    await expect(access(path.join(victimDir, 'marker.txt'))).resolves.toBeUndefined();
  });

  it('sync: the branch-lineage pass feeds appendBranchLineage, which refuses the traversing id', async () => {
    await seedPoisonedRow();
    // latest_lineage_sha differs from HEAD, so pass 1 rewrites lineage for
    // every row on the branch — including the poisoned one.
    const res = await agent().runRaw(['lineage', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/path segment|containment/i);
    await expect(access(path.join(victimDir, 'marker.txt'))).resolves.toBeUndefined();
  });

  it('capture summary: the single-active resolver refuses the traversing id before any write', async () => {
    await seedPoisonedRow();
    // No artifact_id in the payload: the resolver auto-targets the single
    // in-flight row on the branch — the poisoned one.
    const res = await agent().runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({ idempotency_key: `sum-${randomUUID()}`, outcome: 'poisoned-row probe' })
      ),
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/path segment|containment/i);
    await expect(access(path.join(victimDir, 'marker.txt'))).resolves.toBeUndefined();
  });
});
