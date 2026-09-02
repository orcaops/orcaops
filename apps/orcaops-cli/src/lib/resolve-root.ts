import path from 'node:path';

import {
  bestEffortRealpath,
  discoverGitRoot,
  resolveExplicitOverride as resolveExplicitOverrideWith,
} from '@orcaops/project-scope';

import { getInvocationEnv, getInvocationRootOverride } from './invocation-context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

// The path-resolution primitives live in @orcaops/project-scope (shared,
// ALS-free) so the watch app can reuse them. Re-exported here so the CLI's ~6
// resolve-root importers keep their existing import path unchanged.
export { bestEffortRealpath, discoverGitRoot };

/**
 * The explicit root override for this invocation, or `null` when none is
 * set. Thin ALS wrapper over the parameterized primitive: it reads the
 * per-invocation `--root` flag and `env` from the invocation context and
 * delegates. Within the override tier the `--root` flag wins over
 * `ORCAOPS_ROOT`. **Non-throwing** — `doctor` depends on it. Signature is
 * unchanged (`cwd` only) so its importers need no changes.
 */
export async function resolveExplicitOverride(cwd: string): Promise<string | null> {
  return resolveExplicitOverrideWith(cwd, getInvocationEnv(), getInvocationRootOverride());
}

export interface ResolveRootOptions {
  /** The directory the command was invoked from. */
  cwd: string;
  /**
   * An already-resolved root supplied programmatically (highest
   * precedence). `update` passes its resolved root here so discovery does
   * not run twice. This is NOT the `--root` flag — that arrives via ALS
   * and is read by {@link resolveExplicitOverride}.
   */
  root?: string;
}

/**
 * Resolve the `.orcaops` root for a command, **throwing** `NOT_A_REPO`
 * when nothing resolves. Precedence:
 *
 *   1. `opts.root` — explicit programmatic override.
 *   2. `--root` flag (ALS) ?? `ORCAOPS_ROOT` env — via {@link resolveExplicitOverride}.
 *   3. the git worktree root — via {@link discoverGitRoot}.
 *
 * Used by `buildContext` / `update`. `doctor` calls the same primitives
 * but ends in `?? cwd` instead of throwing; `init` is bespoke (it must
 * distinguish "cwd IS the root" from "the root is discoverable from a
 * subdir", which this composition erases). Stays in the CLI because it
 * throws `../io/errors.js` (OrcaopsError), which the shared package must
 * not depend on.
 */
export async function resolveOrcaopsRoot(opts: ResolveRootOptions): Promise<string> {
  if (opts.root !== undefined && opts.root !== '') {
    return bestEffortRealpath(path.resolve(opts.cwd, opts.root));
  }
  const override = await resolveExplicitOverride(opts.cwd);
  if (override !== null) return override;
  const gitRoot = await discoverGitRoot(opts.cwd);
  if (gitRoot !== null) return gitRoot;
  throw new OrcaopsError(
    ErrorCodes.NOT_A_REPO,
    `${opts.cwd} is not inside a git repository, and no --root / ORCAOPS_ROOT override was given.`
  );
}

/**
 * Map a user-supplied `why` target (`file`, interpreted **cwd-relative or
 * absolute** — the shell convention) to the **repo-root-relative** path that
 * `files_changed` stores. `root` is already canonical (from `resolveOrcaopsRoot`).
 *
 * Canonicalize only the target's ANCESTOR directory (so a symlinked `/var` root
 * and a missing tail resolve into `root`'s namespace), and keep the final
 * component LITERAL. Realpath-ing the whole path would FOLLOW a tracked symlink
 * recorded in `files_changed` (e.g. `link.txt` → `real.txt`) to its destination
 * and miss its own checkpoint, even though `git blame -- link.txt` works.
 * (Intermediate tracked-symlink *directories* are still followed — a rare edge,
 * out of scope.) A target outside the repo yields a `../…` path, which simply
 * finds no match.
 */
export async function toRepoRelative(root: string, cwd: string, file: string): Promise<string> {
  const abs = path.resolve(cwd, file);
  const dir = await bestEffortRealpath(path.dirname(abs));
  return path.relative(root, path.join(dir, path.basename(abs)));
}
