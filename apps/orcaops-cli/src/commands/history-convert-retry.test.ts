import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import * as registration from '@orcaops/core/history/registration';
import {
  materializeLegacyFixture,
  prepareLegacySources,
  previewLegacyRepository,
} from '@orcaops/history-convert';
import * as storage from '@orcaops/storage/history/database';
import { openProjectDatabase, readProjectHistoryImport } from '@orcaops/storage/history/database';

import { buildProgram } from '../cli/program.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

const execute = promisify(execFile);
const directories: string[] = [];
const operationId = '01a07e00-1111-7000-8000-000000000001';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

async function legacyRepository() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-cli-retry-')));
  directories.push(directory);
  return materializeLegacyFixture({ directory });
}

type Legacy = Awaited<ReturnType<typeof legacyRepository>>;

async function run(
  legacy: Legacy,
  argv: readonly string[]
): Promise<{ envelope: Record<string, unknown>; exitCode: number | null }> {
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let exitCode: number | null = null;
  try {
    await runInInvocationContext(
      {
        cwd: legacy.cwd,
        env: { ...legacy.env, ORCAOPS_DATA_DIR: legacy.root, ORCAOPS_CLOUD_FEATURES: '0' },
      },
      async () => {
        const program = buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });
        program.exitOverride();
        try {
          await program.parseAsync([...argv], { from: 'user' });
        } catch (cause) {
          exitCode = (cause as { code?: number }).code ?? 1;
        }
      }
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { envelope: JSON.parse(writes.join('')) as Record<string, unknown>, exitCode };
}

const applyArgs = ['history', 'convert', '--apply', '--offline', '--json'] as const;
const retryArgs = [...applyArgs, '--operation-id', operationId] as const;

function targetPath(legacy: Legacy): string {
  return path.join(legacy.root, 'projects', legacy.projectId, 'history.sqlite3');
}

/**
 * Every original legacy byte, keyed by location, taken from the prepared source manifest before
 * anything is converted. It cannot be taken again afterwards: a registered repository carries
 * its own markers under the Git administrative directory, which the legacy inventory reports as
 * unclassified, so preparation refuses on a converted checkout by design.
 */
async function originalBytes(legacy: Legacy): Promise<Map<string, string>> {
  const preview = await previewLegacyRepository({
    cwd: legacy.cwd,
    root: legacy.root,
    env: legacy.env,
  });
  const prepared = await prepareLegacySources(preview);
  return new Map(prepared.manifest.files.map((file) => [file.location, file.sha256]));
}

async function retainsEveryOriginalByte(before: Map<string, string>): Promise<void> {
  for (const [location, sha256] of before) {
    const bytes = await fs.readFile(location);
    expect([location, createHash('sha256').update(bytes).digest('hex')]).toEqual([
      location,
      sha256,
    ]);
  }
}

async function refs(legacy: Legacy): Promise<string> {
  const { stdout } = await execute(
    'git',
    ['-C', legacy.cwd, 'for-each-ref', '--format=%(refname) %(objectname)'],
    { env: legacy.env }
  );
  return stdout;
}

it.each(['explicit', 'omitted'] as const)(
  'recovers a generated conversion identity after registration fails with an %s retry ID',
  { timeout: 240_000 },
  async (retryMode) => {
    const legacy = await legacyRepository();
    const original = storage.importProjectHistory;
    const importing = vi
      .spyOn(storage, 'importProjectHistory')
      .mockImplementation(async (input) => {
        const diagnostics = vi
          .mocked(process.stderr.write)
          .mock.calls.map(([chunk]) => String(chunk))
          .join('');
        expect(diagnostics).toContain(`Conversion operation: ${input.operationId}`);
        expect(diagnostics).toContain(`--operation-id ${input.operationId}`);
        return original(input);
      });
    const fault = vi
      .spyOn(registration, 'publishRepositoryRegistration')
      .mockImplementationOnce(() => {
        throw new Error('Registration interrupted after import committed');
      });
    const interrupted = await run({ ...legacy, cwd: path.join(legacy.cwd, 'src') }, applyArgs);
    fault.mockRestore();
    importing.mockRestore();
    expect(interrupted.exitCode).toBe(1);
    const retry = (
      interrupted.envelope.error as {
        conversion_retry: {
          operation_id: string;
          cwd: string;
          resolved_root: string;
          command: string;
        };
      }
    ).conversion_retry;
    expect(retry.operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(retry.command).toBe(
      `ORCAOPS_DATA_DIR='${legacy.root}' orcaops --root '${legacy.cwd}' history convert --apply --offline --operation-id ${retry.operation_id}`
    );
    expect(retry).toMatchObject({ cwd: legacy.cwd, resolved_root: legacy.root });
    expect((interrupted.envelope.error as { message: string }).message).toContain(
      retry.operation_id
    );
    const committed = await fs.readFile(targetPath(legacy));
    const retried = await run(
      retryMode === 'explicit'
        ? { ...legacy, cwd: path.dirname(legacy.cwd), root: retry.resolved_root }
        : legacy,
      retryMode === 'explicit'
        ? ['--root', retry.cwd, ...applyArgs, '--operation-id', retry.operation_id]
        : applyArgs
    );
    expect(retried.exitCode, JSON.stringify(retried.envelope)).toBeNull();
    expect(retried.envelope).toMatchObject({
      ok: true,
      operationId: retry.operation_id,
      replayed: true,
    });
    expect(await fs.readFile(targetPath(legacy))).toEqual(committed);
    await expect(fs.stat(path.join(legacy.cwd, 'projects'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const conflicting = await run(legacy, [...applyArgs, '--operation-id', operationId]);
    expect(conflicting.envelope).toMatchObject({ ok: false, error: { code: 'IDENTITY_CONFLICT' } });
    expect(conflicting.envelope.error).not.toHaveProperty('conversion_retry');
  }
);

it(
  'refuses automatic adoption when the original conversion sources changed',
  { timeout: 240_000 },
  async () => {
    const legacy = await legacyRepository();
    const fault = vi
      .spyOn(registration, 'publishRepositoryRegistration')
      .mockImplementationOnce(() => {
        throw new Error('Registration interrupted after import committed');
      });
    expect((await run(legacy, applyArgs)).exitCode).toBe(1);
    fault.mockRestore();
    const committed = await fs.readFile(targetPath(legacy));
    const retainedRefs = await refs(legacy);
    await fs.appendFile(path.join(legacy.cwd, '.orcaops', 'config.json'), '\n');
    const changed = await originalBytes(legacy);
    const importer = vi.spyOn(storage, 'importProjectHistory');
    const retried = await run(legacy, applyArgs);
    expect(retried.exitCode).toBe(1);
    expect(retried.envelope).toMatchObject({ ok: false, error: { code: 'IDENTITY_CONFLICT' } });
    expect(importer).not.toHaveBeenCalled();
    expect(await fs.readFile(targetPath(legacy))).toEqual(committed);
    expect(await refs(legacy)).toBe(retainedRefs);
    await retainsEveryOriginalByte(changed);
    await expect(
      registration.readRepositoryRegistration({ commonDir: path.join(legacy.cwd, '.git') })
    ).resolves.toBeNull();
  }
);

it(
  'retries a conversion whose commit failed, by its original operation ID, without double-importing',
  { timeout: 240_000 },
  async () => {
    const legacy = await legacyRepository();
    const before = await originalBytes(legacy);
    const beforeRefs = await refs(legacy);
    const target = targetPath(legacy);
    const commit = Database.prototype.exec;
    const fault = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (this.name === target && sql === 'COMMIT')
        throw new Database.SqliteError('Conversion interrupted before commit', 'SQLITE_IOERR');
      return commit.call(this, sql);
    });
    const cancelled = await run(legacy, retryArgs);
    fault.mockRestore();
    expect(cancelled.exitCode).toBe(1);
    expect(cancelled.envelope).toMatchObject({ ok: false });

    const leftover = new Database(target, { readonly: true });
    try {
      expect(leftover.prepare('SELECT count(*) AS n FROM sqlite_schema').get()).toEqual({ n: 0 });
    } finally {
      leftover.close();
    }
    await expect(
      registration.readRepositoryRegistration({ commonDir: path.join(legacy.cwd, '.git') })
    ).resolves.toBeNull();

    const retried = await run(legacy, retryArgs);
    expect(retried.exitCode).toBeNull();
    expect(retried.envelope).toMatchObject({
      ok: true,
      operationId,
      replayed: false,
      registration: { repository: 'created', catalog: 'created', worktree: 'created' },
    });
    expect((retried.envelope.comparison as { ok: boolean }).ok).toBe(true);
    await retainsEveryOriginalByte(before);
    expect(await refs(legacy)).toEqual(beforeRefs);
  }
);

it.each([
  // Interrupting the first publisher leaves no marker, so the retry re-runs the whole apply and
  // re-derives the comparison; interrupting a later one leaves a marker, and the retry completes
  // only the missing publications.
  [
    'publishRepositoryRegistration',
    { repository: 'created', catalog: 'created', worktree: 'created' },
    'rederived',
  ],
  [
    'publishProjectCatalogEntry',
    { repository: 'existing', catalog: 'created', worktree: 'created' },
    'not-rederived',
  ],
  [
    'publishWorktreeRegistration',
    { repository: 'existing', catalog: 'existing', worktree: 'created' },
    'not-rederived',
  ],
] as const)(
  'completes a registration interrupted at %s when the original operation ID replays',
  { timeout: 240_000 },
  async (publisher, expectedPublications, comparison) => {
    const legacy = await legacyRepository();
    const before = await originalBytes(legacy);
    const fault = vi.spyOn(registration, publisher).mockImplementationOnce(() => {
      throw new Error(`Registration interrupted at ${publisher}`);
    });
    const interrupted = await run(legacy, retryArgs);
    fault.mockRestore();
    expect(interrupted.exitCode).toBe(1);

    const target = targetPath(legacy);
    const handle = await openProjectDatabase({
      authority: await authorityOf(legacy),
      mode: 'reader',
    });
    try {
      expect(readProjectHistoryImport(handle)!.operationId).toBe(operationId);
    } finally {
      handle.close();
    }
    const committed = await fs.readFile(target);

    const retried = await run(legacy, retryArgs);
    expect(retried.exitCode).toBeNull();
    expect(retried.envelope).toMatchObject({
      ok: true,
      operationId,
      replayed: true,
      registration: expectedPublications,
    });
    if (comparison === 'not-rederived') expect(retried.envelope.comparison).toBeNull();
    else expect((retried.envelope.comparison as { ok: boolean }).ok).toBe(true);
    expect(await fs.readFile(target)).toEqual(committed);
    await retainsEveryOriginalByte(before);
    await expect(
      registration.readRepositoryRegistration({ commonDir: path.join(legacy.cwd, '.git') })
    ).resolves.toMatchObject({ authority: { project_id: legacy.projectId } });

    const again = await run(legacy, [...applyArgs]);
    expect(again.exitCode).toBe(1);
    expect(again.envelope).toMatchObject({ ok: false, error: { code: 'IDENTITY_CONFLICT' } });
  }
);

it(
  'converts despite malformed, missing and divergent excluded review state',
  { timeout: 240_000 },
  async () => {
    const legacy = await legacyRepository();
    const secret = 'reviewer narrative that conversion must never read';
    const reviews = path.join(legacy.cwd, '.orcaops', 'reviews');
    await fs.mkdir(path.join(reviews, 'thread'), { recursive: true });
    await fs.writeFile(path.join(reviews, 'thread', 'run.json'), `{ not json ${secret}`);
    await fs.writeFile(path.join(reviews, 'dangling.json'), '');
    const feedback = path.join(legacy.cwd, '.orcaops', 'cache', 'review-feedback');
    await fs.mkdir(feedback, { recursive: true });
    await fs.writeFile(path.join(feedback, 'cursor.json'), `{"cursor":"${secret}"}`);
    const mirror = path.join(legacy.root, 'projects', legacy.projectId, 'reviews');
    await fs.mkdir(mirror, { recursive: true });
    await fs.writeFile(path.join(mirror, 'diverged.ndjson'), `${secret}\n`);
    await execute('git', ['-C', legacy.cwd, 'update-ref', 'refs/orcaops/review/thread', 'HEAD'], {
      env: legacy.env,
    });

    const applied = await run(legacy, retryArgs);
    expect(applied.exitCode).toBeNull();
    expect(applied.envelope).toMatchObject({ ok: true, operationId });
    expect((applied.envelope.comparison as { ok: boolean }).ok).toBe(true);
    const receipt = (applied.envelope.receipt as { omissions: { family: string }[] }).omissions;
    expect(receipt.map((entry) => entry.family).sort()).toEqual([
      'task-review',
      'task-review',
      'task-review-feedback',
      'task-review-refs',
    ]);
    expect(JSON.stringify(applied.envelope)).not.toContain(secret);
    const converted = await fs.readFile(targetPath(legacy));
    expect(converted.includes(Buffer.from(secret))).toBe(false);
    expect(await fs.readFile(path.join(mirror, 'diverged.ndjson'), 'utf8')).toEqual(`${secret}\n`);
  }
);

async function authorityOf(legacy: Legacy) {
  const { derivedImportOperationId, normalizeHistoryRoot } =
    await import('@orcaops/storage/history/database');
  return {
    ...(await normalizeHistoryRoot({ root: legacy.root })),
    projectId: legacy.projectId,
    storeInstanceId: derivedImportOperationId(operationId, 'store-instance'),
    repositoryInstanceId: derivedImportOperationId(operationId, 'repository-instance'),
  };
}
