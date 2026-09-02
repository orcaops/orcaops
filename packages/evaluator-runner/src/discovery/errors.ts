import path from 'node:path';

/**
 * Thrown by the discovery layer when a YAML file fails to load, a
 * schema validation fails, or a resolution-time invariant breaks
 * (params validation, duplicate refs, missing companion files).
 *
 * Carries the source-file path and the dotted field path so the CLI
 * can surface a precise diagnostic. Wraps the underlying cause
 * (Zod issue, ajv error, fs error, EvaluatorResolveError) when
 * applicable.
 */
export class EvaluatorDiscoveryError extends Error {
  override readonly name = 'EvaluatorDiscoveryError';
  readonly source_path: string;
  readonly field_path?: string;
  /**
   * Stable diagnostic code. Lets `eval list --strict` and `doctor`
   * JSON surfaces distinguish error classes without parsing the
   * message string. Known codes:
   *   - `params_schema_invalid` — repo-config override params fail
   *     the spec's params_schema validation.
   *   (Other discovery errors leave `code` undefined; they're either
   *   transient I/O failures or schema-load failures that the
   *   message already disambiguates.)
   */
  readonly code?: string;
  /**
   * Configured pack this error belongs to, when discovery could attribute it.
   * `undefined` for failures that precede or span packs — a malformed
   * `.orcaops/evaluators.yaml`, an unresolvable source, a duplicate-ref clash.
   *
   * Deliberately assignable rather than a constructor argument: these errors
   * are thrown from six modules that mostly do not know which configured entry
   * they are serving, while the discovery loop that collects them always does.
   * Stamping at collection keeps the throw sites unchanged.
   *
   * Callers that act on a *specific* pack — resolving a ref, granting trust —
   * must filter on this. Treating an unrelated pack's failure as a reason to
   * refuse produces confident, wrong diagnoses: a namespaced ref cannot live
   * in some other pack.
   */
  package_id?: string;
  override readonly cause?: unknown;

  constructor(opts: {
    source_path: string;
    field_path?: string;
    message: string;
    code?: string;
    cause?: unknown;
  }) {
    const where = opts.field_path ? `${opts.field_path}: ` : '';
    super(`${path.basename(opts.source_path)}: ${where}${opts.message}`);
    this.source_path = opts.source_path;
    if (opts.field_path !== undefined) this.field_path = opts.field_path;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}
