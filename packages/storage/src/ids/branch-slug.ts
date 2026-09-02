/**
 * Slugify a git branch name for use in a filesystem path.
 * Round-trippable via `unslugifyBranch`.
 *
 * Uses URL encoding so `/` becomes `%2F`, etc. We additionally percent-encode
 * `%` itself in the input so the round-trip is unambiguous.
 */
export function slugifyBranch(branch: string): string {
  return encodeURIComponent(branch);
}

export function unslugifyBranch(slug: string): string {
  return decodeURIComponent(slug);
}
