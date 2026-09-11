export class HistoryConversionError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_SOURCE_PROFILE'
      | 'UNSUPPORTED_RESOURCE_SCHEMA'
      | 'SOURCE_INTEGRITY'
      | 'SOURCE_CONFLICT'
      | 'SOURCE_CHANGED'
      | 'SOURCE_UNAVAILABLE',
    message: string,
    readonly resource?: string
  ) {
    super(message);
    this.name = 'HistoryConversionError';
  }
}
