import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * RFC 9562 UUIDv7. 128 bits laid out as:
 *
 * ```
 *   tttttttt-tttt-7rrr-Yrrr-rrrrrrrrrrrr
 * ```
 *
 * - 48 bits: Unix ms timestamp (big-endian) → first 12 hex chars
 * -  4 bits: version = `0b0111` (the literal `7` after the second `-`)
 * - 12 bits: random `rand_a`
 * -  2 bits: variant = `0b10` (the leading `8`/`9`/`a`/`b` after the third `-`)
 * - 62 bits: random `rand_b`
 *
 * Sortability: lexicographic order of the canonical string matches
 * chronological order at ms resolution. Two IDs minted in the same
 * millisecond may sort either way (rand_a is uncorrelated), which is
 * acceptable — the architecture only needs "browsing the flat artifact
 * directory in roughly chronological order."
 */

export interface UuidV7Options {
  /** Unix epoch milliseconds. Defaults to `Date.now()`. Injectable for tests. */
  now?: number;
  /** Random byte source. Must return at least 10 bytes. Defaults to `crypto.randomBytes`. */
  random?: () => Buffer;
}

const MAX_48_BIT = 0xffff_ffff_ffffn;

export function uuidv7(opts: UuidV7Options = {}): string {
  const nowMs = BigInt(opts.now ?? Date.now());
  if (nowMs < 0n || nowMs > MAX_48_BIT) {
    throw new Error(`uuidv7: timestamp out of 48-bit range: ${nowMs}`);
  }
  const r = (opts.random ?? (() => randomBytes(10)))();
  if (r.length < 10) {
    throw new Error(`uuidv7: random source returned ${r.length} bytes; need >= 10`);
  }

  const bytes = Buffer.alloc(16);

  // Bytes 0..5: 48-bit timestamp (big-endian).
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((nowMs >> BigInt(40 - 8 * i)) & 0xffn);
  }

  // Byte 6: version nibble (top 4 bits = 0b0111) + 4 random bits.
  // Byte 7: 8 random bits → completes rand_a (12 random bits total).
  bytes[6] = 0x70 | (r[0] & 0x0f);
  bytes[7] = r[1];

  // Byte 8: variant (top 2 bits = 0b10) + 6 random bits.
  // Bytes 9..15: 56 random bits → 56 + 6 = 62 bits of rand_b.
  bytes[8] = 0x80 | (r[2] & 0x3f);
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = r[3 + i];
  }

  const hex = bytes.toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/** Strict UUIDv7 canonical-form regex (lowercase). */
export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True iff `s` is a canonical-form lowercase UUIDv7 string. */
export function isUuidV7(s: string): boolean {
  return UUID_V7_REGEX.test(s);
}

/**
 * The shared record-ID schema: every artifact-event and usage-ledger ID is a
 * canonical UUIDv7, at read AND at every override/import ingress. IDs become
 * filesystem path segments (`sidecars/<event_id>.json`, archive mirrors), so
 * shape validation here is what keeps a stored ID from carrying traversal.
 */
export const UuidV7Schema = z
  .string()
  .refine(isUuidV7, { message: 'must be a canonical lowercase UUIDv7' });
