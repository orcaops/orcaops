import { createHash } from 'node:crypto';

/**
 * SHA-256 of a UTF-8 string, hex-encoded. The single shared helper for the
 * source-plan family's content/id hashing across storage, core, and the CLI.
 * It lives in the lowest shared layer (`@orcaops/storage`) so
 * every package imports the identical implementation; a drift here would silently
 * fork the crash-safe upload id, pin content_hash, and database namespace.
 */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
