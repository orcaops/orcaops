import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArtifactStore } from '../artifacts/store.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

function productionStorageSources(): Array<{ file: string; source: string }> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(target);
    }
  };
  visit(root);
  return files.map((file) => ({
    file: path.relative(root, file),
    source: readFileSync(file, 'utf8'),
  }));
}

/**
 * Honest cloud_sync — the targeted, cap-free per-artifact probe
 * (`getCloudSyncStateForArtifact`) + the exact pending count
 * (`countCloudSyncPendingArtifacts`) the classifier reads as ground truth.
 */
describe('Store — cloud-sync state probe', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-0000000000a1';
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

  async function writePlan(id: string, imported = false): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4 as const,
        artifact_id: id,
        branch,
        base_sha: 'abc123',
        agent: 'claude-code' as const,
        agent_session_id: null,
        task: 'do the thing',
        label: `do-thing-${id.slice(-4)}`,
        plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
        ...(imported
          ? {
              origin: {
                kind: 'git-import' as const,
                imported_at: '2026-04-26T13:00:00.000Z',
                tool_version: '0.0.5',
                source_range: 'main~1..main',
                authors: ['dev@example.com'],
                enriched_at: null,
              },
            }
          : {}),
      },
      { idempotencyKey: `plan-${id}` }
    );
  }

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    await writePlan(artifactId);
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  it('a freshly-captured artifact is pending, never landed, with no recorded failures', () => {
    expect(store.store.getCloudSyncStateForArtifact(artifactId)).toEqual({
      pending: true,
      syncedAt: null,
      consecutiveFailures: 0,
      lastErrorKind: null,
    });
    expect(store.store.countCloudSyncPendingArtifacts()).toBe(1);
  });

  it('keeps imports out of implicit sync regardless of recorded attempt state', async () => {
    const importedId = '01999999-9999-7000-8000-0000000000a2';
    await writePlan(importedId, true);
    expect(store.store.getCloudSyncStateForArtifact(importedId)).toEqual({
      pending: false,
      // Not pending because imports never enter the drain — and never landed,
      // which is what keeps `cloud_sync` from reporting it as synced.
      syncedAt: null,
      consecutiveFailures: 0,
      lastErrorKind: null,
    });
    expect(store.store.findArtifactsForCloudSyncDrain().included).toEqual([artifactId]);
    expect(store.store.countCloudSyncPendingArtifacts()).toBe(1);

    store.store.recordCloudSyncFailure(importedId, {
      kind: 'http-5xx',
      message: 'legacy direct push failed',
      attemptedAt: '2026-04-26T13:05:00.000Z',
      attemptStartedAt: '2026-04-26T13:05:00.000Z',
    });
    expect(store.store.getCloudSyncStateForArtifact(importedId)?.pending).toBe(false);
    expect(store.store.findArtifactsForCloudSyncDrain({ force: true }).included).not.toContain(
      importedId
    );
    expect(store.store.countCloudSyncPendingArtifacts()).toBe(1);
  });

  it('returns null for an unknown artifact', () => {
    expect(store.store.getCloudSyncStateForArtifact('01999999-9999-7000-8000-deadbeef0000')).toBe(
      null
    );
  });

  it('a recorded failure bumps consecutiveFailures + surfaces the kind, still pending', () => {
    store.store.recordCloudSyncFailure(artifactId, {
      kind: 'http-5xx',
      message: 'boom',
      attemptedAt: '2026-04-26T12:05:00.000Z',
      attemptStartedAt: '2026-04-26T12:05:00.000Z',
    });
    expect(store.store.getCloudSyncStateForArtifact(artifactId)).toEqual({
      pending: true,
      syncedAt: null,
      consecutiveFailures: 1,
      lastErrorKind: 'http-5xx',
    });
  });

  it('a content-invalid failure round-trips as lastErrorKind (drives content_invalid)', () => {
    store.store.recordCloudSyncFailure(artifactId, {
      kind: 'content-invalid',
      message: 'forbidden control character at evaluators.runs[0].raw.output',
      attemptedAt: '2026-04-26T12:05:00.000Z',
      attemptStartedAt: '2026-04-26T12:05:00.000Z',
    });
    expect(store.store.getCloudSyncStateForArtifact(artifactId)).toEqual({
      pending: true,
      syncedAt: null,
      consecutiveFailures: 1,
      lastErrorKind: 'content-invalid',
    });
  });

  it('after a successful sync the artifact records its landed timestamp, and failures clear', () => {
    store.store.recordCloudSyncFailure(artifactId, {
      kind: 'timeout',
      message: null,
      attemptedAt: '2026-04-26T12:05:00.000Z',
      attemptStartedAt: '2026-04-26T12:05:00.000Z',
    });
    store.store.setCloudSyncState(artifactId, {
      syncedAt: '2026-04-26T12:10:00.000Z',
      hash: 'deadbeef',
      externalId: '01999999-9999-7000-8000-0000000000e1',
      orgId: 'org-1',
    });
    expect(store.store.getCloudSyncStateForArtifact(artifactId)).toEqual({
      pending: false,
      syncedAt: '2026-04-26T12:10:00.000Z',
      consecutiveFailures: 0,
      lastErrorKind: null,
    });
    expect(store.store.countCloudSyncPendingArtifacts()).toBe(0);
  });

  it('rotates dirty versions without leaking the private token through the public hash', () => {
    store.store.setCloudSyncState(artifactId, {
      syncedAt: '2026-04-26T12:10:00.000Z',
      hash: 'deadbeef',
      externalId: '01999999-9999-7000-8000-0000000000e1',
      orgId: 'org-1',
    });

    store.store.rotateCloudSyncTokens([artifactId]);
    const first = store.store.getCloudSyncRawHash(artifactId);
    store.store.rotateCloudSyncTokens([artifactId]);
    const second = store.store.getCloudSyncRawHash(artifactId);

    expect(first).toMatch(/^dirty:[^:]+:deadbeef$/);
    expect(second).toMatch(/^dirty:[^:]+:deadbeef$/);
    expect(second).not.toBe(first);
    expect(store.store.getCloudSyncState(artifactId)?.hash).toBe('deadbeef');
  });

  it('conditionally finalizes null and dirty versions but refuses a stale version', () => {
    expect(store.store.getCloudSyncRawHash(artifactId)).toBeNull();
    const firstState = {
      syncedAt: '2026-04-26T12:10:00.000Z',
      hash: 'hash-1',
      externalId: '01999999-9999-7000-8000-0000000000e1',
      orgId: 'org-1',
    };
    expect(store.store.setCloudSyncStateIfCurrent(artifactId, null, firstState)).toBe(true);

    const cleanVersion = store.store.getCloudSyncRawHash(artifactId);
    store.store.rotateCloudSyncTokens([artifactId]);
    const dirtyVersion = store.store.getCloudSyncRawHash(artifactId);
    expect(
      store.store.setCloudSyncStateIfCurrent(artifactId, cleanVersion ?? null, {
        ...firstState,
        syncedAt: '2026-04-26T12:11:00.000Z',
        hash: 'stale',
      })
    ).toBe(false);
    expect(store.store.getCloudSyncRawHash(artifactId)).toBe(dirtyVersion);
    expect(
      store.store.setCloudSyncStateIfCurrent(artifactId, dirtyVersion ?? null, {
        ...firstState,
        syncedAt: '2026-04-26T12:12:00.000Z',
        hash: 'hash-2',
      })
    ).toBe(true);
    expect(store.store.getCloudSyncState(artifactId)?.hash).toBe('hash-2');
  });

  it('keeps payload projection writers behind the token-rotating boundaries', () => {
    const sources = productionStorageSources();
    const projectionWrites = sources.flatMap(({ file, source }) =>
      [
        ...source.matchAll(
          /\b(INSERT(?:\s+OR\s+IGNORE)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(usage_snapshots|source_plan_links)\b/giu
        ),
      ].map((match) => `${file}:${match[1]!.replace(/\s+/gu, ' ').toUpperCase()}:${match[2]}`)
    );
    expect(projectionWrites.sort()).toEqual([
      'store/sqlite.ts:DELETE FROM:source_plan_links',
      'store/sqlite.ts:DELETE FROM:usage_snapshots',
      'store/sqlite.ts:INSERT INTO:source_plan_links',
      'store/sqlite.ts:INSERT OR IGNORE INTO:usage_snapshots',
    ]);

    const eventAppendSites = sources.flatMap(({ file, source }) =>
      [...source.matchAll(/\bappendEvent\s*\(/gu)].map(() => file)
    );
    expect(eventAppendSites.sort()).toEqual([
      'archive/mirror.ts',
      'archive/mirror.ts',
      'artifacts/store.ts',
      'events/event-log.ts',
    ]);
    const durableAppendSites = sources.flatMap(({ file, source }) =>
      [...source.matchAll(/\bappendDurable\s*\(/gu)].map(() => file)
    );
    // Artifact replay rotates cloud-sync tokens; the other two restore Review logs outside that surface.
    expect(durableAppendSites.sort()).toEqual([
      'archive/restore.ts',
      'archive/restore.ts',
      'archive/restore.ts',
      'events/event-log.ts',
      'fs/durable.ts',
      'usage/ledger-log.ts',
    ]);
    const artifactStoreSource = sources.find(({ file }) => file === 'artifacts/store.ts')!.source;
    const rotationAt = artifactStoreSource.indexOf(
      'this.store.rotateCloudSyncTokens([paths.artifactId])'
    );
    const appendAt = artifactStoreSource.indexOf('const event = await appendEvent(input');
    expect(rotationAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(rotationAt);
    const restoreSource = sources.find(({ file }) => file === 'archive/restore.ts')!.source;
    const restoreRotationAt = restoreSource.indexOf(
      'opts.store.store.rotateCloudSyncTokens([opts.artifactId])'
    );
    const restoreAppendAt = restoreSource.indexOf(
      "appendDurable(hotPaths.eventsNdjson, JSON.stringify(record) + '\\n'"
    );
    expect(restoreRotationAt).toBeGreaterThan(-1);
    expect(restoreAppendAt).toBeGreaterThan(restoreRotationAt);
  });
});
