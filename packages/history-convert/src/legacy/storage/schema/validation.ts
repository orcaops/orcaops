export class ConfigValidationError extends Error {
  readonly code = 'INVALID_CONFIG' as const;
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
