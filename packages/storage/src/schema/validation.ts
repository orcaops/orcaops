/**
 * Error class raised by config validators. Storage doesn't depend on the
 * CLI's error registry, so command boundaries remap this class to the public
 * `INVALID_CONFIG` envelope.
 */
export class ConfigValidationError extends Error {
  /** Stable, public-facing error code. Always `'INVALID_CONFIG'`. */
  readonly code = 'INVALID_CONFIG' as const;

  constructor(
    message: string,
    /** Dotted path into the configuration object. */
    public readonly path: string
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
