import { mkdir, rm } from 'node:fs/promises';
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
});
