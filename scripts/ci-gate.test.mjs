import { describe, expect, it } from 'vitest';

import { ciGate, FULL_MATRIX_LABEL, gateOutputs, isPackagingInput } from './ci-gate.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const nulDelimited = (...files) => files.map((f) => `${f}\0`).join('');
const gatePr = (files, over = {}) =>
  ciGate({
    event: 'pull_request',
    base: BASE,
    head: HEAD,
    labels: [],
    runGitDiff: () => nulDelimited(...files),
    ...over,
  });

describe('packaging inputs', () => {
  it.each([
    ['a workspace manifest', 'apps/orcaops-cli/package.json'],
    ['the lockfile', 'pnpm-lock.yaml'],
    ['a vendored tarball', 'vendor/orcaops-sdk-0.1.15.tgz'],
    ['the Bun pin', '.bun-version'],
    ['the Node pin', '.nvmrc'],
    ['the Watch platform list', 'apps/orcaops-watch/platforms.json'],
    ['the Watch compile script', 'apps/orcaops-watch/scripts/compile.ts'],
    ['the CLI dist builder', 'scripts/build-cli-dist.mjs'],
    ['the platform package stager', 'scripts/build-watch-platforms.mjs'],
    ['the install loop', 'scripts/install-loop.mjs'],
    ['a shared release helper', 'scripts/lib/release-staging.mjs'],
  ])('recognizes %s', (_label, filePath) => {
    expect(isPackagingInput(filePath)).toBe(true);
  });

  it.each([
    ['CLI source', 'apps/orcaops-cli/src/commands/doctor.ts'],
    ['Watch UI source', 'apps/orcaops-watch/src/app.tsx'],
    ['a Watch benchmark script', 'apps/orcaops-watch/scripts/review-performance.ts'],
    ['docs', 'apps/docs/guide/index.md'],
    ['an unrelated root script', 'scripts/check-public-content.mjs'],
  ])('ignores %s', (_label, filePath) => {
    expect(isPackagingInput(filePath)).toBe(false);
  });
});

describe('ciGate', () => {
  it.each(['push', 'workflow_dispatch', 'schedule'])('runs the full matrix on %s', (event) => {
    const runGitDiff = () => {
      throw new Error('a non-PR event must not diff');
    };
    expect(ciGate({ event, base: '', head: HEAD, runGitDiff }).fullMatrix).toBe(true);
  });

  it('runs Linux only for a pull request that touches no packaging input', () => {
    const result = gatePr(['apps/orcaops-cli/src/commands/doctor.ts', 'README.md']);
    expect(result.fullMatrix).toBe(false);
    expect(result.reason).toContain('2 changed file(s)');
  });

  it('runs the full matrix for a pull request that touches a packaging input', () => {
    const result = gatePr(['apps/orcaops-cli/src/index.ts', 'scripts/install-loop.mjs']);
    expect(result).toEqual({
      fullMatrix: true,
      reason: 'packaging inputs changed: scripts/install-loop.mjs',
    });
  });

  it('runs the full matrix for a pull request carrying the label', () => {
    expect(gatePr(['README.md'], { labels: ['bug', FULL_MATRIX_LABEL] }).fullMatrix).toBe(true);
  });

  it('runs the full matrix when a pull request has no comparison base', () => {
    expect(gatePr(['README.md'], { base: '' }).fullMatrix).toBe(true);
    expect(gatePr(['README.md'], { base: '0'.repeat(40) }).fullMatrix).toBe(true);
  });

  it('rejects a malformed base rather than guessing', () => {
    expect(() => gatePr(['README.md'], { base: 'not-a-sha' })).toThrow(/Malformed base/);
  });
});

describe('gateOutputs', () => {
  it('compiles on Linux and smokes only Linux legs for the reduced matrix', () => {
    const outputs = gateOutputs(false);
    expect(outputs['full-matrix']).toBe('false');
    expect(outputs['compile-runner']).toBe('ubuntu-latest');
    const { include } = JSON.parse(outputs['smoke-matrix']);
    expect(include.map((leg) => leg.os)).toEqual(['ubuntu-latest', 'ubuntu-latest']);
    expect(include.map((leg) => leg.node)).toEqual([22, 24]);
  });

  it('compiles on a Mac and smokes every supported host for the full matrix', () => {
    const outputs = gateOutputs(true);
    expect(outputs['compile-runner']).toBe('macos-15');
    const legs = JSON.parse(outputs['smoke-matrix']).include.map((leg) => `${leg.os}/${leg.node}`);
    expect(legs.sort()).toEqual(
      [
        'macos-15-intel/22',
        'macos-15/22',
        'macos-15/24',
        'ubuntu-24.04-arm/22',
        'ubuntu-latest/22',
        'ubuntu-latest/24',
      ].sort()
    );
  });
});
