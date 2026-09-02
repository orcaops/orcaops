/**
 * Remove the `user:password@` component from an http(s) remote URL.
 *
 * A credential embedded in a remote is not part of the repository's identity,
 * but the remote URL is: it becomes the local SQLite primary key, the
 * `repo_url` shipped to the cloud by `captureThread.start`, and a hint written
 * into the on-disk project registry. Stripping it at the point the remote is
 * read keeps all three free of it.
 *
 * Only http and https are touched. An SSH remote's `git@host` is a username,
 * not a secret, and rewriting it would change a legitimate wire identity — the
 * scp-like form is already collapsed to `https://host/path` by
 * `normalizeRepoUrl`, which drops the user for the local key on its own.
 *
 * The last `@` in the authority wins, matching how a URL parser resolves an
 * unencoded `@` inside the password.
 */
export function stripHttpUserinfo(raw: string): string {
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd < 0) return raw;

  const scheme = raw.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return raw;

  const authorityStart = schemeEnd + '://'.length;
  // The authority ends at the first `/`, `?` or `#`. Ending it at `/` alone
  // read a query or fragment containing `@` as userinfo, so a valid URL whose
  // host is the part BEFORE the `?` was rewritten onto whatever followed it.
  const relativeEnd = raw.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = relativeEnd < 0 ? -1 : authorityStart + relativeEnd;
  const authority =
    authorityEnd < 0 ? raw.slice(authorityStart) : raw.slice(authorityStart, authorityEnd);

  const at = authority.lastIndexOf('@');
  if (at < 0) return raw;

  const rest = authorityEnd < 0 ? '' : raw.slice(authorityEnd);
  return raw.slice(0, authorityStart) + authority.slice(at + 1) + rest;
}
