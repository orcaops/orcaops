// Branch-slug helper for the `.orcaops/reviews/<branch-slug>/` directory key.
//
// This is a byte-for-byte mirror of the storage layer's canonical
// `slugifyBranch`/`unslugifyBranch` (URL-encoding: `/` → `%2F`, etc., fully
// round-trippable). review-core stays pure and Bun-safe — it must NOT import
// the storage package, which would pull `better-sqlite3` into the Bun UI — so
// the one-line recipe is reproduced here rather than re-exported. Both sites
// reduce to `encodeURIComponent`, so they cannot meaningfully drift; the
// reviews-dir path a review computes always matches the sidecar's.

/**
 * Slugify a git branch name for use in a filesystem path. Round-trippable via
 * `unslugifyBranch`.
 */
export function slugifyBranch(branch: string): string {
  return encodeURIComponent(branch);
}

export function unslugifyBranch(slug: string): string {
  return decodeURIComponent(slug);
}
