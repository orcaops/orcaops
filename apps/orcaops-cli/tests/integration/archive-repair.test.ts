import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `archive status` + `archive repair`. The load-bearing flow:
 * capture with archive OFF (pre-existing history), enable, `status` shows
 * lag, `repair` backfills byte-identically, a second `repair` is a no-op,
 * and archive-side corruption is surfaced but never rewritten.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T>(r: CliResult): T {
  expect(r.exitCode, `${r.stderr}\n${r.stdout}`).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

interface StatusJson {
  enabled: boolean;
  project_id?: string;
  total_missing?: number;
  repairable_missing?: number;
  blocked_missing?: number;
  blocked_artifacts?: number;
  artifacts_requiring_rebuild?: number;
  artifacts?: Array<{
    artifact_id: string;
    repair_mode: 'complete' | 'tail_replay' | 'canonical_rebuild' | 'blocked';
    block_reason: 'hot_log_corrupt' | 'archive_ahead' | 'hot_unreconstructable' | null;
    resolution_commands?: string[];
    source_state?: {
      hot: { valid: boolean };
      archive: { valid: boolean };
    };
  }>;
  archive_corrupt_lines?: number;
  hint?: string;
  note?: string;
}

interface RepairJson {
  missing_before: number;
  replayed_events: number;
  remaining_missing: number;
  blocked_missing: number;
  blocked_artifacts: number;
  complete: boolean;
  artifact_issues: Array<{ artifact_id: string; kind: string; message: string }>;
  rebuilt_artifacts: Array<{ artifact_id: string; backup_path: string }>;
  remaining_rebuilds: number;
  archive_corrupt_lines: number;
}

interface ResolveJson {
  artifact_id: string;
  source: 'archive' | 'hot';
  applied: boolean;
  backup_path: string | null;
  events_installed?: number;
  source_state: {
    hot: { valid: boolean; event_ids: string[]; corrupt_lines: number; error: string | null };
    archive: { valid: boolean; event_ids: string[]; corrupt_lines: number; error: string | null };
  };
  resolution_commands: string[];
}

describe('archive status + repair', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-archive-repair-'));
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DATA_DIR: dataRoot } });
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function setArchiveEnabled(enabled: boolean): Promise<void> {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  async function capturePlan(): Promise<string> {
    const plan = parseOk<{ artifact_id: string }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'repair e2e',
            label: `repair-e2e-${randomUUID().slice(0, 8)}`,
            plan_steps: [{ text: 'step 1', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    return plan.artifact_id;
  }

  async function captureAbandonedCheckpoint(): Promise<string> {
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'prefix repair e2e',
            label: `prefix-repair-${randomUUID().slice(0, 8)}`,
            plan_steps: [{ text: 'step 1', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            declared_step_ids: [plan.plan_steps[0].step_id],
          })
        ),
      ])
    );
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'abandon',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            n: 1,
            reason: 'fixture abandonment',
          })
        ),
      ])
    );
    return plan.artifact_id;
  }

  it('status on a disabled repo reports disabled', async () => {
    await setArchiveEnabled(false);
    const s = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(s.enabled).toBe(false);
    expect(s.note).toContain('disabled');
  });

  it('enable-after-capture: status shows lag → repair backfills → clean → idempotent', async () => {
    await setArchiveEnabled(false);
    const artifactId = await capturePlan(); // archive OFF — pre-existing history
    await setArchiveEnabled(true);

    const before = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(before.enabled).toBe(true);
    expect(before.total_missing).toBeGreaterThanOrEqual(1);
    expect(before.hint).toContain('archive repair');

    const repair = parseOk<RepairJson>(await agent.runRaw(['archive', 'repair', '--json']));
    expect(repair.missing_before).toBe(before.total_missing);
    expect(repair.replayed_events).toBe(before.total_missing);
    expect(repair.remaining_missing).toBe(0);
    expect(repair.rebuilt_artifacts).toEqual([]);
    expect(repair.remaining_rebuilds).toBe(0);

    // Backfill is byte-identical to the hot log.
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLog = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      'utf8'
    );
    const archiveLog = await readFile(
      path.join(dataRoot, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'),
      'utf8'
    );
    expect(archiveLog).toBe(hotLog);

    const after = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(after.total_missing).toBe(0);
    expect(after.hint).toBeUndefined();

    const again = parseOk<RepairJson>(await agent.runRaw(['archive', 'repair', '--json']));
    expect(again.missing_before).toBe(0);
    expect(again.replayed_events).toBe(0);
    expect(again.remaining_missing).toBe(0);
    expect(archiveLog).toBe(
      await readFile(
        path.join(dataRoot, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'),
        'utf8'
      )
    );
  });

  it('rebuilds a missing prefix in canonical order, validates it, and retains the damaged copy', async () => {
    await setArchiveEnabled(true);
    const artifactId = await captureAbandonedCheckpoint();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const hotLog = await readFile(hotLogPath, 'utf8');
    const hotLines = hotLog.trimEnd().split('\n');
    const abandonAt = hotLines.findIndex(
      (line) => (JSON.parse(line) as { type: string }).type === 'checkpoint_abandoned'
    );
    expect(abandonAt).toBeGreaterThan(0);
    const damaged = `${hotLines.slice(abandonAt).join('\n')}\n`;
    await writeFile(archiveLogPath, damaged, 'utf8');

    const before = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(before.total_missing).toBe(abandonAt);
    expect(before.artifacts_requiring_rebuild).toBe(1);
    expect(before.artifacts?.find((row) => row.artifact_id === artifactId)?.repair_mode).toBe(
      'canonical_rebuild'
    );

    // Put the missing prefix after the existing suffix: every event id is
    // present, but the order is unreconstructable and still requires a
    // canonical rebuild.
    const outOfOrderArchive = `${damaged}${hotLines.slice(0, abandonAt).join('\n')}\n`;
    await writeFile(archiveLogPath, outOfOrderArchive, 'utf8');
    const wrongOrder = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(wrongOrder.total_missing).toBe(0);
    expect(wrongOrder.artifacts_requiring_rebuild).toBe(1);

    const repair = parseOk<RepairJson>(await agent.runRaw(['archive', 'repair', '--json']));
    expect(repair.remaining_missing).toBe(0);
    expect(repair.remaining_rebuilds).toBe(0);
    expect(repair.rebuilt_artifacts).toEqual([
      {
        artifact_id: artifactId,
        backup_path: expect.any(String),
      },
    ]);
    const backupPath = repair.rebuilt_artifacts[0].backup_path;
    expect(await readFile(path.join(backupPath, 'events.ndjson'), 'utf8')).toBe(outOfOrderArchive);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(hotLog);

    // The command's post-repair strict reconstruction is part of success, not
    // merely an event-ID set comparison that can accept the wrong order.
    const after = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(after.total_missing).toBe(0);
    expect(after.artifacts_requiring_rebuild).toBe(0);
    expect(after.artifacts?.find((row) => row.artifact_id === artifactId)?.repair_mode).toBe(
      'complete'
    );
  });

  it('appended archive garbage is surfaced and left unchanged when no rebuild is needed', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan(); // mirrored live
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    await appendFile(archiveLogPath, '{"tampered": true}\n', 'utf8');
    const tampered = await readFile(archiveLogPath, 'utf8');

    const status = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(status.archive_corrupt_lines).toBe(1);

    const repair = parseOk<RepairJson>(await agent.runRaw(['archive', 'repair', '--json']));
    expect(repair.archive_corrupt_lines).toBe(1);
    // Append-only: the corrupt line is still there, byte-for-byte.
    expect(await readFile(archiveLogPath, 'utf8')).toBe(tampered);
  });

  it('rebuilds a damaged existing archive event and retains the damaged bytes', async () => {
    await setArchiveEnabled(true);
    const artifactId = await captureAbandonedCheckpoint();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const hot = await readFile(hotLogPath, 'utf8');
    const lines = hot.trimEnd().split('\n');
    const damagedEvent = JSON.parse(lines[1]!) as Record<string, unknown>;
    damagedEvent.idempotency_key = 'checksum-invalidated';
    lines[1] = JSON.stringify(damagedEvent);
    const damaged = `${lines.join('\n')}\n`;
    await writeFile(archiveLogPath, damaged, 'utf8');

    const status = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(status.archive_corrupt_lines).toBe(1);
    expect(status.artifacts?.find((row) => row.artifact_id === artifactId)?.repair_mode).toBe(
      'canonical_rebuild'
    );

    const repair = parseOk<RepairJson>(await agent.runRaw(['archive', 'repair', '--json']));
    expect(repair.rebuilt_artifacts).toEqual([
      { artifact_id: artifactId, backup_path: expect.any(String) },
    ]);
    expect(
      await readFile(path.join(repair.rebuilt_artifacts[0]!.backup_path, 'events.ndjson'), 'utf8')
    ).toBe(damaged);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(hot);
  });

  it('reports a corrupt hot artifact without aborting repair or changing its archive', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const archivedBefore = await readFile(archiveLogPath, 'utf8');
    await appendFile(hotLogPath, '{"broken":', 'utf8');

    const status = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(status.repairable_missing).toBe(0);
    expect(status.blocked_missing).toBe(0);
    expect(status.blocked_artifacts).toBe(1);
    expect(status.artifacts_requiring_rebuild).toBe(0);
    expect(status.artifacts?.find((row) => row.artifact_id === artifactId)).toMatchObject({
      repair_mode: 'blocked',
      block_reason: 'hot_log_corrupt',
      source_state: {
        hot: { valid: false },
        archive: { valid: true },
      },
      resolution_commands: [
        `orcaops archive resolve --artifact ${artifactId} --source archive --apply`,
      ],
    });

    const result = await agent.runRaw(['archive', 'repair', '--json']);
    const repair = parseOk<RepairJson>(result);
    expect(repair.complete).toBe(false);
    expect(repair.remaining_missing).toBe(0);
    expect(repair.blocked_artifacts).toBe(1);
    expect(repair.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: artifactId,
        kind: 'hot_log_corrupt',
      }),
    ]);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(archivedBefore);
  });

  it('resolve is dry-run first and archive authority restores corrupt hot with a retained backup', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    await appendFile(hotLogPath, '{"broken":', 'utf8');
    const hotBefore = await readFile(hotLogPath, 'utf8');
    const archiveBefore = await readFile(archiveLogPath, 'utf8');

    const dryRun = parseOk<ResolveJson>(
      await agent.runRaw([
        'archive',
        'resolve',
        '--artifact',
        artifactId,
        '--source',
        'archive',
        '--json',
      ])
    );
    expect(dryRun).toMatchObject({
      artifact_id: artifactId,
      source: 'archive',
      applied: false,
      backup_path: null,
      source_state: {
        hot: { valid: false },
        archive: { valid: true },
      },
    });
    expect(await readFile(hotLogPath, 'utf8')).toBe(hotBefore);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(archiveBefore);

    const invalid = await agent.runRaw([
      'archive',
      'resolve',
      '--artifact',
      artifactId,
      '--source',
      'hot',
      '--apply',
      '--json',
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await readFile(hotLogPath, 'utf8')).toBe(hotBefore);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(archiveBefore);

    const applied = parseOk<ResolveJson>(
      await agent.runRaw([
        'archive',
        'resolve',
        '--artifact',
        artifactId,
        '--source',
        'archive',
        '--apply',
        '--json',
      ])
    );
    expect(applied).toMatchObject({
      artifact_id: artifactId,
      source: 'archive',
      applied: true,
      events_installed: 1,
      backup_path: expect.any(String),
    });
    expect(await readFile(path.join(applied.backup_path!, 'events.ndjson'), 'utf8')).toBe(
      hotBefore
    );
    expect(await readFile(hotLogPath, 'utf8')).toBe(archiveBefore);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(archiveBefore);

    const after = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(after.blocked_artifacts).toBe(0);
  });

  it('resolve exposes both valid authorities and hot authority retains the prior archive', async () => {
    await setArchiveEnabled(true);
    const artifactId = await captureAbandonedCheckpoint();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const archiveBefore = await readFile(archiveLogPath, 'utf8');
    const planOnly = `${(await readFile(hotLogPath, 'utf8')).split('\n')[0]}\n`;
    await writeFile(hotLogPath, planOnly, 'utf8');

    const status = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(status.artifacts?.find((row) => row.artifact_id === artifactId)).toMatchObject({
      repair_mode: 'blocked',
      block_reason: 'archive_ahead',
      source_state: {
        hot: { valid: true },
        archive: { valid: true },
      },
      resolution_commands: [
        `orcaops archive resolve --artifact ${artifactId} --source archive --apply`,
        `orcaops archive resolve --artifact ${artifactId} --source hot --apply`,
      ],
    });

    const dryRun = parseOk<ResolveJson>(
      await agent.runRaw([
        'archive',
        'resolve',
        '--artifact',
        artifactId,
        '--source',
        'hot',
        '--json',
      ])
    );
    expect(dryRun).toMatchObject({
      source: 'hot',
      applied: false,
      backup_path: null,
    });
    expect(await readFile(hotLogPath, 'utf8')).toBe(planOnly);
    expect(await readFile(archiveLogPath, 'utf8')).toBe(archiveBefore);

    const applied = parseOk<ResolveJson>(
      await agent.runRaw([
        'archive',
        'resolve',
        '--artifact',
        artifactId,
        '--source',
        'hot',
        '--apply',
        '--json',
      ])
    );
    expect(applied).toMatchObject({
      source: 'hot',
      applied: true,
      events_installed: 1,
      backup_path: expect.any(String),
    });
    expect(await readFile(path.join(applied.backup_path!, 'events.ndjson'), 'utf8')).toBe(
      archiveBefore
    );
    expect(await readFile(archiveLogPath, 'utf8')).toBe(planOnly);
    expect(await readFile(hotLogPath, 'utf8')).toBe(planOnly);
  });

  it('offers no automated resolution when neither source strictly reconstructs', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const hotLogPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    await appendFile(hotLogPath, '{"broken":', 'utf8');
    await appendFile(archiveLogPath, '{"broken":', 'utf8');

    const status = parseOk<StatusJson>(await agent.runRaw(['archive', 'status', '--json']));
    expect(status.artifacts?.find((row) => row.artifact_id === artifactId)).toMatchObject({
      repair_mode: 'blocked',
      source_state: {
        hot: { valid: false },
        archive: { valid: false },
      },
      resolution_commands: [],
    });
  });

  it('repair on a disabled repo is INVALID_INPUT', async () => {
    await setArchiveEnabled(false);
    const r = await agent.runRaw(['archive', 'repair', '--json']);
    expect(r.exitCode).not.toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});
