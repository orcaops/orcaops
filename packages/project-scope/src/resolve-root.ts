import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { resolveRepoTopLevel } from '@orcaops/core';

/**
 * Canonicalize `p` by realpath-ing its **longest existing prefix** and
 * re-appending the (possibly non-existent) trailing segments. Never
 * throws: on ANY filesystem error (ENOENT, EACCES, ELOOP, …) for a
 * prefix it falls back to the next-shorter prefix, ultimately returning
 * the plain absolute path.
 *
 * Why best-effort: every base we hand to `path.relative` must live in
 * the same namespace, but the paths we canonicalize are frequently
 * symlinked (macOS `/var`→`/private/var`) AND frequently absent — a
 * not-yet-created `.orcaops`, a typo'd `--root`, or a blamed/deleted
 * `why` target. A plain `fs.realpath` would throw on those; this does
 * not, so a bogus override flows to a clean `UNINITIALIZED` / `NOT_A_REPO`
 * downstream instead of a raw `ENOENT`.
 */
export async function bestEffortRealpath(p: string): Promise<string> {
  const abs = path.resolve(p);
  const trailing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs; // hit the fs root, nothing resolved
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The explicit root override for this invocation, or `null` when none is
 * set. Within the override tier the `rootOverride` argument (the parsed
 * `--root` flag, threaded in by the caller) wins over the `ORCAOPS_ROOT`
 * env var. The value is resolved relative→absolute against `cwd` and
 * canonicalized with {@link bestEffortRealpath}. **Non-throwing** — `doctor`
 * depends on this never throwing so it can report a bogus override instead
 * of crashing.
 *
 * ALS-free by construction: `cwd`, `env`, and `rootOverride` are all
 * parameters, so this primitive is shared unchanged by the CLI (which
 * reads them from its invocation context) and the watch app (which reads
 * `ORCAOPS_ROOT` from the child env the delegation stub forwards).
 */
export async function resolveExplicitOverride(
  cwd: string,
  env: NodeJS.ProcessEnv,
  rootOverride?: string
): Promise<string | null> {
  const raw = rootOverride ?? env.ORCAOPS_ROOT;
  if (raw === undefined || raw === '') return null;
  return bestEffortRealpath(path.resolve(cwd, raw));
}

/**
 * The git worktree root that contains `cwd`, canonicalized, or `null` when
 * `cwd` is not inside a git work tree. When Git metadata is temporarily
 * unreadable, the nearest `.git` boundary preserves the initialized root only
 * when it also contains `.orcaops`, so callers can surface the underlying
 * identity failure and recover after repair. The search never crosses a nested
 * repository boundary or treats an arbitrary `.orcaops` directory as a root.
 */
export async function discoverGitRoot(cwd: string): Promise<string | null> {
  try {
    return await bestEffortRealpath(await resolveRepoTopLevel(cwd));
  } catch {
    let current = await bestEffortRealpath(cwd);
    for (;;) {
      try {
        await lstat(path.join(current, '.git'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
        continue;
      }
      try {
        await access(path.join(current, '.orcaops'));
        return current;
      } catch {
        return null;
      }
    }
  }
}
