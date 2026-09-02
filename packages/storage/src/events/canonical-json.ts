/**
 * Deterministic, whitespace-free JSON serialization. Two values compare
 * equal under `===` on the output iff they are the same JSON value
 * regardless of object-key insertion order.
 *
 * Used in two load-bearing places:
 *
 *   1. Per-line event-record SHA-256 checksum. The checksum is computed
 *      over the canonical serialization of the event record minus the
 *      `checksum` field itself; tampering with any other field breaks
 *      the checksum.
 *
 *   2. Idempotency payload equality. Same key → same idempotency_key
 *      plus structurally-equal payload → IDEMPOTENT_REPLAY;
 *      same key + different canonical form → IDEMPOTENCY_CONFLICT.
 *      One canonicalization rule used by both keeps the equality
 *      definition consistent end-to-end.
 *
 * Rules:
 *   - Object keys sorted lexicographically (codepoint order).
 *   - No whitespace between tokens.
 *   - Arrays preserve insertion order.
 *   - Primitives (`null`, booleans, numbers, strings) serialize the
 *     same as `JSON.stringify`.
 *   - Disallowed: `undefined`, `NaN`, `±Infinity`, functions, symbols,
 *     bigints — none of these can appear in the on-disk payloads we
 *     control, so making them throw early catches programmer error
 *     instead of silently producing non-portable output.
 */

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(`canonicalJson: ${message} at ${path || '<root>'}`);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number ${value}`, path);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts = value.map((item, i) => serialize(item, `${path}[${i}]`));
        return `[${parts.join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const childValue = obj[key];
        if (childValue === undefined) {
          // Match JSON.stringify's behavior: undefined values are dropped
          // entirely (rather than throwing), so callers can use `?:` /
          // optional fields without first having to filter the object.
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${serialize(childValue, childPath)}`);
      }
      return `{${parts.join(',')}}`;
    }
    case 'undefined':
      throw new CanonicalJsonError('undefined is not representable', path);
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
  }
}
