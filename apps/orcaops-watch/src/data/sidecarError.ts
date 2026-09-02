const SIDECAR_ERROR_SCHEMA = 'orcaops.watch-sidecar-error/v1';

type SidecarErrorCode = 'CACHE_BEHIND' | 'CACHE_UNSUPPORTED' | 'SCHEMA_AHEAD';

interface SidecarErrorEnvelope {
  schema: typeof SIDECAR_ERROR_SCHEMA;
  code: SidecarErrorCode;
  message: string;
  cache_version: number | string | null;
  current_version: number;
}

export class ReviewCacheBehindError extends Error {
  readonly code = 'CACHE_BEHIND' as const;

  constructor(
    readonly cacheVersion: number,
    readonly currentVersion: number,
    message: string
  ) {
    super(message);
    this.name = 'ReviewCacheBehindError';
  }
}

export class ReviewSidecarSchemaError extends Error {
  constructor(
    readonly code: Exclude<SidecarErrorCode, 'CACHE_BEHIND'>,
    readonly cacheVersion: number | string | null,
    readonly currentVersion: number,
    message: string
  ) {
    super(message);
    this.name = 'ReviewSidecarSchemaError';
  }
}

export function serializeSidecarSchemaError(error: unknown): string | null {
  let envelope: SidecarErrorEnvelope;
  if (isSchemaAheadError(error)) {
    envelope = {
      schema: SIDECAR_ERROR_SCHEMA,
      code: 'SCHEMA_AHEAD',
      message: error.message,
      cache_version: error.cacheVersion,
      current_version: error.cliVersion,
    };
  } else if (isUnsupportedSchemaVersionError(error)) {
    const parsed = parseCacheSchemaVersion(error.cacheVersion);
    envelope = {
      schema: SIDECAR_ERROR_SCHEMA,
      code: parsed !== null && parsed < error.currentVersion ? 'CACHE_BEHIND' : 'CACHE_UNSUPPORTED',
      message: error.message,
      cache_version: parsed ?? error.cacheVersion,
      current_version: error.currentVersion,
    };
  } else {
    return null;
  }
  return JSON.stringify(envelope);
}

function isSchemaAheadError(error: unknown): error is Error & {
  cacheVersion: number;
  cliVersion: number;
} {
  return (
    error instanceof Error &&
    error.name === 'SchemaAheadError' &&
    typeof (error as { cacheVersion?: unknown }).cacheVersion === 'number' &&
    typeof (error as { cliVersion?: unknown }).cliVersion === 'number'
  );
}

function isUnsupportedSchemaVersionError(error: unknown): error is Error & {
  cacheVersion: string | null;
  currentVersion: number;
} {
  if (!(error instanceof Error) || error.name !== 'UnsupportedSchemaVersionError') return false;
  const candidate = error as Error & { cacheVersion?: unknown; currentVersion?: unknown };
  return (
    (candidate.cacheVersion === null || typeof candidate.cacheVersion === 'string') &&
    typeof candidate.currentVersion === 'number'
  );
}

function parseCacheSchemaVersion(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseSidecarSchemaError(stderr: string): Error | null {
  for (const line of stderr.trim().split(/\r?\n/).reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isSidecarErrorEnvelope(value)) continue;
    if (value.code === 'CACHE_BEHIND') {
      return typeof value.cache_version === 'number'
        ? new ReviewCacheBehindError(value.cache_version, value.current_version, value.message)
        : null;
    }
    return new ReviewSidecarSchemaError(
      value.code,
      value.cache_version,
      value.current_version,
      value.message
    );
  }
  return null;
}

function isSidecarErrorEnvelope(value: unknown): value is SidecarErrorEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === SIDECAR_ERROR_SCHEMA &&
    (record.code === 'CACHE_BEHIND' ||
      record.code === 'CACHE_UNSUPPORTED' ||
      record.code === 'SCHEMA_AHEAD') &&
    typeof record.message === 'string' &&
    (record.cache_version === null ||
      typeof record.cache_version === 'string' ||
      typeof record.cache_version === 'number') &&
    typeof record.current_version === 'number' &&
    Number.isSafeInteger(record.current_version)
  );
}
