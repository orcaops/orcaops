export class HistoryPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'HistoryPersistenceError';
  }
}

export function integrity(message: string, context: Record<string, unknown> = {}): never {
  throw new HistoryPersistenceError('HISTORY_INTEGRITY_REQUIRED', message, context);
}
