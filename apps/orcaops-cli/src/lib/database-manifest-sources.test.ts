import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import type { ArtifactThread, ClosedCheckpoint } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import { hydrateHistoryThreads, requireRepositoryScope } from './database-branch-history.js';
import { collectBranchHistory } from './database-branch-history.js';
import {
  adjudicateThreadOverlap,
  EMPTY_OVERLAP_SUPPORT,
  loadDatabaseManifestSources,
  readDatabaseOverlapSupport,
  recordedOverlapSiblings,
  retainedCheckpointManifest,
} from './database-manifest-sources.js';
import {
  closeFingerprintedCheckpoint,
  commitFile,
} from '../../tests/helpers/database-fingerprint.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
  vi.restoreAllMocks();
});
async function openScope(f: Awaited<ReturnType<typeof fixture>>) {
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: 'git-history',
    selector: {},
  });
  readers.add(scope);
  return scope;
}
async function threadsOf(f: Awaited<ReturnType<typeof fixture>>, ids: string[]) {
  const scope = await openScope(f);
  const collection = collectBranchHistory(scope, { profile: 'versions' });
  const entries = collection.entries.filter((entry) => ids.includes(entry.row.artifactId));
  return { scope, hydrated: hydrateHistoryThreads(scope, entries) };
}
const closedOf = (thread: ArtifactThread, n: number) =>
  thread.checkpoints.find(
    (checkpoint): checkpoint is ClosedCheckpoint =>
      checkpoint.n === n && checkpoint.status === 'closed'
  )!;

describe('database manifest sources', { timeout: 60_000 }, () => {
  it('reads manifests only from retained closed payloads and keeps skipped closes file-level', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    const fingerprinted = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    await f.recordFiles(id, ['src/skipped.ts'], head);
    const before = await inventory(f.temporary);
    const { hydrated } = await threadsOf(f, [id]);
    expect(hydrated.skipped).toEqual([]);
    const thread = hydrated.threads[0].thread;
    const manifest = await retainedCheckpointManifest(thread, closedOf(thread, fingerprinted.n));
    expect(manifest).not.toBeNull();
    expect(manifest!.hunks.map((hunk) => hunk.file_after)).toEqual(['src/a.ts']);
    expect(manifest!.open_tree_sha).toBe(fingerprinted.openTree);
    const result = await loadDatabaseManifestSources([thread]);
    expect(result.sources.map((source) => [source.checkpoint_n, source.ts])).toEqual([
      [fingerprinted.n, closedOf(thread, fingerprinted.n).closed_at],
    ]);
    expect(result.checkpointGranularity).toEqual({
      [`${id}:${fingerprinted.n}`]: 'hunk',
      [`${id}:${fingerprinted.n + 1}`]: 'file',
    });
    expect(result.manifestless).toEqual([
      { artifact_id: id, checkpoint_n: fingerprinted.n + 1, files_changed: ['src/skipped.ts'] },
    ]);
    expect(result.incompatibleCount).toBe(0);
    expect(result.overlapAdjudications.size).toBe(0);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('rejects inconsistent evidence while retaining explicit inspection of a recovered window', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    const { hydrated } = await threadsOf(f, [id]);
    const original = hydrated.threads[0].thread;
    for (const field of ['artifact_id', 'checkpoint_n', 'summary'] as const) {
      const thread = structuredClone(original);
      const checkpoint = closedOf(thread, close.n);
      const payload = thread.events.find(
        (event) => event.record.event_id === checkpoint.source_event_ids.closed
      )!.payload as {
        diff_fingerprint_manifest: { artifact_id: string; checkpoint_n: number };
      };
      if (field === 'artifact_id')
        payload.diff_fingerprint_manifest.artifact_id = '00000000-0000-7000-8000-000000000001';
      else if (field === 'checkpoint_n') payload.diff_fingerprint_manifest.checkpoint_n += 1;
      else checkpoint.diff_fingerprint_summary.captured_hunk_count += 1;
      const before = structuredClone(thread);
      expect(await retainedCheckpointManifest(thread, checkpoint)).toBeNull();
      expect(await loadDatabaseManifestSources([thread])).toMatchObject({
        sources: [],
        incompatibleCount: 1,
      });
      expect(thread).toEqual(before);
    }
    const recovered = structuredClone(original);
    const checkpoint = closedOf(recovered, close.n);
    checkpoint.open_snapshot.tree_sha = close.closeTree;
    expect(await retainedCheckpointManifest(recovered, checkpoint)).not.toBeNull();
    expect(await loadDatabaseManifestSources([recovered])).toMatchObject({
      sources: [],
      incompatibleCount: 1,
    });
    const planPayload = recovered.events.find((event) => event.record.type === 'plan_captured')!
      .payload as {
      baseline_seed_tree_sha?: string;
    };
    planPayload.baseline_seed_tree_sha = close.openTree;
    expect((await loadDatabaseManifestSources([recovered])).sources).toHaveLength(1);
    expect((await loadDatabaseManifestSources([original])).sources).toHaveLength(1);
  });

  it('marks a retained manifest hash without a manifest incompatible instead of manifestless', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/hashed.ts', 'export const hashed = true;\n');
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/hashed.ts'],
      openRef: base,
      closeRef: head,
      withoutManifest: true,
    });
    const { hydrated } = await threadsOf(f, [id]);
    const thread = hydrated.threads[0].thread;
    const checkpoint = closedOf(thread, close.n);
    expect(checkpoint.diff_fingerprint_summary.manifest_hash).not.toBeNull();
    expect(await retainedCheckpointManifest(thread, checkpoint)).toBeNull();
    const result = await loadDatabaseManifestSources([thread]);
    expect(result.incompatibleCount).toBe(1);
    expect(result.checkpointGranularity[`${id}:${close.n}`]).toBe('incompatible');
    expect(result.sources).toEqual([]);
    expect(result.manifestless).toEqual([]);
  });

  it('replays overlap and unmerged removals without resurrecting dropped hunks', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    const head = await commitFile(f, 'src/b.ts', 'export const b = 2;\n');
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts', 'src/b.ts'],
      openRef: base,
      closeRef: head,
    });
    const { hydrated } = await threadsOf(f, [id]);
    const original = hydrated.threads[0].thread;
    expect(
      (await retainedCheckpointManifest(original, closedOf(original, close.n)))!.hunks.map(
        (hunk) => hunk.file_after
      )
    ).toEqual(['src/a.ts', 'src/b.ts']);
    const overlapped = structuredClone(original);
    closedOf(overlapped, close.n).window_overlap = {
      siblings: [],
      cross_artifact_siblings: [],
      pending: false,
      dropped_files: [{ file_before: null, file_after: 'src/b.ts', status: 'unclaimed' }],
      rejected_claims: [],
      ambiguous_files: [],
      mixed_segment: [],
      own_claim_pending: [],
      segment_attributed: [],
      unattributed_in_window: [],
      degradations: [],
    };
    const replayed = await loadDatabaseManifestSources([overlapped]);
    expect(replayed.sources[0].manifest.hunks.map((hunk) => hunk.file_after)).toEqual(['src/a.ts']);
    expect(replayed.overlapAdjudications.get(`${id}:${close.n}`)).toMatchObject({
      finalized: true,
      unreadableSiblingArtifacts: [],
    });
    const degraded = structuredClone(original);
    closedOf(degraded, close.n).attribution_degraded = { unmerged_paths: ['src/a.ts'] };
    expect(
      (await loadDatabaseManifestSources([degraded])).sources[0].manifest.hunks.map(
        (hunk) => hunk.file_after
      )
    ).toEqual(['src/b.ts']);
  });

  it('reads a manifest that spilled to a sidecar record', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(
      f,
      'src/wide.ts',
      Array.from({ length: 600 }, (_, line) => `export const value${line} = ${line};`).join('\n') +
        '\n'
    );
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/wide.ts'],
      openRef: base,
      closeRef: head,
    });
    const raw = new Database(projectDatabasePath(f.authority));
    const spilled = raw
      .prepare(
        'SELECT count(*) AS n FROM artifact_events WHERE artifact_id=? AND sidecar_payload_bytes IS NOT NULL'
      )
      .get(id) as { n: number };
    raw.close();
    expect(spilled.n).toBe(1);
    const { hydrated } = await threadsOf(f, [id]);
    const thread = hydrated.threads[0].thread;
    const manifest = await retainedCheckpointManifest(thread, closedOf(thread, close.n));
    expect(manifest).not.toBeNull();
    expect(manifest!.hunks[0].added_line_count).toBe(600);
    expect((await loadDatabaseManifestSources([thread])).checkpointGranularity).toEqual({
      [`${id}:${close.n}`]: 'hunk',
    });
  });

  it('hydrates only recorded siblings within the support budget and folds omissions as unreadable', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const owner = await f.capture();
    const sibling = await f.capture();
    await f.capture();
    const head = await commitFile(f, 'src/shared.ts', 'export const shared = 1;\n');
    await f.recordFiles(sibling, ['src/shared.ts'], head);
    const close = await closeFingerprintedCheckpoint(f, owner, {
      files: ['src/shared.ts'],
      openRef: base,
      closeRef: head,
      crossArtifactSiblings: [{ artifact_id: sibling, n: 1 }],
    });
    const before = await inventory(f.temporary);
    const { scope, hydrated } = await threadsOf(f, [owner]);
    const thread = hydrated.threads[0].thread;
    expect(closedOf(thread, close.n).window_overlap?.cross_artifact_siblings).toEqual([
      { artifact_id: sibling, n: 1 },
    ]);
    expect(recordedOverlapSiblings([thread])).toEqual([sibling]);
    const { database } = requireRepositoryScope(scope);
    const statements: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      statements.push(sql);
      return prepare.call(this, sql);
    });
    const support = readDatabaseOverlapSupport(database, [thread]);
    vi.restoreAllMocks();
    expect(
      statements.filter((sql) => /FROM artifact_events/u.test(sql) && /record_bytes/u.test(sql))
    ).toHaveLength(1);
    expect([...support.siblings.keys()]).toEqual([sibling]);
    expect(support.omitted).toEqual([]);
    const adjudication = adjudicateThreadOverlap(thread, support).get(close.n)!;
    expect(adjudication.finalized).toBe(true);
    expect(adjudication.unreadableSiblingArtifacts).toEqual([]);
    expect(adjudication.ambiguous.map((file) => file.file_after ?? file.file_before)).toContain(
      'src/shared.ts'
    );
    const capped = readDatabaseOverlapSupport(database, [thread], 0);
    expect(capped.omitted).toEqual([sibling]);
    expect([...capped.unavailable]).toEqual([sibling]);
    const provisional = adjudicateThreadOverlap(thread, capped).get(close.n)!;
    expect(provisional.finalized).toBe(false);
    expect(provisional.unreadableSiblingArtifacts).toEqual([sibling]);
    expect(
      (await loadDatabaseManifestSources([thread], EMPTY_OVERLAP_SUPPORT)).overlapAdjudications.get(
        `${owner}:${close.n}`
      )
    ).toMatchObject({ finalized: false, unreadableSiblingArtifacts: [sibling] });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  // The containment rule the retired enumeration helper used to state: a rotted
  // artifact degrades its OWN row, but only for the refusals that mean rot.
  // Anything else — a programming error, a containment violation — must abort
  // the sweep, because folding it into `unavailable` reports a healthy corpus
  // as partially unreadable and hides the real fault.
  it('aborts the sibling sweep on an error that does not mean a rotted artifact', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const owner = await f.capture();
    const sibling = await f.capture();
    const head = await commitFile(f, 'src/shared.ts', 'export const shared = 1;\n');
    await f.recordFiles(sibling, ['src/shared.ts'], head);
    await closeFingerprintedCheckpoint(f, owner, {
      files: ['src/shared.ts'],
      openRef: base,
      closeRef: head,
      crossArtifactSiblings: [{ artifact_id: sibling, n: 1 }],
    });
    const { scope, hydrated } = await threadsOf(f, [owner]);
    const thread = hydrated.threads[0].thread;
    const { database } = requireRepositoryScope(scope);

    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (/FROM artifact_events/u.test(sql) && /record_bytes/u.test(sql)) {
        throw new TypeError('sibling hydration is broken');
      }
      return prepare.call(this, sql);
    });
    expect(() => readDatabaseOverlapSupport(database, [thread])).toThrow(TypeError);
  });
});
