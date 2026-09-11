import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Validate the raw `--limit` flag value. Exported for direct unit
 * testing — production callers go through the command actions.
 */
export function parseLimit(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--limit must be a positive integer.',
      'limit'
    );
  }
  return raw;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse one window bound with **UTC semantics pinned**:
 *
 *   - date-only `YYYY-MM-DD` → the given UTC day edge (`T00:00:00.000Z` for
 *     lower bounds, `T23:59:59.999Z` for upper bounds);
 *   - a full ISO-8601 datetime passes through, canonicalized to
 *     `Date.toISOString()` Z-form so lexicographic SQL compares against the
 *     stored `toISOString()` timestamps are exact — a datetime WITHOUT an
 *     explicit offset is read as UTC (never local time);
 *   - anything unparseable → `INVALID_INPUT` carrying the flag name.
 *
 * Shared by all four window flags (`--since`/`--until`/`--active-since`/
 * `--active-until`). Exported via {@link parseSince}/{@link parseUntil} for
 * direct unit testing.
 */
function parseWindowBound(
  raw: string | undefined,
  flag: string,
  dayEdge: 'T00:00:00.000Z' | 'T23:59:59.999Z'
): string | undefined {
  if (raw === undefined) return undefined;
  const fail = (): OrcaopsError =>
    new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--${flag} must be an ISO-8601 date (YYYY-MM-DD) or datetime, interpreted as UTC; got "${raw}".`,
      flag
    );
  // Gate on ISO shape BEFORE handing to `new Date`: V8 happily parses
  // non-ISO forms like "07/01/2026" — as LOCAL time — which would silently
  // break the pinned-UTC contract.
  let candidate: string;
  if (DATE_ONLY_RE.test(raw)) {
    candidate = `${raw}${dayEdge}`;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    candidate = TZ_SUFFIX_RE.test(raw) ? raw : `${raw}Z`;
  } else {
    throw fail();
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) throw fail();
  // V8 leniently rolls over out-of-range days ("2026-02-30" → Mar 2). For
  // Z-form candidates the UTC date part must round-trip exactly; explicit
  // non-Z offsets legitimately shift the date and are exempt.
  if (candidate.endsWith('Z') && parsed.toISOString().slice(0, 10) !== candidate.slice(0, 10)) {
    throw fail();
  }
  return parsed.toISOString();
}

/** Parse a window LOWER bound (`--since` / `--active-since`). See {@link parseWindowBound}. */
export function parseSince(raw: string | undefined, flag = 'since'): string | undefined {
  return parseWindowBound(raw, flag, 'T00:00:00.000Z');
}

/** Parse a window UPPER bound (`--until` / `--active-until`). See {@link parseWindowBound}. */
export function parseUntil(raw: string | undefined, flag = 'until'): string | undefined {
  return parseWindowBound(raw, flag, 'T23:59:59.999Z');
}

/**
 * Reject an inverted window pair (lower bound after upper bound). Both
 * bounds are already-normalized ISO-Z strings, so string compare is exact.
 */
export function assertWindowOrdered(
  lower: string | undefined,
  upper: string | undefined,
  lowerFlag: string,
  upperFlag: string
): void {
  if (lower !== undefined && upper !== undefined && lower > upper) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--${lowerFlag} (${lower}) must not be after --${upperFlag} (${upper}).`,
      lowerFlag
    );
  }
}
