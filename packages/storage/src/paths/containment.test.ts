import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertCanonicalRelativePath,
  assertResolvedWithin,
  assertSafePathSegment,
  assertSafeRelativePath,
  isDanglingFinalSymlink,
  PathContainmentError,
  resolveCanonicalPath,
} from './containment.js';

describe('assertSafePathSegment', () => {
  it('accepts single segments including UUIDs and prefixed ids', () => {
    expect(assertSafePathSegment('019fc013-a305-7ff1-8125-057d164d975d', 'id')).toBeTruthy();
    expect(assertSafePathSegment('fixture-abc', 'id')).toBe('fixture-abc');
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', '../x', '/abs', 'a\0b'])('rejects %j', (bad) => {
    expect(() => assertSafePathSegment(bad, 'id')).toThrow(PathContainmentError);
  });
});

describe('assertSafeRelativePath', () => {
  it('accepts normal repo-relative paths', () => {
    expect(assertSafeRelativePath('.orcaops/artifacts', 'p')).toBe('.orcaops/artifacts');
    expect(assertSafeRelativePath('nested/deep/dir', 'p')).toBe('nested/deep/dir');
  });

  it.each([
    '/abs/path',
    'C:\\absolute\\path',
    '\\\\server\\share\\path',
    '../out',
    'a/../../b',
    '..',
    '',
  ])('rejects %j', (bad) => {
    expect(() => assertSafeRelativePath(bad, 'p')).toThrow(PathContainmentError);
  });
});

describe('assertCanonicalRelativePath', () => {
  it('accepts direct repo-relative paths with either portable separator', () => {
    expect(assertCanonicalRelativePath('.orcaops/artifacts', 'p')).toBe('.orcaops/artifacts');
    expect(assertCanonicalRelativePath('nested\\deep\\file', 'p')).toBe('nested\\deep\\file');
  });

  it.each(['nested/../victim', './victim', 'nested//victim', 'nested/', 'nested\\..\\victim'])(
    'rejects %j',
    (bad) => {
      expect(() => assertCanonicalRelativePath(bad, 'p')).toThrow(PathContainmentError);
    }
  );
});

describe('isDanglingFinalSymlink', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-dangling-link-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('distinguishes a dangling final link from a live link and ordinary absence', async () => {
    const target = path.join(root, 'target');
    const live = path.join(root, 'live');
    const dangling = path.join(root, 'dangling');
    await writeFile(target, 'data', 'utf8');
    await symlink(target, live);
    await symlink(path.join(root, 'missing'), dangling);

    expect(isDanglingFinalSymlink(dangling)).toBe(true);
    expect(isDanglingFinalSymlink(live)).toBe(false);
    expect(isDanglingFinalSymlink(path.join(root, 'absent'))).toBe(false);
  });
});

describe('resolveCanonicalPath', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-canonical-root-'));
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-canonical-out-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('returns the resolved target rather than a mutable symlink spelling', async () => {
    const alias = path.join(root, 'alias');
    await symlink(outside, alias);
    expect(resolveCanonicalPath(path.join(alias, 'future'), 'target')).toBe(
      path.join(await realpath(outside), 'future')
    );
  });

  it('refuses a dangling symlink instead of treating it as an absent suffix', async () => {
    const alias = path.join(root, 'alias');
    await symlink(path.join(outside, 'missing'), alias);
    expect(() => resolveCanonicalPath(alias, 'target')).toThrow(/could not be resolved/);
  });
});

describe('assertResolvedWithin (symlink-aware)', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-contain-root-'));
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-contain-out-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('accepts targets beneath the root, existing or not-yet-created', async () => {
    await mkdir(path.join(root, 'a'));
    expect(assertResolvedWithin(path.join(root, 'a'), root, 't')).toBe(
      assertResolvedWithin(path.join(root, 'a'), root, 't')
    );
    // not-yet-existing suffix still resolves inside
    expect(assertResolvedWithin(path.join(root, 'a', 'new', 'leaf'), root, 't')).toContain(root);
  });

  it('rejects equality with the root unless allowed', () => {
    expect(() => assertResolvedWithin(root, root, 't')).toThrow(/containment root itself/);
    expect(assertResolvedWithin(root, root, 't', { allowRoot: true })).toBeTruthy();
  });

  it('rejects plain upward traversal', () => {
    expect(() => assertResolvedWithin(path.join(root, '..', 'x'), root, 't')).toThrow(
      PathContainmentError
    );
  });

  it('refuses an in-root symlink that points outside (configured-path shape)', async () => {
    await symlink(outside, path.join(root, 'link'));
    expect(() => assertResolvedWithin(path.join(root, 'link', 'file'), root, 't')).toThrow(
      /resolves outside/
    );
  });

  it('refuses a target whose ancestor was replaced by a symlink', async () => {
    await mkdir(path.join(root, 'dir'));
    await rm(path.join(root, 'dir'), { recursive: true });
    await symlink(outside, path.join(root, 'dir'));
    expect(() => assertResolvedWithin(path.join(root, 'dir', 'artifacts', 'x'), root, 't')).toThrow(
      /resolves outside/
    );
  });

  it('refuses a dangling symlink instead of treating it as an uncreated suffix', async () => {
    await symlink(path.join(outside, 'future-file'), path.join(root, 'dangling'));
    expect(() => assertResolvedWithin(path.join(root, 'dangling'), root, 't')).toThrow(
      /could not be resolved/
    );
  });

  it('refuses a deletion target that IS a symlink resolving outside', async () => {
    await writeFile(path.join(outside, 'victim.txt'), 'data', 'utf8');
    await symlink(path.join(outside, 'victim.txt'), path.join(root, 'doomed'));
    expect(() => assertResolvedWithin(path.join(root, 'doomed'), root, 't')).toThrow(
      /resolves outside/
    );
  });

  it('still accepts an in-root symlink that resolves inside the root', async () => {
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    expect(assertResolvedWithin(path.join(root, 'alias', 'f'), root, 't')).toContain('real');
  });

  it('can reject even an in-root symlink for managed storage paths', async () => {
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    expect(() =>
      assertResolvedWithin(path.join(root, 'alias', 'f'), root, 't', {
        rejectSymlinks: true,
      })
    ).toThrow(/must not contain symlinks/);
  });
});
