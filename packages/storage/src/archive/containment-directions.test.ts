import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArchiveMirror } from './mirror.js';
import { archiveArtifactPaths, archiveUsageLedgerPaths } from './paths.js';
import { computeMirrorLag, replayMissingEvents } from './repair.js';
import { restoreArtifactFromArchive } from './restore.js';
import { usageLedgerPath, usageSidecarsDir } from '../artifacts/paths.js';
import { ArtifactStore } from '../artifacts/store.js';
import type { EventRecord } from '../events/event-log.js';
import { getDefaultConfig } from '../schema/config.js';
import { appendUsageLedgerRecord } from '../usage/ledger-log.js';

/**
 * Traversal fixtures for every real archive direction: artifact
 * hot→archive mirror, archive→hot restore, usage hot→archive mirror, and
 * archive read/repair. A record id carrying traversal must never place or
 * read a file outside the intended subtree, and repair applies the canonical
 * checksum bar before copying anything.
 */

const EVIL_ID = '../../escape-target';

describe('archive direction containment', () => {
  let base: string;
  let repoRoot: string;
  let projectDir: string;
  let warns: string[];
  let mirror: ArchiveMirror;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'orcaops-dirs-'));
    repoRoot = path.join(base, 'repo');
    projectDir = path.join(base, 'archive', 'projects', '019fc1aa-0000-7000-8000-000000000001');
    await mkdir(repoRoot, { recursive: true });
    warns = [];
    mirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(base, 'locks'),
      redactSecrets: false,
      onWarn: (m) => warns.push(m),
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('hot→archive event mirror refuses a traversing event id (fail-open warn, no outside write)', async () => {
    const record = {
      event_id: EVIL_ID,
      type: 'plan_captured',
      ts: '2026-01-01T00:00:00.000Z',
      schema_version: 1,
      idempotency_key: 'k1',
      sidecar_sha256: 'a'.repeat(64),
      sidecar_size: 2,
      checksum: 'b'.repeat(64),
    } as unknown as EventRecord;
    await mirror.mirrorEventRecord(
      '019fc1aa-0000-7000-8000-0000000000a1',
      record,
      path.join(repoRoot, 'sidecars'),
      repoRoot
    );
    // Fail-open: the mirror warned rather than threw…
    expect(warns.length).toBeGreaterThan(0);
    // …and nothing landed outside the archive tree.
    expect(await exists(path.join(base, 'escape-target.json'))).toBe(false);
    expect(await exists(path.join(base, 'archive', 'escape-target.json'))).toBe(false);
  });

  it('usage hot→archive mirror refuses a traversing event id the same way', async () => {
    const record = {
      event_id: EVIL_ID,
      type: 'source_plan_linked',
      ts: '2026-01-01T00:00:00.000Z',
      schema_version: 1,
      idempotency_key: 'k2',
      sidecar_sha256: 'a'.repeat(64),
      sidecar_size: 2,
      checksum: 'b'.repeat(64),
    } as never;
    await mirror.mirrorUsageRecord(record, path.join(repoRoot, 'sidecars'), repoRoot);
    expect(warns.length).toBeGreaterThan(0);
    expect(await exists(path.join(base, 'escape-target.json'))).toBe(false);
  });

  it('archive→hot restore never copies a hand-crafted traversing record', async () => {
    const artifactId = '019fc1aa-0000-7000-8000-0000000000a2';
    const archivePaths = archiveArtifactPaths(projectDir, artifactId);
    await mkdir(path.dirname(archivePaths.eventsNdjson), { recursive: true });
    // A raw line with a traversing id (as an attacker-controlled archive
    // would carry): the strict read schema rejects it, so the restore either
    // refuses the source or skips the record — in NO case does the id reach
    // a filesystem join.
    await writeFile(
      archivePaths.eventsNdjson,
      JSON.stringify({
        event_id: EVIL_ID,
        type: 'plan_captured',
        ts: '2026-01-01T00:00:00.000Z',
        schema_version: 1,
        idempotency_key: 'k3',
        sidecar_sha256: 'a'.repeat(64),
        sidecar_size: 2,
        checksum: 'b'.repeat(64),
      }) + '\n',
      'utf8'
    );
    const store = new ArtifactStore({ repoRoot, config: getDefaultConfig() });
    try {
      await expect(
        restoreArtifactFromArchive({
          repoRoot,
          config: getDefaultConfig(),
          store,
          projectDir,
          artifactId,
        })
      ).rejects.toThrow();
      expect(await exists(path.join(base, 'escape-target.json'))).toBe(false);
      expect(await exists(path.join(repoRoot, 'escape-target.json'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('repair applies the canonical checksum bar: a schema-valid bad-checksum usage record is never counted or copied', async () => {
    // A legitimate record first, then a corrupted twin whose body was edited
    // after write (schema-valid, checksum stale).
    const hotLedger = usageLedgerPath(repoRoot);
    const hotSidecars = usageSidecarsDir(repoRoot);
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: 'good-1',
        payload: {
          canonical_ref_id: 'cloud:plan-1',
          artifact_id: '019fc1aa-0000-7000-8000-0000000000a3',
          linked_at: '2026-01-01T00:00:00.000Z',
          pinned_version: null,
        },
      },
      { ledgerPath: hotLedger, sidecarsDir: hotSidecars }
    );
    const raw = await readFile(hotLedger, 'utf8');
    const good = JSON.parse(raw.trim()) as Record<string, unknown>;
    const corrupted = {
      ...good,
      event_id: '019fc1aa-0000-7000-8000-00000000bad1',
      idempotency_key: 'tampered-1',
      // checksum left as the GOOD record's — schema-valid, integrity-false.
    };
    await writeFile(raw.trim() ? hotLedger : hotLedger, raw + JSON.stringify(corrupted) + '\n');

    const lag = await computeMirrorLag({
      repoRoot,
      config: getDefaultConfig(),
      projectDir,
    });
    // Only the intact record counts as hot/missing.
    expect(lag.usage.hot_events).toBe(1);
    expect(lag.usage.missing_event_ids).toEqual([good.event_id]);

    const result = await replayMissingEvents({
      repoRoot,
      config: getDefaultConfig(),
      projectDir,
      mirror,
    });
    expect(result.replayed_events).toBeGreaterThanOrEqual(1);
    const archivedRaw = await readFile(archiveUsageLedgerPaths(projectDir).ledgerNdjson, 'utf8');
    expect(archivedRaw).toContain(String(good.event_id));
    expect(archivedRaw).not.toContain('tampered-1');
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    const entries = await readdir(path.dirname(p));
    return entries.includes(path.basename(p));
  } catch {
    return false;
  }
}
