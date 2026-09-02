import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findByPath,
  type PullCacheRecord,
  pullCacheTemporaryPath,
  readPullCacheRecord,
  scanByExternalIdVersion,
  sourcePlanCacheDir,
  writePullCachePathPointer,
  writePullCacheRecord,
} from './pull-cache.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function mkRecord(overrides: Partial<PullCacheRecord> = {}): PullCacheRecord {
  const body = overrides.body ?? '# Plan\n\nfull plan body';
  return {
    schema_version: 1,
    external_id: 'ext-1',
    slug: 'my-plan',
    version_number: 3,
    title: 'My Plan',
    body,
    content_hash: sha(body),
    source_ref: null,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('pull-cache', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cache-'));
    cacheDir = sourcePlanCacheDir(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('cacheDir is under .orcaops/cache/source-plan', async () => {
    expect(cacheDir).toBe(path.join(await realpath(root), '.orcaops', 'cache', 'source-plan'));
  });

  it('writes and reads a record (namespace-scoped round-trip)', async () => {
    const rec = mkRecord();
    await writePullCacheRecord(cacheDir, rec);
    const read = await readPullCacheRecord(
      cacheDir,
      rec.base_url,
      rec.org_id,
      rec.external_id,
      rec.version_number
    );
    expect(read).toEqual(rec);
  });

  it('rejects a record whose body hash does not match content_hash', async () => {
    const rec = { ...mkRecord(), content_hash: 'deadbeef' };
    await expect(writePullCacheRecord(cacheDir, rec)).rejects.toThrow(/integrity/);
  });

  it('org-scopes keys: same (externalId, version) under two orgs stay distinct', async () => {
    const a = mkRecord({ org_id: 'org_a', body: 'A body' });
    const b = mkRecord({ org_id: 'org_b', body: 'B body' });
    await writePullCacheRecord(cacheDir, a);
    await writePullCacheRecord(cacheDir, b);
    // Namespace-scoped reads return the right per-org record.
    expect((await readPullCacheRecord(cacheDir, a.base_url, 'org_a', 'ext-1', 3))?.body).toBe(
      'A body'
    );
    expect((await readPullCacheRecord(cacheDir, b.base_url, 'org_b', 'ext-1', 3))?.body).toBe(
      'B body'
    );
    // The offline scan surfaces BOTH (the ambiguity the resolver must reject).
    const matches = await scanByExternalIdVersion(cacheDir, 'ext-1', 3);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.record.org_id))).toEqual(new Set(['org_a', 'org_b']));
  });

  it('scan returns exactly one for a single namespace, and empty on miss', async () => {
    await writePullCacheRecord(cacheDir, mkRecord());
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 3)).toHaveLength(1);
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 9)).toEqual([]);
    expect(await scanByExternalIdVersion(cacheDir, 'nope', 3)).toEqual([]);
  });

  it('findByPath traces a --out file to its pull, org-scoped', async () => {
    const outDir = path.join(root, 'work');
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, 'pulled-plan.md');
    await writeFile(outPath, 'body-on-disk', 'utf8');
    const rec = mkRecord({ body: 'body-on-disk' });
    await writePullCacheRecord(cacheDir, rec);
    await writePullCachePathPointer(cacheDir, {
      baseUrl: rec.base_url,
      orgId: rec.org_id,
      realPath: outPath,
      externalId: rec.external_id,
      versionNumber: rec.version_number,
    });

    expect(await findByPath(cacheDir, rec.base_url, rec.org_id, outPath)).toEqual({
      external_id: 'ext-1',
      version_number: 3,
    });
    // Wrong org namespace → no hit.
    expect(await findByPath(cacheDir, rec.base_url, 'other-org', outPath)).toBeNull();
  });

  it('findByPath returns null for a moved/deleted file (path-resilience)', async () => {
    const outPath = path.join(root, 'gone.md');
    await writeFile(outPath, 'x', 'utf8');
    const rec = mkRecord({ body: 'x' });
    await writePullCacheRecord(cacheDir, rec);
    // Pointer written while the file exists, then the file is removed: findByPath
    // realpaths the (now-absent) query and degrades to null — the record stays.
    await writePullCachePathPointer(cacheDir, {
      baseUrl: rec.base_url,
      orgId: rec.org_id,
      realPath: outPath,
      externalId: rec.external_id,
      versionNumber: rec.version_number,
    });
    await rm(outPath);
    expect(await findByPath(cacheDir, rec.base_url, rec.org_id, outPath)).toBeNull();
  });

  it('keeps the by-id record durable even when the by-path pointer is skipped', async () => {
    // A `plan pull --out` whose file write failed: the by-id record is written,
    // the pointer call is skipped — the cloud:<id>@<n> pin must still resolve.
    const rec = mkRecord();
    await writePullCacheRecord(cacheDir, rec);
    expect(
      await readPullCacheRecord(cacheDir, rec.base_url, rec.org_id, 'ext-1', 3)
    ).not.toBeNull();
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 3)).toHaveLength(1);
    // No pointer was ever written → findByPath has nothing to resolve.
    expect(
      await findByPath(cacheDir, rec.base_url, rec.org_id, '/out/never/written.md')
    ).toBeNull();
  });

  it('writePullCachePathPointer no-ops (null) when the --out file is absent', async () => {
    const res = await writePullCachePathPointer(cacheDir, {
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      realPath: path.join(root, 'never-written.md'),
      externalId: 'ext-1',
      versionNumber: 3,
    });
    expect(res).toBeNull();
  });

  it('namespace is stable across trailing-slash / case base_url variants', async () => {
    await writePullCacheRecord(cacheDir, mkRecord({ base_url: 'https://Cloud.Example' }));
    // Read back under a lowercased, trailing-slash variant — same namespace.
    const read = await readPullCacheRecord(cacheDir, 'https://cloud.example/', 'org_1', 'ext-1', 3);
    expect(read?.body).toBe('# Plan\n\nfull plan body');
    // A single namespace, not two forks.
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 3)).toHaveLength(1);
  });

  it('does not scan the sibling uploads/ subtree as a pull namespace', async () => {
    await writePullCacheRecord(cacheDir, mkRecord());
    // Plant a record-shaped decoy under uploads/by-id/<same target name>. A
    // scan that iterated cacheDir directly would surface this as a second
    // "namespace" match; the pull/-scoped scan must ignore it.
    const target = `${sha('ext-1')}@3.json`;
    const decoy = mkRecord({ org_id: 'decoy-org', body: 'decoy' });
    await mkdir(path.join(cacheDir, 'uploads', 'by-id'), { recursive: true });
    await writeFile(
      path.join(cacheDir, 'uploads', 'by-id', target),
      JSON.stringify(decoy, null, 2),
      'utf8'
    );
    const matches = await scanByExternalIdVersion(cacheDir, 'ext-1', 3);
    expect(matches).toHaveLength(1);
    expect(matches[0].record.org_id).toBe('org_1');
  });

  it('overwrites a record on re-pull (same key, deterministic path)', async () => {
    await writePullCacheRecord(cacheDir, mkRecord({ title: 'v1', body: 'one' }));
    await writePullCacheRecord(cacheDir, mkRecord({ title: 'v2', body: 'two' }));
    const matches = await scanByExternalIdVersion(cacheDir, 'ext-1', 3);
    expect(matches).toHaveLength(1);
    expect(matches[0].record.title).toBe('v2');
  });

  it('uses distinct staging files for concurrent writes in the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const writes = await Promise.all([
      writePullCacheRecord(cacheDir, mkRecord({ title: 'first', body: 'first body' })),
      writePullCacheRecord(cacheDir, mkRecord({ title: 'second', body: 'second body' })),
    ]).finally(() => now.mockRestore());

    const stored = await readPullCacheRecord(
      cacheDir,
      'https://cloud.example',
      'org_1',
      'ext-1',
      3
    );
    expect(['first', 'second']).toContain(stored?.title);
    expect(
      (await readdir(path.dirname(writes[0]!.recordPath))).filter((entry) =>
        entry.includes('.tmp.')
      )
    ).toEqual([]);
  });

  it('creates distinct staging paths when the clock does not advance', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const recordPath = path.join(cacheDir, 'record.json');
      expect(pullCacheTemporaryPath(recordPath)).not.toBe(pullCacheTemporaryPath(recordPath));
    } finally {
      now.mockRestore();
    }
  });

  it('refuses an ancestor cache symlink before reading or writing outside the repository', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cache-outside-'));
    try {
      const redirected = path.join(root, '.orcaops', 'cache', 'source-plan');
      await mkdir(path.dirname(redirected), { recursive: true });
      await symlink(outside, redirected);

      await expect(writePullCacheRecord(redirected, mkRecord(), root)).rejects.toThrow(
        /must not contain symlinks/
      );
      await expect(
        readPullCacheRecord(redirected, 'https://cloud.example', 'org_1', 'ext-1', 3, root)
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a final record symlink without reading or replacing its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cache-outside-'));
    try {
      const rec = mkRecord();
      const { recordPath } = await writePullCacheRecord(cacheDir, rec, root);
      const external = path.join(outside, 'record.json');
      const externalRecord = mkRecord({
        title: 'External poison',
        body: 'valid but external cache bytes',
      });
      const externalBytes = `${JSON.stringify(externalRecord, null, 2)}\n`;
      await writeFile(external, externalBytes, 'utf8');
      await unlink(recordPath);
      await symlink(external, recordPath);

      await expect(
        readPullCacheRecord(
          cacheDir,
          rec.base_url,
          rec.org_id,
          rec.external_id,
          rec.version_number,
          root
        )
      ).rejects.toThrow(/must not contain symlinks/);
      await expect(writePullCacheRecord(cacheDir, rec, root)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe(externalBytes);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a final path-pointer symlink without reading or replacing its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cache-outside-'));
    try {
      const outPath = path.join(root, 'plan.md');
      await writeFile(outPath, 'plan', 'utf8');
      const args = {
        baseUrl: 'https://cloud.example',
        orgId: 'org_1',
        realPath: outPath,
        externalId: 'ext-1',
        versionNumber: 3,
      };
      const written = await writePullCachePathPointer(cacheDir, args, root);
      expect(written).not.toBeNull();
      const external = path.join(outside, 'pointer.json');
      await writeFile(external, 'external sentinel', 'utf8');
      await unlink(written!.pathPointerPath);
      await symlink(external, written!.pathPointerPath);

      await expect(findByPath(cacheDir, args.baseUrl, args.orgId, outPath, root)).rejects.toThrow(
        /must not contain symlinks/
      );
      await expect(writePullCachePathPointer(cacheDir, args, root)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe('external sentinel');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
