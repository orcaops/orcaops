import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendDurable, mkdirDurable, replaceDurable, writeDurable } from './durable.js';

/**
 * Modes are the assertable half of durability here: fsync has no
 * observable effect short of pulling the power, so these tests pin the
 * permissions and the umask-independence, and the durability itself is
 * covered by call-order review rather than pretended-at with a fake.
 */

const IS_WINDOWS = process.platform === 'win32';
let dir: string;
let priorUmask: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orcaops-durable-'));
  // A permissive umask is the whole point: a mode argument must not be
  // silently widened by the process's umask.
  priorUmask = process.umask(0o000);
});

afterEach(async () => {
  process.umask(priorUmask);
  await rm(dir, { recursive: true, force: true });
});

describe('writeDurable', () => {
  it('writes the bytes and creates the file 0600 despite a permissive umask', async () => {
    const file = path.join(dir, 'secret.json');
    await writeDurable(file, Buffer.from('{"a":1}'), 0o600);
    expect(await readFile(file, 'utf8')).toBe('{"a":1}');
    if (!IS_WINDOWS) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('does not widen an existing file', async () => {
    const file = path.join(dir, 'existing.json');
    await writeDurable(file, 'first', 0o600);
    await writeDurable(file, 'second', 0o600);
    expect(await readFile(file, 'utf8')).toBe('second');
    if (!IS_WINDOWS) {
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  });
});

describe('replaceDurable', () => {
  it('replaces the target atomically, leaves no temp sibling, and keeps 0600', async () => {
    const file = path.join(dir, 'seed-state.json');
    await replaceDurable(file, '{"v":1}', 0o600, dir);
    await replaceDurable(file, '{"v":2}', 0o600, dir);
    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
    const siblings = (await readdir(dir)).filter((name) => name.includes('.tmp.'));
    expect(siblings).toEqual([]);
    if (!IS_WINDOWS) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a target escaping the containment root and cleans up', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-durable-out-'));
    try {
      await expect(
        replaceDurable(path.join(outside, 'escape.json'), 'x', 0o600, dir)
      ).rejects.toThrow();
      const leftovers = await readdir(outside);
      expect(leftovers).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('appendDurable', () => {
  it('creates the log 0600 under a permissive umask and appends in order', async () => {
    const file = path.join(dir, 'events.ndjson');
    await appendDurable(file, 'one\n');
    await appendDurable(file, 'two\n');
    expect(await readFile(file, 'utf8')).toBe('one\ntwo\n');
    if (!IS_WINDOWS) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('appends to a pre-existing log without truncating it', async () => {
    const file = path.join(dir, 'events.ndjson');
    await writeFile(file, 'seed\n', { mode: 0o600 });
    await appendDurable(file, 'next\n');
    expect(await readFile(file, 'utf8')).toBe('seed\nnext\n');
  });
});

describe('mkdirDurable', () => {
  it('creates every level 0700 despite a permissive umask', async () => {
    const deep = path.join(dir, 'a', 'b', 'c');
    await mkdirDurable(deep, 0o700);
    if (IS_WINDOWS) return;
    for (const p of [path.join(dir, 'a'), path.join(dir, 'a', 'b'), deep]) {
      expect((await stat(p)).mode & 0o777, `${p} mode`).toBe(0o700);
    }
  });

  it('TIGHTENS a pre-existing permissive directory', async () => {
    // These are orcaops-owned local directories (the artifact tree and the
    // usage ledger are gitignored), so nothing recreates them at the ambient
    // umask and tightening is safe. The tracked `.orcaops/` root is never
    // passed to this helper.
    const existing = path.join(dir, 'preexisting');
    await mkdir(existing, { recursive: true, mode: 0o755 });
    await mkdirDurable(existing, 0o700);
    if (IS_WINDOWS) return;
    expect((await stat(existing)).mode & 0o777).toBe(0o700);
  });

  it('tightens a PRE-EXISTING permissive ancestor when creating a new child', async () => {
    // The shape the event log actually hits: `<artifacts>` already exists and
    // is permissive, `<artifacts>/<id>` is new. Tightening only the leaf
    // would leave the parent readable.
    const parent = path.join(dir, 'artifacts');
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const child = path.join(parent, 'artifact-1');
    await mkdirDurable(child, 0o700, parent);
    if (IS_WINDOWS) return;
    expect((await stat(parent)).mode & 0o777, 'parent').toBe(0o700);
    expect((await stat(child)).mode & 0o777, 'child').toBe(0o700);
  });

  it('touches only the target when no ownership is granted', async () => {
    // The safety property behind the explicit grant: without one, a
    // permissive ANCESTOR is left alone. Inferring ownership here would mean
    // chmod'ing whatever sits above a caller's scratch directory — /tmp, for
    // a caller working in an mkdtemp.
    const parent = path.join(dir, 'not-ours');
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const child = path.join(parent, 'child');
    await mkdirDurable(child, 0o700);
    if (IS_WINDOWS) return;
    expect((await stat(parent)).mode & 0o777, 'ancestor must be untouched').toBe(0o755);
    expect((await stat(child)).mode & 0o777, 'target').toBe(0o700);
  });

  it('leaves an already-private directory untouched', async () => {
    const existing = path.join(dir, 'private');
    await mkdir(existing, { recursive: true, mode: 0o700 });
    await mkdirDurable(existing, 0o700);
    if (IS_WINDOWS) return;
    expect((await stat(existing)).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked ancestor before creating or chmodding outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-durable-outside-'));
    await symlink(outside, path.join(dir, 'redirect'));
    try {
      await expect(
        mkdirDurable(path.join(dir, 'redirect', 'artifact'), 0o700, undefined, dir)
      ).rejects.toThrow(/must not contain symlinks/);
      await expect(access(path.join(outside, 'artifact'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
