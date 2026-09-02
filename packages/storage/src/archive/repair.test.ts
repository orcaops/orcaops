import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArchiveMirror } from './mirror.js';
import { archiveArtifactPaths, archiveProjectDir, archiveUsageLedgerPaths } from './paths.js';
import { computeMirrorLag, replayMissingEvents } from './repair.js';
import { artifactPathsFor, usageLedgerPath, usageSidecarsDir } from '../artifacts/paths.js';
import { ArtifactStore } from '../artifacts/store.js';
import { appendEvent, type EventRecord, readEventLog } from '../events/event-log.js';
import { getDefaultConfig } from '../schema/config.js';
import { redactSecretsInObject } from '../secrets.js';
import { appendUsageLedgerRecord, readUsageLedger } from '../usage/ledger-log.js';
import { deriveUsageLedgerRecord } from '../usage/record.js';

const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

describe('archive repair containment', () => {
  let repo: TempRepo;
  let scratchDir: string;
  let projectDir: string;
  let mirror: ArchiveMirror;
  let store: ArtifactStore;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    scratchDir = await mkdtemp(path.join(tmpdir(), 'orcaops-repair-engine-'));
    projectDir = archiveProjectDir(path.join(scratchDir, 'archive'), 'proj-1');
    mirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'locks'),
      redactSecrets: false,
    });
    store = new ArtifactStore({
      repoRoot: repo.path,
      config: getDefaultConfig(),
    });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('names each blocked cause while leaving an invalid ordered tail replayable', async () => {
    const corruptId = artifactId(1);
    const archiveAheadId = artifactId(2);
    const invalidCanonicalId = artifactId(3);
    const invalidTailId = artifactId(4);

    await writePlan(corruptId);
    await appendFile(hotPaths(corruptId).eventsNdjson, '{"truncated":', 'utf8');

    const [archiveAheadPlan] = await writePlan(archiveAheadId);
    await mirrorRecord(archiveAheadId, archiveAheadPlan);
    await appendEvent(
      {
        type: 'pin_displaced',
        ts: '2026-07-31T01:00:00.000Z',
        idempotency_key: 'archive-only',
        payload: {},
      },
      eventLogOptions(archiveArtifactPaths(projectDir, archiveAheadId))
    );

    await writePlan(invalidCanonicalId);
    const invalidCanonicalClose = await appendOrphanAbandon(invalidCanonicalId);
    await mirrorRecord(invalidCanonicalId, invalidCanonicalClose);

    const [invalidTailPlan] = await writePlan(invalidTailId);
    await appendOrphanAbandon(invalidTailId);
    await mirrorRecord(invalidTailId, invalidTailPlan);

    const report = await computeMirrorLag(repairOptions());

    expect(report.artifacts).toEqual([
      expect.objectContaining({
        artifact_id: corruptId,
        repair_mode: 'blocked',
        block_reason: 'hot_log_corrupt',
        hot_corrupt_lines: 1,
      }),
      expect.objectContaining({
        artifact_id: archiveAheadId,
        repair_mode: 'blocked',
        block_reason: 'archive_ahead',
        archive_only_event_ids: [expect.any(String)],
      }),
      expect.objectContaining({
        artifact_id: invalidCanonicalId,
        repair_mode: 'blocked',
        block_reason: 'hot_unreconstructable',
      }),
      expect.objectContaining({
        artifact_id: invalidTailId,
        repair_mode: 'tail_replay',
        block_reason: null,
      }),
    ]);
    expect(report.total_missing).toBe(3);
    expect(report.repairable_missing).toBe(1);
    expect(report.blocked_missing).toBe(2);
    expect(report.blocked_artifacts).toBe(3);
    expect(report.artifacts_requiring_rebuild).toBe(0);

    const archiveAheadLog = archiveArtifactPaths(projectDir, archiveAheadId).eventsNdjson;
    const archiveAheadBefore = await readFile(archiveAheadLog, 'utf8');
    const replay = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(replay.rebuilt_artifacts).toEqual([]);
    expect(await readFile(archiveAheadLog, 'utf8')).toBe(archiveAheadBefore);
  });

  it('returns successful sibling rebuild evidence when a later artifact is blocked', async () => {
    const rebuildId = artifactId(10);
    const tailId = artifactId(11);
    const corruptId = artifactId(12);

    const rebuildRecords = await writeClosedLifecycle(rebuildId);
    await mirrorRecord(rebuildId, rebuildRecords.at(-1)!);
    const damagedArchive = await readFile(
      archiveArtifactPaths(projectDir, rebuildId).eventsNdjson,
      'utf8'
    );

    const tailRecords = await writeClosedLifecycle(tailId);
    await writePlan(corruptId);
    await appendFile(hotPaths(corruptId).eventsNdjson, '{"truncated":', 'utf8');

    const result = await replayMissingEvents({ ...repairOptions(), mirror });

    expect(result.complete).toBe(false);
    expect(result.replayed_events).toBe(tailRecords.length);
    expect(result.remaining_missing).toBe(0);
    expect(result.blocked_missing).toBe(1);
    expect(result.blocked_artifacts).toBe(1);
    expect(result.remaining_rebuilds).toBe(0);
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: corruptId,
        kind: 'hot_log_corrupt',
      }),
    ]);
    expect(result.rebuilt_artifacts).toEqual([
      {
        artifact_id: rebuildId,
        backup_path: expect.any(String),
      },
    ]);
    expect(
      await readFile(path.join(result.rebuilt_artifacts[0].backup_path, 'events.ndjson'), 'utf8')
    ).toBe(damagedArchive);
    expect(await readFile(archiveArtifactPaths(projectDir, rebuildId).eventsNdjson, 'utf8')).toBe(
      await readFile(hotPaths(rebuildId).eventsNdjson, 'utf8')
    );
  });

  it('reports a replayed artifact that remains semantically invalid without aborting', async () => {
    const healthyId = artifactId(20);
    const invalidTailId = artifactId(21);

    const healthyRecords = await writeClosedLifecycle(healthyId);
    for (const record of healthyRecords) await mirrorRecord(healthyId, record);

    const [plan] = await writePlan(invalidTailId);
    await appendOrphanAbandon(invalidTailId);
    await mirrorRecord(invalidTailId, plan);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });

    expect(result.replayed_events).toBe(1);
    expect(result.remaining_missing).toBe(0);
    expect(result.blocked_missing).toBe(0);
    expect(result.blocked_artifacts).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: invalidTailId,
        kind: 'archive_unreconstructable',
        missing_events: 0,
      }),
    ]);
    expect(
      await readEventLog({
        eventLogPath: archiveArtifactPaths(projectDir, healthyId).eventsNdjson,
        sidecarsDir: archiveArtifactPaths(projectDir, healthyId).sidecarsDir,
      })
    ).toMatchObject({ corrupt: [] });
  });

  it('heals a torn archive tail in one verbatim run and retains the damaged copy', async () => {
    const id = artifactId(40);
    const records = await writeClosedLifecycle(id);
    await mirrorRecord(id, records[0]);
    await mirrorRecord(id, records[1]);
    const archiveLog = archiveArtifactPaths(projectDir, id).eventsNdjson;
    await appendFile(archiveLog, '{"truncated":', 'utf8');
    const damaged = await readFile(archiveLog, 'utf8');

    const before = await computeMirrorLag(repairOptions());
    expect(before.artifacts).toEqual([
      expect.objectContaining({
        artifact_id: id,
        repair_mode: 'tail_replay',
        block_reason: null,
        archive_corrupt_lines: 1,
      }),
    ]);

    const warnings: string[] = [];
    const disclosingMirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'tail-disclose-locks'),
      redactSecrets: false,
      onWarn: (message) => warnings.push(message),
    });
    const result = await replayMissingEvents({ ...repairOptions(), mirror: disclosingMirror });
    expect(result.complete).toBe(true);
    expect(result.remaining_missing).toBe(0);
    expect(result.artifact_issues).toEqual([]);
    expect(await readFile(archiveLog, 'utf8')).toBe(
      await readFile(hotPaths(id).eventsNdjson, 'utf8')
    );
    const backupsDir = path.join(archiveArtifactPaths(projectDir, id).dir, 'repair-backups');
    const backups = await readdir(backupsDir);
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(backupsDir, backups[0], 'events.ndjson'), 'utf8')).toBe(
      damaged
    );
    const retention = warnings.filter((message) => message.includes('retained at'));
    expect(retention).toHaveLength(1);
    expect(retention[0]).toContain(id);
  });

  it('heals a torn archive tail in one redacting run without sealing the residue', async () => {
    const redactingMirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'redacting-tail-locks'),
      redactSecrets: true,
    });
    const id = artifactId(41);
    const records = await writeClosedLifecycle(id);
    for (const record of records.slice(0, 2)) {
      await redactingMirror.mirrorEventRecord(id, record, hotPaths(id).sidecarsDir, repo.path);
    }
    const archivePaths = archiveArtifactPaths(projectDir, id);
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const damaged = await readFile(archivePaths.eventsNdjson, 'utf8');

    const result = await replayMissingEvents({ ...repairOptions(), mirror: redactingMirror });
    expect(result.complete).toBe(true);
    const read = await readEventLog(eventLogOptions(archivePaths));
    expect(read.corrupt).toEqual([]);
    expect(read.events.map((event) => event.event_id)).toEqual(
      records.map((record) => record.event_id)
    );
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).not.toContain('{"truncated":');
    const backupsDir = path.join(archivePaths.dir, 'repair-backups');
    const backups = await readdir(backupsDir);
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(backupsDir, backups[0], 'events.ndjson'), 'utf8')).toBe(
      damaged
    );
  });

  it('replays an unterminated final record instead of treating its id as archived', async () => {
    const id = artifactId(42);
    const records = await writeClosedLifecycle(id);
    for (const record of records) await mirrorRecord(id, record);
    const archiveLog = archiveArtifactPaths(projectDir, id).eventsNdjson;
    await writeFile(archiveLog, (await readFile(archiveLog, 'utf8')).slice(0, -1), 'utf8');

    const before = await computeMirrorLag(repairOptions());
    expect(before.artifacts).toEqual([
      expect.objectContaining({
        artifact_id: id,
        repair_mode: 'tail_replay',
        missing_event_ids: [records.at(-1)!.event_id],
      }),
    ]);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.complete).toBe(true);
    expect(result.remaining_missing).toBe(0);
    expect(await readFile(archiveLog, 'utf8')).toBe(
      await readFile(hotPaths(id).eventsNdjson, 'utf8')
    );
  });

  it('heals a damaged archive tail even when the hot thread stays semantically invalid', async () => {
    const id = artifactId(43);
    const [plan] = await writePlan(id);
    await appendOrphanAbandon(id);
    await mirrorRecord(id, plan);
    const archivePaths = archiveArtifactPaths(projectDir, id);
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const damaged = await readFile(archivePaths.eventsNdjson, 'utf8');

    const before = await computeMirrorLag(repairOptions());
    expect(before.artifacts).toEqual([
      expect.objectContaining({
        artifact_id: id,
        repair_mode: 'tail_replay',
        block_reason: null,
      }),
    ]);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.complete).toBe(false);
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({ artifact_id: id, kind: 'archive_unreconstructable' }),
    ]);
    const read = await readEventLog(eventLogOptions(archivePaths));
    expect(read.corrupt).toEqual([]);
    expect(read.events.map((event) => event.event_id)).toEqual(
      (await readEventLog(eventLogOptions(hotPaths(id)))).events.map((event) => event.event_id)
    );
    const backupsDir = path.join(archivePaths.dir, 'repair-backups');
    const backups = await readdir(backupsDir);
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(backupsDir, backups[0], 'events.ndjson'), 'utf8')).toBe(
      damaged
    );
  });

  it('replays a missing tail past a terminated corrupt line and leaves its bytes in place', async () => {
    const id = artifactId(44);
    const records = await writeClosedLifecycle(id);
    await mirrorRecord(id, records[0]);
    await mirrorRecord(id, records[1]);
    const archiveLog = archiveArtifactPaths(projectDir, id).eventsNdjson;
    await appendFile(archiveLog, '{"junk":1}\n', 'utf8');
    const damagedBefore = await readFile(archiveLog, 'utf8');

    const before = await computeMirrorLag(repairOptions());
    expect(before.artifacts).toEqual([
      expect.objectContaining({
        artifact_id: id,
        repair_mode: 'tail_replay',
        archive_corrupt_lines: 1,
      }),
    ]);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.complete).toBe(false);
    expect(result.remaining_missing).toBe(0);
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({ artifact_id: id, kind: 'archive_unreconstructable' }),
    ]);
    const closeLine = (await readFile(hotPaths(id).eventsNdjson, 'utf8'))
      .trimEnd()
      .split('\n')
      .at(-1)!;
    expect(await readFile(archiveLog, 'utf8')).toBe(`${damagedBefore}${closeLine}\n`);
    const read = await readEventLog(eventLogOptions(archiveArtifactPaths(projectDir, id)));
    expect(read.corrupt).toHaveLength(1);
  });

  it('keeps filesystem failures fatal instead of classifying them as content issues', async () => {
    await writePlan(artifactId(30));
    const notADirectory = path.join(scratchDir, 'not-a-directory');
    await writeFile(notADirectory, 'x', 'utf8');

    await expect(
      computeMirrorLag({
        ...repairOptions(),
        projectDir: path.join(notADirectory, 'project'),
      })
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('leaves checksummed payload-invalid usage visible as unrepaired lag', async () => {
    const invalid = await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-07-31T00:00:00.000Z',
        idempotency_key: 'invalid-usage',
        payload: { malformed: true },
      },
      {
        ledgerPath: usageLedgerPath(repo.path),
        sidecarsDir: usageSidecarsDir(repo.path),
        containmentRoot: repo.path,
      }
    );

    const before = await computeMirrorLag(repairOptions());
    expect(before.usage).toEqual({
      hot_events: 1,
      archived_events: 0,
      missing_event_ids: [invalid.event_id],
    });
    expect(before.repairable_missing).toBe(0);
    expect(before.blocked_missing).toBe(0);
    expect(before.usage_blocked_missing).toBe(1);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.replayed_events).toBe(0);
    expect(result.remaining_missing).toBe(0);
    expect(result.blocked_missing).toBe(0);
    expect(result.usage_blocked_missing).toBe(1);
    expect(result.complete).toBe(true);
    await expect(
      readFile(archiveUsageLedgerPaths(projectDir).ledgerNdjson, 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a valid duplicate id admit an invalid usage record', async () => {
    const eventId = artifactId(99);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:00:00.000Z',
        idempotency_key: 'invalid-duplicate',
        payload: { malformed: true },
        event_id: eventId,
      },
      paths
    );
    const validPayload = {
      canonical_ref_id: 'cloud:plan-1',
      artifact_id: artifactId(1),
      linked_at: '2026-07-31T00:01:00.000Z',
      pinned_version: null,
    };
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:01:00.000Z',
        idempotency_key: 'valid-duplicate',
        payload: validPayload,
        event_id: eventId,
      },
      paths
    );

    const before = await computeMirrorLag(repairOptions());
    expect(before.usage).toEqual({
      hot_events: 2,
      archived_events: 0,
      missing_event_ids: [eventId, eventId],
    });
    expect(before.repairable_missing).toBe(1);
    expect(before.blocked_missing).toBe(0);
    expect(before.usage_blocked_missing).toBe(1);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.replayed_events).toBe(1);
    expect(result.remaining_missing).toBe(0);
    expect(result.blocked_missing).toBe(0);
    expect(result.usage_blocked_missing).toBe(1);
    expect(result.complete).toBe(true);
    const archivePaths = archiveUsageLedgerPaths(projectDir);
    const archived = await readUsageLedger({
      ledgerPath: archivePaths.ledgerNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.payload).toEqual(validPayload);
  });

  it('repairs a valid usage record hidden behind a malformed archive sibling', async () => {
    const eventId = artifactId(100);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const invalid = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:00:00.000Z',
        idempotency_key: 'invalid-archived-sibling',
        payload: { malformed: true },
        event_id: eventId,
      },
      paths
    );
    const validPayload = {
      canonical_ref_id: 'cloud:plan-2',
      artifact_id: artifactId(2),
      linked_at: '2026-07-31T00:01:00.000Z',
      pinned_version: null,
    };
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:01:00.000Z',
        idempotency_key: 'valid-archived-sibling',
        payload: validPayload,
        event_id: eventId,
      },
      paths
    );
    await mirror.mirrorUsageRecord(invalid, paths.sidecarsDir, repo.path);

    const before = await computeMirrorLag(repairOptions());
    expect(before.usage).toEqual({
      hot_events: 2,
      archived_events: 1,
      missing_event_ids: [eventId],
    });
    expect(before.repairable_missing).toBe(1);
    expect(before.blocked_missing).toBe(0);

    const result = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(result.replayed_events).toBe(1);
    expect(result.remaining_missing).toBe(0);
    expect(result.blocked_missing).toBe(0);
    expect(result.complete).toBe(true);

    const archivePaths = archiveUsageLedgerPaths(projectDir);
    const rawLines = (await readFile(archivePaths.ledgerNdjson, 'utf8')).trim().split('\n');
    expect(rawLines).toHaveLength(2);
    const archived = await readUsageLedger({
      ledgerPath: archivePaths.ledgerNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.payload).toEqual(validPayload);
  });

  it('treats a valid same-envelope archive record with different payload as missing', async () => {
    const eventId = artifactId(106);
    const envelope = {
      type: 'source_plan_linked' as const,
      ts: '2026-07-31T00:00:00.000Z',
      idempotency_key: 'divergent-valid',
      event_id: eventId,
    };
    const hotPaths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const archivePaths = archiveUsageLedgerPaths(projectDir);
    const archiveLedger = {
      ledgerPath: archivePaths.ledgerNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    };
    await appendUsageLedgerRecord(
      {
        ...envelope,
        payload: {
          canonical_ref_id: 'cloud:authoritative',
          artifact_id: artifactId(1),
          linked_at: envelope.ts,
          pinned_version: null,
        },
      },
      hotPaths
    );
    await appendUsageLedgerRecord(
      {
        ...envelope,
        payload: {
          canonical_ref_id: 'cloud:divergent',
          artifact_id: artifactId(2),
          linked_at: envelope.ts,
          pinned_version: null,
        },
      },
      archiveLedger
    );

    const before = await computeMirrorLag(repairOptions());
    expect(before.usage.missing_event_ids).toEqual([eventId]);
    expect(before.repairable_missing).toBe(1);

    const repaired = await replayMissingEvents({ ...repairOptions(), mirror });
    expect(repaired.replayed_events).toBe(1);
    expect(repaired.remaining_missing).toBe(0);
    expect(repaired.complete).toBe(true);
    const archived = await readUsageLedger(archiveLedger);
    expect(archived).toHaveLength(2);
    expect(archived.at(-1)?.payload).toMatchObject({
      canonical_ref_id: 'cloud:authoritative',
    });
  });

  it('keeps an exact-envelope malformed sibling quarantined after valid publication', async () => {
    const eventId = artifactId(101);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const envelope = {
      type: 'source_plan_linked' as const,
      ts: '2026-07-31T00:00:00.000Z',
      idempotency_key: 'same-envelope',
      event_id: eventId,
    };
    await appendUsageLedgerRecord({ ...envelope, payload: { malformed: true } }, paths);
    const valid = await appendUsageLedgerRecord(
      {
        ...envelope,
        payload: {
          canonical_ref_id: 'cloud:plan-3',
          artifact_id: artifactId(3),
          linked_at: '2026-07-31T00:00:00.000Z',
          pinned_version: null,
        },
      },
      paths
    );
    await mirror.mirrorUsageRecord(valid, paths.sidecarsDir, repo.path);

    const report = await computeMirrorLag(repairOptions());
    expect(report.usage).toEqual({
      hot_events: 2,
      archived_events: 1,
      missing_event_ids: [eventId],
    });
    expect(report.repairable_missing).toBe(0);
    expect(report.blocked_missing).toBe(0);
    expect(report.usage_blocked_missing).toBe(1);
  });

  it('recognizes the exact redacted copy of an invalid record across a spill change', async () => {
    const redactingMirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'redacted-invalid-locks'),
      redactSecrets: true,
    });
    const eventId = artifactId(104);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const invalid = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:00:00.000Z',
        idempotency_key: 'redacted-invalid',
        payload: {
          malformed: `api_key=${'s'.repeat(9_000)}`,
        },
        event_id: eventId,
      },
      paths
    );
    expect(invalid).toHaveProperty('sidecar_sha256');
    await redactingMirror.mirrorUsageRecord(invalid, paths.sidecarsDir, repo.path);

    const report = await computeMirrorLag(repairOptions());
    expect(report.usage).toEqual({
      hot_events: 1,
      archived_events: 1,
      missing_event_ids: [],
    });
    expect(report.repairable_missing).toBe(0);
    expect(report.blocked_missing).toBe(0);
    expect(report.usage_blocked_missing).toBe(0);
    const archivedLine = JSON.parse(
      (await readFile(archiveUsageLedgerPaths(projectDir).ledgerNdjson, 'utf8')).trim()
    ) as Record<string, unknown>;
    expect(archivedLine).toHaveProperty('payload');
    expect(archivedLine).not.toHaveProperty('sidecar_sha256');
  });

  it('consumes redaction-colliding invalid archive identities only once', async () => {
    const redactingMirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'redacted-twin-locks'),
      redactSecrets: true,
    });
    const eventId = artifactId(105);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const envelope = {
      type: 'source_plan_linked' as const,
      ts: '2026-07-31T00:00:00.000Z',
      idempotency_key: 'invalid-twins',
      event_id: eventId,
    };
    const archived = await appendUsageLedgerRecord(
      { ...envelope, payload: { malformed: 'ghp_0000000000000000000000000000000000000' } },
      paths
    );
    const sibling = await appendUsageLedgerRecord(
      { ...envelope, payload: { malformed: 'ghp_1111111111111111111111111111111111111' } },
      paths
    );
    await redactingMirror.mirrorUsageRecord(archived, paths.sidecarsDir, repo.path);

    const firstRedacted = deriveUsageLedgerRecord({
      ...envelope,
      payload: redactSecretsInObject({ malformed: 'ghp_0000000000000000000000000000000000000' }),
    }).record;
    const secondRedacted = deriveUsageLedgerRecord({
      ...envelope,
      payload: redactSecretsInObject({ malformed: 'ghp_1111111111111111111111111111111111111' }),
    }).record;
    expect(firstRedacted.checksum).toBe(secondRedacted.checksum);
    expect(firstRedacted.checksum).not.toBe(archived.checksum);
    expect(firstRedacted.checksum).not.toBe(sibling.checksum);
    const archivedRecord = JSON.parse(
      (await readFile(archiveUsageLedgerPaths(projectDir).ledgerNdjson, 'utf8')).trim()
    ) as { checksum: string };
    expect(archivedRecord.checksum).toBe(firstRedacted.checksum);

    const report = await computeMirrorLag(repairOptions());
    expect(report.usage.missing_event_ids).toEqual([eventId]);
    expect(report.repairable_missing).toBe(0);
    expect(report.blocked_missing).toBe(0);
    expect(report.usage_blocked_missing).toBe(1);
  });

  it.each([false, true])(
    'retains a displaced sidecar when repairing a valid same-id sibling with redaction=%s',
    async (redactSecrets) => {
      const collisionMirror = new ArchiveMirror({
        projectDir,
        locksDir: path.join(scratchDir, 'collision-locks'),
        redactSecrets,
      });
      const initialMirror = redactSecrets
        ? new ArchiveMirror({
            projectDir,
            locksDir: path.join(scratchDir, 'collision-locks'),
            redactSecrets: false,
          })
        : collisionMirror;
      const eventId = artifactId(102);
      const paths = {
        ledgerPath: usageLedgerPath(repo.path),
        sidecarsDir: usageSidecarsDir(repo.path),
        containmentRoot: repo.path,
      };
      const invalid = await appendUsageLedgerRecord(
        {
          type: 'source_plan_linked',
          ts: '2026-07-31T00:00:00.000Z',
          idempotency_key: 'invalid-sidecar',
          payload: {
            malformed: 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyz' + 'x'.repeat(9_000),
          },
          event_id: eventId,
        },
        paths
      );
      expect(invalid).toHaveProperty('sidecar_sha256');
      await initialMirror.mirrorUsageRecord(invalid, paths.sidecarsDir, repo.path);
      const archivePaths = archiveUsageLedgerPaths(projectDir);
      const displacedBytes = await readFile(path.join(archivePaths.sidecarsDir, `${eventId}.json`));
      const conflictRoot = path.join(path.dirname(archivePaths.sidecarsDir), 'sidecar-conflicts');
      await mkdir(conflictRoot, { recursive: true });
      if (process.platform !== 'win32') await chmod(conflictRoot, 0o755);

      const validPayload = {
        canonical_ref_id: `cloud:${'p'.repeat(9_000)}`,
        artifact_id: artifactId(4),
        linked_at: '2026-07-31T00:01:00.000Z',
        pinned_version: null,
      };
      await appendUsageLedgerRecord(
        {
          type: 'source_plan_linked',
          ts: '2026-07-31T00:01:00.000Z',
          idempotency_key: 'valid-sidecar',
          payload: validPayload,
          event_id: eventId,
        },
        paths
      );

      const result = await replayMissingEvents({ ...repairOptions(), mirror: collisionMirror });
      expect(result.replayed_events).toBe(1);
      expect(result.complete).toBe(true);
      expect(result.blocked_missing).toBe(0);
      expect(result.usage_blocked_missing).toBe(1);
      const conflictDir = path.join(conflictRoot, eventId);
      const conflictFiles = await readdir(conflictDir);
      expect(conflictFiles).toHaveLength(1);
      const retainedBytes = await readFile(path.join(conflictDir, conflictFiles[0]!));
      expect(conflictFiles[0]).toBe(
        `${createHash('sha256').update(retainedBytes).digest('hex')}.json`
      );
      if (process.platform !== 'win32') {
        expect((await stat(path.dirname(conflictDir))).mode & 0o777).toBe(0o700);
        expect((await stat(conflictDir)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(conflictDir, conflictFiles[0]!))).mode & 0o777).toBe(0o600);
      }
      expect(retainedBytes).toEqual(displacedBytes);
      const archived = await readUsageLedger({
        ledgerPath: archivePaths.ledgerNdjson,
        sidecarsDir: archivePaths.sidecarsDir,
      });
      expect(archived).toHaveLength(1);
      expect(archived[0]?.payload).toEqual(validPayload);
    }
  );

  it('keeps the canonical sidecar unchanged when conflict retention fails', async () => {
    const warnings: string[] = [];
    const collisionMirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(scratchDir, 'blocked-collision-locks'),
      redactSecrets: false,
      onWarn: (message) => warnings.push(message),
    });
    const eventId = artifactId(103);
    const paths = {
      ledgerPath: usageLedgerPath(repo.path),
      sidecarsDir: usageSidecarsDir(repo.path),
      containmentRoot: repo.path,
    };
    const invalid = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:00:00.000Z',
        idempotency_key: 'invalid-sidecar',
        payload: { malformed: 'x'.repeat(9_000) },
        event_id: eventId,
      },
      paths
    );
    await collisionMirror.mirrorUsageRecord(invalid, paths.sidecarsDir, repo.path);
    const archivePaths = archiveUsageLedgerPaths(projectDir);
    const canonicalPath = path.join(archivePaths.sidecarsDir, `${eventId}.json`);
    const displacedBytes = await readFile(canonicalPath);
    await writeFile(
      path.join(path.dirname(archivePaths.sidecarsDir), 'sidecar-conflicts'),
      'block'
    );

    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-07-31T00:01:00.000Z',
        idempotency_key: 'valid-sidecar',
        payload: {
          canonical_ref_id: `cloud:${'p'.repeat(9_000)}`,
          artifact_id: artifactId(5),
          linked_at: '2026-07-31T00:01:00.000Z',
          pinned_version: null,
        },
        event_id: eventId,
      },
      paths
    );

    const result = await replayMissingEvents({ ...repairOptions(), mirror: collisionMirror });
    expect(result.complete).toBe(false);
    expect(result.remaining_missing).toBe(1);
    expect(await readFile(canonicalPath)).toEqual(displacedBytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed to mirror usage event');
  });

  function repairOptions() {
    return {
      repoRoot: repo.path,
      config: getDefaultConfig(),
      projectDir,
    };
  }

  function hotPaths(id: string) {
    return artifactPathsFor(repo.path, getDefaultConfig(), id);
  }

  async function writePlan(id: string): Promise<EventRecord[]> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: id,
        branch: 'main',
        base_sha: 'abc123',
        agent: 'codex',
        agent_session_id: null,
        task: `repair fixture ${id}`,
        label: `repair-${id}`,
        plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-07-31T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: `plan-${id}` }
    );
    return readHotRecords(id);
  }

  async function writeClosedLifecycle(id: string): Promise<EventRecord[]> {
    await writePlan(id);
    await store.writeCheckpointOpened(
      { artifact_id: id, declared_step_ids: [STEP_ID] },
      { idempotencyKey: `open-${id}`, headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: id,
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
      { idempotencyKey: `close-${id}` }
    );
    return readHotRecords(id);
  }

  async function appendOrphanAbandon(id: string): Promise<EventRecord> {
    return appendEvent(
      {
        type: 'checkpoint_abandoned',
        ts: '2026-07-31T00:01:00.000Z',
        idempotency_key: `orphan-${id}`,
        payload: { artifact_id: id, n: 1 },
      },
      eventLogOptions(hotPaths(id))
    );
  }

  async function readHotRecords(id: string): Promise<EventRecord[]> {
    return (await readEventLog(eventLogOptions(hotPaths(id)))).events;
  }

  async function mirrorRecord(id: string, record: EventRecord): Promise<void> {
    await mirror.mirrorEventRecord(id, record, hotPaths(id).sidecarsDir, repo.path);
  }
});

function artifactId(n: number): string {
  return `01999999-9999-7000-8000-${n.toString().padStart(12, '0')}`;
}

function eventLogOptions(paths: { eventsNdjson: string; sidecarsDir: string }) {
  return {
    eventLogPath: paths.eventsNdjson,
    sidecarsDir: paths.sidecarsDir,
  };
}
