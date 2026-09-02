import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  assertResolvedWithin,
  type EvaluatorPackage,
  EvaluatorPackageSchema,
  PathContainmentError,
} from '@orcaops/evaluator-protocol';

import { EvaluatorDiscoveryError } from './errors.js';

export const PACKAGE_MANIFEST_FILE = 'package.yaml';

export interface LoadedPackage {
  manifest: EvaluatorPackage;
  package_root: string;
  manifest_path: string;
}

/**
 * Load + validate a pack's `package.yaml`. The pack root is the
 * directory containing the manifest; the manifest's `id` field is
 * authoritative (the directory name is decorative).
 *
 * Throws `EvaluatorDiscoveryError` on YAML parse failure or schema
 * validation failure.
 */
export async function loadPackage(packageRoot: string): Promise<LoadedPackage> {
  const declaredManifestPath = path.join(packageRoot, PACKAGE_MANIFEST_FILE);
  let manifestPath = declaredManifestPath;
  if (existsSync(packageRoot)) {
    try {
      manifestPath = assertResolvedWithin(declaredManifestPath, packageRoot, 'package.yaml');
    } catch (err) {
      if (!(err instanceof PathContainmentError)) throw err;
      throw new EvaluatorDiscoveryError({
        source_path: declaredManifestPath,
        field_path: 'package.yaml',
        code: 'path_escapes_pack',
        message: err.message,
        cause: err,
      });
    }
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EvaluatorDiscoveryError({
        source_path: manifestPath,
        message: `package.yaml not found in pack directory ${packageRoot}`,
        cause: err,
      });
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: manifestPath,
      message: `YAML parse failed: ${(err as Error).message}`,
      cause: err,
    });
  }
  const result = EvaluatorPackageSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new EvaluatorDiscoveryError({
      source_path: manifestPath,
      field_path: issue.path.length ? issue.path.join('.') : undefined,
      message: issue.message,
      cause: result.error,
    });
  }
  return {
    manifest: result.data,
    package_root: realpathSync(packageRoot),
    manifest_path: manifestPath,
  };
}
