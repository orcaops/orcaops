/**
 * The `orcaops search --type` contract, shared.
 *
 * Hosted here for the same reason as the other shared subpaths in this
 * package: `@orcaops/evaluator-protocol` is already a dependency of both the
 * CLI (which owns the command) and `@orcaops/test-harness` (which drives it),
 * and nothing here pulls in a new one, so sharing adds no dependency edge. The
 * harness cannot import from the CLI app, which is how the two copies drifted
 * — the CLI grew three types the harness never learned about, and a test that
 * needed one had to bypass the typed wrapper entirely.
 */
export const SEARCH_TYPES = [
  'plan',
  'checkpoint',
  'summary',
  'evaluator',
  'digest',
  'block-resolution',
  'pin-displaced',
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export function isSearchType(value: string): value is SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(value);
}
