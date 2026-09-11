import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import {
  publishDatabaseCaptureRetention,
  requireDatabaseExecutionContext,
  setupProjectDatabase,
} from '@orcaops/core/history/database-capture';
import {
  applyDatabaseGitReclamation,
  inspectDatabaseMaintenance,
  previewDatabaseGitReclamation,
  readRegisteredDatabaseContext,
  resumeDatabaseGitReclamation,
} from '@orcaops/core/history/database-retention';
import { uuidv7 } from '@orcaops/storage';
import {
  beginProjectCaptureRetention,
  beginProjectGitReclamation,
  gitRetentionPreparation,
  openProjectDatabase,
  type PendingCaptureInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  readProjectGitReclamationAdmission,
  retireProjectGitRetention,
} from '@orcaops/storage/history/database';

import { createDatabaseGcAction } from '../../src/commands/gc.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { makeAgent } from '../support/test-agent.js';
import { withCleanSession } from '../support/test-helpers.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return (
    await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
      env: {
        ...environment,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
        GIT_OPTIONAL_LOCKS: '0',
      },
      timeout: 10_000,
    })
  ).stdout.trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cli-database-gc-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Retained baseline');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable test project'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  const prior = JSON.parse(
    await readFile(
      new URL(
        '../../../../packages/storage/src/history/database/fixtures/retention-inputs.json',
        import.meta.url
      ),
      'utf8'
    )
  );
  const original = JSON.parse(
    Buffer.from(prior.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  const { checksum: _checksum, ...record } = original;
  const treeOid = await git(cwd, 'rev-parse', 'HEAD^{tree}');
  const objectOid = await git(cwd, 'rev-parse', 'HEAD');
  record.payload.baseline_seed_tree_sha = treeOid;
  const checksum = createHash('sha256').update(canonical(record)).digest('hex');
  const capture: PendingCaptureInput = {
    artifactId: prior.rows.artifact_events[0].artifact_id,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: context.binding,
      ts: '2026-09-01T00:00:00.000Z',
    },
  };
  const retention = prepareProjectGitRetention({
    operationId: capture.operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: context.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId: capture.artifactId,
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'baseline',
        targetId: record.event_id,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid,
        treeOid,
      },
    ],
    secretAllow: [],
  });
  return {
    cwd,
    root,
    handle,
    context,
    capture,
    retention,
    publication: gitRetentionPreparation(retention).publications[0]!,
  };
}

async function retiredFixture() {
  const value = await fixture();
  const prepared = gitRetentionPreparation(value.retention);
  await beginProjectCaptureRetention(value.handle, value);
  await git(value.cwd, 'update-ref', value.publication.fullRef, value.publication.objectOid);
  await retireProjectGitRetention(value.handle, {
    operationId: uuidv7(),
    originalOperationId: prepared.operationId,
    expectedTransitionId: prepared.preparedTransitionId,
    transitionId: uuidv7(),
    reason: 'Explicit fixture retirement',
    secretAllow: [],
  });
  const preview = previewDatabaseGitReclamation(
    value.handle,
    value.publication.publicationId
  ).value;
  if (preview.status !== 'eligible') throw new Error('Fixture publication must be eligible');
  return {
    ...value,
    target: preview.target,
    admission: {
      admissionOperationId: uuidv7(),
      terminalOperationId: uuidv7(),
      target: preview.target,
    },
  };
}

function agent(cwd: string, root: string) {
  return makeAgent({
    cwd,
    env: withCleanSession({
      ORCAOPS_DATA_DIR: root,
      ORCAOPS_DISABLE_DRAIN: '1',
      XDG_STATE_HOME: path.join(root, 'state'),
    }),
  });
}

function output(stdout: string) {
  return JSON.parse(stdout) as {
    ok: boolean;
    applied?: boolean;
    project_id?: string | null;
    resources?: Array<{
      publication_id: string | null;
      full_ref: string;
      state: string;
      reason: string;
    }>;
    pending_reclamations?: unknown[];
    would_reclaim?: number;
    deleted?: {
      git_publications: number;
      operations: number;
      removed: number;
      absent: number;
      replayed: number;
    };
    error?: {
      code: string;
      message: string;
      reason?: string;
      gc_progress?: {
        state: string;
        completed: {
          git_publications: number;
          operations: number;
          removed: number;
          absent: number;
          replayed: number;
        };
        recoverability?: string;
        failed_candidate: { kind: string; id: string };
      };
    };
  };
}

async function runAction(
  value: Awaited<ReturnType<typeof retiredFixture>>,
  action: () => Promise<void>
) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    await runInInvocationContext(
      {
        cwd: value.cwd,
        env: withCleanSession({
          ORCAOPS_DATA_DIR: value.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        }),
      },
      action
    );
  } catch {
    // Command failures are emitted before the CliExit sentinel is thrown.
  }
  return output(writes.join(''));
}

async function runTextAction(
  value: Awaited<ReturnType<typeof retiredFixture>>,
  action: () => Promise<void>
) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  await runInInvocationContext(
    {
      cwd: value.cwd,
      env: withCleanSession({
        ORCAOPS_DATA_DIR: value.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      }),
    },
    action
  );
  return writes.join('');
}

it('leaves an uninitialized repository and data root untouched', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cli-empty-gc-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  const root = path.join(directory, 'history');
  await mkdir(cwd);
  await mkdir(root);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Unregistered repository');
  const configBefore = await readFile(path.join(cwd, '.git/config'));

  const dryRun = await agent(cwd, root).runRaw(['gc', '--json']);
  const apply = await agent(cwd, root).runRaw(['gc', '--apply', '--json']);
  const help = await agent(cwd, root).runRaw(['gc', '--help']);

  expect(dryRun.exitCode).toBe(0);
  expect(output(dryRun.stdout)).toMatchObject({
    ok: true,
    applied: false,
    project_id: null,
    resources: [],
    would_reclaim: 0,
  });
  expect(apply.exitCode).toBe(0);
  expect(output(apply.stdout)).toMatchObject({ ok: true, applied: true, project_id: null });
  expect(await readdir(root)).toEqual([]);
  expect(await readFile(path.join(cwd, '.git/config'))).toEqual(configBefore);
  expect(help.stdout).toContain('--project <id>');
  expect(help.stdout).not.toContain('retention-days');
});

it('reports a registered missing database without recreating it', async () => {
  const value = await fixture();
  const databasePath = value.handle.databasePath;
  value.handle.close();
  handles.splice(handles.indexOf(value.handle), 1);
  await rm(databasePath);

  const result = await agent(value.cwd, value.root).runRaw(['gc', '--json']);

  expect(result.exitCode).toBe(1);
  expect(output(result.stdout)).toMatchObject({ ok: false, error: { code: 'HISTORY_MISSING' } });
  await expect(access(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not use --project to select an unrelated project database', async () => {
  const value = await retiredFixture();
  const before = (await readdir(value.root, { recursive: true })).sort();

  const result = await agent(value.cwd, value.root).runRaw([
    'gc',
    '--project',
    uuidv7(),
    '--apply',
    '--json',
  ]);

  expect(result.exitCode).toBe(1);
  expect(output(result.stdout)).toMatchObject({ ok: false, error: { code: 'IDENTITY_CONFLICT' } });
  expect((await readdir(value.root, { recursive: true })).sort()).toEqual(before);
  expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(
    value.publication.objectOid
  );
});

it('uses read-only dry-run inspection and protects selected and raw refs', async () => {
  const value = await fixture();
  await publishDatabaseCaptureRetention(value.handle, value.context, value);
  const unknown = `refs/orcaops/review/${uuidv7()}-${uuidv7()}`;
  const symbolic = `refs/orcaops/review/${uuidv7()}-${uuidv7()}-base`;
  const danglingPath = path.join(value.context.git.commonDir, 'refs/orcaops/dangling');
  await git(value.cwd, 'update-ref', unknown, value.publication.objectOid);
  await git(value.cwd, 'symbolic-ref', symbolic, 'refs/heads/topic');
  await mkdir(path.dirname(danglingPath), { recursive: true });
  await writeFile(danglingPath, 'ref: refs/heads/missing\n');
  const databasePath = value.handle.databasePath;
  value.handle.close();
  handles.splice(handles.indexOf(value.handle), 1);
  const before = await readFile(databasePath);
  await chmod(databasePath, 0o444);

  try {
    const result = await agent(value.cwd, value.root).runRaw(['gc', '--json']);
    expect(result.exitCode).toBe(0);
    const body = output(result.stdout);
    expect(body).toMatchObject({ ok: true, applied: false, would_reclaim: 0 });
    expect(body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publication_id: value.publication.publicationId,
          state: 'protected',
          reason: 'selected',
        }),
        expect.objectContaining({ full_ref: unknown, state: 'protected', reason: 'unknown' }),
        expect.objectContaining({ full_ref: symbolic, state: 'protected', reason: 'symbolic' }),
        expect.objectContaining({ full_ref: 'refs/orcaops/dangling', state: 'protected' }),
      ])
    );
    expect((await readFile(databasePath)).equals(before)).toBe(true);
    expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(
      value.publication.objectOid
    );
  } finally {
    await chmod(databasePath, 0o600);
  }
});

it('reclaims only the exact positively retired publication on apply', async () => {
  const value = await retiredFixture();
  const unknown = `refs/orcaops/review/${uuidv7()}-${uuidv7()}`;
  await git(value.cwd, 'update-ref', unknown, value.publication.objectOid);

  const preview = await agent(value.cwd, value.root).runRaw(['gc', '--json']);
  expect(output(preview.stdout)).toMatchObject({
    ok: true,
    applied: false,
    would_reclaim: 1,
    deleted: { git_publications: 0 },
  });
  expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(
    value.publication.objectOid
  );

  const apply = await agent(value.cwd, value.root).runRaw(['gc', '--apply', '--json']);
  expect(output(apply.stdout)).toMatchObject({
    ok: true,
    applied: true,
    deleted: { git_publications: 1, removed: 1, absent: 0 },
  });
  await expect(git(value.cwd, 'rev-parse', value.publication.fullRef)).rejects.toThrow();
  expect(await git(value.cwd, 'rev-parse', unknown)).toBe(value.publication.objectOid);
});

it('refuses an exact publication whose OID changes after inspection', async () => {
  const value = await retiredFixture();
  await git(value.cwd, 'commit', '--allow-empty', '-qm', 'Different object');
  const changedOid = await git(value.cwd, 'rev-parse', 'HEAD');
  const body = await runAction(
    value,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      resume: resumeDatabaseGitReclamation,
      apply: async (...args) => {
        await git(value.cwd, 'update-ref', value.publication.fullRef, changedOid);
        return applyDatabaseGitReclamation(...args);
      },
    }).bind(null, { apply: true, json: true })
  );

  expect(body).toMatchObject({
    ok: false,
    error: { code: 'HISTORY_UNEXPECTED_OWNER', gc_progress: { state: 'recoverable_in_progress' } },
  });
  expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(changedOid);
  expect(
    readProjectGitReclamationAdmission(
      value.handle,
      body.error!.gc_progress
        ? value.handle.read((view) =>
            view.get<{ id: string }>(
              "SELECT operation_id AS id FROM operations WHERE operation_kind = 'git.retention.cleanup.begin'"
            )
          ).value!.id
        : ''
    ).value!.terminal
  ).toBeNull();
});

it.each(['throws', 'becomes incomplete'] as const)(
  'preserves completed progress when the second inspection %s',
  async (failure) => {
    const value = await retiredFixture();
    await beginProjectGitReclamation(value.handle, value.admission);
    let inspections = 0;
    const body = await runAction(
      value,
      createDatabaseGcAction({
        readContext: readRegisteredDatabaseContext,
        openDatabase: openProjectDatabase,
        inspect: async (...args) => {
          const result = await inspectDatabaseMaintenance(...args);
          inspections += 1;
          if (inspections !== 2) return result;
          if (failure === 'throws') throw new Error('Simulated post-reclamation inspection fault');
          return {
            ...result,
            completeness: {
              complete: false,
              issues: [
                {
                  code: 'GIT_NAMESPACE_UNAVAILABLE',
                  message: 'Simulated incomplete namespace',
                  resourceId: null,
                },
              ],
            },
          };
        },
        apply: applyDatabaseGitReclamation,
        resume: resumeDatabaseGitReclamation,
      }).bind(null, { apply: true, json: true })
    );

    expect(body).toMatchObject({
      ok: false,
      error: {
        code: failure === 'throws' ? 'GC_APPLY_FAILED' : 'HISTORY_INACCESSIBLE',
        gc_progress: {
          state: 'partial_completion',
          completed: {
            git_publications: 1,
            operations: 1,
            removed: 1,
            absent: 0,
            replayed: 0,
          },
          failed_candidate: { kind: 'inspection', id: 'managed_git_namespace' },
        },
      },
    });
    await expect(git(value.cwd, 'rev-parse', value.publication.fullRef)).rejects.toThrow();
    expect(
      readProjectGitReclamationAdmission(value.handle, value.admission.admissionOperationId).value!
        .terminal?.value.outcome
    ).toBe('removed');
  }
);

it('preserves a structured database failure reason on an apply error', async () => {
  const value = await retiredFixture();
  await beginProjectGitReclamation(value.handle, value.admission);
  const readonly = new Database(value.handle.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let failure: ProjectDatabaseError | null = null;
  try {
    readonly.exec('CREATE TABLE forbidden_gc_write (id INTEGER)');
  } catch (cause) {
    failure = new ProjectDatabaseError('TRANSACTION_FAILED', 'Simulated read-only settlement', {
      cause,
    });
  } finally {
    readonly.close();
  }
  if (!failure) throw new Error('Fixture must produce a read-only SQLite failure');

  const body = await runAction(
    value,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      apply: applyDatabaseGitReclamation,
      resume: async () => {
        throw failure;
      },
    }).bind(null, { apply: true, json: true })
  );

  expect(body).toMatchObject({
    ok: false,
    error: {
      code: 'TRANSACTION_FAILED',
      reason: 'read-only',
      gc_progress: { state: 'recoverable_in_progress' },
    },
  });
  expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(
    value.publication.objectOid
  );
});

it('preserves the original failure when admission recovery state is unavailable', async () => {
  const value = await retiredFixture();
  const firstAdmission = {
    admissionOperationId: '01999999-0000-7000-8000-000000000001',
    terminalOperationId: '01999999-0000-7000-8000-000000000002',
    target: value.target,
  };
  const secondAdmission = {
    admissionOperationId: '01999999-0000-7000-8000-000000000003',
    terminalOperationId: '01999999-0000-7000-8000-000000000004',
    target: value.target,
  };
  await beginProjectGitReclamation(value.handle, firstAdmission);
  await beginProjectGitReclamation(value.handle, secondAdmission);
  let resumed = 0;
  const body = await runAction(
    value,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      apply: applyDatabaseGitReclamation,
      resume: async (...args) => {
        resumed += 1;
        if (resumed === 1) return resumeDatabaseGitReclamation(...args);
        args[0].close();
        throw new ProjectDatabaseError(
          'TRANSACTION_FAILED',
          'Original simulated settlement failure'
        );
      },
    }).bind(null, { apply: true, json: true })
  );

  expect(body).toMatchObject({
    ok: false,
    error: {
      code: 'TRANSACTION_FAILED',
      message: expect.stringContaining('Original simulated settlement failure'),
      gc_progress: {
        state: 'partial_completion',
        recoverability: 'unknown',
        completed: {
          git_publications: 1,
          operations: 1,
          removed: 1,
          absent: 0,
          replayed: 0,
        },
        failed_candidate: {
          kind: 'pending_reclamation',
          id: secondAdmission.admissionOperationId,
        },
      },
    },
  });
  await expect(git(value.cwd, 'rev-parse', value.publication.fullRef)).rejects.toThrow();
  expect(
    readProjectGitReclamationAdmission(value.handle, firstAdmission.admissionOperationId).value!
      .terminal?.value.outcome
  ).toBe('removed');
  expect(
    readProjectGitReclamationAdmission(value.handle, secondAdmission.admissionOperationId).value!
      .terminal
  ).toBeNull();
});

it('counts distinct publications separately from admission outcomes and replays', async () => {
  const value = await retiredFixture();
  const secondAdmission = {
    admissionOperationId: uuidv7(),
    terminalOperationId: uuidv7(),
    target: value.target,
  };
  await beginProjectGitReclamation(value.handle, value.admission);
  await beginProjectGitReclamation(value.handle, secondAdmission);
  let resumed = 0;
  const body = await runAction(
    value,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      apply: applyDatabaseGitReclamation,
      resume: async (...args) => {
        resumed += 1;
        if (resumed === 1) await resumeDatabaseGitReclamation(...args);
        return resumeDatabaseGitReclamation(...args);
      },
    }).bind(null, { apply: true, json: true })
  );

  expect(body).toMatchObject({
    ok: true,
    deleted: {
      git_publications: 1,
      operations: 2,
      removed: 1,
      absent: 1,
      replayed: 1,
    },
  });

  vi.restoreAllMocks();
  const human = await retiredFixture();
  const humanSecondAdmission = {
    admissionOperationId: uuidv7(),
    terminalOperationId: uuidv7(),
    target: human.target,
  };
  await beginProjectGitReclamation(human.handle, human.admission);
  await beginProjectGitReclamation(human.handle, humanSecondAdmission);
  let humanResumed = 0;
  const text = await runTextAction(
    human,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      apply: applyDatabaseGitReclamation,
      resume: async (...args) => {
        humanResumed += 1;
        if (humanResumed === 1) await resumeDatabaseGitReclamation(...args);
        return resumeDatabaseGitReclamation(...args);
      },
    }).bind(null, { apply: true })
  );
  expect(text).toContain('publication outcomes:  1');
  expect(text).toContain('operations observed:   2 (1 replayed)');
});

it('settles an interrupted deletion once and replays no further work', async () => {
  const value = await retiredFixture();
  await beginProjectGitReclamation(value.handle, value.admission);
  await git(value.cwd, 'update-ref', '-d', value.publication.fullRef, value.publication.objectOid);

  const recovered = await agent(value.cwd, value.root).runRaw(['gc', '--apply', '--json']);
  expect(output(recovered.stdout)).toMatchObject({
    ok: true,
    deleted: { git_publications: 1, removed: 0, absent: 1, replayed: 0 },
  });
  expect(
    readProjectGitReclamationAdmission(value.handle, value.admission.admissionOperationId).value!
      .terminal?.value.outcome
  ).toBe('absent');
  const operationCount = value.handle.read((view) =>
    view.get<{ count: number }>('SELECT COUNT(*) AS count FROM operations')
  ).value!.count;

  const retry = await agent(value.cwd, value.root).runRaw(['gc', '--apply', '--json']);
  expect(output(retry.stdout)).toMatchObject({
    ok: true,
    would_reclaim: 0,
    deleted: { git_publications: 0, removed: 0, absent: 0, replayed: 0 },
  });
  expect(
    value.handle.read((view) =>
      view.get<{ count: number }>('SELECT COUNT(*) AS count FROM operations')
    ).value!.count
  ).toBe(operationCount);
});

it('cancels an admitted retry without deleting its publication', async () => {
  const value = await retiredFixture();
  await beginProjectGitReclamation(value.handle, value.admission);
  const listeners = process.listenerCount('SIGINT');
  const body = await runAction(
    value,
    createDatabaseGcAction({
      readContext: readRegisteredDatabaseContext,
      openDatabase: openProjectDatabase,
      inspect: inspectDatabaseMaintenance,
      apply: applyDatabaseGitReclamation,
      resume: async (...args) => {
        process.emit('SIGINT');
        return resumeDatabaseGitReclamation(...args);
      },
    }).bind(null, { apply: true, json: true })
  );

  expect(body).toMatchObject({
    ok: false,
    error: { code: 'CANCELLED', gc_progress: { state: 'recoverable_in_progress' } },
  });
  expect(process.listenerCount('SIGINT')).toBe(listeners);
  expect(await git(value.cwd, 'rev-parse', value.publication.fullRef)).toBe(
    value.publication.objectOid
  );
  expect(
    readProjectGitReclamationAdmission(value.handle, value.admission.admissionOperationId).value!
      .terminal
  ).toBeNull();
});
