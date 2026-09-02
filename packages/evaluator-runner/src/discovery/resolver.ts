import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackSource } from '@orcaops/evaluator-protocol';

import { EvaluatorDiscoveryError } from './errors.js';

export interface ResolverContext {
  /** Absolute path to the user's repository root. */
  repoRoot: string;
  /**
   * Absolute path the resolver uses as the dependency anchor for
   * `kind: bundled` packs — typically the @orcaops/cli install
   * directory so first-party packs resolve via the CLI's own
   * node_modules. Defaults to the runner's own location (which
   * itself is a workspace dep of the CLI), so callers that don't
   * know the CLI root still get a working resolution path.
   */
  cliRoot?: string;
}

export interface ResolvedPackSource {
  /** Echo of the source descriptor for debugging / lock metadata. */
  source: PackSource;
  /**
   * Absolute path to the resolved pack root. Spec engine.command
   * relative paths resolve against this; `loadPackage(pack_root)`
   * accepts this directly.
   */
  pack_root: string;
}

const DEFAULT_CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Resolve a `PackSource` descriptor to an absolute pack root.
 * Throws `EvaluatorDiscoveryError` on resolution failure (e.g.,
 * package not installed, path missing).
 */
export function resolvePackSource(source: PackSource, ctx: ResolverContext): ResolvedPackSource {
  switch (source.kind) {
    case 'bundled':
      return resolveBundled(source, ctx);
    case 'path':
      return resolvePath(source, ctx);
    case 'package':
      return resolvePackage(source, ctx);
  }
}

function resolveBundled(
  source: Extract<PackSource, { kind: 'bundled' }>,
  ctx: ResolverContext
): ResolvedPackSource {
  const cliRoot = ctx.cliRoot ?? DEFAULT_CLI_ROOT;
  const req = createRequire(path.join(cliRoot, 'package.json'));
  let packageJsonPath: string;
  try {
    packageJsonPath = req.resolve(`${source.package}/package.json`);
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: cliRoot,
      field_path: 'source.package',
      message:
        `bundled pack source could not resolve "${source.package}" from the CLI install ` +
        `at ${cliRoot}: ${(err as Error).message}. This usually means the CLI build is ` +
        `incomplete — first-party packs ship as a workspace dep of @orcaops/cli.`,
      cause: err,
    });
  }
  const packageRoot = path.dirname(packageJsonPath);
  return {
    source,
    pack_root: packRootFromPackage(packageRoot, source.pack),
  };
}

function resolvePath(
  source: Extract<PackSource, { kind: 'path' }>,
  ctx: ResolverContext
): ResolvedPackSource {
  const pack_root = path.isAbsolute(source.path)
    ? source.path
    : path.resolve(ctx.repoRoot, source.path);
  return { source, pack_root };
}

function resolvePackage(
  source: Extract<PackSource, { kind: 'package' }>,
  ctx: ResolverContext
): ResolvedPackSource {
  // Resolve from the user's project root. createRequire needs a file
  // anchor; package.json at the repo root is the conventional choice
  // even if absent (require.resolve only uses the anchor for paths,
  // not actual reads).
  const anchor = path.join(ctx.repoRoot, 'package.json');
  const req = createRequire(anchor);
  let packageJsonPath: string;
  try {
    packageJsonPath = req.resolve(`${source.package}/package.json`);
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: ctx.repoRoot,
      field_path: 'source.package',
      message:
        `pack source "${source.package}" is not installed in this project. ` +
        `Run \`pnpm add -D ${source.package}\` (or your package manager's equivalent) ` +
        `to install it before discovery. Original: ${(err as Error).message}`,
      cause: err,
    });
  }
  const packageRoot = path.dirname(packageJsonPath);
  return {
    source,
    pack_root: packRootFromPackage(packageRoot, source.pack),
  };
}

/**
 * Resolve a pack id to its subtree inside a package.
 * `@orcaops/evaluator-pack` ships packs under `dist/packs/<id>/` in
 * the published artifact. Tries the dist-first path; falls back to
 * the source-tree path (workspace
 * development without a build) so first-party packs work in-repo
 * without a published artifact.
 */
function packRootFromPackage(packageRoot: string, packId: string): string {
  // Production layout: dist/packs/<id>/ — the resolver sees the
  // published artifact's contents.
  const distPath = path.join(packageRoot, 'dist', 'packs', packId);
  // Workspace fallback: packs/<id>/ — useful while the package
  // hasn't been built yet (CI warm-up, fresh checkout). The runtime
  // will still need engine.command files to exist; this just lets
  // discovery succeed enough for tests to surface the failure.
  const sourcePath = path.join(packageRoot, 'packs', packId);
  // We don't stat() here — loadPackage will fail with a clear error
  // if neither path holds a package.yaml. The resolver's job is to
  // commit to a path, not to validate pack content.
  return preferIfExistsSync(distPath, sourcePath);
}

function preferIfExistsSync(preferred: string, fallback: string): string {
  if (existsSync(path.join(preferred, 'package.yaml'))) return preferred;
  return fallback;
}
