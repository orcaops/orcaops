import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ExecutableIdentity, executableIdentitySchema } from '@orcaops/review-core';

import { runGit } from './git.js';

export interface ReviewRuntimeDescriptor {
  /** Root of the package that owns the invoked review entrypoint. */
  packageRoot: string;
  /** The user-visible CLI or sidecar entrypoint, before realpath resolution when available. */
  entrypointPath: string;
}

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  orcaopsBuild?: { commit?: unknown; timestamp?: unknown; dirty?: unknown };
}

interface RuntimePackageManifest {
  name: string;
  version: string;
  files: Array<{ path: string; sha256: string }>;
}

const ENGINE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultReviewRuntimeDescriptor(): ReviewRuntimeDescriptor {
  return {
    packageRoot: ENGINE_PACKAGE_ROOT,
    entrypointPath: process.argv[1] ?? fileURLToPath(import.meta.url),
  };
}

export async function reviewRuntimeDescriptorFromModule(
  moduleUrl: string,
  entrypointPath = process.argv[1] ?? fileURLToPath(moduleUrl)
): Promise<ReviewRuntimeDescriptor> {
  let candidate = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    try {
      await readFile(path.join(candidate, 'package.json'), 'utf8');
      return { packageRoot: candidate, entrypointPath };
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return { packageRoot: candidate, entrypointPath };
      candidate = parent;
    }
  }
}

async function packageMetadata(packageRoot: string): Promise<PackageMetadata> {
  try {
    return JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8')
    ) as PackageMetadata;
  } catch {
    return {};
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const WATCH_PLATFORM_PACKAGE = /^@orcaops\/watch-(darwin|linux)-(arm64|x64)$/;

function isWatchPlatformPackage(metadata: PackageMetadata): boolean {
  return typeof metadata.name === 'string' && WATCH_PLATFORM_PACKAGE.test(metadata.name);
}

function dependencyNames(metadata: PackageMetadata): string[] {
  const names = new Set<string>();
  for (const collection of [
    metadata.dependencies,
    metadata.optionalDependencies,
    metadata.peerDependencies,
  ]) {
    if (typeof collection !== 'object' || collection === null || Array.isArray(collection))
      continue;
    for (const name of Object.keys(collection)) if (name.startsWith('@orcaops/')) names.add(name);
  }
  return [...names].sort(codePointCompare);
}

function isCompiledRuntimeFile(file: string): boolean {
  return ['.js', '.mjs', '.cjs', '.json', '.node', '.wasm'].includes(path.extname(file));
}

async function compiledFiles(
  packageRoot: string
): Promise<Array<{ path: string; sha256: string }>> {
  const distRoot = path.join(packageRoot, 'dist');
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && isCompiledRuntimeFile(entry.name)) files.push(absolute);
    }
  };
  await visit(distRoot);
  files.sort((a, b) => codePointCompare(path.relative(distRoot, a), path.relative(distRoot, b)));
  return Promise.all(
    files.map(async (file) => ({
      path: path.relative(distRoot, file).split(path.sep).join('/'),
      sha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    }))
  );
}

/**
 * Hash the compiled files that can determine review behavior. Package names,
 * versions, relative dist paths, and bytes enter the manifest; installation
 * paths and dependency traversal order do not.
 */
async function compiledRuntimeManifestSha256(root: string): Promise<string> {
  const pending = [await realpath(root).catch(() => path.resolve(root))];
  const visited = new Set<string>();
  const packages: RuntimePackageManifest[] = [];

  while (pending.length > 0) {
    const packageRoot = pending.shift()!;
    if (visited.has(packageRoot)) continue;
    visited.add(packageRoot);
    const metadata = await packageMetadata(packageRoot);
    // A Watch UI platform package is an os/cpu-filtered optional dependency:
    // which one npm installed says where the CLI runs, not what review code
    // runs, and only one of the four ever exists on a host. Matched by name,
    // never by a manifest field a package could claim, and never for the root.
    if (packages.length > 0 && isWatchPlatformPackage(metadata)) continue;
    packages.push({
      name: nonEmpty(metadata.name) ?? 'unknown-package',
      version: nonEmpty(metadata.version) ?? 'unknown-version',
      files: await compiledFiles(packageRoot),
    });
    for (const dependency of dependencyNames(metadata)) {
      const dependencyRoot = await realpath(
        path.join(packageRoot, 'node_modules', dependency)
      ).catch(() => null);
      if (dependencyRoot !== null && !visited.has(dependencyRoot)) pending.push(dependencyRoot);
    }
  }

  packages.sort((a, b) => codePointCompare(`${a.name}\0${a.version}`, `${b.name}\0${b.version}`));
  return createHash('sha256')
    .update(JSON.stringify({ schema_version: 1, packages }))
    .digest('hex');
}

async function trackedWorkspaceIdentity(packageRoot: string): Promise<{
  commit: string | null;
  dirty: boolean | null;
}> {
  try {
    const topResult = await runGit(packageRoot, ['rev-parse', '--show-toplevel']);
    if (topResult.code !== 0) return { commit: null, dirty: null };
    const top = topResult.stdout.toString('utf8').trim();
    const packageFile = path.relative(top, path.join(packageRoot, 'package.json'));
    if (packageFile.startsWith('..') || path.isAbsolute(packageFile)) {
      return { commit: null, dirty: null };
    }
    // A package merely installed under another repository must never inherit
    // the consuming repository's HEAD as its own build identity.
    const tracked = await runGit(top, ['ls-files', '--error-unmatch', '--', packageFile]);
    if (tracked.code !== 0) return { commit: null, dirty: null };
    const commitResult = await runGit(top, ['rev-parse', 'HEAD']);
    const dirtyResult = await runGit(top, ['status', '--porcelain', '--untracked-files=no']);
    return {
      commit: commitResult.code === 0 ? nonEmpty(commitResult.stdout.toString('utf8')) : null,
      dirty: dirtyResult.code === 0 ? dirtyResult.stdout.length > 0 : null,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * Observe the executable that is serving this invocation. Unknown build facts
 * remain null; the observer never invents a release commit or timestamp.
 */
export async function observeReviewExecutableIdentity(
  descriptor: ReviewRuntimeDescriptor = defaultReviewRuntimeDescriptor(),
  env: NodeJS.ProcessEnv = process.env
): Promise<ExecutableIdentity> {
  const packageRoot = path.resolve(descriptor.packageRoot);
  const linkedTarget = await realpath(packageRoot).catch(() => packageRoot);
  const metadata = await packageMetadata(linkedTarget);
  const workspace = await trackedWorkspaceIdentity(linkedTarget);
  const build = metadata.orcaopsBuild;
  const buildCommit =
    nonEmpty(env.ORCAOPS_BUILD_COMMIT) ?? nonEmpty(build?.commit) ?? workspace.commit;
  const buildTimestamp =
    nonEmpty(env.ORCAOPS_BUILD_TIMESTAMP) ?? nonEmpty(build?.timestamp) ?? null;
  const buildDirty =
    booleanValue(env.ORCAOPS_BUILD_DIRTY) ?? booleanValue(build?.dirty) ?? workspace.dirty;
  const entrypointPath = path.resolve(descriptor.entrypointPath);
  const entrypointSha256 = await readFile(entrypointPath)
    .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
    .catch(() => null);
  const compiledManifestSha256 = await compiledRuntimeManifestSha256(linkedTarget);
  const runtimeFingerprintSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        packageName: nonEmpty(metadata.name) ?? 'unknown-package',
        packageVersion: nonEmpty(metadata.version) ?? 'unknown-version',
        sourceCommit: buildCommit,
        buildDirty,
        entrypointSha256,
        compiledRuntimeManifestSha256: compiledManifestSha256,
      })
    )
    .digest('hex');
  const identity: ExecutableIdentity = {
    executablePath: path.resolve(process.execPath),
    entrypointPath,
    packageName: nonEmpty(metadata.name) ?? 'unknown-package',
    packageVersion: nonEmpty(metadata.version) ?? 'unknown-version',
    packageRoot,
    packageLinkTarget: linkedTarget,
    buildCommit,
    buildTimestamp,
    buildDirty,
    entrypointSha256,
    compiledRuntimeManifestSha256: compiledManifestSha256,
    runtimeFingerprintSha256,
  };
  // Validate at observation so a malformed release stamp (e.g. an
  // offset-bearing ORCAOPS_BUILD_TIMESTAMP) fails HERE, at the stamp,
  // instead of minting run files every later strict read rejects.
  return executableIdentitySchema.parse(identity);
}
