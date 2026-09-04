import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGit } from './git.js';
import { observeReviewExecutableIdentity } from './runtimeIdentity.js';

let root: string;

async function writeRuntimePackage(packageRoot: string): Promise<void> {
  const dependency = path.join(packageRoot, 'node_modules', '@orcaops', 'review-engine');
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await mkdir(path.join(dependency, 'dist'), { recursive: true });
  await writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@orcaops/cli',
      version: '1.2.3',
      dependencies: { '@orcaops/review-engine': 'workspace:*' },
    })
  );
  await writeFile(path.join(packageRoot, 'entry.js'), 'export {};\n');
  await writeFile(path.join(packageRoot, 'dist', 'runtime.js'), 'export const runtime = 1;\n');
  await writeFile(
    path.join(dependency, 'package.json'),
    JSON.stringify({ name: '@orcaops/review-engine', version: '1.2.3' })
  );
  await writeFile(path.join(dependency, 'dist', 'review.js'), 'export const reviewRuntime = 1;\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-runtime-identity-'));
  await writeRuntimePackage(root);
  expect((await runGit(root, ['init'])).code).toBe(0);
  expect(
    (
      await runGit(root, [
        'add',
        'package.json',
        'entry.js',
        'dist/runtime.js',
        'node_modules/@orcaops/review-engine/package.json',
        'node_modules/@orcaops/review-engine/dist/review.js',
      ])
    ).code
  ).toBe(0);
  expect(
    (
      await runGit(root, ['commit', '-m', 'fixture'], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Orcaops Test',
          GIT_AUTHOR_EMAIL: 'test@orcaops.local',
          GIT_COMMITTER_NAME: 'Orcaops Test',
          GIT_COMMITTER_EMAIL: 'test@orcaops.local',
        },
      })
    ).code
  ).toBe(0);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('review executable identity', () => {
  it('uses tracked workspace provenance and reports dirty state without inventing a timestamp', async () => {
    const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
    const clean = await observeReviewExecutableIdentity({
      packageRoot: root,
      entrypointPath: path.join(root, 'entry.js'),
    });
    expect(clean).toMatchObject({
      packageName: '@orcaops/cli',
      packageVersion: '1.2.3',
      packageRoot: root,
      packageLinkTarget: await realpath(root),
      buildCommit: head,
      buildTimestamp: null,
      buildDirty: false,
      entrypointSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      compiledRuntimeManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await writeFile(path.join(root, 'entry.js'), 'export const dirty = true;\n');
    const dirty = await observeReviewExecutableIdentity({
      packageRoot: root,
      entrypointPath: path.join(root, 'entry.js'),
    });
    expect(dirty).toMatchObject({ buildCommit: head, buildDirty: true });
    expect(dirty.entrypointSha256).not.toBe(clean.entrypointSha256);
    expect(dirty.runtimeFingerprintSha256).not.toBe(clean.runtimeFingerprintSha256);
  });

  it('rejects a malformed build timestamp at observation, not at every later read', async () => {
    const descriptor = { packageRoot: root, entrypointPath: path.join(root, 'entry.js') };
    // An offset-bearing stamp (git %cI shape) fails the identity contract
    // (`z.iso.datetime()` accepts only Z); it must fail HERE, at the
    // stamp, instead of minting run files every strict read rejects.
    await expect(
      observeReviewExecutableIdentity(descriptor, {
        ...process.env,
        ORCAOPS_BUILD_TIMESTAMP: '2026-08-06T12:00:00+02:00',
      })
    ).rejects.toThrow(/buildTimestamp/);

    const valid = await observeReviewExecutableIdentity(descriptor, {
      ...process.env,
      ORCAOPS_BUILD_TIMESTAMP: '2026-08-06T12:00:00.000Z',
    });
    expect(valid.buildTimestamp).toBe('2026-08-06T12:00:00.000Z');
  });

  it('changes identity when compiled runtime closure bytes change with a stable entrypoint', async () => {
    const descriptor = { packageRoot: root, entrypointPath: path.join(root, 'entry.js') };
    const clean = await observeReviewExecutableIdentity(descriptor, {
      ...process.env,
      ORCAOPS_BUILD_DIRTY: 'false',
    });

    await writeFile(path.join(root, 'dist', 'runtime.js'), 'export const runtime = 2;\n');
    const rootChanged = await observeReviewExecutableIdentity(descriptor, {
      ...process.env,
      ORCAOPS_BUILD_DIRTY: 'false',
    });
    expect(rootChanged.entrypointSha256).toBe(clean.entrypointSha256);
    expect(rootChanged.compiledRuntimeManifestSha256).not.toBe(clean.compiledRuntimeManifestSha256);
    expect(rootChanged.runtimeFingerprintSha256).not.toBe(clean.runtimeFingerprintSha256);

    await writeFile(path.join(root, 'dist', 'runtime.js'), 'export const runtime = 1;\n');
    await writeFile(
      path.join(root, 'node_modules', '@orcaops', 'review-engine', 'dist', 'review.js'),
      'export const reviewRuntime = 2;\n'
    );
    const dependencyChanged = await observeReviewExecutableIdentity(descriptor, {
      ...process.env,
      ORCAOPS_BUILD_DIRTY: 'false',
    });
    expect(dependencyChanged.entrypointSha256).toBe(clean.entrypointSha256);
    expect(dependencyChanged.compiledRuntimeManifestSha256).not.toBe(
      clean.compiledRuntimeManifestSha256
    );
    expect(dependencyChanged.runtimeFingerprintSha256).not.toBe(clean.runtimeFingerprintSha256);
  });

  it('ignores the Watch UI platform package npm picked for this host', async () => {
    const descriptor = { packageRoot: root, entrypointPath: path.join(root, 'entry.js') };
    const env = { ...process.env, ORCAOPS_BUILD_DIRTY: 'false' };
    const before = await observeReviewExecutableIdentity(descriptor, env);

    // The four platform packages are os/cpu-filtered optionals; exactly one
    // installs per host, so hashing it would make the same release fingerprint
    // differently on a mac and on linux.
    const platform = path.join(root, 'node_modules', '@orcaops', 'watch-darwin-arm64');
    await mkdir(path.join(platform, 'bin'), { recursive: true });
    await mkdir(path.join(platform, 'dist'), { recursive: true });
    await writeFile(
      path.join(platform, 'package.json'),
      JSON.stringify({
        name: '@orcaops/watch-darwin-arm64',
        version: '1.2.3',
        os: ['darwin'],
        cpu: ['arm64'],
        orcaopsWatch: { exe: 'bin/orcaops-watch-ui', bun: '1.4.0', target: 'bun-darwin-arm64' },
      })
    );
    await writeFile(path.join(platform, 'bin', 'orcaops-watch-ui'), 'not really an executable\n');
    await writeFile(path.join(platform, 'dist', 'stray.js'), 'export const stray = 1;\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@orcaops/cli',
        version: '1.2.3',
        dependencies: { '@orcaops/review-engine': 'workspace:*' },
        optionalDependencies: { '@orcaops/watch-darwin-arm64': '1.2.3' },
      })
    );
    const withPlatform = await observeReviewExecutableIdentity(descriptor, env);
    expect(withPlatform.compiledRuntimeManifestSha256).toBe(before.compiledRuntimeManifestSha256);

    // Control: an ordinary @orcaops optional dependency with compiled files
    // still enters the manifest.
    const plain = path.join(root, 'node_modules', '@orcaops', 'keyring-shim');
    await mkdir(path.join(plain, 'dist'), { recursive: true });
    await writeFile(
      path.join(plain, 'package.json'),
      JSON.stringify({ name: '@orcaops/keyring-shim', version: '1.2.3' })
    );
    await writeFile(path.join(plain, 'dist', 'index.js'), 'export const shim = 1;\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@orcaops/cli',
        version: '1.2.3',
        dependencies: { '@orcaops/review-engine': 'workspace:*' },
        optionalDependencies: {
          '@orcaops/watch-darwin-arm64': '1.2.3',
          '@orcaops/keyring-shim': '1.2.3',
        },
      })
    );
    const withPlain = await observeReviewExecutableIdentity(descriptor, env);
    expect(withPlain.compiledRuntimeManifestSha256).not.toBe(before.compiledRuntimeManifestSha256);
  });

  it('uses content and build provenance rather than the diagnostic entrypoint path', async () => {
    const alternate = path.join(root, 'alternate-entry.js');
    await writeFile(alternate, 'export {};\n');
    const original = await observeReviewExecutableIdentity(
      { packageRoot: root, entrypointPath: path.join(root, 'entry.js') },
      { ...process.env, ORCAOPS_BUILD_DIRTY: 'false' }
    );
    const relocated = await observeReviewExecutableIdentity(
      { packageRoot: root, entrypointPath: alternate },
      { ...process.env, ORCAOPS_BUILD_DIRTY: 'false' }
    );
    expect(relocated.entrypointPath).not.toBe(original.entrypointPath);
    expect(relocated.entrypointSha256).toBe(original.entrypointSha256);
    expect(relocated.compiledRuntimeManifestSha256).toBe(original.compiledRuntimeManifestSha256);
    expect(relocated.runtimeFingerprintSha256).toBe(original.runtimeFingerprintSha256);
  });

  it('keeps the compiled runtime identity stable across equivalent installation paths', async () => {
    const relocatedRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-runtime-relocated-'));
    try {
      await writeRuntimePackage(relocatedRoot);
      const env = {
        ...process.env,
        ORCAOPS_BUILD_COMMIT: 'fixed-build',
        ORCAOPS_BUILD_DIRTY: 'false',
      };
      const original = await observeReviewExecutableIdentity(
        { packageRoot: root, entrypointPath: path.join(root, 'entry.js') },
        env
      );
      const relocated = await observeReviewExecutableIdentity(
        {
          packageRoot: relocatedRoot,
          entrypointPath: path.join(relocatedRoot, 'entry.js'),
        },
        env
      );
      expect(relocated.packageRoot).not.toBe(original.packageRoot);
      expect(relocated.compiledRuntimeManifestSha256).toBe(original.compiledRuntimeManifestSha256);
      expect(relocated.runtimeFingerprintSha256).toBe(original.runtimeFingerprintSha256);
    } finally {
      await rm(relocatedRoot, { recursive: true, force: true });
    }
  });

  it('does not borrow a consuming repository commit for an untracked installed package', async () => {
    const installed = path.join(root, 'node_modules', '@orcaops', 'cli');
    await mkdir(installed, { recursive: true });
    await writeFile(
      path.join(installed, 'package.json'),
      JSON.stringify({ name: '@orcaops/cli', version: '9.9.9' })
    );
    await writeFile(path.join(installed, 'entry.js'), 'export {};\n');
    const identity = await observeReviewExecutableIdentity({
      packageRoot: installed,
      entrypointPath: path.join(installed, 'entry.js'),
    });
    expect(identity).toMatchObject({
      packageName: '@orcaops/cli',
      packageVersion: '9.9.9',
      buildCommit: null,
      buildTimestamp: null,
      buildDirty: null,
    });
  });
});
