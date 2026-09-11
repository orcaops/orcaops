import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { readRepositoryRegistration } from '@orcaops/core/history/registration';
import { materializeLegacyFixture } from '@orcaops/history-convert';

const binary = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));
const directories: string[] = [];
const operationId = '01a07e00-2222-7000-8000-000000000001';

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

async function legacyRepository() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-cli-signal-')));
  directories.push(directory);
  return materializeLegacyFixture({ directory });
}

type Legacy = Awaited<ReturnType<typeof legacyRepository>>;

/** Runs the built command as a real child process, optionally interrupting it with SIGINT. */
function convert(
  legacy: Legacy,
  options: { interruptWhen?: () => Promise<boolean> } = {}
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const child = spawn(
    process.execPath,
    [binary, 'history', 'convert', '--apply', '--offline', '--json', '--operation-id', operationId],
    {
      cwd: legacy.cwd,
      env: {
        ...legacy.env,
        ORCAOPS_DATA_DIR: legacy.root,
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DISABLE_DRAIN: '1',
        NODE_DISABLE_COMPILE_CACHE: '1',
        HOME: path.join(path.dirname(legacy.cwd), 'home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', () => undefined);
  const interrupt = options.interruptWhen;
  if (interrupt)
    void (async () => {
      const deadline = Date.now() + 60_000;
      while (child.exitCode === null && Date.now() < deadline) {
        if (await interrupt()) {
          child.kill('SIGINT');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGINT');
    })();
  return new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal, stdout }))
  );
}

it(
  'rolls back on SIGINT, leaves the repository unregistered, and converges on retry',
  { timeout: 300_000 },
  async () => {
    const legacy = await legacyRepository();
    const target = path.join(legacy.root, 'projects', legacy.projectId, 'history.sqlite3');
    const interrupted = await convert(legacy, {
      // The target file is created exclusively before the transaction opens, so its arrival is
      // the earliest moment the command has anything to roll back.
      interruptWhen: () =>
        fs
          .stat(target)
          .then(() => true)
          .catch(() => false),
    });
    expect(interrupted.code === 0 && interrupted.signal === null).toBe(false);

    // Whether the signal landed before or after COMMIT, the repository is never registered and
    // the store is never half-written: it holds either no schema at all or a complete
    // conversion under this operation ID.
    await expect(
      readRepositoryRegistration({ commonDir: path.join(legacy.cwd, '.git') })
    ).resolves.toBeNull();
    const observed = new Database(target, { readonly: true });
    let committed: boolean;
    try {
      const objects = observed.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as {
        n: number;
      };
      committed = objects.n > 0;
      if (committed)
        expect(
          observed.prepare('SELECT operation_id FROM legacy_import WHERE singleton = 1').get()
        ).toEqual({ operation_id: operationId });
    } finally {
      observed.close();
    }

    const retried = await convert(legacy);
    expect(retried.code).toBe(0);
    const envelope = JSON.parse(retried.stdout) as {
      ok: boolean;
      operationId: string;
      replayed: boolean;
      registration: Record<string, string>;
    };
    expect(envelope).toMatchObject({
      ok: true,
      operationId,
      replayed: committed,
      registration: { repository: 'created', catalog: 'created', worktree: 'created' },
    });
  }
);
