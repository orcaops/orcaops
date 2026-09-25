import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../../tests/helpers/database-history.js';
import { placeReleasedProjectDatabase } from '../../tests/helpers/released-project-database.js';
import { buildProgram } from '../cli/program.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const RELEASED_SCHEMA_VERSION = 29;
const CURRENT_SCHEMA_VERSION = 33;
const BACKUP_DIRECTORY = 'upgrade-backups';

async function run(f: Fixture, argv: readonly string[]) {
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const errors: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  let exitCode: number | null = null;
  try {
    await runInInvocationContext(
      {
        cwd: f.main,
        env: {
          ...process.env,
          ORCAOPS_DATA_DIR: f.root,
          ORCAOPS_ROOT: '',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DISABLE_DRAIN: '1',
          CLAUDE_SESSION_ID: '',
          CLAUDE_CODE_SESSION_ID: '',
          CODEX_SESSION_ID: 'history-upgrade-session',
          HOME: path.join(f.temporary, 'home'),
          XDG_STATE_HOME: path.join(f.temporary, 'state'),
        },
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
  const output = writes.join('');
  return {
    envelope: argv.includes('--json')
      ? (JSON.parse(output) as Record<string, unknown>)
      : ({} as Record<string, unknown>),
    output,
    stderr: errors.join(''),
    exitCode,
  };
}

/**
 * Every file beside the database, except the shared-memory file and an empty write-ahead log:
 * SQLite creates and refreshes both beside a write-ahead-log database it merely reads, and an
 * empty log holds no rows. A log with frames in it is compared, because a preview that
 * checkpointed one would have rewritten the main file.
 */
async function projectFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (file.endsWith('-shm')) continue;
    if (entry.isDirectory()) {
      files[path.relative(directory, file)] = 'directory';
      continue;
    }
    const bytes = await fs.readFile(file);
    if (file.endsWith('-wal') && bytes.length === 0) continue;
    files[path.relative(directory, file)] = createHash('sha256').update(bytes).digest('hex');
  }
  return files;
}

function schemaVersionOf(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database.pragma('user_version', { simple: true }) as number;
  } finally {
    database.close();
  }
}

async function backupNames(projectDirectory: string): Promise<string[]> {
  return fs
    .readdir(path.join(projectDirectory, BACKUP_DIRECTORY))
    .then((names) => names.filter((name) => name.startsWith('schema-')).sort())
    .catch(() => []);
}

async function releasedProject() {
  const f = await fixture();
  await placeReleasedProjectDatabase(f.writer);
  const file = f.writer.databasePath;
  return { f, file, projectDirectory: path.dirname(file) };
}

const planInput = () =>
  inputFile(
    JSON.stringify({
      idempotency_key: 'history-upgrade-plan',
      task: 'Preserve existing history',
      plan_steps: [
        {
          text: 'Inspect the history',
          label: 'Inspect',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
    })
  );

it(
  'previews a released database without touching it, then upgrades it behind a verified backup',
  { timeout: 180_000 },
  async () => {
    const { f, file, projectDirectory } = await releasedProject();
    expect(schemaVersionOf(file)).toBe(RELEASED_SCHEMA_VERSION);
    const before = await projectFiles(projectDirectory);

    const preview = await run(f, ['history', 'upgrade', '--json']);
    expect(preview.exitCode).toBeNull();
    expect(preview.envelope).toMatchObject({
      ok: true,
      mode: 'preview',
      changed: false,
      state: 'upgrade-required',
      database: file,
      from_version: RELEASED_SCHEMA_VERSION,
      to_version: CURRENT_SCHEMA_VERSION,
      backup_directory: path.join(projectDirectory, BACKUP_DIRECTORY),
    });
    const rebuilt = preview.envelope.rebuilt_tables as Array<{ table: string; rows: number }>;
    expect(rebuilt.map((entry) => entry.table).sort()).toEqual([
      'adoptions',
      'claim_revisions',
      'decision_revisions',
      'pending_capture_requests',
      'record_relationships',
      'remote_requests',
    ]);
    expect(rebuilt.every((entry) => Number.isInteger(entry.rows))).toBe(true);
    // The released bytes are placed without their evidence directory, so the preview has to
    // name the evidence files the database points at and cannot find.
    expect(
      (
        preview.envelope.retained_references_not_found as {
          evidence_files: unknown[];
        }
      ).evidence_files.length
    ).toBeGreaterThan(0);

    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(await backupNames(projectDirectory)).toEqual([]);

    const human = await run(f, ['history', 'upgrade']);
    expect(human.output).toContain('Nothing was changed');
    expect(human.output).toContain('orcaops history upgrade --apply');
    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(await backupNames(projectDirectory)).toEqual([]);

    const applied = await run(f, ['history', 'upgrade', '--apply', '--json']);
    expect(applied.exitCode).toBeNull();
    expect(applied.envelope).toMatchObject({
      ok: true,
      mode: 'apply',
      changed: true,
      state: 'upgraded',
      from_version: RELEASED_SCHEMA_VERSION,
      to_version: CURRENT_SCHEMA_VERSION,
    });
    const backup = applied.envelope.backup as { name: string; directory: string };
    expect(backup.name).toMatch(/^schema-29-[0-9a-f-]{36}$/);
    expect(await backupNames(projectDirectory)).toEqual([backup.name]);
    expect(schemaVersionOf(file)).toBe(CURRENT_SCHEMA_VERSION);

    const listed = await run(f, ['list', '--json']);
    expect(listed.exitCode).toBeNull();
    expect(listed.envelope).toMatchObject({ ok: true });
    expect((listed.envelope.results as unknown[]).length).toBeGreaterThan(0);

    const again = await run(f, ['history', 'upgrade', '--apply', '--json']);
    expect(again.envelope).toMatchObject({ ok: true, changed: false, state: 'current' });
    expect(await backupNames(projectDirectory)).toEqual([backup.name]);
  }
);

it(
  'lists the backup an upgrade wrote and restores it, and a read then asks for the upgrade again',
  { timeout: 180_000 },
  async () => {
    const { f, file, projectDirectory } = await releasedProject();
    const applied = await run(f, ['history', 'upgrade', '--apply', '--json']);
    const backup = applied.envelope.backup as { name: string; database_file: string };
    expect(schemaVersionOf(file)).toBe(CURRENT_SCHEMA_VERSION);

    const listed = await run(f, ['history', 'backups', '--json']);
    expect(listed.exitCode).toBeNull();
    expect(listed.envelope.backups).toEqual([
      expect.objectContaining({
        name: backup.name,
        database_file: backup.database_file,
        source_schema_version: RELEASED_SCHEMA_VERSION,
        created_at: expect.any(String),
        write_sequence: expect.any(Number),
        intent_change_counter: expect.any(Number),
      }),
    ]);

    const upgraded = await projectFiles(projectDirectory);
    const restorePreview = await run(f, ['history', 'restore', backup.name, '--json']);
    expect(restorePreview.exitCode).toBeNull();
    expect(restorePreview.envelope).toMatchObject({
      ok: true,
      mode: 'preview',
      changed: false,
      database: file,
      work_written_after_backup: 'not-restored',
    });
    expect(await projectFiles(projectDirectory)).toEqual(upgraded);
    expect(schemaVersionOf(file)).toBe(CURRENT_SCHEMA_VERSION);

    const restoreHuman = await run(f, ['history', 'restore', backup.name]);
    expect(restoreHuman.output).toContain('is NOT in it and will not be restored');
    expect(restoreHuman.output).toContain('Nothing was changed');
    expect(await projectFiles(projectDirectory)).toEqual(upgraded);

    const restored = await run(f, ['history', 'restore', backup.name, '--apply', '--json']);
    expect(restored.exitCode).toBeNull();
    expect(restored.envelope).toMatchObject({
      ok: true,
      mode: 'apply',
      changed: true,
      work_written_after_backup: 'not-restored',
      other_sessions: 'refused-across-the-swap',
    });
    const replaced = restored.envelope.replaced as {
      database_file: string;
      schema_version: number;
    };
    expect(replaced.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    // The database that was in place is kept whole, never removed.
    expect(await fs.stat(replaced.database_file)).toBeTruthy();
    expect(schemaVersionOf(file)).toBe(RELEASED_SCHEMA_VERSION);
    expect(await backupNames(projectDirectory)).toEqual([backup.name]);

    const afterRestore = await run(f, ['list', '--json']);
    expect(afterRestore.envelope).toMatchObject({
      ok: true,
      completeness: {
        complete: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'HISTORY_UPGRADE_REQUIRED' }),
        ]),
      },
    });
    expect((afterRestore.envelope.results as unknown[]).length).toBe(0);
  }
);

it(
  'refuses a capture against a released database, writes nothing and names the upgrade command',
  { timeout: 180_000 },
  async () => {
    const { f, projectDirectory } = await releasedProject();
    const before = await projectFiles(projectDirectory);

    // `capture plan` takes JSON in and gives JSON out; it has no --json flag.
    const captured = await run(f, ['capture', 'plan', '--no-llm', '--input', planInput()]);
    expect(captured.exitCode).toBe(1);
    const { error } = JSON.parse(captured.output) as {
      error: { code: string; message: string };
    };
    expect(error.code).toBe('HISTORY_UPGRADE_REQUIRED');
    expect(error.message).toContain('orcaops history upgrade');
    expect(error.message).not.toMatch(/rebuild|reinitializ|delete/i);
    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(await backupNames(projectDirectory)).toEqual([]);
  }
);

it('reports a current database as needing nothing and takes no backup', async () => {
  const f = await fixture();
  const file = f.writer.databasePath;
  const projectDirectory = path.dirname(file);

  const preview = await run(f, ['history', 'upgrade', '--json']);
  expect(preview.exitCode).toBeNull();
  expect(preview.envelope).toMatchObject({
    ok: true,
    mode: 'preview',
    changed: false,
    state: 'current',
    from_version: CURRENT_SCHEMA_VERSION,
    backup_directory: null,
  });

  const applied = await run(f, ['history', 'upgrade', '--apply', '--json']);
  expect(applied.exitCode).toBeNull();
  expect(applied.envelope).toMatchObject({ ok: true, changed: false, state: 'current' });
  expect(await backupNames(projectDirectory)).toEqual([]);

  const backups = await run(f, ['history', 'backups', '--json']);
  expect(backups.envelope).toMatchObject({ ok: true, backups: [] });
  const human = await run(f, ['history', 'backups']);
  expect(human.output).toContain('No upgrade backups have been taken');
});

it.each([
  [28, 'HISTORY_FORMAT_UNSUPPORTED', /never released/],
  [32, 'HISTORY_FORMAT_UNSUPPORTED', /never released/],
  [99, 'HISTORY_FORMAT_NEWER', /newer build/],
  [RELEASED_SCHEMA_VERSION, 'HISTORY_INTEGRITY_REQUIRED', /does not hold the released definition/],
])(
  'refuses to upgrade a schema-%s database with %s and takes no backup',
  async (version, code, message) => {
    const f = await fixture();
    const file = f.writer.databasePath;
    const projectDirectory = path.dirname(file);
    f.writer.close();
    const raw = new Database(file, { fileMustExist: true });
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = await projectFiles(projectDirectory);

    const refused = await run(f, ['history', 'upgrade', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.envelope.error).toMatchObject({ code, message: expect.stringMatching(message) });
    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(await backupNames(projectDirectory)).toEqual([]);

    const applied = await run(f, ['history', 'upgrade', '--apply', '--json']);
    expect(applied.exitCode).toBe(1);
    expect(applied.envelope.error).toMatchObject({ code });
    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(await backupNames(projectDirectory)).toEqual([]);
  }
);

it(
  'lists a backup whose manifest cannot be read with the reason, and refuses to restore from it',
  { timeout: 180_000 },
  async () => {
    const { f, file, projectDirectory } = await releasedProject();
    const applied = await run(f, ['history', 'upgrade', '--apply', '--json']);
    const backup = applied.envelope.backup as { name: string; manifest_file: string };
    await fs.writeFile(backup.manifest_file, '{ not a manifest');
    const before = await projectFiles(projectDirectory);

    const listed = await run(f, ['history', 'backups', '--json']);
    expect(listed.exitCode).toBeNull();
    expect(listed.envelope.backups).toEqual([
      expect.objectContaining({ name: backup.name, unreadable: expect.any(String) }),
    ]);
    const human = await run(f, ['history', 'backups']);
    expect(human.output).toContain(`${backup.name}  cannot be used:`);

    const refused = await run(f, ['history', 'restore', backup.name, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.envelope.error).toMatchObject({ code: 'HISTORY_BACKUP_UNVERIFIED' });
    expect(await projectFiles(projectDirectory)).toEqual(before);
    expect(schemaVersionOf(file)).toBe(CURRENT_SCHEMA_VERSION);
  }
);

it('refuses a restore of a backup this project database does not have', async () => {
  const f = await fixture();
  const projectDirectory = path.dirname(f.writer.databasePath);
  const missing = 'schema-29-01998f00-0000-7000-8000-000000000000';

  const refused = await run(f, ['history', 'restore', missing, '--json']);
  expect(refused.exitCode).toBe(1);
  expect(refused.envelope.error).toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('orcaops history backups'),
  });
  expect(await backupNames(projectDirectory)).toEqual([]);
});

it('says a passive read of a released database needs an explicit upgrade', async () => {
  const { f, file } = await releasedProject();
  const before = await fs.readFile(file);

  const shown = await run(f, ['list', '--json']);
  expect(shown.envelope).toMatchObject({
    ok: true,
    completeness: {
      complete: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'HISTORY_UPGRADE_REQUIRED',
          message: expect.stringContaining('orcaops history upgrade'),
        }),
      ]),
    },
  });
  expect(await fs.readFile(file)).toEqual(before);
});
