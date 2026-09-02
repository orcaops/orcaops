import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { type EvaluatorConfig, EvaluatorConfigSchema } from '@orcaops/evaluator-protocol';
import { assertResolvedWithin } from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
import { type EvaluatorGrantMutation, withGrantMutation } from './evaluator-grants.js';
import { formatZodIssues } from './zod-issues.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Absolute path to the @orcaops/cli package root. Bundled-source
 * resolution treats this as the dependency anchor: @orcaops/evaluator-pack
 * is a workspace dep of the CLI, not the runner. Source layout
 * (src/lib/evaluators-config.ts) is three directories deep; the
 * built layout (dist/lib/evaluators-config.js) is the same depth.
 *
 * Every CLI call site that invokes resolvePackSource OR discoverEvaluators
 * should pass this — without it the runner's DEFAULT_CLI_ROOT (the
 * runner's own location) is used, and bundled resolution fails because
 * the runner doesn't have @orcaops/evaluator-pack as a dep.
 */
export const CLI_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const EVALUATOR_CONFIG_FILE = '.orcaops/evaluators.yaml';

export const CONFIG_YAML_HEADER =
  '# .orcaops/evaluators.yaml — owned by `orcaops eval add-pack`.\n' +
  '# Edit by hand to tweak provider / model / timeout / severity / params / enable flags; full schema:\n' +
  '#   https://docs.orcaops.ai/evaluators\n';

export function evaluatorsConfigPath(repoRoot: string): string {
  return path.join(repoRoot, EVALUATOR_CONFIG_FILE);
}

export function emptyEvaluatorsConfig(): EvaluatorConfig {
  return {
    schema: 'orcaops.evaluator_config/v2',
    runtime: { max_concurrent: 4 },
    packages: [],
    evaluators: {},
  };
}

function parseEvaluatorConfig(value: unknown): EvaluatorConfig {
  const result = EvaluatorConfigSchema.safeParse(value);
  if (result.success) return result.data;

  // Report EVERY issue: the config's cross-field checks can flag a duplicate
  // pack id and an undeclared pack ref in one parse, and surfacing only the
  // first turns one round of fixes into as many rounds as there are mistakes.
  const issues = result.error.issues;
  const first = issues[0]!;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    issues.length === 1
      ? `${EVALUATOR_CONFIG_FILE} is invalid at ${formatZodIssues(issues)}`
      : `${EVALUATOR_CONFIG_FILE} has ${issues.length} problems:\n${formatZodIssues(issues)}`,
    first.path.length > 0 ? first.path.join('.') : undefined
  );
}

export function validateEvaluatorsConfig(value: unknown): EvaluatorConfig {
  return parseEvaluatorConfig(value);
}

/**
 * Load + normalize the config file. `null` when the file is absent —
 * callers decide whether absence is an error (e.g., remove-pack /
 * disable) or a soft default (e.g., add-pack). Malformed YAML or an
 * invalid structure throws `INVALID_INPUT` naming the offending field
 * instead of the old blind cast's downstream misbehavior.
 */
export async function readEvaluatorsConfig(repoRoot: string): Promise<EvaluatorConfig | null> {
  const configPath = assertResolvedWithin(
    evaluatorsConfigPath(repoRoot),
    repoRoot,
    'evaluators configuration',
    { rejectSymlinks: true }
  );
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${EVALUATOR_CONFIG_FILE}: YAML parse failed: ${(err as Error).message}`
    );
  }
  if (parsed === null || parsed === undefined) return emptyEvaluatorsConfig();
  return parseEvaluatorConfig(parsed);
}

/**
 * Write the config back, preserving the canonical header. The yaml
 * library produces a stable, sorted-key serialization (no internal
 * ordering depends on it; humans editing by hand may reorder freely).
 */
export async function writeEvaluatorsConfig(
  repoRoot: string,
  config: EvaluatorConfig
): Promise<void> {
  const canonical = parseEvaluatorConfig(config);
  const body = stringifyYaml(canonical, { indent: 2, lineWidth: 0 });
  await atomicWriteFile(evaluatorsConfigPath(repoRoot), CONFIG_YAML_HEADER + body, repoRoot);
}

export async function writeEvaluatorState(
  repoRoot: string,
  config: EvaluatorConfig,
  grantMutation: EvaluatorGrantMutation
): Promise<boolean> {
  const configPath = evaluatorsConfigPath(repoRoot);
  let snapshot: Buffer | null | undefined;
  try {
    const { grantChanged } = await withGrantMutation(grantMutation, { repoRoot }, async () => {
      snapshot = await readOptionalFile(configPath);
      await writeEvaluatorsConfig(repoRoot, config);
    });
    return grantChanged;
  } catch (error) {
    if (snapshot === undefined) throw error;
    try {
      await restoreConfigSnapshot(configPath, repoRoot, snapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Evaluator mutation failed and the config rollback also failed.'
      );
    }
    throw error;
  }
}

async function readOptionalFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function restoreConfigSnapshot(
  file: string,
  repoRoot: string,
  snapshot: Buffer | null
): Promise<void> {
  if (snapshot !== null) {
    await atomicWriteFile(file, snapshot, repoRoot);
    return;
  }
  try {
    await unlink(
      assertResolvedWithin(file, repoRoot, 'evaluator configuration rollback', {
        rejectSymlinks: true,
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
