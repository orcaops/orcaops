import { describe, expect, it } from 'vitest';

import {
  assertUsableSha,
  dependencyFilesChanged,
  isAllZeroSha,
  isDependencyInput,
} from './dependency-files-changed.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ALL_ZERO = '0'.repeat(40);

/** git diff --name-only -z emits NUL-terminated paths. */
const nulDelimited = (...files) => files.map((f) => `${f}\0`).join('');
const detect = (files, over = {}) =>
  dependencyFilesChanged({
    base: BASE,
    head: HEAD,
    runGitDiff: () => nulDelimited(...files),
    ...over,
  });

describe('dependency-input path classes', () => {
  it.each([
    ['the root manifest', 'package.json'],
    ['a workspace manifest', 'apps/orcaops-cli/package.json'],
    ['a deeply nested manifest', 'packages/a/b/c/package.json'],
    ['the lockfile', 'pnpm-lock.yaml'],
    ['the workspace file', 'pnpm-workspace.yaml'],
    ['the dependency policy', 'config/dependency-policy.json'],
    ['a root npmrc', '.npmrc'],
    ['a workspace npmrc', 'packages/storage/.npmrc'],
    ['a dotted pnpmfile', '.pnpmfile.cjs'],
    ['an undotted pnpmfile', 'pnpmfile.cjs'],
    ['a root patch', 'patches/some-package@1.0.0.patch'],
    ['a nested patch', 'packages/storage/patches/thing.patch'],
    ['a vendored tarball', 'vendor/orcaops-sdk-0.1.15.tgz'],
    ['a nested vendored file', 'apps/docs/vendor/lib.js'],
  ])('recognizes %s', (_label, filePath) => {
    expect(isDependencyInput(filePath)).toBe(true);
  });

  it.each([
    ['ordinary source', 'packages/core/src/index.ts'],
    ['a test', 'packages/core/src/index.test.ts'],
    ['documentation', 'docs/dependency-policy.md'],
    ['a workflow', '.github/workflows/ci.yml'],
    ['the Dependabot config', '.github/dependabot.yml'],
    ['a lookalike suffix', 'package.json.bak'],
    ['a lookalike prefix', 'my-package.json'],
    ['a file merely named vendor', 'src/vendor.ts'],
    ['a file merely named patches', 'docs/patches.md'],
    ['the empty string', ''],
  ])('ignores %s', (_label, filePath) => {
    expect(isDependencyInput(filePath)).toBe(false);
  });

  it('recognizes a manifest whose directory contains spaces', () => {
    expect(isDependencyInput('some dir/with spaces/package.json')).toBe(true);
  });
});

describe('detecting a changed range', () => {
  it('reports changed when a dependency input is touched', () => {
    const { changed, files } = detect(['README.md', 'pnpm-lock.yaml']);
    expect(changed).toBe(true);
    expect(files).toEqual(['pnpm-lock.yaml']);
  });

  it('reports unchanged when nothing relevant is touched', () => {
    const { changed, files } = detect(['README.md', 'packages/core/src/index.ts']);
    expect(changed).toBe(false);
    expect(files).toEqual([]);
  });

  it('reports unchanged for an empty diff', () => {
    expect(dependencyFilesChanged({ base: BASE, head: HEAD, runGitDiff: () => '' }).changed).toBe(
      false
    );
  });

  it('preserves filenames containing spaces', () => {
    const { changed, files } = detect(['some dir/with spaces/package.json']);
    expect(changed).toBe(true);
    expect(files).toEqual(['some dir/with spaces/package.json']);
  });

  it('keeps a filename containing a newline in one piece', () => {
    // The whole point of -z: git's default output would quote and escape this,
    // and a line-split would see two bogus paths.
    const { changed, files } = detect(['weird\nname/package.json']);
    expect(changed).toBe(true);
    expect(files).toEqual(['weird\nname/package.json']);
  });

  it('lists every matched input in the reason', () => {
    const { reason } = detect(['package.json', 'pnpm-lock.yaml', 'src/a.ts']);
    expect(reason).toMatch(/package\.json/);
    expect(reason).toMatch(/pnpm-lock\.yaml/);
    expect(reason).not.toMatch(/src\/a\.ts/);
  });
});

describe('a branch-creation push', () => {
  it('audits unconditionally on an all-zero base without diffing', () => {
    let called = false;
    const { changed, reason } = dependencyFilesChanged({
      base: ALL_ZERO,
      head: HEAD,
      runGitDiff: () => {
        called = true;
        return '';
      },
    });
    expect(changed).toBe(true);
    expect(called).toBe(false);
    expect(reason).toMatch(/branch creation/);
  });

  it.each([['0'.repeat(40)], ['0'.repeat(7)]])('recognizes %s as an all-zero base', (sha) => {
    expect(isAllZeroSha(sha)).toBe(true);
  });

  it.each([[BASE], [''], ['0'], [undefined]])('does not mistake %s for an all-zero base', (sha) => {
    expect(isAllZeroSha(sha)).toBe(false);
  });
});

describe('comparison SHA validation', () => {
  it.each([
    ['an absent value', undefined],
    ['an empty string', ''],
    ['a short value', 'abc123'],
    ['a non-hex value', 'z'.repeat(40)],
    ['a ref name', 'refs/heads/main'],
    ['an over-long value', 'a'.repeat(41)],
  ])('rejects %s', (_label, sha) => {
    expect(() => assertUsableSha(sha, 'base')).toThrow(/base/);
  });

  it.each([
    ['a full SHA', BASE],
    ['a short SHA', 'abc1234'],
    ['an uppercase SHA', 'A'.repeat(40)],
  ])('accepts %s', (_label, sha) => {
    expect(() => assertUsableSha(sha, 'head')).not.toThrow();
  });

  it('rejects a malformed base before running git', () => {
    expect(() =>
      dependencyFilesChanged({
        base: 'nonsense',
        head: HEAD,
        runGitDiff: () => {
          throw new Error('git should not have run');
        },
      })
    ).toThrow(/Malformed base commit/);
  });

  it('rejects a malformed head before running git', () => {
    expect(() => dependencyFilesChanged({ base: BASE, head: '', runGitDiff: () => '' })).toThrow(
      /Missing head commit/
    );
  });
});
