import {
  assertUniqueRefs,
  type EvaluatorConfig,
  EvaluatorResolveError,
  overridesByRef,
  type ResolvedEvaluator,
  resolveEvaluator,
} from '@orcaops/evaluator-protocol';

import { loadEvaluatorConfig } from './config.js';
import { EvaluatorDiscoveryError } from './errors.js';
import { type LoadedPackage, loadPackage } from './package.js';
import { resolvePackSource } from './resolver.js';
import { type LoadedSpec, loadSpecs } from './spec.js';
import { createParamsValidator } from './validator.js';

export interface DiscoverEvaluatorsOptions {
  /**
   * Lenient mode: per-spec / per-pack errors are reported via this
   * callback and the discovery continues. When omitted, discovery
   * throws on the first error (capture mode).
   */
  onError?: (err: EvaluatorDiscoveryError) => void;
  /**
   * Inject a pre-built params validator. Defaults to a fresh
   * ajv-backed validator. Tests use a stub to assert the validator
   * is invoked with the expected arguments without coupling to ajv.
   */
  validateParams?: (params: Record<string, unknown>, schema: Record<string, unknown>) => void;
  /**
   * Override the CLI install directory used as the dependency anchor
   * for `kind: bundled` pack sources. Defaults to the runner's own
   * location (a workspace dep of @orcaops/cli). Tests use this to
   * pin a synthetic CLI root.
   */
  cliRoot?: string;
  /**
   * Where the registration file lives when it is not the worktree default —
   * the git common dir under personal scope — and the root it resolves
   * within. Pack sources declared with relative paths still resolve from
   * `repoRoot`: the pack is code in that checkout, not in `.git`.
   */
  configPath?: string;
  configContainmentRoot?: string;
}

export interface DiscoveryResult {
  /**
   * The successfully-resolved evaluators. Includes both enabled and
   * disabled entries — callers filter by `enabled` themselves when
   * they need the runnable set.
   */
  evaluators: ResolvedEvaluator[];
  /**
   * Errors collected during discovery (only populated when
   * `onError` was provided). Empty when discovery completed without
   * issues OR when the caller is in throw-on-first-error mode.
   */
  errors: EvaluatorDiscoveryError[];
  /**
   * The parsed config that was read during discovery. Returned so
   * callers (e.g., the CLI bridge) don't have to re-read
   * `.orcaops/evaluators.yaml` to access `runtime.max_concurrent`
   * or `packages[]`. `null` when no config file exists.
   */
  config: EvaluatorConfig | null;
}

/**
 * Top-level discovery entry point. Loads the repo config, walks the
 * declared packs, parses every spec under each pack's
 * `evaluator_dir`, applies repo-config overrides, validates params
 * against `params_schema`, and emits the immutable
 * `ResolvedEvaluator[]` that the dispatch layer consumes.
 *
 * The pipeline is:
 *   1. Load `.orcaops/evaluators.yaml`. Missing → empty result.
 *   2. For each entry in `packages`, load `<path>/package.yaml`.
 *   3. Validate pack-id uniqueness (already enforced by the config
 *      schema but defended here for direct callers).
 *   4. Enumerate + parse `<path>/<evaluator_dir>/*.eval.yaml`.
 *   5. Apply repo-config overrides and run ajv params validation.
 *   6. Assert resolved-ref uniqueness across all packs.
 */
export async function discoverEvaluators(
  repoRoot: string,
  opts: DiscoverEvaluatorsOptions = {}
): Promise<DiscoveryResult> {
  const errors: EvaluatorDiscoveryError[] = [];
  const collect = (err: EvaluatorDiscoveryError): void => {
    if (opts.onError) {
      opts.onError(err);
      errors.push(err);
    } else {
      throw err;
    }
  };

  const config = await loadEvaluatorConfig(repoRoot, {
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.configContainmentRoot !== undefined
      ? { containmentRoot: opts.configContainmentRoot }
      : {}),
  }).catch((err: unknown) => {
    if (err instanceof EvaluatorDiscoveryError) {
      collect(err);
      return null;
    }
    throw err;
  });
  if (config === null) {
    return { evaluators: [], errors, config: null };
  }

  const validateParams = opts.validateParams ?? createParamsValidator();
  const overrides = overridesByRef(config);

  const resolverCtx = {
    repoRoot,
    ...(opts.cliRoot !== undefined ? { cliRoot: opts.cliRoot } : {}),
  };
  const loadedPackages = await loadDeclaredPackages(config, resolverCtx, collect);
  const evaluators: ResolvedEvaluator[] = [];

  for (const pkg of loadedPackages) {
    const collectForPack = attributeTo(pkg.manifest.id, collect);
    const specs = await loadSpecs(pkg, { onError: collectForPack });
    for (const loaded of specs) {
      const ref = `${pkg.manifest.id}/${loaded.spec.id}`;
      const override = overrides.get(ref);
      try {
        const resolved = resolveEvaluator({
          spec: loaded.spec,
          package_manifest: pkg.manifest,
          package_root: pkg.package_root,
          spec_path: loaded.spec_path,
          description: loaded.description,
          ...(override !== undefined ? { override } : {}),
          validate_params: validateParams,
        });
        evaluators.push(resolved);
      } catch (err) {
        collectForPack(wrapResolveError(err, loaded.spec_path));
      }
    }
  }

  try {
    assertUniqueRefs(evaluators.map((e) => e.ref));
  } catch (err) {
    collect(wrapResolveError(err, '<discovery>'));
  }

  return { evaluators, errors, config };
}

async function loadDeclaredPackages(
  config: EvaluatorConfig,
  resolverCtx: { repoRoot: string; cliRoot?: string },
  collect: (err: EvaluatorDiscoveryError) => void
): Promise<LoadedPackage[]> {
  const out: LoadedPackage[] = [];
  const seenIds = new Map<string, string>();
  for (const entry of config.packages) {
    const collectForPack = attributeTo(entry.id, collect);
    let packageRoot: string;
    try {
      const resolved = resolvePackSource(entry.source, resolverCtx);
      packageRoot = resolved.pack_root;
    } catch (err) {
      if (err instanceof EvaluatorDiscoveryError) {
        collectForPack(err);
        continue;
      }
      throw err;
    }
    try {
      const pkg = await loadPackage(packageRoot);
      // The manifest's `id` is authoritative but the config entry's
      // `id` is what the override map keys on. Mismatch = config bug
      // worth flagging loudly.
      if (pkg.manifest.id !== entry.id) {
        collectForPack(
          new EvaluatorDiscoveryError({
            source_path: pkg.manifest_path,
            field_path: 'id',
            message:
              `package.yaml id "${pkg.manifest.id}" does not match the entry id ` +
              `"${entry.id}" in .orcaops/evaluators.yaml — rename one to match`,
          })
        );
        continue;
      }
      const prior = seenIds.get(pkg.manifest.id);
      if (prior !== undefined) {
        collectForPack(
          new EvaluatorDiscoveryError({
            source_path: pkg.manifest_path,
            field_path: 'id',
            message: `duplicate package id "${pkg.manifest.id}" — first declared at ${prior}`,
          })
        );
        continue;
      }
      seenIds.set(pkg.manifest.id, pkg.manifest_path);
      out.push(pkg);
    } catch (err) {
      if (err instanceof EvaluatorDiscoveryError) collectForPack(err);
      else throw err;
    }
  }
  return out;
}

/**
 * Wrap a collector so everything it receives while serving one configured
 * pack is attributed to it. Errors that already carry an id keep it.
 */
function attributeTo(
  packageId: string,
  collect: (err: EvaluatorDiscoveryError) => void
): (err: EvaluatorDiscoveryError) => void {
  return (err) => {
    if (err.package_id === undefined) err.package_id = packageId;
    collect(err);
  };
}

function wrapResolveError(err: unknown, sourcePath: string): EvaluatorDiscoveryError {
  if (err instanceof EvaluatorResolveError) {
    return new EvaluatorDiscoveryError({
      source_path: err.spec_path,
      field_path: err.field_path,
      message: err.message.replace(/^[^:]+:\s*/, ''),
      ...(err.code !== undefined ? { code: err.code } : {}),
      cause: err,
    });
  }
  if (err instanceof EvaluatorDiscoveryError) return err;
  return new EvaluatorDiscoveryError({
    source_path: sourcePath,
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

export type { LoadedPackage, LoadedSpec };
