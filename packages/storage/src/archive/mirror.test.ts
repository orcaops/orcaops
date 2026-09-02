import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArchiveMirror, reviewEventIdentity } from './mirror.js';
import {
  archiveArtifactPaths,
  archiveProjectDir,
  archiveReviewPaths,
  archiveUsageLedgerPaths,
} from './paths.js';
import { loadArtifactThreadFromArchive } from './read.js';
import { artifactPathsFor } from '../artifacts/paths.js';
import { ArtifactStore } from '../artifacts/store.js';
import { appendEvent, readEventLog } from '../events/event-log.js';
import { getDefaultConfig } from '../schema/config.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '../schema/diff-fingerprint.js';
import { appendUsageLedgerRecord, readUsageLedger } from '../usage/ledger-log.js';

const { boundedSidecarRead, durabilityFault, renameFault } = vi.hoisted(() => ({
  boundedSidecarRead: vi.fn(),
  durabilityFault: vi.fn(),
  renameFault: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1]
    ) => {
      renameFault(String(oldPath), String(newPath));
      return actual.rename(oldPath, newPath);
    },
  };
});

vi.mock('../fs/durable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs/durable.js')>();
  return {
    ...actual,
    fsyncDirStrict: async (...args: Parameters<typeof actual.fsyncDirStrict>) => {
      durabilityFault('fsyncDirStrict', String(args[0]));
      return actual.fsyncDirStrict(...args);
    },
  };
});

vi.mock('../usage/record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../usage/record.js')>();
  return {
    ...actual,
    readExactBytes: async (...args: Parameters<typeof actual.readExactBytes>) => {
      boundedSidecarRead();
      return actual.readExactBytes(...args);
    },
  };
});

afterEach(() => {
  durabilityFault.mockReset();
  renameFault.mockReset();
});

const ARTIFACT_ID = '01999999-9999-7000-8000-00000000000b';

/**
 * Warnings other than the mid-artifact disclosure. Fixtures that seed an
 * archive directly with a synthetic non-plan event trip that disclosure
 * legitimately; each of those tests is asserting on a different warning.
 */
function otherThanMidArtifact(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !warning.includes('started mid-artifact'));
}
const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

interface Harness {
  hotDir: string;
  dataRoot: string;
  projectDir: string;
  locksDir: string;
  warnings: string[];
  mirror: ArchiveMirror;
}

async function makeHarness(redactSecrets = false): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), 'orcaops-mirror-'));
  const hotDir = path.join(base, 'hot');
  const dataRoot = path.join(base, 'archive');
  const projectDir = archiveProjectDir(dataRoot, 'proj-1');
  const locksDir = path.join(base, 'locks');
  const warnings: string[] = [];
  const mirror = new ArchiveMirror({
    projectDir,
    locksDir,
    redactSecrets,
    onWarn: (m) => warnings.push(m),
  });
  return { hotDir, dataRoot, projectDir, locksDir, warnings, mirror };
}

function hotOpts(hotDir: string): { eventLogPath: string; sidecarsDir: string } {
  return {
    eventLogPath: path.join(hotDir, 'events.ndjson'),
    sidecarsDir: path.join(hotDir, 'sidecars'),
  };
}

async function seedCanonicalRepair(h: Harness) {
  const opts = hotOpts(h.hotDir);
  const first = await appendEvent(
    {
      type: 'plan_captured',
      ts: '2026-07-02T10:00:00.000Z',
      idempotency_key: 'repair-first',
      payload: {
        schema_version: 4,
        artifact_id: ARTIFACT_ID,
        branch: 'main',
        base_sha: 'abc123',
        agent: 'codex',
        agent_session_id: null,
        task: 'repair fixture',
        label: 'repair-fixture',
        plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-07-02T10:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
    },
    opts
  );
  const second = await appendEvent(
    {
      type: 'pin_displaced',
      ts: '2026-07-02T10:01:00.000Z',
      idempotency_key: 'repair-second',
      payload: { note: 'second' },
    },
    opts
  );
  await h.mirror.mirrorEventRecord(ARTIFACT_ID, second, opts.sidecarsDir, h.hotDir);
  const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
  return {
    opts,
    records: [first, second] as const,
    archivePaths,
    archivedBefore: await readFile(archivePaths.eventsNdjson),
  };
}

async function onlyRepairBackup(artifactDir: string): Promise<Buffer> {
  const backupsRoot = path.join(artifactDir, 'repair-backups');
  const backups = await readdir(backupsRoot);
  expect(backups).toHaveLength(1);
  return readFile(path.join(backupsRoot, backups[0]!, 'events.ndjson'));
}

function completedRepairBackupSyncs(): number {
  return durabilityFault.mock.calls.filter(
    ([operation, target]) =>
      operation === 'fsyncDirStrict' &&
      path.basename(path.dirname(String(target))) === 'repair-backups'
  ).length;
}

describe('ArchiveMirror — fidelity (redaction off)', () => {
  it('mirrors inline and sidecar events byte-identically, sidecar file included', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const small = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { a: 1 },
      },
      opts
    );
    const big = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'k2',
        payload: { blob: 'x'.repeat(9000) },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, small, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, big, opts.sidecarsDir, h.hotDir);

    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(
      await readFile(opts.eventLogPath, 'utf8')
    );
    expect(
      await readFile(path.join(archivePaths.sidecarsDir, `${big.event_id}.json`), 'utf8')
    ).toBe(await readFile(path.join(opts.sidecarsDir, `${big.event_id}.json`), 'utf8'));
    // The archive log passes full integrity verification.
    const read = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(read.corrupt).toEqual([]);
    expect(read.events.map((e) => e.event_id)).toEqual([small.event_id, big.event_id]);
    expect(h.warnings).toEqual([]);
  });

  it('rebuilds the checkpoint-open head into archived closed projections', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const open = await appendEvent(
      {
        type: 'checkpoint_opened',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'open-head-open',
        payload: {
          artifact_id: ARTIFACT_ID,
          n: 1,
          declared_step_ids: [STEP_ID],
          agent: 'codex',
          policy_exceptions: [],
          plan_revision_id: null,
          open_plan_revision_event_id: 'plan-event',
          opened_at: '2026-07-02T10:00:00.000Z',
          head_sha: 'open-head',
          open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        },
      },
      opts
    );
    const close = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:05:00.000Z',
        idempotency_key: 'open-head-close',
        payload: {
          artifact_id: ARTIFACT_ID,
          n: 1,
          closed_by_agent: 'codex',
          summary: 'closed',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: [STEP_ID],
          head_sha: 'close-head',
          ts: '2026-07-02T10:05:00.000Z',
          close_snapshot: buildDefaultSkippedSnapshotBoundary(),
          diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
        },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, open, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, close, opts.sidecarsDir, h.hotDir);

    const thread = await loadArtifactThreadFromArchive(h.projectDir, ARTIFACT_ID);
    expect(thread.checkpoints).toEqual([
      expect.objectContaining({
        status: 'closed',
        open_head_sha: 'open-head',
        head_sha: 'close-head',
      }),
    ]);
  });

  it('is idempotent by event_id (replay is a no-op)', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const rec = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { a: 1 },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const lines = (await readFile(archivePaths.eventsNdjson, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('canonical rebuild refuses a concurrently changed archive and leaves both sources untouched', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const first = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { task: 'first' },
      },
      opts
    );
    const second = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'k2',
        payload: { note: 'second' },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, second, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);

    // The resolver observed a clean one-event archive, but another writer
    // changed it before the mirror lock was acquired.
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const hotBefore = await readFile(opts.eventLogPath, 'utf8');
    const archiveBefore = await readFile(archivePaths.eventsNdjson, 'utf8');

    await expect(
      h.mirror.rebuildArtifactFromHot(
        ARTIFACT_ID,
        [first, second],
        opts.sidecarsDir,
        h.hotDir,
        [second.event_id],
        0
      )
    ).rejects.toThrow(/changed while repair was preparing/);
    expect(await readFile(opts.eventLogPath, 'utf8')).toBe(hotBefore);
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(archiveBefore);
  });

  it('does not replace the canonical archive when the repair backup cannot be fsynced', async () => {
    const h = await makeHarness();
    const seeded = await seedCanonicalRepair(h);
    let backupDirSyncs = 0;
    durabilityFault.mockImplementation((operation, target) => {
      if (
        operation === 'fsyncDirStrict' &&
        path.basename(path.dirname(String(target))) === 'repair-backups' &&
        ++backupDirSyncs === 2
      ) {
        throw new Error('injected backup fsync failure');
      }
    });

    await expect(
      h.mirror.rebuildArtifactFromHot(
        ARTIFACT_ID,
        seeded.records,
        seeded.opts.sidecarsDir,
        h.hotDir,
        [seeded.records[1].event_id],
        0
      )
    ).rejects.toThrow('injected backup fsync failure');

    expect(await readFile(seeded.archivePaths.eventsNdjson)).toEqual(seeded.archivedBefore);
  });

  it('does not swallow destination ENOENT while installing the repair backup', async () => {
    const h = await makeHarness();
    const seeded = await seedCanonicalRepair(h);
    renameFault.mockImplementation((_source, destination) => {
      if (
        destination.includes(`${path.sep}repair-backups${path.sep}`) &&
        destination.endsWith('events.ndjson')
      ) {
        throw Object.assign(new Error('injected missing backup destination'), { code: 'ENOENT' });
      }
    });

    await expect(
      h.mirror.rebuildArtifactFromHot(
        ARTIFACT_ID,
        seeded.records,
        seeded.opts.sidecarsDir,
        h.hotDir,
        [seeded.records[1].event_id],
        0
      )
    ).rejects.toThrow('injected missing backup destination');

    expect(await readFile(seeded.archivePaths.eventsNdjson)).toEqual(seeded.archivedBefore);
  });

  it('retains the durable repair backup when the canonical rename fails', async () => {
    const h = await makeHarness();
    const seeded = await seedCanonicalRepair(h);
    renameFault.mockImplementation((_source, destination) => {
      if (destination.endsWith(path.join('artifacts', ARTIFACT_ID, 'events.ndjson'))) {
        expect(completedRepairBackupSyncs()).toBeGreaterThanOrEqual(2);
        throw new Error('injected canonical rename failure');
      }
    });

    await expect(
      h.mirror.rebuildArtifactFromHot(
        ARTIFACT_ID,
        seeded.records,
        seeded.opts.sidecarsDir,
        h.hotDir,
        [seeded.records[1].event_id],
        0
      )
    ).rejects.toThrow('injected canonical rename failure');

    expect(await readFile(seeded.archivePaths.eventsNdjson)).toEqual(seeded.archivedBefore);
    expect(await onlyRepairBackup(seeded.archivePaths.dir)).toEqual(seeded.archivedBefore);
  });

  it('retains the durable backup when canonical directory fsync fails after rename', async () => {
    const h = await makeHarness();
    const seeded = await seedCanonicalRepair(h);
    let canonicalRenamed = false;
    renameFault.mockImplementation((_source, destination) => {
      if (destination.endsWith(path.join('artifacts', ARTIFACT_ID, 'events.ndjson'))) {
        canonicalRenamed = true;
      }
    });
    durabilityFault.mockImplementation((operation, target) => {
      if (
        canonicalRenamed &&
        operation === 'fsyncDirStrict' &&
        target.endsWith(path.join('artifacts', ARTIFACT_ID))
      ) {
        throw new Error('injected canonical fsync failure');
      }
    });

    await expect(
      h.mirror.rebuildArtifactFromHot(
        ARTIFACT_ID,
        seeded.records,
        seeded.opts.sidecarsDir,
        h.hotDir,
        [seeded.records[1].event_id],
        0
      )
    ).rejects.toThrow('injected canonical fsync failure');

    expect(await onlyRepairBackup(seeded.archivePaths.dir)).toEqual(seeded.archivedBefore);
  });

  it('leaves a damaged tail in place and retains its backup when truncation rename fails', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const record = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'tail-repair',
        payload: { task: 'tail' },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, record, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const damaged = await readFile(archivePaths.eventsNdjson);
    renameFault.mockImplementation((_source, destination) => {
      if (destination.endsWith(path.join('artifacts', ARTIFACT_ID, 'events.ndjson'))) {
        expect(completedRepairBackupSyncs()).toBeGreaterThanOrEqual(2);
        throw new Error('injected truncation rename failure');
      }
    });

    await expect(h.mirror.clearUnterminatedArchiveTail(ARTIFACT_ID)).rejects.toThrow(
      'injected truncation rename failure'
    );

    expect(await readFile(archivePaths.eventsNdjson)).toEqual(damaged);
    expect(await onlyRepairBackup(archivePaths.dir)).toEqual(damaged);
  });

  it('mirrors usage-ledger records byte-identically under the usage lock id', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const rec = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'u1',
        payload: { canonical_ref_id: 'r', artifact_id: 'a', linked_at: 't', pinned_version: null },
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(rec, hotLedger.sidecarsDir, h.hotDir);
    await h.mirror.mirrorUsageRecord(rec, hotLedger.sidecarsDir, h.hotDir);
    const archiveLedger = archiveUsageLedgerPaths(h.projectDir);
    expect(await readFile(archiveLedger.ledgerNdjson, 'utf8')).toBe(
      await readFile(hotLedger.ledgerPath, 'utf8')
    );
    expect(h.warnings).toEqual([]);
  });

  it('does not let a valid divergent payload suppress the authoritative hot record', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const archivePaths = archiveUsageLedgerPaths(h.projectDir);
    const archiveLedger = {
      ledgerPath: archivePaths.ledgerNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    };
    const envelope = {
      type: 'source_plan_linked' as const,
      ts: '2026-07-02T10:00:00.000Z',
      idempotency_key: 'same-envelope',
      event_id: ARTIFACT_ID,
    };
    await appendUsageLedgerRecord(
      {
        ...envelope,
        payload: {
          canonical_ref_id: 'cloud:divergent',
          artifact_id: 'divergent-artifact',
          linked_at: envelope.ts,
          pinned_version: null,
        },
      },
      archiveLedger
    );
    const hot = await appendUsageLedgerRecord(
      {
        ...envelope,
        payload: {
          canonical_ref_id: 'cloud:authoritative',
          artifact_id: 'authoritative-artifact',
          linked_at: envelope.ts,
          pinned_version: null,
        },
      },
      hotLedger
    );

    await h.mirror.mirrorUsageRecord(hot, hotLedger.sidecarsDir, h.hotDir);

    const archived = await readUsageLedger(archiveLedger);
    expect(archived).toHaveLength(2);
    expect(archived.at(-1)?.payload).toMatchObject({
      canonical_ref_id: 'cloud:authoritative',
      artifact_id: 'authoritative-artifact',
    });
  });

  it('uses the aligned content cache without rescanning history for a new event', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const first = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'cache-first',
        payload: {
          canonical_ref_id: 'cloud:first',
          artifact_id: 'first',
          linked_at: '2026-07-02T10:00:00.000Z',
          pinned_version: null,
        },
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(first, hotLedger.sidecarsDir, h.hotDir);
    const sentinel = path.join(h.locksDir, 'usage-content-cache', 'sentinel');
    await writeFile(sentinel, 'cache generation');

    const second = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'cache-second',
        payload: {
          canonical_ref_id: 'cloud:second',
          artifact_id: 'second',
          linked_at: '2026-07-02T10:01:00.000Z',
          pinned_version: null,
        },
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(second, hotLedger.sidecarsDir, h.hotDir);

    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it('does not trust a cached sidecar identity after the archived bytes change', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const record = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'cache-sidecar',
        payload: {
          canonical_ref_id: `cloud:${'p'.repeat(9_000)}`,
          artifact_id: 'authoritative',
          linked_at: '2026-07-02T10:00:00.000Z',
          pinned_version: null,
        },
      },
      hotLedger
    );
    expect(record).toHaveProperty('sidecar_sha256');
    await h.mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, h.hotDir);
    const archivePaths = archiveUsageLedgerPaths(h.projectDir);
    const sentinel = path.join(h.locksDir, 'usage-content-cache', 'sentinel');
    await writeFile(sentinel, 'cache generation');
    await writeFile(path.join(archivePaths.sidecarsDir, `${record.event_id}.json`), '{}');

    boundedSidecarRead.mockClear();
    await h.mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, h.hotDir);

    expect(boundedSidecarRead).toHaveBeenCalledOnce();
    await expect(access(sentinel)).resolves.toBeUndefined();
    const archived = await readUsageLedger({
      ledgerPath: archivePaths.ledgerNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(archived).toHaveLength(2);
    expect(archived.at(-1)?.payload).toMatchObject({ artifact_id: 'authoritative' });
  });

  it('refuses a hot usage sidecar whose bytes no longer match its bounded envelope', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const record = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'invalid-hot-sidecar',
        payload: {
          canonical_ref_id: `cloud:${'p'.repeat(9_000)}`,
          artifact_id: 'hot',
          linked_at: '2026-07-02T10:00:00.000Z',
          pinned_version: null,
        },
      },
      hotLedger
    );
    expect(record).toHaveProperty('sidecar_sha256');
    await writeFile(
      path.join(hotLedger.sidecarsDir, `${record.event_id}.json`),
      '{"different":"payload"}'
    );

    await h.mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, h.hotDir);

    expect(h.warnings).toEqual([expect.stringContaining('has no valid bounded payload')]);
    await expect(
      readFile(archiveUsageLedgerPaths(h.projectDir).ledgerNdjson, 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('ArchiveMirror — redaction on', () => {
  it('repairs a malformed same-id usage record and deduplicates its redacted sibling', async () => {
    const h = await makeHarness(true);
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const invalid = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T09:59:00.000Z',
        idempotency_key: 'invalid-redacted-usage',
        payload: { malformed: true },
        event_id: ARTIFACT_ID,
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(invalid, hotLedger.sidecarsDir, h.hotDir);
    const record = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'redacted-usage',
        payload: {
          canonical_ref_id: 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
          artifact_id: ARTIFACT_ID,
          linked_at: '2026-07-02T10:00:00.000Z',
          pinned_version: null,
        },
        event_id: ARTIFACT_ID,
      },
      hotLedger
    );

    await h.mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, h.hotDir);
    await h.mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, h.hotDir);

    const archivePaths = archiveUsageLedgerPaths(h.projectDir);
    const rawLines = (await readFile(archivePaths.ledgerNdjson, 'utf8')).trim().split('\n');
    expect(rawLines).toHaveLength(2);
    expect(rawLines.join('\n')).toContain('[REDACTED_SECRET]');
    expect(rawLines.join('\n')).not.toContain('ghp_0123456789');
    expect(
      await readUsageLedger({
        ledgerPath: archivePaths.ledgerNdjson,
        sidecarsDir: archivePaths.sidecarsDir,
      })
    ).toHaveLength(1);
  });

  it('redacts the archive copy, re-verifies checksums, preserves identity', async () => {
    const h = await makeHarness(true);
    const opts = hotOpts(h.hotDir);
    const rec = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { note: 'api_key=sk-ant-api03-abcdefghijklmnopqrstuvwx' },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const read = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    // Checksums recomputed for the redacted payload — no corruption.
    expect(read.corrupt).toEqual([]);
    expect(read.events).toHaveLength(1);
    const mirrored = read.events[0];
    expect(mirrored.event_id).toBe(rec.event_id);
    expect(mirrored.ts).toBe(rec.ts);
    expect(mirrored.idempotency_key).toBe(rec.idempotency_key);
    const raw = await readFile(archivePaths.eventsNdjson, 'utf8');
    expect(raw).toContain('[REDACTED_SECRET]');
    expect(raw).not.toContain('sk-ant-api03');
    // Hot log untouched.
    expect(await readFile(opts.eventLogPath, 'utf8')).toContain('sk-ant-api03');
  });

  it('re-decides the sidecar spill for an oversized redacted payload', async () => {
    const h = await makeHarness(true);
    const opts = hotOpts(h.hotDir);
    const rec = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k2',
        payload: {
          blob: 'y'.repeat(9000),
          secret: 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
        },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const read = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(read.corrupt).toEqual([]);
    const sidecar = await readFile(
      path.join(archivePaths.sidecarsDir, `${rec.event_id}.json`),
      'utf8'
    );
    expect(sidecar).toContain('[REDACTED_SECRET]');
    expect(sidecar).not.toContain('ghp_0123456789');
  });

  it('canonical rebuild installs the sidecars selected by the staged redacted records', async () => {
    const h = await makeHarness(true);
    const opts = hotOpts(h.hotDir);
    const shrinksInline = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'shrink',
        payload: { note: `api_key=${'s'.repeat(9000)}` },
      },
      opts
    );
    const growsSidecar = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'grow',
        payload: { note: 'token=aaaaaaaa '.repeat(450) },
      },
      opts
    );
    expect('sidecar_sha256' in shrinksInline).toBe(true);
    expect('sidecar_sha256' in growsSidecar).toBe(false);

    // Seed the archive with only the later event: this is the non-tail shape
    // that sends explicit repair through the canonical rebuild path.
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, growsSidecar, opts.sidecarsDir, h.hotDir);
    const hotLogBefore = await readFile(opts.eventLogPath, 'utf8');
    const hotSidecarBefore = await readFile(
      path.join(opts.sidecarsDir, `${shrinksInline.event_id}.json`),
      'utf8'
    );

    await h.mirror.rebuildArtifactFromHot(
      ARTIFACT_ID,
      [shrinksInline, growsSidecar],
      opts.sidecarsDir,
      h.hotDir,
      [growsSidecar.event_id],
      0
    );

    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const rebuilt = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(rebuilt.corrupt).toEqual([]);
    expect(rebuilt.events.map((record) => record.event_id)).toEqual([
      shrinksInline.event_id,
      growsSidecar.event_id,
    ]);
    expect('sidecar_sha256' in rebuilt.events[0]).toBe(false);
    expect('sidecar_sha256' in rebuilt.events[1]).toBe(true);

    const archiveLog = await readFile(archivePaths.eventsNdjson, 'utf8');
    const archiveSidecar = await readFile(
      path.join(archivePaths.sidecarsDir, `${growsSidecar.event_id}.json`),
      'utf8'
    );
    expect(`${archiveLog}\n${archiveSidecar}`).toContain('[REDACTED_SECRET]');
    expect(`${archiveLog}\n${archiveSidecar}`).not.toContain('token=aaaaaaaa');
    expect(`${archiveLog}\n${archiveSidecar}`).not.toContain(`api_key=${'s'.repeat(9000)}`);

    // Rebuilding the archive copy never mutates the authoritative hot source.
    expect(await readFile(opts.eventLogPath, 'utf8')).toBe(hotLogBefore);
    expect(
      await readFile(path.join(opts.sidecarsDir, `${shrinksInline.event_id}.json`), 'utf8')
    ).toBe(hotSidecarBefore);
    expect(otherThanMidArtifact(h.warnings)).toEqual([]);
  });
});

describe('ArchiveMirror — hot source containment', () => {
  it.each([false, true])(
    'refuses a final hot sidecar symlink when redaction is %s',
    async (redactSecrets) => {
      const h = await makeHarness(redactSecrets);
      const opts = hotOpts(h.hotDir);
      const record = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-07-02T10:00:00.000Z',
          idempotency_key: 'sidecar-symlink',
          payload: { blob: 'x'.repeat(9000) },
        },
        opts
      );
      const hotSidecar = path.join(opts.sidecarsDir, `${record.event_id}.json`);
      const externalSidecar = path.join(path.dirname(h.hotDir), 'external-payload.json');
      await writeFile(externalSidecar, await readFile(hotSidecar));
      await unlink(hotSidecar);
      await symlink(externalSidecar, hotSidecar);

      await h.mirror.mirrorEventRecord(ARTIFACT_ID, record, opts.sidecarsDir, h.hotDir);

      const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
      await expect(readFile(archivePaths.eventsNdjson, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(otherThanMidArtifact(h.warnings)).toHaveLength(1);
      expect(otherThanMidArtifact(h.warnings)[0]).toContain('must not contain symlinks');
    }
  );
});

describe('ArchiveMirror — mirroring that begins mid-artifact', () => {
  it('warns once naming the event actually seen, and still mirrors the tail', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const opened = await appendEvent(
      {
        type: 'checkpoint_opened',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'mid-open',
        payload: {},
      },
      opts
    );
    const closed = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:05:00.000Z',
        idempotency_key: 'mid-close',
        payload: {},
      },
      opts
    );

    await h.mirror.mirrorEventRecord(ARTIFACT_ID, opened, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, closed, opts.sidecarsDir, h.hotDir);

    // Once, not per event: the log is no longer empty after the first append.
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(ARTIFACT_ID);
    expect(h.warnings[0]).toContain('checkpoint_opened');
    expect(h.warnings[0]).toContain('archive repair');

    // The tail survives — refusing the append is what would destroy it.
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const read = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(read.events.map((event) => event.type)).toEqual([
      'checkpoint_opened',
      'checkpoint_closed',
    ]);
  });

  it('stays silent when the archive starts at the artifact plan', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const plan = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'head-plan',
        payload: {},
      },
      opts
    );
    const closed = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:05:00.000Z',
        idempotency_key: 'head-close',
        payload: {},
      },
      opts
    );

    await h.mirror.mirrorEventRecord(ARTIFACT_ID, plan, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, closed, opts.sidecarsDir, h.hotDir);

    expect(h.warnings).toEqual([]);
  });
});

describe('ArchiveMirror — fail-open', () => {
  it('an unwritable archive warns and never throws', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-mirror-fail-'));
    const hotDir = path.join(base, 'hot');
    // Make the project dir path unusable: its parent is a FILE.
    const notADir = path.join(base, 'not-a-dir');
    await writeFile(notADir, 'x', 'utf8');
    const warnings: string[] = [];
    const mirror = new ArchiveMirror({
      projectDir: path.join(notADir, 'projects', 'p1'),
      locksDir: path.join(base, 'locks'),
      redactSecrets: false,
      onWarn: (m) => warnings.push(m),
    });
    const opts = hotOpts(hotDir);
    const rec = await appendEvent(
      { type: 'plan_captured', ts: '2026-07-02T10:00:00.000Z', idempotency_key: 'k1', payload: {} },
      opts
    );
    await expect(
      mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, hotDir)
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('archive repair');
  });
});

describe('ArchiveMirror — unterminated archive tail', () => {
  it.each<[string, boolean]>([
    ['torn partial line', false],
    ['torn partial line', true],
    ['unterminated final record', false],
    ['unterminated final record', true],
  ])('warns and appends nothing over a %s when redaction is %s', async (shape, redactSecrets) => {
    const h = await makeHarness(redactSecrets);
    const opts = hotOpts(h.hotDir);
    const first = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { a: 1 },
      },
      opts
    );
    const second = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'k2',
        payload: { b: 2 },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, first, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const clean = await readFile(archivePaths.eventsNdjson, 'utf8');
    const damaged = shape === 'torn partial line' ? `${clean}{"truncated":` : clean.slice(0, -1);
    await writeFile(archivePaths.eventsNdjson, damaged, 'utf8');

    await h.mirror.mirrorEventRecord(ARTIFACT_ID, second, opts.sidecarsDir, h.hotDir);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('archive repair');
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(damaged);
    const read = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(read.events.map((event) => event.event_id)).not.toContain(second.event_id);
  });

  it('warns on a same-id retry whose only archived copy is the unterminated final line', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const rec = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { a: 1 },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const damaged = (await readFile(archivePaths.eventsNdjson, 'utf8')).slice(0, -1);
    await writeFile(archivePaths.eventsNdjson, damaged, 'utf8');

    await h.mirror.mirrorEventRecord(ARTIFACT_ID, rec, opts.sidecarsDir, h.hotDir);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('archive repair');
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(damaged);
  });

  it('warns even when the mirrored id is already archived behind the damaged tail', async () => {
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const first = await appendEvent(
      {
        type: 'plan_captured',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { a: 1 },
      },
      opts
    );
    const second = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'k2',
        payload: { b: 2 },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, first, opts.sidecarsDir, h.hotDir);
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, second, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const damaged = await readFile(archivePaths.eventsNdjson, 'utf8');

    await h.mirror.mirrorEventRecord(ARTIFACT_ID, first, opts.sidecarsDir, h.hotDir);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('archive repair');
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(damaged);
  });

  it('an unreadable archived sidecar pauses later mirroring as disclosed lag until repaired', async () => {
    if (process.getuid?.() === 0) return;
    const h = await makeHarness();
    const opts = hotOpts(h.hotDir);
    const big = await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'k1',
        payload: { blob: 'x'.repeat(9000) },
      },
      opts
    );
    const next = await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'k2',
        payload: { b: 2 },
      },
      opts
    );
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, big, opts.sidecarsDir, h.hotDir);
    const archivePaths = archiveArtifactPaths(h.projectDir, ARTIFACT_ID);
    const archivedSidecar = path.join(archivePaths.sidecarsDir, `${big.event_id}.json`);
    const before = await readFile(archivePaths.eventsNdjson, 'utf8');
    await chmod(archivedSidecar, 0o000);
    try {
      // The append-state read verifies sidecars (the same price the hot
      // choke point pays); an infrastructure error there refuses the blind
      // append and surfaces as fail-open lag rather than a silent write.
      await h.mirror.mirrorEventRecord(ARTIFACT_ID, next, opts.sidecarsDir, h.hotDir);
      expect(otherThanMidArtifact(h.warnings)).toHaveLength(1);
      expect(otherThanMidArtifact(h.warnings)[0]).toContain('archive repair');
      expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(before);
    } finally {
      await chmod(archivedSidecar, 0o644);
    }
    await h.mirror.mirrorEventRecord(ARTIFACT_ID, next, opts.sidecarsDir, h.hotDir);
    expect((await readFile(archivePaths.eventsNdjson, 'utf8')).split('\n')).toHaveLength(3);
  });

  it('still appends a usage record over a torn ledger tail without warning', async () => {
    const h = await makeHarness();
    const hotLedger = {
      ledgerPath: path.join(h.hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(h.hotDir, 'usage', 'sidecars'),
    };
    const first = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:00:00.000Z',
        idempotency_key: 'u1',
        payload: {
          canonical_ref_id: 'r1',
          artifact_id: 'a1',
          linked_at: 't',
          pinned_version: null,
        },
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(first, hotLedger.sidecarsDir, h.hotDir);
    const archiveLedger = archiveUsageLedgerPaths(h.projectDir);
    await appendFile(archiveLedger.ledgerNdjson, '{"truncated":', 'utf8');
    const damaged = await readFile(archiveLedger.ledgerNdjson, 'utf8');

    const second = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-02T10:01:00.000Z',
        idempotency_key: 'u2',
        payload: {
          canonical_ref_id: 'r2',
          artifact_id: 'a2',
          linked_at: 't',
          pinned_version: null,
        },
      },
      hotLedger
    );
    await h.mirror.mirrorUsageRecord(second, hotLedger.sidecarsDir, h.hotDir);

    expect(h.warnings).toEqual([]);
    // The torn residue merges with the appended line — the ledger's disclosed
    // residual; its readers skip unparseable lines instead of refusing.
    expect(await readFile(archiveLedger.ledgerNdjson, 'utf8')).toBe(
      `${damaged}${JSON.stringify(second)}\n`
    );
    const archived = await readUsageLedger({
      ledgerPath: archiveLedger.ledgerNdjson,
      sidecarsDir: archiveLedger.sidecarsDir,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.payload).toMatchObject({ canonical_ref_id: 'r1' });
  });
});

describe('ArchiveMirror — review logs (mirrorReviewEvent)', () => {
  const SLUG = 'feat%2Fx';

  it('appends the verbatim line + a trailing newline, byte-identical to the hot log', async () => {
    const h = await makeHarness();
    const raw = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    await h.mirror.mirrorReviewEvent(3, SLUG, 'journal', raw, reviewEventIdentity(raw));
    const paths = archiveReviewPaths(h.projectDir, 3, SLUG);
    expect(await readFile(paths.journalNdjson, 'utf8')).toBe(`${raw}\n`);
    expect(h.warnings).toEqual([]);
  });

  it('is idempotent by identity (the same line twice → one archived line)', async () => {
    const h = await makeHarness();
    const raw = JSON.stringify({
      type: 'add',
      comment_id: 'c1',
      ts: '2026-07-09T00:00:00.000Z',
      author: 'reviewer',
      body: 'why 42?',
    });
    const id = reviewEventIdentity(raw);
    await h.mirror.mirrorReviewEvent(3, SLUG, 'comments', raw, id);
    await h.mirror.mirrorReviewEvent(3, SLUG, 'comments', raw, id);
    const paths = archiveReviewPaths(h.projectDir, 3, SLUG);
    const lines = (await readFile(paths.commentsNdjson, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('keeps journal and comments in separate logs and accumulates distinct lines', async () => {
    const h = await makeHarness();
    const j1 = JSON.stringify({ type: 'section', ts: 't1', threadKey: 'S1', action: 'VISIT' });
    const j2 = JSON.stringify({ type: 'section', ts: 't2', threadKey: 'S2', action: 'VISIT' });
    const c1 = JSON.stringify({ type: 'add', comment_id: 'c1', ts: 't1', author: 'reviewer' });
    await h.mirror.mirrorReviewEvent(3, SLUG, 'journal', j1, reviewEventIdentity(j1));
    await h.mirror.mirrorReviewEvent(3, SLUG, 'journal', j2, reviewEventIdentity(j2));
    await h.mirror.mirrorReviewEvent(3, SLUG, 'comments', c1, reviewEventIdentity(c1));
    const paths = archiveReviewPaths(h.projectDir, 3, SLUG);
    expect(await readFile(paths.journalNdjson, 'utf8')).toBe(`${j1}\n${j2}\n`);
    expect(await readFile(paths.commentsNdjson, 'utf8')).toBe(`${c1}\n`);
    expect(h.warnings).toEqual([]);
  });

  it.each(['journal', 'comments'] as const)(
    'coordinates review-wide archive reads with %s mirror writers',
    async (kind) => {
      const h = await makeHarness();
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = h.mirror.withReviewLocks(SLUG, async () => {
        entered();
        await releasePromise;
      });
      await enteredPromise;

      let completed = false;
      const raw = JSON.stringify({ type: 'section', ts: 't1', action: 'VISIT' });
      const append = h.mirror
        .mirrorReviewEvent(3, SLUG, kind, raw, reviewEventIdentity(raw))
        .then(() => {
          completed = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);

      release();
      await Promise.all([held, append]);
      expect(completed).toBe(true);
    }
  );

  it('fails open: an unwritable archive warns and never throws', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-fail-'));
    const notADir = path.join(base, 'not-a-dir');
    await writeFile(notADir, 'x', 'utf8');
    const warnings: string[] = [];
    const mirror = new ArchiveMirror({
      projectDir: path.join(notADir, 'projects', 'p1'),
      locksDir: path.join(base, 'locks'),
      redactSecrets: false,
      onWarn: (m) => warnings.push(m),
    });
    const raw = JSON.stringify({ type: 'section', ts: 't', threadKey: 'S1', action: 'VISIT' });
    await expect(
      mirror.mirrorReviewEvent(3, SLUG, 'journal', raw, reviewEventIdentity(raw))
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('review journal line');
  });
});

describe('ArtifactStore — write-through mirroring (full lifecycle)', () => {
  let repo: TempRepo;
  let store: ArtifactStore;
  let harness: Harness;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    harness = await makeHarness();
    store = new ArtifactStore({
      repoRoot: repo.path,
      config: getDefaultConfig(),
      archive: harness.mirror,
    });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  it('archive events.ndjson is byte-identical to the hot log after plan + open + close', async () => {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ARTIFACT_ID,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'mirror lifecycle',
        label: 'mirror-lifecycle',
        plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-07-02T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-1' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_ID] },
      { idempotencyKey: 'open-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: ARTIFACT_ID,
        n: 1,
        summary: 'done',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'close-1' }
    );

    const hotPaths = artifactPathsFor(repo.path, getDefaultConfig(), ARTIFACT_ID);
    const archivePaths = archiveArtifactPaths(harness.projectDir, ARTIFACT_ID);
    const hotLog = await readFile(hotPaths.eventsNdjson, 'utf8');
    const archiveLog = await readFile(archivePaths.eventsNdjson, 'utf8');
    expect(archiveLog).toBe(hotLog);
    expect(hotLog.trim().split('\n').length).toBeGreaterThanOrEqual(3);
    expect(harness.warnings).toEqual([]);
  });
});
