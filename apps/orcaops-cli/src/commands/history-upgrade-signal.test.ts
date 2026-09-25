import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { fixture } from '../../tests/helpers/database-history.js';
import { placeReleasedProjectDatabase } from '../../tests/helpers/released-project-database.js';

const binary = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));
const RELEASED_SCHEMA_VERSION = 29;
const CURRENT_SCHEMA_VERSION = 33;
const BACKUP_DIRECTORY = 'upgrade-backups';

/**
 * The version and the whole content, as one snapshot. Raw bytes are not the measure here: a
 * writer connection that opens and closes folds the write-ahead log into the main file, which
 * rewrites bytes without changing a single row.
 */
function snapshot(file: string): { version: number; content: string } {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      version: database.pragma('user_version', { simple: true }) as number,
      content: createHash('sha256').update(database.serialize()).digest('hex'),
    };
  } finally {
    database.close();
  }
}

/** Runs the built command as a real child process and interrupts it with SIGINT. */
function upgrade(
  cwd: string,
  root: string,
  home: string,
  interruptWhen: () => Promise<boolean>
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const child = spawn(process.execPath, [binary, 'history', 'upgrade', '--apply', '--json'], {
    cwd,
    env: {
      ...process.env,
      ORCAOPS_DATA_DIR: root,
      ORCAOPS_ROOT: '',
      ORCAOPS_CLOUD_FEATURES: '0',
      ORCAOPS_DISABLE_DRAIN: '1',
      NODE_DISABLE_COMPILE_CACHE: '1',
      HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', () => undefined);
  void (async () => {
    const deadline = Date.now() + 60_000;
    while (child.exitCode === null && Date.now() < deadline) {
      if (await interruptWhen()) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    child.kill('SIGINT');
  })();
  return new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal, stdout }))
  );
}

it(
  'leaves the released database untouched when the upgrade is cancelled before it changes anything',
  { timeout: 300_000 },
  async () => {
    const f = await fixture();
    await placeReleasedProjectDatabase(f.writer);
    const file = f.writer.databasePath;
    const projectDirectory = path.dirname(file);
    const backupParent = path.join(projectDirectory, BACKUP_DIRECTORY);
    const before = snapshot(file);
    expect(before.version).toBe(RELEASED_SCHEMA_VERSION);

    const interrupted = await upgrade(
      f.main,
      f.root,
      path.join(f.temporary, 'home'),
      // The backup directory is created before anything is copied into it, so its arrival is
      // the earliest moment the command has taken any step of its own.
      () =>
        fs
          .stat(backupParent)
          .then(() => true)
          .catch(() => false)
    );
    expect(interrupted.code === 0 && interrupted.signal === null).toBe(false);

    const published = await fs
      .readdir(backupParent)
      .then((names) => names.filter((name) => name.startsWith('schema-')))
      .catch(() => []);
    // Whether the signal landed before or after COMMIT, the store is never half-made: it is
    // either the released database with no published backup, or the upgraded one with the
    // verified backup that upgrade took.
    const after = snapshot(file);
    if (after.version === RELEASED_SCHEMA_VERSION) {
      expect(JSON.parse(interrupted.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'CANCELLED',
          message: expect.stringContaining('before the database changed'),
        },
      });
      expect(after).toEqual(before);
      expect(published).toEqual([]);
    } else {
      expect(after.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(published).toHaveLength(1);
    }
    // An unverified copy is never left behind under either outcome.
    const pending = await fs
      .readdir(backupParent)
      .then((names) => names.filter((name) => name.startsWith('.pending-')))
      .catch(() => []);
    expect(pending).toEqual([]);
  }
);
