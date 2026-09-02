import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  assertResolvedWithin,
  type EvaluatorConfig,
  EvaluatorConfigSchema,
} from '@orcaops/evaluator-protocol';

import { EvaluatorDiscoveryError } from './errors.js';

/** Default location for the repo evaluator config. */
export const EVALUATOR_CONFIG_FILE = '.orcaops/evaluators.yaml';

/**
 * Load and validate `.orcaops/evaluators.yaml`. Returns `null` when
 * the file is absent — the runner treats that case as "no packs, no
 * overrides".
 *
 * Throws `EvaluatorDiscoveryError` on:
 *   - YAML parse failure
 *   - Schema validation failure (with the first Zod issue's path)
 *
 * Filesystem errors other than ENOENT propagate as-is so the caller
 * can distinguish "config missing" from "permission denied / I/O
 * error reading config."
 */
export async function loadEvaluatorConfig(repoRoot: string): Promise<EvaluatorConfig | null> {
  const configPath = assertResolvedWithin(
    path.join(repoRoot, EVALUATOR_CONFIG_FILE),
    repoRoot,
    EVALUATOR_CONFIG_FILE,
    { rejectSymlinks: true }
  );
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  return parseConfigContents(raw, configPath);
}

/**
 * Parse + validate config contents without touching the filesystem.
 * Exported for tests that synthesize YAML inline and for the CLI's
 * `eval list --config <inline>` path.
 */
export function parseConfigContents(yamlText: string, sourcePath: string): EvaluatorConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new EvaluatorDiscoveryError({
      source_path: sourcePath,
      message: `YAML parse failed: ${(err as Error).message}`,
      cause: err,
    });
  }
  if (parsed === null || parsed === undefined) {
    // Empty file → treat as the empty config (schema fills defaults).
    parsed = { schema: 'orcaops.evaluator_config/v2' };
  }
  const result = EvaluatorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new EvaluatorDiscoveryError({
      source_path: sourcePath,
      field_path: issue.path.length ? issue.path.join('.') : undefined,
      message: issue.message,
      cause: result.error,
    });
  }
  return result.data;
}
