// The npm dist-tag and GitHub release kind a version implies.
//
// Derived from the version, never chosen by hand: publishing a release
// candidate to `latest` hands every `npm i -g @orcaops/cli` an untested
// build, and npm keeps no undo — the tag can be moved, but whoever installed
// in the meantime already has it.

/** A SemVer prerelease component (the part after `-`) makes it a candidate. */
export function isPrerelease(version) {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/** Testers opt into candidates with `npm i -g @orcaops/cli@next`. */
export function distTagFor(version) {
  return isPrerelease(version) ? 'next' : 'latest';
}

/** The base `X.Y.Z` a candidate is heading toward, or the version itself. */
export function baseVersionOf(version) {
  const match = /^(\d+\.\d+\.\d+)/.exec(version);
  if (match === null) throw new Error(`unparseable version: ${version}`);
  return match[1];
}
