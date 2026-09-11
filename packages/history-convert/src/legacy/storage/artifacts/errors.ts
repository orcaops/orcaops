export class RecoveryRefusedError extends Error {
  readonly code = 'RECOVERY_REFUSED' as const;
  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = 'RecoveryRefusedError';
  }
}
