import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  assertResolvedWithin,
  type Evaluator,
  EvaluatorSchema,
  PathContainmentError,
} from '@orcaops/evaluator-protocol';

import { EvaluatorDiscoveryError } from './errors.js';
import type { LoadedPackage } from './package.js';

const SPEC_FILE_SUFFIX = '.eval.yaml';

export interface LoadedSpec {
  spec: Evaluator;
  spec_path: string;
  /**
   * Inline `description` or the contents of the spec's
   * `description_file` (resolved relative to the pack root).
   * Always populated — the schema's cross-field invariant
   * guarantees exactly one source is set.
   */
  description: string;
}

/**
 * Enumerate + parse every `<id>.eval.yaml` under the pack's
 * `evaluator_dir`. Returns one `LoadedSpec` per file in sorted
 * name order.
 *
 * Per-spec errors are reported via `onError` when provided (lenient
 * mode for `eval list` / doctor) or thrown otherwise (capture mode
 * — fail loud on misconfiguration). Returns the SUCCESSFULLY-LOADED
 * subset in both modes.
 */
export async function loadSpecs(
  pkg: LoadedPackage,
  opts: { onError?: (err: EvaluatorDiscoveryError) => void } = {}
): Promise<LoadedSpec[]> {
  const declaredEvalDir = path.resolve(pkg.package_root, pkg.manifest.evaluator_dir);
  let evalDir: string;
  try {
    evalDir = assertResolvedWithin(declaredEvalDir, pkg.package_root, 'evaluator_dir', {
      allowRoot: true,
    });
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    const wrapped = new EvaluatorDiscoveryError({
      source_path: pkg.manifest_path,
      field_path: 'evaluator_dir',
      code: 'path_escapes_pack',
      message: err.message,
      cause: err,
    });
    if (opts.onError) {
      opts.onError(wrapped);
      return [];
    }
    throw wrapped;
  }

  let entries: string[];
  try {
    entries = await readdir(evalDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const specFiles = entries
    .filter((name) => name.endsWith(SPEC_FILE_SUFFIX))
    .sort()
    .map((name) => path.join(evalDir, name));

  const seenIds = new Map<string, string>();
  const out: LoadedSpec[] = [];

  for (const specPath of specFiles) {
    try {
      const loaded = await parseSpec(specPath, pkg);
      const priorPath = seenIds.get(loaded.spec.id);
      if (priorPath !== undefined) {
        throw new EvaluatorDiscoveryError({
          source_path: specPath,
          field_path: 'id',
          message:
            `duplicate evaluator id "${loaded.spec.id}" within pack "${pkg.manifest.id}" ` +
            `(first declared at ${path.basename(priorPath)})`,
        });
      }
      seenIds.set(loaded.spec.id, specPath);
      out.push(loaded);
    } catch (err) {
      if (err instanceof EvaluatorDiscoveryError) {
        if (opts.onError) opts.onError(err);
        else throw err;
      } else {
        throw err;
      }
    }
  }
  return out;
}

async function parseSpec(specPath: string, pkg: LoadedPackage): Promise<LoadedSpec> {
  const declaredSpecPath = specPath;
  try {
    specPath = assertResolvedWithin(specPath, pkg.package_root, 'evaluator spec');
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    throw new EvaluatorDiscoveryError({
      source_path: declaredSpecPath,
      code: 'path_escapes_pack',
      message: err.message,
      cause: err,
    });
  }
  let raw: string;
  try {
    raw = await readFile(specPath, 'utf8');
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      message: `read failed: ${(err as Error).message}`,
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      message: `YAML parse failed: ${(err as Error).message}`,
      cause: err,
    });
  }
  const result = EvaluatorSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      field_path: issue.path.length ? issue.path.join('.') : undefined,
      message: issue.message,
      cause: result.error,
    });
  }
  const spec = result.data;
  const description = await resolveDescription(spec, pkg, specPath);
  return { spec, spec_path: specPath, description };
}

async function resolveDescription(
  spec: Evaluator,
  pkg: LoadedPackage,
  specPath: string
): Promise<string> {
  if (spec.description !== undefined) return spec.description;
  // Schema invariant: exactly one of description / description_file is
  // set. If description is absent, description_file must be present.
  if (spec.description_file === undefined) {
    // Defense in depth — the schema should never let us reach here.
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      field_path: 'description',
      message: 'neither description nor description_file is set (schema invariant violated)',
    });
  }
  const declaredFilePath = path.resolve(pkg.package_root, spec.description_file);
  let filePath: string;
  try {
    filePath = assertResolvedWithin(declaredFilePath, pkg.package_root, 'description_file');
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      field_path: 'description_file',
      code: 'path_escapes_pack',
      message: err.message,
      cause: err,
    });
  }
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: specPath,
      field_path: 'description_file',
      message: `description_file ${spec.description_file} could not be read: ${(err as Error).message}`,
      cause: err,
    });
  }
}
