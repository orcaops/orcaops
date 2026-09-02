import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "or refused" half of the tighten-or-refuse requirement, in its own
 * file because it mocks `chmod` at the module level.
 *
 * The failure is INJECTED rather than provoked: making a real chmod fail
 * needs either another uid or a host directory we do not own, and a test that
 * reaches outside its own fixture can damage the machine it runs on (and
 * silently passes as root, where chmod always succeeds).
 */

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: (target: string, mode: number) => {
      if (String(target).includes('refuse-me')) {
        return Promise.reject(Object.assign(new Error('mocked EPERM'), { code: 'EPERM' }));
      }
      return actual.chmod(target, mode);
    },
    open: (target: string, ...args: unknown[]) => {
      if (
        String(target).includes('unsyncable-dir') ||
        (String(target).endsWith('sidecar-conflicts') && args[0] === 'r')
      ) {
        return Promise.reject(
          Object.assign(new Error('mocked EOPNOTSUPP'), { code: 'EOPNOTSUPP' })
        );
      }
      return Reflect.apply(actual.open, actual, [target, ...args]).then(
        (handle: import('node:fs/promises').FileHandle) => {
          if (String(target).includes('sync-fails')) {
            return {
              sync: () => Promise.reject(Object.assign(new Error('mocked EIO'), { code: 'EIO' })),
              close: () => handle.close(),
            };
          }
          return handle;
        }
      );
    },
  };
});

let dir: string;

beforeEach(async () => {
  const { mkdtemp: realMkdtemp } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  dir = await realMkdtemp(path.join(tmpdir(), 'orcaops-refuse-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('mkdirDurable refusal', () => {
  it('throws rather than proceeding over a permissive directory it cannot tighten', async () => {
    if (process.platform === 'win32') return;
    const { mkdirDurable } = await import('./durable.js');
    const { mkdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const target = path.join(dir, 'refuse-me');
    await mkdir(target, { recursive: true, mode: 0o755 });

    await expect(mkdirDurable(target, 0o700, target)).rejects.toThrow(/refusing to use/);
  });
});

describe('fsyncDirStrict refusal', () => {
  it('throws when a POSIX directory cannot be opened for sync', async () => {
    if (process.platform === 'win32') return;
    const { fsyncDirStrict } = await import('./durable.js');

    await expect(fsyncDirStrict(path.join(dir, 'unsyncable-dir'))).rejects.toMatchObject({
      code: 'EOPNOTSUPP',
    });
  });

  it('throws when a POSIX directory cannot be synced', async () => {
    if (process.platform === 'win32') return;
    const { fsyncDirStrict } = await import('./durable.js');
    const target = path.join(dir, 'sync-fails');
    await mkdir(target);

    await expect(fsyncDirStrict(target)).rejects.toMatchObject({ code: 'EIO' });
  });

  it('keeps a canonical usage sidecar when conflict retention cannot be synced', async () => {
    if (process.platform === 'win32') return;
    const { ArchiveMirror } = await import('../archive/mirror.js');
    const { archiveUsageLedgerPaths } = await import('../archive/paths.js');
    const { appendUsageLedgerRecord } = await import('../usage/ledger-log.js');
    const hotDir = path.join(dir, 'hot');
    const projectDir = path.join(dir, 'archive', 'projects', 'project-1');
    await mkdir(hotDir, { recursive: true });
    const hotPaths = {
      ledgerPath: path.join(hotDir, 'usage', 'ledger.ndjson'),
      sidecarsDir: path.join(hotDir, 'usage', 'sidecars'),
      containmentRoot: hotDir,
    };
    const warnings: string[] = [];
    const mirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(dir, 'locks'),
      redactSecrets: false,
      onWarn: (message) => {
        warnings.push(message);
      },
    });
    const eventId = '01999999-9999-7000-8000-000000000001';
    const first = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-08-05T00:00:00.000Z',
        idempotency_key: 'first',
        payload: { malformed: 'x'.repeat(9_000) },
        event_id: eventId,
      },
      hotPaths
    );
    await mirror.mirrorUsageRecord(first, hotPaths.sidecarsDir, hotDir);
    const canonicalPath = path.join(
      archiveUsageLedgerPaths(projectDir).sidecarsDir,
      `${eventId}.json`
    );
    const original = await readFile(canonicalPath);

    const second = await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-08-05T00:01:00.000Z',
        idempotency_key: 'second',
        payload: {
          canonical_ref_id: `cloud:${'p'.repeat(9_000)}`,
          artifact_id: eventId,
          linked_at: '2026-08-05T00:01:00.000Z',
          pinned_version: null,
        },
        event_id: eventId,
      },
      hotPaths
    );
    await mirror.mirrorUsageRecord(second, hotPaths.sidecarsDir, hotDir);

    expect(await readFile(canonicalPath)).toEqual(original);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('mocked EOPNOTSUPP');
  });
});
