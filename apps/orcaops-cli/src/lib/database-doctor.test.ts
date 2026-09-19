import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildDiffFingerprintManifest } from '@orcaops/core';
import type { DatabaseMaintenanceInspection } from '@orcaops/core/history/database-retention';
import { type Pin, uuidv7 } from '@orcaops/storage';
import {
  ProjectDatabaseError,
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
} from '@orcaops/storage/history/database';

import { databaseMaintenanceCheck, inspectDatabaseDoctorHistory } from './database-doctor.js';
import { fixture, git, inventory } from '../../tests/helpers/database-history.js';
import { databaseHistoryFailure } from '../commands/doctor.js';

function check(result: Awaited<ReturnType<typeof inspectDatabaseDoctorHistory>>, name: string) {
  const found = result.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing doctor check ${name}`);
  return found;
}

async function inspectLineage(f: Awaited<ReturnType<typeof fixture>>) {
  return check(
    await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    }),
    'lineage-orphan'
  );
}

async function recordLineage(
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string,
  headSha: string
) {
  return f.mutate(artifactId, { headSha }, (semantics) =>
    semantics.appendBranchLineage(artifactId, {
      branch: 'main',
      head_sha: headSha,
      ts: '2026-09-05T01:00:00.000Z',
      event: 'rebased',
    })
  );
}

async function logGitProbes(f: Awaited<ReturnType<typeof fixture>>, failCommand = '') {
  const bin = path.join(f.temporary, 'bin');
  const log = path.join(f.temporary, 'git-probes');
  await mkdir(bin);
  await writeFile(log, '');
  await writeFile(
    path.join(bin, 'git'),
    '#!/bin/sh\n' +
      'printf "%s\\n" "$1" >> "$GIT_PROBE_LOG"\n' +
      'if [ "$1" = "$GIT_FAIL_COMMAND" ]; then cat >/dev/null; exit 128; fi\n' +
      'exec "$REAL_GIT" "$@"\n',
    { mode: 0o700 }
  );
  vi.stubEnv('REAL_GIT', execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
  vi.stubEnv('GIT_PROBE_LOG', log);
  vi.stubEnv('GIT_FAIL_COMMAND', failCommand);
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  return log;
}

async function recordCapturedCheckpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string
) {
  const commit = f.registeredContext.git.headOid;
  if (commit === null) throw new Error('Fixture has no Git HEAD');
  const tree = (await git(f.main, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  await f.mutate(artifactId, { capturedFingerprint: true }, async (semantics) => {
    const plan = await semantics.readPlan(artifactId);
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [plan!.plan_steps[0]!.step_id] },
      {
        idempotencyKey: uuidv7(),
        headSha: commit,
        snapshotCallbacks: {
          captureOpenSnapshot: async () => ({
            boundary: {
              snapshot_ref: `refs/orcaops/snap/${artifactId}/open`,
              tree_sha: tree,
              snapshot_commit_sha: commit,
              snapshot_error_reason: null,
            },
          }),
        },
      }
    );
    if (!('checkpoint' in opened)) throw new Error('Fixture checkpoint did not open');
    const fingerprint = await buildDiffFingerprintManifest({
      artifactId,
      checkpointN: opened.checkpoint.n,
      openTreeSha: tree,
      closeTreeSha: tree,
      diffBytes: Buffer.alloc(0),
      truncated: false,
      maxDiffBytes: 1024,
    });
    return semantics.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: opened.checkpoint.n,
        head_sha: commit,
        summary: 'Retained empty fingerprint',
        files_changed: [],
        completed_step_ids: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      },
      {
        idempotencyKey: uuidv7(),
        snapshotCallbacks: {
          captureCloseFingerprint: async () => ({
            boundary: {
              snapshot_ref: `refs/orcaops/snap/${artifactId}/${opened.checkpoint.n}/close`,
              tree_sha: tree,
              snapshot_commit_sha: commit,
              snapshot_error_reason: null,
            },
            ...fingerprint,
          }),
        },
      }
    );
  });
}

describe('database doctor history', () => {
  it('reads retained history and Git evidence without changing application state', async () => {
    const f = await fixture();
    const captured = await f.capture(undefined, { ts: '2026-09-08T00:00:00.000Z' });
    await f.recordFiles(captured, ['src/example.ts']);
    await f.capture(undefined, { reason: 'imported', ts: '2026-09-08T00:00:00.000Z' });
    const before = await inventory(f.temporary);

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
      now: Date.parse('2026-09-08T01:00:00.000Z'),
    });

    expect(check(result, 'history-database')).toMatchObject({ status: 'pass' });
    expect(check(result, 'artifact-integrity')).toMatchObject({
      status: 'pass',
      summary: '2 retained artifact revision(s) reconstructed exactly',
    });
    expect(check(result, 'execution-history')).toMatchObject({ status: 'warn' });
    expect(check(result, 'git-publications')).toMatchObject({ status: 'pass' });
    expect(check(result, 'seed')).toMatchObject({ status: 'warn' });
    expect(check(result, 'seed').details?.join('\n')).not.toContain('owned seed protocol');
    expect(check(result, 'plan-idempotency')).toMatchObject({ status: 'pass' });
    expect(check(result, 'cloud-sync-pending')).toMatchObject({ status: 'pass' });
    expect(check(result, 'usage-history')).toMatchObject({ status: 'pass' });
    expect(check(result, 'skipped-fingerprint-rate')).toMatchObject({ status: 'warn' });
    expect(check(result, 'stale-pin')).toMatchObject({ status: 'pass' });
    expect(result.seedNeedsRepair).toBe(true);
    expect(result.checks.some((entry) => entry.summary.includes(captured))).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports every retained publication state and pending admission identity', () => {
    const projectId = uuidv7();
    const storeInstanceId = uuidv7();
    const repositoryInstanceId = uuidv7();
    const originalOperationId = uuidv7();
    const publicationId = uuidv7();
    const admissionOperationId = uuidv7();
    const terminalOperationId = uuidv7();
    const retiredTransitionId = uuidv7();
    const oid = 'a'.repeat(40);
    const resources: DatabaseMaintenanceInspection['resources'] = [
      {
        publicationId,
        originalOperationId,
        fullRef: `refs/orcaops/baseline/${projectId}-${publicationId}`,
        expectedOid: oid,
        observedOid: oid,
        symbolicTarget: null,
        state: 'eligible',
        reason: 'retired',
        admissionOperationId,
        target: {
          publicationId,
          originalOperationId,
          repositoryInstanceId,
          retiredTransitionId,
          fullRef: `refs/orcaops/baseline/${projectId}-${publicationId}`,
          objectOid: oid,
          objectFormat: 'sha1',
        },
      },
      ...(['unknown', 'symbolic', 'pending', 'selected'] as const).map((reason) => ({
        publicationId: reason === 'unknown' ? null : uuidv7(),
        originalOperationId: reason === 'unknown' ? null : uuidv7(),
        fullRef: `refs/orcaops/snap/${projectId}/${reason}`,
        expectedOid: reason === 'unknown' ? null : oid,
        observedOid: oid,
        symbolicTarget: reason === 'symbolic' ? 'refs/heads/main' : null,
        state: 'protected' as const,
        reason,
        admissionOperationId: null,
        target: null,
      })),
      {
        publicationId: uuidv7(),
        originalOperationId: uuidv7(),
        fullRef: `refs/orcaops/baseline/${projectId}-reclaimed`,
        expectedOid: oid,
        observedOid: null,
        symbolicTarget: null,
        state: 'reclaimed',
        reason: 'already-reclaimed',
        admissionOperationId: null,
        target: null,
      },
    ];
    const inspection: DatabaseMaintenanceInspection = {
      authority: {
        resolvedRoot: '/history',
        rootKey: '/history',
        projectId,
        storeInstanceId,
        repositoryInstanceId,
      },
      resources,
      pendingAdmissions: [
        {
          admissionOperationId,
          terminalOperationId,
          target: resources[0]!.target!,
        },
      ],
      completeness: { complete: true, issues: [] },
    };

    const result = databaseMaintenanceCheck(inspection);

    expect(result.status).toBe('warn');
    expect(result.summary).toContain('1 eligible, 4 protected, 1 reclaimed');
    const details = result.details?.join('\n') ?? '';
    for (const value of [
      publicationId,
      originalOperationId,
      admissionOperationId,
      terminalOperationId,
      retiredTransitionId,
      oid,
      'eligible/retired',
      'protected/unknown',
      'protected/symbolic',
      'protected/pending',
      'protected/selected',
      'reclaimed/already-reclaimed',
      'symbolic-target=refs/heads/main',
    ])
      expect(details).toContain(value);
  });

  it('preserves a nested database failure code and integrity guidance', () => {
    const failure = databaseHistoryFailure(
      new Error('outer failure', {
        cause: new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Retained relationship is missing'
        ),
      })
    );

    expect(failure.summary).toBe('HISTORY_INTEGRITY_REQUIRED: Retained relationship is missing');
    expect(failure.details).toEqual([
      'Preserve the database, SQLite companion files, registration and retained evidence. Restore a verified backup if available; otherwise report this Doctor output for investigation. Doctor cannot reconstruct authoritative history.',
    ]);
  });

  it('does not offer setup as a replacement for missing registered history', () => {
    const failure = databaseHistoryFailure(
      new ProjectDatabaseError('HISTORY_MISSING', 'The registered database is missing')
    );

    expect(failure.details).toEqual([
      'Preserve the registration, SQLite companion files and retained evidence. Restore the original registered database from a verified backup if available; otherwise report this Doctor output for investigation. Setup cannot replace missing history.',
    ]);
  });

  it('validates ephemeral pin targets against database execution state', async () => {
    const f = await fixture();
    const artifactId = await f.capture(undefined, { ts: '2026-09-08T00:00:00.000Z' });
    const pin: Pin = {
      schema_version: 1,
      artifact_id: artifactId,
      branch: 'elsewhere',
      shell_key: { kind: 'codex_session', value: 'doctor-test' },
      pinned_at: '2026-08-01T00:00:00.000Z',
      pinned_via: 'explicit-checkout',
    };
    await f.mutate(artifactId, { displacedBy: uuidv7() }, (semantics) =>
      semantics.writePinDisplaced(artifactId, {
        displaced_by_artifact_id: uuidv7(),
        shell_key: pin.shell_key,
        reason: 'explicit-checkout',
      })
    );

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [pin],
      shellKey: { kind: 'none' },
      historyCommitCount: 0,
      dispositionTtlDays: 30,
      now: Date.parse('2026-09-08T01:00:00.000Z'),
    });

    expect(check(result, 'stale-pin')).toMatchObject({ status: 'warn' });
    expect(check(result, 'stale-pin').details).toContain(
      `  - ${artifactId}: binding branch differs from the pin`
    );
    expect(check(result, 'aged-pin')).toMatchObject({ status: 'warn' });
    expect(check(result, 'pin-displaced')).toMatchObject({ status: 'warn' });
  });

  it('preserves evaluator resolution denominators and global trailing-run order', async () => {
    const f = await fixture();
    const first = await f.capture();
    const second = await f.capture();
    const appendRun = async (
      artifactId: string,
      evaluatorRef: string,
      ts: string,
      outcome: 'pass' | 'violation' | 'error' | 'skipped'
    ) => {
      const runId = uuidv7();
      await f.mutate(artifactId, { runId }, (semantics) =>
        semantics.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: evaluatorRef,
          package_id: 'test',
          evaluator_id: evaluatorRef.split('/')[1]!,
          phase: 'checkpoint-close',
          severity: outcome === 'violation' ? 'block' : 'warn',
          run_status:
            outcome === 'error' ? 'error' : outcome === 'skipped' ? 'skipped' : 'completed',
          verdict: outcome === 'pass' ? 'pass' : outcome === 'violation' ? 'violation' : null,
          body: outcome.toUpperCase(),
          ...(outcome === 'error'
            ? { error: { code: 'TEST_ERROR', message: 'retained failure' } }
            : {}),
          ts,
        })
      );
      return runId;
    };
    const passing = await appendRun(first, 'test/resolutions', '2026-09-01T00:00:00.000Z', 'pass');
    expect(passing).toBeTruthy();
    for (const disposition of ['dismissed', 'policy-excepted'] as const) {
      const runId = await appendRun(
        first,
        'test/resolutions',
        `2026-09-0${disposition === 'dismissed' ? 2 : 3}T00:00:00.000Z`,
        'violation'
      );
      await f.mutate(first, { runId, disposition }, (semantics) =>
        semantics.writeEvaluatorDisposition(first, {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: uuidv7(),
          artifact_id: first,
          run_id: runId,
          evaluator_ref: 'test/resolutions',
          disposition,
          reason: 'Retained resolution',
          agent_session_id: null,
          ts: '2026-09-04T00:00:00.000Z',
        })
      );
    }
    for (const ts of [
      '2026-09-01T01:00:00.000Z',
      '2026-09-02T01:00:00.000Z',
      '2026-09-03T01:00:00.000Z',
    ])
      await appendRun(first, 'test/order', ts, 'error');
    await appendRun(second, 'test/order', '2026-09-04T01:00:00.000Z', 'skipped');
    for (const ts of [
      '2026-09-02T02:00:00.000Z',
      '2026-09-03T02:00:00.000Z',
      '2026-09-04T02:00:00.000Z',
    ])
      await appendRun(second, 'test/persistent', ts, 'error');

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 2,
      now: Date.parse('2026-09-08T00:00:00.000Z'),
    });

    expect(check(result, 'evaluator-dismiss-rate')).toMatchObject({ status: 'warn' });
    expect(check(result, 'evaluator-dismiss-rate').details).toContain(
      '  - test/resolutions: 2/3 resolutions dismissed'
    );
    expect(check(result, 'persistent-evaluator-errors')).toMatchObject({ status: 'warn' });
    expect(check(result, 'persistent-evaluator-errors').details).toContain('  - test/persistent');
    expect(check(result, 'persistent-evaluator-errors').details).not.toContain('  - test/order');
    expect(check(result, 'stale-dispositions')).toMatchObject({ status: 'warn' });
    expect(check(result, 'materialized-disposition-consistency')).toMatchObject({
      status: 'pass',
    });
  });

  it('counts acknowledgements as resolutions without treating them as dismissals', async () => {
    const f = await fixture();
    const artifactId = await f.capture();
    for (let index = 0; index < 3; index++) {
      const runId = uuidv7();
      await f.mutate(artifactId, { runId }, (semantics) =>
        semantics.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: 'test/acknowledged',
          package_id: 'test',
          evaluator_id: 'acknowledged',
          phase: 'checkpoint-close',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'VIOLATION',
          ts: `2026-09-0${index + 1}T00:00:00.000Z`,
        })
      );
      await f.mutate(artifactId, { runId, acknowledged: true }, (semantics) =>
        semantics.writeEvaluatorDisposition(artifactId, {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: uuidv7(),
          artifact_id: artifactId,
          run_id: runId,
          evaluator_ref: 'test/acknowledged',
          disposition: 'acknowledged',
          reason: 'Retained acknowledgement',
          agent_session_id: null,
          ts: `2026-09-0${index + 1}T01:00:00.000Z`,
        })
      );
    }

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
      now: Date.parse('2026-09-04T00:00:00.000Z'),
    });

    expect(check(result, 'evaluator-dismiss-rate')).toMatchObject({
      status: 'pass',
      summary: 'no evaluator has a high dismissal rate with enough retained resolutions',
    });
    expect(check(result, 'unresolved-blocks')).toMatchObject({ status: 'pass' });
  });

  it('fails stale evaluator materialization without hiding the exact unresolved block', async () => {
    const f = await fixture();
    const artifactId = await f.capture();
    const runId = uuidv7();
    await f.mutate(artifactId, { runId }, (semantics) =>
      semantics.writeEvaluatorRunPayload(artifactId, {
        schema: 'orcaops.evaluator_run/v1',
        run_id: runId,
        artifact_id: artifactId,
        evaluator_ref: 'test/materialized',
        package_id: 'test',
        evaluator_id: 'materialized',
        phase: 'checkpoint-close',
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
        body: 'VIOLATION',
        ts: '2026-09-01T00:00:00.000Z',
      })
    );
    const raw = new Database(f.writer.databasePath);
    try {
      const row = raw
        .prepare(
          'SELECT details_json AS detailsJson FROM artifact_query_metadata WHERE artifact_id=?'
        )
        .get(artifactId) as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as {
        evaluatorRuns: Array<{ run_id: string; disposition: string | null }>;
      };
      details.evaluatorRuns.find((run) => run.run_id === runId)!.disposition = 'acknowledged';
      raw
        .prepare('UPDATE artifact_query_metadata SET details_json=? WHERE artifact_id=?')
        .run(JSON.stringify(details), artifactId);
    } finally {
      raw.close();
    }

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    });

    expect(check(result, 'materialized-disposition-consistency')).toMatchObject({
      status: 'fail',
    });
    expect(check(result, 'materialized-disposition-consistency').details?.join('\n')).toContain(
      artifactId
    );
    expect(check(result, 'unresolved-blocks').details?.join('\n')).toContain('test/materialized');
  });

  it('reports stale activity, unresolved blocks, and retained evaluator skips', async () => {
    const f = await fixture();
    const artifactId = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    await f.mutate(artifactId, { evaluator: 'test/block' }, (semantics) =>
      semantics.writeEvaluatorRunPayload(artifactId, {
        schema: 'orcaops.evaluator_run/v1',
        run_id: uuidv7(),
        artifact_id: artifactId,
        evaluator_ref: 'test/block',
        package_id: 'test',
        evaluator_id: 'block',
        phase: 'checkpoint-close',
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
        body: 'VIOLATION',
        ts: '2026-09-01T01:00:00.000Z',
      })
    );
    for (let index = 0; index < 7; index++)
      await f.mutate(artifactId, { evaluator: 'test/skippy', index }, (semantics) =>
        semantics.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: uuidv7(),
          artifact_id: artifactId,
          evaluator_ref: 'test/skippy',
          package_id: 'test',
          evaluator_id: 'skippy',
          phase: 'checkpoint-close',
          severity: 'warn',
          run_status: index < 6 ? 'skipped' : 'completed',
          verdict: index < 6 ? null : 'pass',
          body: index < 6 ? 'SKIPPED' : 'PASS',
          ts: `2026-09-01T0${index + 2}:00:00.000Z`,
        })
      );

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
      now: Date.parse('2026-09-08T00:00:00.000Z'),
    });

    expect(check(result, 'stale-artifacts')).toMatchObject({ status: 'warn' });
    expect(check(result, 'unresolved-blocks').details?.join('\n')).toContain('test/block');
    expect(check(result, 'skipped-run-analytics')).toMatchObject({ status: 'warn' });
    expect(check(result, 'skipped-run-analytics').details?.join('\n')).toContain('test/skippy');
  });

  it('passes skipped fingerprint checks with no checkpoints and at the twenty-percent boundary', async () => {
    const empty = await fixture();
    await empty.capture();
    const emptyResult = await inspectDatabaseDoctorHistory({
      database: empty.writer,
      context: empty.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    });
    expect(check(emptyResult, 'skipped-fingerprint-rate')).toMatchObject({
      status: 'pass',
      summary: 'no closed checkpoints to inspect',
    });

    const boundary = await fixture();
    const artifactId = await boundary.capture();
    await boundary.recordFiles(artifactId, []);
    for (let index = 0; index < 4; index++) await recordCapturedCheckpoint(boundary, artifactId);
    const boundaryResult = await inspectDatabaseDoctorHistory({
      database: boundary.writer,
      context: boundary.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    });
    expect(check(boundaryResult, 'skipped-fingerprint-rate')).toMatchObject({
      status: 'pass',
      summary: '1/5 recent closed checkpoints skipped fingerprint capture',
    });
  });

  it('validates Source Plan selections and reports unreachable lineage', async () => {
    const f = await fixture();
    await git(f.main, ['checkout', '-qb', 'temporary-lineage']);
    await writeFile(path.join(f.main, 'lineage.txt'), 'orphaned\n', 'utf8');
    await git(f.main, ['add', 'lineage.txt']);
    await git(f.main, ['commit', '-qm', 'Temporary lineage']);
    const artifactId = await f.capture(undefined, {
      sourcePlan: {
        source_ref: { kind: 'local', locator: '/plans/source.md' },
        content: 'Original plan',
        hash: 'different',
        baseline: null,
      },
    });
    await git(f.main, ['checkout', '-q', 'main']);
    await git(f.main, ['branch', '-D', 'temporary-lineage']);
    const namespace = {
      namespaceId: uuidv7(),
      scopeKind: 'account' as const,
      serverUrl: 'https://example.test',
      orgId: 'org',
      accountId: 'account',
      originalNamespaceHash: null,
      originalLocatorHash: null,
    };
    const body = 'Candidate plan';
    await publishProjectSourcePlanRecord(
      f.writer,
      {
        operationId: uuidv7(),
        recordId: uuidv7(),
        namespace,
        kind: 'candidate',
        expectedSelection: null,
        recordBytes: Buffer.from(
          JSON.stringify({
            schema_version: 1,
            external_id: 'plan',
            body,
            content_hash: createHash('sha256').update(body).digest('hex'),
            base_url: 'https://example.test',
            org_id: 'org',
            pulled_at: '2026-09-01T00:00:00.000Z',
            target: 'candidate',
            version_id: 'version',
            version_number: 1,
            proposal_id: null,
            base_version_number: null,
          })
        ),
      },
      { secretAllow: [] }
    );
    const approvedBody = 'Approved plan';
    const approvedRecordId = uuidv7();
    await publishProjectSourcePlanRecord(
      f.writer,
      {
        operationId: uuidv7(),
        recordId: approvedRecordId,
        namespace,
        kind: 'approved',
        expectedSelection: null,
        recordBytes: Buffer.from(
          JSON.stringify({
            schema_version: 1,
            external_id: 'approved-plan',
            slug: 'approved-plan',
            version_number: 1,
            title: 'Approved plan',
            body: approvedBody,
            content_hash: createHash('sha256').update(approvedBody).digest('hex'),
            base_url: 'https://example.test',
            org_id: 'org',
            pulled_at: '2026-09-01T00:00:00.000Z',
            source_ref: null,
          })
        ),
      },
      { secretAllow: [] }
    );
    await publishProjectSourcePlanLocator(
      f.writer,
      {
        operationId: uuidv7(),
        revisionId: uuidv7(),
        namespace,
        kind: 'path',
        realPath: '/plans/approved.md',
        approvedRecordId,
        expectedSelection: null,
        recordBytes: Buffer.from(
          JSON.stringify({
            real_path: '/plans/approved.md',
            external_id: 'approved-plan',
            version_number: 1,
          })
        ),
      },
      { secretAllow: [] }
    );

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    });

    expect(check(result, 'source-plan-pin-integrity')).toMatchObject({ status: 'warn' });
    expect(check(result, 'source-plan-pin-integrity').details).toContain(`  - ${artifactId}`);
    expect(check(result, 'source-plan-history').summary).toContain(
      '1 approval(s), 1 review selection(s), 1 locator(s)'
    );
    expect(check(result, 'lineage-orphan')).toMatchObject({ status: 'warn' });
    expect(check(result, 'lineage-orphan').summary).toContain('1 unreachable');

    const raw = new Database(f.writer.databasePath);
    try {
      raw.exec('DROP TRIGGER source_plan_review_no_delete');
      raw
        .prepare(
          "DELETE FROM source_plan_review_current WHERE namespace_id=? AND kind='candidate' AND subject_id='plan'"
        )
        .run(namespace.namespaceId);
    } finally {
      raw.close();
    }
    await expect(
      inspectDatabaseDoctorHistory({
        database: f.writer,
        context: f.registeredContext,
        pins: [],
        shellKey: { kind: 'none' },
        historyCommitCount: 1,
        dispositionTtlDays: 30,
      })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  });

  it('warns when retained lineage has no local branch tip to verify it', async () => {
    const f = await fixture();
    await f.capture();
    await git(f.main, ['update-ref', '-d', 'refs/heads/main']);
    await git(f.main, ['update-ref', '-d', 'refs/heads/linked']);

    const result = await inspectDatabaseDoctorHistory({
      database: f.writer,
      context: f.registeredContext,
      pins: [],
      shellKey: { kind: 'none' },
      historyCommitCount: 1,
      dispositionTtlDays: 30,
    });

    expect(check(result, 'lineage-orphan')).toMatchObject({ status: 'warn' });
    expect(check(result, 'lineage-orphan').summary).toContain('no local branches');
    expect(check(result, 'lineage-orphan').summary).toContain('1 artifact');
  });

  it('checks many retained artifacts and local branches with two Git subprocesses', async () => {
    const f = await fixture();
    for (let index = 0; index < 24; index++) await f.capture();
    const head = f.registeredContext.git.headOid!;
    for (let index = 0; index < 40; index++) {
      await git(f.main, ['update-ref', `refs/heads/branch-${index}`, head]);
    }
    const log = await logGitProbes(f);

    expect(await inspectLineage(f)).toMatchObject({
      status: 'pass',
      summary: '24 artifact(s); all latest lineage SHAs reach a local branch',
    });
    expect(await readFile(log, 'utf8')).toBe('for-each-ref\nrev-list\n-C\n');
  });

  it('reports duplicate unreachable lineage and missing commits without counting other refs as branches', async () => {
    const f = await fixture();
    const tree = (await git(f.main, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const unreachable = (
      await git(f.main, ['commit-tree', tree, '-m', 'Unreachable'])
    ).stdout.trim();
    for (const ref of ['refs/remotes/origin/feature', 'refs/tags/saved', 'refs/orcaops/saved']) {
      await git(f.main, ['update-ref', ref, unreachable]);
    }
    await f.capture();
    const orphaned = [await f.capture(), await f.capture()];
    for (const artifact of orphaned) await recordLineage(f, artifact, unreachable);
    const missing = await f.capture();
    await recordLineage(f, missing, 'deadbeef'.repeat(5));
    const log = await logGitProbes(f);

    const result = await inspectLineage(f);

    expect(result).toMatchObject({
      status: 'warn',
      summary: '2 unreachable and 1 uncertain latest lineage SHA(s)',
    });
    for (const artifact of orphaned) {
      expect(
        result.details?.some((line) => line.includes(artifact) && line.endsWith(': unreachable'))
      ).toBe(true);
    }
    expect(
      result.details?.some(
        (line) => line.includes(missing) && line.endsWith(': reachability unknown')
      )
    ).toBe(true);
    expect(await readFile(log, 'utf8')).toBe('for-each-ref\nrev-list\ncat-file\n-C\n');
  });

  it.each(['for-each-ref', 'rev-list', 'cat-file'])(
    'warns when %s fails during lineage inspection',
    async (command) => {
      const f = await fixture();
      const artifact = await f.capture();
      await recordLineage(f, artifact, 'deadbeef'.repeat(5));
      await logGitProbes(f, command);

      expect(await inspectLineage(f)).toMatchObject({
        status: 'warn',
        summary:
          command === 'for-each-ref'
            ? 'could not enumerate local branch tips'
            : '0 unreachable and 1 uncertain latest lineage SHA(s)',
      });
    }
  );

  it('keeps artifacts on readable branches reachable when a branch ref is dangling', async () => {
    const f = await fixture();
    await f.capture();
    await f.capture();
    // update-ref refuses a ref pointing at a missing object, so write it directly.
    await writeFile(
      path.join(f.main, '.git', 'refs', 'heads', 'dangling'),
      `${'deadbeef'.repeat(5)}\n`
    );

    expect(await inspectLineage(f)).toMatchObject({
      status: 'pass',
      summary: '2 artifact(s); all latest lineage SHAs reach a local branch',
    });
  });

  it.each([true, false])(
    'skips the lineage traversal without artifacts when local branches exist: %s',
    async (branches) => {
      const f = await fixture();
      if (!branches) {
        await git(f.main, ['update-ref', '-d', 'refs/heads/main']);
        await git(f.main, ['update-ref', '-d', 'refs/heads/linked']);
      }
      const log = await logGitProbes(f);

      expect(await inspectLineage(f)).toMatchObject({
        status: 'pass',
        summary: branches
          ? '0 artifact(s); all latest lineage SHAs reach a local branch'
          : 'no retained lineage or local branches to compare',
      });
      expect(await readFile(log, 'utf8')).toBe('for-each-ref\n-C\n');
    }
  );
});
