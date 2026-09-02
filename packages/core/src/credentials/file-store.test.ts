import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type StoredCredentials } from '@orcaops/sdk';

import { defaultConfigDir, FileStore, FileStoreError } from './file-store.js';
import { RefreshLockContendedError } from './refresh-lock.js';

const execFileAsync = promisify(execFile);

function ownerRecordPath(lockPath: string, identity: { ino: number; birthtimeMs: number }): string {
  return path.join(lockPath, `owner.${identity.ino}.${identity.birthtimeMs}.json`);
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sample = (over: Partial<StoredCredentials> = {}): StoredCredentials => ({
  v: 1,
  loginMethod: 'oauth',
  baseUrl: 'https://api.test',
  userId: 'usr_1',
  orgId: 'org_1',
  orgName: 'Acme',
  orgSlug: 'acme',
  email: 'jane@test',
  accessToken: 'eyJ.fake',
  refreshToken: 'rt_fake',
  expiresAt: 1700000000,
  ...over,
});

describe('FileStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-fs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a credential blob with mode 0600', () => {
    const store = new FileStore({ dir });
    const creds = sample();
    store.write('https://api.test', creds);
    const file = path.join(dir, 'credentials.json');
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.read('https://api.test')).toEqual(creds);
  });

  it('returns null when the file is missing', () => {
    const store = new FileStore({ dir });
    expect(store.read('https://api.test')).toBeNull();
  });

  it('returns null when the file exists but the baseUrl is unknown', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample());
    expect(store.read('https://other.test')).toBeNull();
  });

  it('supports multiple baseUrls in one file (multi-cloud)', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample({ baseUrl: 'https://api.test', orgName: 'Acme' }));
    store.write(
      'https://staging.test',
      sample({ baseUrl: 'https://staging.test', orgName: 'Staging' })
    );
    expect(store.read('https://api.test')?.orgName).toBe('Acme');
    expect(store.read('https://staging.test')?.orgName).toBe('Staging');
  });

  it('rejects writes whose credentials.baseUrl mismatches the key', () => {
    const store = new FileStore({ dir });
    expect(() =>
      store.write('https://api.test', sample({ baseUrl: 'https://other.test' }))
    ).toThrow(FileStoreError);
  });

  it('rejects non-OAuth and unknown fields before writing', () => {
    const store = new FileStore({ dir });
    expect(() => store.write('https://api.test', { ...sample(), loginMethod: 'env' })).toThrow(
      FileStoreError
    );
    expect(() =>
      store.write('https://api.test', { ...sample(), unexpected: true } as StoredCredentials)
    ).toThrow(FileStoreError);
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
  });

  it('rejects an on-disk entry whose map key disagrees with its base URL', () => {
    const store = new FileStore({ dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ 'https://api.test': sample({ baseUrl: 'https://other.test' }) }),
      { mode: 0o600 }
    );
    expect(() => store.read('https://api.test')).toThrow(/must match map key/);
  });

  it('clear removes only the named baseUrl', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample({ baseUrl: 'https://api.test' }));
    store.write('https://staging.test', sample({ baseUrl: 'https://staging.test' }));
    store.clear('https://api.test');
    expect(store.read('https://api.test')).toBeNull();
    expect(store.read('https://staging.test')).not.toBeNull();
  });

  it('clear is a no-op when the baseUrl is absent', () => {
    const store = new FileStore({ dir });
    expect(() => store.clear('https://nope')).not.toThrow();
  });

  it('clear deletes the file entirely when the last baseUrl is removed', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample());
    store.clear('https://api.test');
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
  });

  it('throws FileStoreError on a corrupt JSON file', () => {
    const store = new FileStore({ dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{not json', { mode: 0o600 });
    expect(() => store.read('https://api.test')).toThrow(FileStoreError);
  });

  it('throws FileStoreError on a schema-invalid file', () => {
    const store = new FileStore({ dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ 'https://api.test': { v: 1, loginMethod: 'oauth' } }),
      { mode: 0o600 }
    );
    expect(() => store.read('https://api.test')).toThrow(/failed validation/);
  });

  it('rewrite re-applies mode 0600 even if a prior process widened it', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample());
    fs.chmodSync(path.join(dir, 'credentials.json'), 0o644);
    store.write('https://api.test', sample({ accessToken: 'new' }));
    const mode = fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // A torn writeFileSync (SIGKILL / OOM / power loss mid-write) leaves the
  // credentials file at zero bytes or partial JSON; the next read then fails
  // Zod validation with no automatic recovery and the user has to manually
  // rm the file to log in again. Writing to a tmp sibling and renaming
  // atomically avoids that; the tests below pin both the happy path and the
  // failure-recovery shape.
  it('writes atomically via a tmp sibling + rename (no torn writes on failure)', () => {
    const store = new FileStore({ dir });
    store.write('https://api.test', sample());
    // After a successful write, no tmp sibling should remain.
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((e) => e.startsWith('credentials.json.tmp.'));
    expect(tmps).toEqual([]);
    // And the canonical file is well-formed JSON readable by FileStore.
    const fresh = new FileStore({ dir });
    expect(fresh.read('https://api.test')).toMatchObject({ baseUrl: 'https://api.test' });
  });

  it('tightens the parent directory to mode 0700 on creation', () => {
    // Use a fresh subdirectory the test owns so we can observe the mode the
    // FileStore set rather than whatever the tmpdir() already had.
    const sub = path.join(dir, 'nested', 'orcaops');
    const store = new FileStore({ dir: sub });
    store.write('https://api.test', sample());
    const mode = fs.statSync(sub).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('defaultConfigDir', () => {
  const ORIGINAL = {
    config: process.env.ORCAOPS_CONFIG_HOME,
    xdg: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME,
  };
  afterEach(() => {
    if (ORIGINAL.config === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
    else process.env.ORCAOPS_CONFIG_HOME = ORIGINAL.config;
    if (ORIGINAL.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL.xdg;
  });

  it('honors ORCAOPS_CONFIG_HOME first', () => {
    process.env.ORCAOPS_CONFIG_HOME = '/explicit/override';
    expect(defaultConfigDir()).toBe('/explicit/override');
  });

  it('falls back to XDG_CONFIG_HOME/orcaops when set', () => {
    delete process.env.ORCAOPS_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/xdg/cfg';
    expect(defaultConfigDir()).toBe('/xdg/cfg/orcaops');
  });

  it('falls back to ~/.config/orcaops as the last resort', () => {
    delete process.env.ORCAOPS_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    expect(defaultConfigDir()).toMatch(/\/\.config\/orcaops$/);
  });

  describe('withRefreshLock', () => {
    let lockDir: string;
    beforeEach(async () => {
      lockDir = await mkdtemp(path.join(tmpdir(), 'orcaops-fs-lock-'));
    });
    afterEach(async () => {
      await rm(lockDir, { recursive: true, force: true });
    });

    it('serializes concurrent critical sections for the same baseUrl', async () => {
      const store = new FileStore({ dir: lockDir });
      const order: string[] = [];
      const section = (id: string) =>
        store.withRefreshLock('https://api.test', async () => {
          order.push(`enter-${id}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`exit-${id}`);
        });
      await Promise.all([section('a'), section('b')]);
      // Mutual exclusion: one section fully completes before the other enters,
      // never interleaved (enter-a, enter-b, exit-a, exit-b).
      expect(order).toHaveLength(4);
      expect(order[1]).toBe(order[0].replace('enter', 'exit'));
    });

    it('releases the lock (and returns fn result) even when fn throws', async () => {
      const store = new FileStore({ dir: lockDir });
      await expect(
        store.withRefreshLock('https://api.test', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      // Lock released → a subsequent acquire resolves immediately.
      await expect(store.withRefreshLock('https://api.test', async () => 'ok')).resolves.toBe('ok');
    });

    it('preserves the callback result when physical lock cleanup fails', async () => {
      const store = new FileStore({
        dir: lockDir,
        refreshLock: { acquireMs: 200, retryMs: 5, staleMs: 20 },
      });
      const blocker = path.join(lockDir, '.credentials.lock', 'cleanup-blocker');
      const result = await store.withRefreshLock('https://api.test', async () => {
        await writeFile(blocker, 'occupied');
        return 'protected-result';
      });

      expect(result).toBe('protected-result');
      expect(fs.readdirSync(path.join(lockDir, '.credentials.lock'))).toEqual(['cleanup-blocker']);

      await rm(blocker);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(
        store.withRefreshLock('https://api.test', async () => 'recovered')
      ).resolves.toBe('recovered');
    });

    it('preserves the callback error when physical lock cleanup also fails', async () => {
      const store = new FileStore({ dir: lockDir });
      const operationError = new Error('protected-operation-failed');

      await expect(
        store.withRefreshLock('https://api.test', async () => {
          await writeFile(path.join(lockDir, '.credentials.lock', 'cleanup-blocker'), 'occupied');
          throw operationError;
        })
      ).rejects.toBe(operationError);
    });

    it('fails closed (throws) when the lock is held past the acquire budget', async () => {
      // Fail-closed is the safety property: never run the refresh unlocked, since
      // two concurrent /oauth2/token POSTs would trip OAuth reuse detection.
      const store = new FileStore({ dir: lockDir, refreshLock: { acquireMs: 120, retryMs: 10 } });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const holder = store.withRefreshLock('https://api.test', () => held);
      await new Promise((r) => setTimeout(r, 20)); // let the holder acquire
      await expect(
        store.withRefreshLock('https://api.test', async () => 'should-not-run')
      ).rejects.toBeInstanceOf(RefreshLockContendedError);
      release();
      await holder;
    });

    // The real cross-process guarantee: two separate `node` processes sharing
    // one store dir must serialize via the atomic mkdir lock. (Same-process
    // tests above can't prove the OS-level lock spans processes.)
    it('serializes the critical section across separate processes', async () => {
      const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
      // This is the separate-process proof of the mkdir lock, so the compiled
      // entry is an explicit prerequisite. Repository test orchestration
      // builds this package before running the suite.
      expect(
        fs.existsSync(distEntry),
        'dist/index.js missing — build @orcaops/core first; the cross-process refresh-lock proof requires the compiled entry'
      ).toBe(true);
      const log = path.join(lockDir, 'order.log');
      const worker = path.join(lockDir, 'worker.mjs');
      await writeFile(
        worker,
        [
          'const [dist, dir, baseUrl, logPath, id] = process.argv.slice(2);',
          'const { FileStore } = await import(dist);',
          'const { appendFileSync } = await import("node:fs");',
          'const store = new FileStore({ dir });',
          'await store.withRefreshLock(baseUrl, async () => {',
          '  appendFileSync(logPath, `start ${id}\\n`);',
          '  await new Promise((r) => setTimeout(r, 250));',
          '  appendFileSync(logPath, `end ${id}\\n`);',
          '});',
        ].join('\n')
      );
      const run = (id: string) =>
        execFileAsync('node', [worker, distEntry, lockDir, 'https://api.test', log, id], {
          cwd: process.cwd(),
        });
      await Promise.all([run('A'), run('B')]);
      const lines = (await readFile(log, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(4);
      // The first holder fully finished (start+end, same id) before the other entered.
      const firstId = lines[0].split(' ')[1];
      expect(lines[0]).toBe(`start ${firstId}`);
      expect(lines[1]).toBe(`end ${firstId}`);
    });
  });
});

describe('store-wide locking and owner-safe release', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-storewide-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function creds(baseUrl: string, token: string): StoredCredentials {
    return {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'u',
      orgId: 'o',
      orgName: null,
      orgSlug: null,
      email: 'e@example.test',
      accessToken: token,
      refreshToken: `rt-${token}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  it('concurrent mutators for DIFFERENT clouds both survive', async () => {
    // The defect this pins: the lock used to be keyed by base URL while the
    // protected resource is one shared file, so two clouds' refreshes could
    // read-modify-write concurrently and the second would discard the first.
    const a = 'https://a.test';
    const b = 'https://b.test';
    const store = new FileStore({ dir });

    // Interleave through the real async lock the SDK uses, each side doing a
    // full read-modify-write with a yield in the middle to force overlap.
    const mutate = (baseUrl: string, token: string): Promise<void> =>
      store.withRefreshLock(baseUrl, async () => {
        const before = store.read(baseUrl);
        await new Promise((r) => setTimeout(r, 25));
        store.write(baseUrl, creds(baseUrl, token));
        expect(before).toBeNull();
      });

    await Promise.all([mutate(a, 'token-a'), mutate(b, 'token-b')]);

    expect(store.read(a)?.accessToken).toBe('token-a');
    expect(store.read(b)?.accessToken).toBe('token-b');
    expect(store.knownBaseUrls().sort()).toEqual([a, b]);
  });

  it('a nested write inside a held refresh lock does not deadlock', async () => {
    // Exactly the SDK's shape: withRefreshLock → … → store.write. A
    // non-re-entrant store-wide lock would block here until the acquire
    // budget expired and then throw.
    const store = new FileStore({ dir, refreshLock: { acquireMs: 300, retryMs: 10 } });
    await store.withRefreshLock('https://api.test', async () => {
      store.write('https://api.test', creds('https://api.test', 'nested'));
    });
    expect(store.read('https://api.test')?.accessToken).toBe('nested');
  });

  it('an INDEPENDENT concurrent acquire still fails closed rather than re-entering', async () => {
    // The re-entrancy above must be scoped to the nested call stack; a
    // separate concurrent acquirer is a real contender and must not be
    // waved through.
    const store = new FileStore({ dir, refreshLock: { acquireMs: 120, retryMs: 10 } });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = store.withRefreshLock('https://api.test', () => held);
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      store.withRefreshLock('https://other.test', async () => 'should-not-run')
    ).rejects.toBeInstanceOf(RefreshLockContendedError);
    release();
    await holder;
  });

  it('a sync mutation fails fast instead of freezing the loop under an async holder', async () => {
    // Atomics.wait would block the very event loop the async holder needs to
    // release, so waiting could never succeed. Fail immediately instead.
    const store = new FileStore({ dir, refreshLock: { acquireMs: 5000, retryMs: 10 } });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = store.withRefreshLock('https://api.test', () => held);
    await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    expect(() => store.write('https://api.test', creds('https://api.test', 'x'))).toThrow(
      RefreshLockContendedError
    );
    expect(Date.now() - started).toBeLessThan(500);

    release();
    await holder;
    store.write('https://api.test', creds('https://api.test', 'after'));
    expect(store.read('https://api.test')?.accessToken).toBe('after');
  });

  it('TWO overlapping async contenders still block a sync acquirer from waiting', async () => {
    // The refcount: with a plain flag, the first async operation to finish
    // would erase the marker while the other still holds the lock, and a sync
    // mutation would then enter Atomics.wait and freeze the loop.
    const store = new FileStore({ dir, refreshLock: { acquireMs: 4000, retryMs: 10 } });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = store.withRefreshLock('https://a.test', () => firstHeld);
    await new Promise((r) => setTimeout(r, 20));

    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const second = store.withRefreshLock('https://b.test', () => secondHeld);
    await new Promise((r) => setTimeout(r, 20));

    // Hand the lock over; the marker must survive the handover.
    releaseFirst();
    await first;
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    expect(() => store.write('https://c.test', creds('https://c.test', 'x'))).toThrow(
      RefreshLockContendedError
    );
    expect(Date.now() - started).toBeLessThan(500);

    releaseSecond();
    await second;
  });

  it('holding an UNRELATED lock does not license a blocking sync acquire', async () => {
    // The fail-fast keys on the TARGET lock, not on "this stack holds
    // something": a caller inside store A's lock writing to store B must
    // still fail fast when B is held asynchronously by someone else.
    const otherDir = await mkdtemp(path.join(tmpdir(), 'orcaops-other-'));
    try {
      const storeA = new FileStore({
        dir: otherDir,
        refreshLock: { acquireMs: 5000, retryMs: 10 },
      });
      const storeB = new FileStore({ dir, refreshLock: { acquireMs: 5000, retryMs: 10 } });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const holder = storeB.withRefreshLock('https://b.test', () => held);
      await new Promise((r) => setTimeout(r, 20));

      const started = Date.now();
      await storeA.withRefreshLock('https://a.test', async () => {
        expect(() => storeB.write('https://b.test', creds('https://b.test', 'x'))).toThrow(
          RefreshLockContendedError
        );
      });
      expect(Date.now() - started).toBeLessThan(1000);

      release();
      await holder;
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('CROSS-PROCESS: different clouds serialize on the one store-wide lock', async () => {
    // What is deterministically observable, and what the store-wide lock
    // actually turns on. The lost update itself cannot be forced from outside the store:
    // `write` performs its own internal readAll → writeAll, so a test that
    // synchronizes around an EXTERNAL read proves nothing — either process
    // may complete its whole write before the other starts, and the loser's
    // fresh read would pick up the winner's entry anyway.
    //
    // What can be proven is the mechanism that prevents it: two processes
    // holding the store lock for DIFFERENT base URLs must not overlap. Under
    // the old per-baseUrl keying they take different locks and interleave
    // freely; under one store-wide lock the second cannot enter until the
    // first has left, which is exactly what makes a read-modify-write of the
    // shared file safe.
    const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
    expect(
      fs.existsSync(distEntry),
      'dist/index.js missing — build @orcaops/core first; the cross-process proof requires the compiled entry'
    ).toBe(true);
    const log = path.join(dir, 'order.log');
    const worker = path.join(dir, 'writer.mjs');
    await writeFile(
      worker,
      [
        'const [dist, storeDir, baseUrl, token, logPath, id, inMarker, peerMarker] = process.argv.slice(2);',
        'const { FileStore } = await import(dist);',
        'const { appendFileSync, writeFileSync, existsSync } = await import("node:fs");',
        'const store = new FileStore({ dir: storeDir, refreshLock: { acquireMs: 8000, retryMs: 10 } });',
        // The production shape: hold the lock across a slow refresh, then
        // persist. Both the hold and the write are inside the section.
        'await store.withRefreshLock(baseUrl, async () => {',
        '  appendFileSync(logPath, `start ${id}\n`);',
        // In-section peer handshake, so overlap is DETECTED rather than
        // hoped for: publish that we are inside, then wait for the peer's
        // marker. Under per-baseUrl locking both processes are inside their
        // (different) locks, each sees the other's marker at once, and both
        // remain in-section together — the log interleaves. Under the
        // store-wide lock the peer cannot enter, this wait times out, and the
        // sections stay strictly ordered. A fixed sleep proves neither.
        '  writeFileSync(inMarker, "in");',
        '  const deadline = Date.now() + 1500;',
        '  while (!existsSync(peerMarker) && Date.now() < deadline) {',
        '    await new Promise((r) => setTimeout(r, 10));',
        '  }',
        '  store.write(baseUrl, {',
        '    v: 1, loginMethod: "oauth", baseUrl,',
        '    userId: "u", orgId: "o", orgName: null, orgSlug: null,',
        '    email: "e@example.test", accessToken: token, refreshToken: "rt-" + token,',
        '    expiresAt: Math.floor(Date.now() / 1000) + 3600,',
        '  });',
        '  appendFileSync(logPath, `end ${id}\n`);',
        '});',
      ].join('\n')
    );
    const markA = path.join(dir, 'in-a');
    const markB = path.join(dir, 'in-b');
    const run = (baseUrl: string, token: string, id: string, mine: string, theirs: string) =>
      execFileAsync('node', [worker, distEntry, dir, baseUrl, token, log, id, mine, theirs], {
        cwd: process.cwd(),
      });
    await Promise.all([
      run('https://a.test', 'token-a', 'A', markA, markB),
      run('https://b.test', 'token-b', 'B', markB, markA),
    ]);

    // Serialized: the first holder finished before the second started.
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    const firstId = lines[0].split(' ')[1];
    expect(lines[0]).toBe(`start ${firstId}`);
    expect(lines[1]).toBe(`end ${firstId}`);

    // And with serialization, neither cloud's entry was lost.
    const store = new FileStore({ dir });
    expect(store.read('https://a.test')?.accessToken).toBe('token-a');
    expect(store.read('https://b.test')?.accessToken).toBe('token-b');
  }, 20_000);

  it('does not reap a live owner solely because the lock is old', async () => {
    const lockPath = path.join(dir, '.credentials.lock');
    const store = new FileStore({
      dir,
      refreshLock: { acquireMs: 150, retryMs: 5, staleMs: 40 },
    });

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = store.withRefreshLock('https://a.test', () => held);
    await new Promise((r) => setTimeout(r, 20));
    const identity = fs.statSync(lockPath);
    await new Promise((r) => setTimeout(r, 100));

    await expect(
      store.withRefreshLock('https://b.test', async () => 'overlap')
    ).rejects.toBeInstanceOf(RefreshLockContendedError);
    const after = fs.statSync(lockPath);
    expect(after.ino).toBe(identity.ino);
    expect(after.birthtimeMs).toBe(identity.birthtimeMs);

    release();
    await holder;
  });

  it('keeps a stale child-owned lock until the owner process exits', async () => {
    const lockPath = path.join(dir, '.credentials.lock');
    const childReady = path.join(dir, 'child-ready');
    const child = spawn(process.execPath, [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);',
      childReady,
    ]);
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    try {
      const ownerPid = child.pid;
      if (ownerPid === undefined) throw new Error('child process did not expose a pid');
      await waitForFile(childReady);
      fs.mkdirSync(lockPath);
      const old = new Date(Date.now() - 1_000);
      fs.utimesSync(lockPath, old, old);
      // On APFS, setting an mtime earlier than creation can also change the
      // reported birthtime, so bind the record to the post-aging identity.
      const identity = fs.statSync(lockPath);
      const ownerFile = ownerRecordPath(lockPath, identity);
      fs.writeFileSync(
        ownerFile,
        `${JSON.stringify({
          v: 1,
          pid: ownerPid,
          ino: identity.ino,
          birthtimeMs: identity.birthtimeMs,
        })}\n`,
        { mode: 0o600 }
      );
      fs.utimesSync(lockPath, old, old);

      const store = new FileStore({
        dir,
        refreshLock: { acquireMs: 150, retryMs: 5, staleMs: 40 },
      });
      await expect(
        store.withRefreshLock('https://b.test', async () => 'overlap')
      ).rejects.toBeInstanceOf(RefreshLockContendedError);
      expect(fs.existsSync(lockPath)).toBe(true);

      child.kill();
      await exited;
      await expect(store.withRefreshLock('https://b.test', async () => 'acquired')).resolves.toBe(
        'acquired'
      );
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited.catch(() => undefined);
    }
  });

  it('does not release a replacement lock with a different identity', async () => {
    const lockPath = path.join(dir, '.credentials.lock');
    const prepared = path.join(dir, 'prepared-successor');
    const store = new FileStore({ dir });
    let predecessor!: fs.Stats;
    let successor!: fs.Stats;

    await store.withRefreshLock('https://a.test', async () => {
      predecessor = fs.statSync(lockPath);
      fs.mkdirSync(prepared);
      successor = fs.statSync(prepared);
      expect(successor.ino).not.toBe(predecessor.ino);

      fs.unlinkSync(ownerRecordPath(lockPath, predecessor));
      fs.rmdirSync(lockPath);
      fs.renameSync(prepared, lockPath);
      fs.writeFileSync(
        ownerRecordPath(lockPath, successor),
        `${JSON.stringify({
          v: 1,
          pid: process.pid,
          ino: successor.ino,
          birthtimeMs: successor.birthtimeMs,
        })}\n`,
        { mode: 0o600 }
      );
    });

    const observed = fs.statSync(lockPath);
    expect(observed.ino).toBe(successor.ino);
    expect(observed.birthtimeMs).toBe(successor.birthtimeMs);
    expect(JSON.parse(fs.readFileSync(ownerRecordPath(lockPath, successor), 'utf8'))).toMatchObject(
      {
        ino: successor.ino,
        birthtimeMs: successor.birthtimeMs,
      }
    );

    fs.unlinkSync(ownerRecordPath(lockPath, successor));
    fs.rmdirSync(lockPath);
  });

  it('refuses entry if the lock is replaced during owner publication', async () => {
    const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
    expect(
      fs.existsSync(distEntry),
      'dist/index.js missing — build @orcaops/core before this cross-process proof'
    ).toBe(true);
    const lockPath = path.join(dir, '.credentials.lock');
    const prepared = path.join(dir, 'prepared-publication-successor');
    const ready = path.join(dir, 'publication-ready');
    const resume = path.join(dir, 'publication-resume');
    const entered = path.join(dir, 'publication-entered');
    const refused = path.join(dir, 'publication-refused');
    const worker = path.join(dir, 'publication-worker.mjs');
    await writeFile(
      worker,
      [
        'const [dist, storeDir, ready, resume, entered, refused] = process.argv.slice(2);',
        'const { createRequire, syncBuiltinESMExports } = await import("node:module");',
        'const require = createRequire(import.meta.url);',
        'const fs = require("node:fs");',
        'const writeFileSync = fs.writeFileSync;',
        'fs.writeFileSync = (destination, ...args) => {',
        '  if (String(destination).includes(".credentials.lock/owner.")) {',
        '    fs.writeFileSync(ready, "ready");',
        '    while (!fs.existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
        '  }',
        '  return writeFileSync(destination, ...args);',
        '};',
        'syncBuiltinESMExports();',
        'const { FileStore } = await import(dist);',
        'const store = new FileStore({ dir: storeDir });',
        'try {',
        '  await store.withRefreshLock("publication", async () => fs.writeFileSync(entered, "entered"));',
        '} catch {',
        '  fs.writeFileSync(refused, "refused");',
        '}',
      ].join('\n'),
      'utf8'
    );

    const child = execFileAsync(
      process.execPath,
      [worker, distEntry, dir, ready, resume, entered, refused],
      { timeout: 10_000 }
    );
    try {
      await waitForFile(ready);
      const predecessor = fs.statSync(lockPath);
      fs.mkdirSync(prepared);
      const successor = fs.statSync(prepared);
      expect(successor.ino).not.toBe(predecessor.ino);
      fs.rmdirSync(lockPath);
      fs.renameSync(prepared, lockPath);
      const successorOwner = ownerRecordPath(lockPath, successor);
      fs.writeFileSync(
        successorOwner,
        `${JSON.stringify({
          v: 1,
          pid: process.pid,
          ino: successor.ino,
          birthtimeMs: successor.birthtimeMs,
        })}\n`,
        { mode: 0o600 }
      );
      fs.writeFileSync(resume, 'resume');
      await child;

      expect(fs.existsSync(entered)).toBe(false);
      expect(fs.existsSync(refused)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(successorOwner, 'utf8'))).toMatchObject({
        ino: successor.ino,
        birthtimeMs: successor.birthtimeMs,
      });

      fs.unlinkSync(successorOwner);
      fs.rmdirSync(lockPath);
    } finally {
      if (!fs.existsSync(resume)) fs.writeFileSync(resume, 'resume');
      await child.catch(() => undefined);
    }
  });
});

describe('permissions on pre-existing state', () => {
  let dir: string;
  let priorUmask: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-modes-'));
    priorUmask = process.umask(0o000);
  });

  afterEach(async () => {
    process.umask(priorUmask);
    await rm(dir, { recursive: true, force: true });
  });

  function creds(baseUrl: string): StoredCredentials {
    return {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'u',
      orgId: 'o',
      orgName: null,
      orgSlug: null,
      email: 'e@example.test',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing world-readable directory on write',
    async () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
      fs.chmodSync(dir, 0o777);
      const store = new FileStore({ dir });
      store.write('https://api.test', creds('https://api.test'));
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'repairs a widened credentials file and directory on READ, not only on write',
    async () => {
      const store = new FileStore({ dir });
      store.write('https://api.test', creds('https://api.test'));
      // Widen both out-of-band, as a stray chmod or a bad umask would.
      fs.chmodSync(path.join(dir, 'credentials.json'), 0o644);
      fs.chmodSync(dir, 0o755);

      // A pure READ must repair rather than leave them exposed until the
      // next write, which may never come.
      expect(store.read('https://api.test')?.accessToken).toBe('at');
      expect(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o077).toBe(0);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
    }
  );
});
