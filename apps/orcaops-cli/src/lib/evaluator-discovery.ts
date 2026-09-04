import type { EvaluatorConfig, ResolvedEvaluator } from '@orcaops/evaluator-protocol';
import { discoverEvaluators, type EvaluatorDiscoveryError } from '@orcaops/evaluator-runner';

import { CLI_ROOT, resolveEvaluatorsConfigLocation } from './evaluators-config.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface CliDiscoveryResult {
  evaluators: ResolvedEvaluator[];
  config: EvaluatorConfig | null;
  /** Packs that failed to load. Empty when every configured pack resolved. */
  errors: EvaluatorDiscoveryError[];
}

/**
 * Discover evaluators for a CLI command, collecting load failures instead of
 * throwing on the first one.
 *
 * This collects; it does not impose a response. Callers differ on purpose:
 * the lifecycle gate must fail loud, `doctor` reports, and best-effort hint
 * surfaces keep going. Flattening them into one policy would silence the
 * cases this helper exists to make visible.
 *
 * Passing `CLI_ROOT` is the part every caller must not forget — without it
 * the runner anchors bundled-pack resolution at its own location, where
 * @orcaops/evaluator-pack is not a dependency.
 */
export async function discoverEvaluatorsForCli(repoRoot: string): Promise<CliDiscoveryResult> {
  const location = await resolveEvaluatorsConfigLocation(repoRoot);
  const { evaluators, config, errors } = await discoverEvaluators(repoRoot, {
    cliRoot: CLI_ROOT,
    configPath: location.configPath,
    configContainmentRoot: location.containmentRoot,
    onError: () => undefined,
  });
  return { evaluators: [...evaluators], config, errors: [...errors] };
}

/**
 * Errors that could hide `packageId`'s evaluators: the pack's own failures,
 * plus unattributable ones (a malformed config, an unresolvable source, a
 * duplicate-ref clash) that precede or span packs.
 *
 * An unrelated pack's failure is not among them. A namespaced ref cannot live
 * in another pack, so treating `local`'s broken spec as a reason to doubt
 * `core/typo` sends the user hunting for a correctly-spelled ref.
 */
export function errorsAffecting(
  packageId: string | undefined,
  errors: readonly EvaluatorDiscoveryError[]
): EvaluatorDiscoveryError[] {
  return errors.filter((err) => err.package_id === undefined || err.package_id === packageId);
}

/** Human count of the packs a set of errors came from. */
function describeScope(errors: readonly EvaluatorDiscoveryError[]): string {
  const packs = new Set(errors.map((err) => err.package_id).filter((id) => id !== undefined));
  const specs = `${errors.length} problem(s)`;
  return packs.size > 0 ? `${specs} in ${packs.size} pack(s)` : specs;
}

function formatErrors(errors: readonly EvaluatorDiscoveryError[]): string {
  return errors.map((err) => `  - ${err.source_path}: ${err.message}`).join('\n');
}

/**
 * The error to raise when a ref was not found.
 *
 * When a failure could hide this ref, the honest answer is that the evaluator
 * set is incomplete. Saying EVALUATOR_NOT_FOUND there sends the user to fix a
 * typo in a ref that is spelled correctly, while the broken pack goes
 * unmentioned. Failures elsewhere say nothing about this ref, so they do not
 * change the answer.
 */
export function evaluatorNotFound(
  ref: string,
  errors: readonly EvaluatorDiscoveryError[]
): OrcaopsError {
  const slash = ref.indexOf('/');
  const packageId = slash === -1 ? undefined : ref.slice(0, slash);
  const relevant = errorsAffecting(packageId, errors);

  if (relevant.length === 0) {
    return new OrcaopsError(
      ErrorCodes.EVALUATOR_NOT_FOUND,
      `No evaluator with ref "${ref}" found in the configured packs. ` +
        "Run `orcaops eval list` to see what's available."
    );
  }
  return new OrcaopsError(
    ErrorCodes.EVALUATOR_DISCOVERY_FAILED,
    `Cannot resolve "${ref}": ${describeScope(relevant)} kept part of the evaluator ` +
      `set from loading, so the ref may exist and be hidden.\n${formatErrors(relevant)}\n` +
      'Run `orcaops doctor` for the full diagnosis.'
  );
}

/**
 * The error to raise when discovery failures make a pack's capability set
 * untrustworthy, or `null` when none of them touch it.
 *
 * An evaluator whose spec failed to load is simply absent from the set burned
 * into the grant, so trust is recorded narrower than the pack requires and
 * dispatch later refuses it as capability-short — with nothing pointing back
 * at the load failure. `validatePack` catches most of this upstream, but not a
 * repo-config `params` override failing the spec's `params_schema`, which is
 * config-dependent and surfaces only at discovery.
 */
export function untrustworthyCapabilities(
  packageId: string,
  errors: readonly EvaluatorDiscoveryError[]
): OrcaopsError | null {
  const relevant = errorsAffecting(packageId, errors);
  if (relevant.length === 0) return null;
  return new OrcaopsError(
    ErrorCodes.EVALUATOR_DISCOVERY_FAILED,
    `Refusing to grant trust to "${packageId}": ${describeScope(relevant)} kept part of ` +
      'its evaluator set from loading, so the capability set recorded in the grant would ' +
      `be narrower than the pack requires.\n${formatErrors(relevant)}\n` +
      'Run `orcaops doctor` for the full diagnosis.'
  );
}
