import { spawnSync } from 'node:child_process';

import { LEGACY_SOURCE_REVISION } from './profile.js';

/**
 * Where the provenance comparisons run git. Pinned to the package root so the
 * comparison does not depend on whatever directory the runner happens to use.
 */
export const legacySourceGitOptions = { cwd: new URL('../', import.meta.url) };

/**
 * Whether the pinned original commit is reachable from this checkout. A public
 * export carries independent history, so the comparisons against the original
 * source have nothing to read and skip themselves; the vendored-byte and
 * manifest checks stay live everywhere. A missing git binary throws instead —
 * a broken toolchain must not look like an absent commit.
 */
export const legacySourceCommitAvailable = (() => {
  const probe = spawnSync('git', ['cat-file', '-e', `${LEGACY_SOURCE_REVISION}^{commit}`], {
    ...legacySourceGitOptions,
    stdio: 'ignore',
  });
  if (probe.error) throw probe.error;
  return probe.status === 0;
})();
