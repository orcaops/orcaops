/**
 * Parse a digit-only integer literal. Returns null unless the value is
 * strictly `/^\d+$/` AND a safe integer — `Number()`/`parseInt` accept '',
 * '1e3', '0x10', or trailing garbage, and an oversized digit-only literal
 * silently becomes Infinity or loses precision.
 */
export function parseDigitInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
