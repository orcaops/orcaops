import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared path-containment primitives for checked-in configuration and stored
 * identifiers that become filesystem paths.
 */
export class PathContainmentError extends Error {
  constructor(
    message: string,
    /** Which input was refused (for error envelopes). */
    public readonly label: string
  ) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/**
 * Refuse any value that could alter the shape of a joined path: empty, `.`,
 * `..`, separators, drive/root markers, or NUL.
 */
export function assertSafePathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value)
  ) {
    throw new PathContainmentError(
      `${label} must be a single path segment; got ${JSON.stringify(value)}.`,
      label
    );
  }
  return value;
}

/**
 * Refuse a checked-in relative path that is absolute or escapes upward.
 * Normalization catches `a/../../b` shapes, not just literal leading dots.
 */
export function assertSafeRelativePath(value: string, label: string): string {
  if (value.length === 0 || value.includes('\0')) {
    throw new PathContainmentError(`${label} must be a non-empty relative path.`, label);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new PathContainmentError(
      `${label} must stay inside the repository; absolute path ${JSON.stringify(value)} refused.`,
      label
    );
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new PathContainmentError(
      `${label} must stay inside the repository; ${JSON.stringify(value)} escapes upward.`,
      label
    );
  }
  return value;
}

/**
 * Refuse relative paths whose lexical spelling does not name the reported
 * entry directly. This is required for manifest and mutation paths, where
 * normalizing `a/../b` to `b` would make review output disagree with the
 * filesystem entry that is actually changed.
 */
export function assertCanonicalRelativePath(value: string, label: string): string {
  assertSafeRelativePath(value, label);
  if (
    value.split(/[\\/]/u).some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new PathContainmentError(
      `${label} must be a canonical relative path; got ${JSON.stringify(value)}.`,
      label
    );
  }
  return value;
}

/**
 * The display-path form of {@link assertCanonicalRelativePath}, for targets a
 * mutation may legitimately own OUTSIDE the repository root — a hooks
 * directory under `core.hooksPath`, or the common dir's `info/exclude` seen
 * from a linked worktree. Those have no repo-relative spelling, so a LEADING
 * `..` run is the honest one and is allowed here. Containment for such targets
 * is enforced separately, against the mutation's own root; what this preserves
 * is the reporting invariant the canonical form exists for — an INTERIOR `..`
 * would normalize to a different file than the one named, so it stays refused.
 */
export function assertCanonicalMutationPath(value: string, label: string): string {
  if (value.length === 0 || value.includes('\0')) {
    throw new PathContainmentError(`${label} must be a non-empty relative path.`, label);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new PathContainmentError(
      `${label} must be a relative path; absolute path ${JSON.stringify(value)} refused.`,
      label
    );
  }
  const segments = value.split(/[\\/]/u);
  let first = 0;
  while (first < segments.length && segments[first] === '..') first += 1;
  const named = segments.slice(first);
  if (
    named.length === 0 ||
    named.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new PathContainmentError(
      `${label} must be a canonical relative path; got ${JSON.stringify(value)}.`,
      label
    );
  }
  return value;
}

export function isDanglingFinalSymlink(target: string): boolean {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return false;
  }
  if (!stats.isSymbolicLink()) return false;
  try {
    realpathSync(target);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw err;
  }
}

/**
 * Resolved, symlink-aware containment. The target's deepest existing ancestor
 * is realpath-resolved, the not-yet-existing suffix is re-appended, and the
 * result must sit strictly beneath `root` unless `allowRoot` is set. Use the
 * returned canonical path for the protected operation.
 */
export function assertResolvedWithin(
  target: string,
  root: string,
  label: string,
  opts: { allowRoot?: boolean; rejectSymlinks?: boolean } = {}
): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const rootReal = realpathSync(absoluteRoot);
  if (opts.rejectSymlinks === true) {
    assertNoSymlinkComponents(absoluteTarget, absoluteRoot, rootReal, label);
  }
  const resolved = resolveCanonicalPath(absoluteTarget, label);
  if (resolved === rootReal) {
    if (opts.allowRoot === true) return resolved;
    throw new PathContainmentError(
      `${label} resolves to the containment root itself (${rootReal}); refusing.`,
      label
    );
  }
  if (!resolved.startsWith(rootReal + path.sep)) {
    throw new PathContainmentError(
      `${label} resolves outside ${rootReal}; got ${resolved}.`,
      label
    );
  }
  return resolved;
}

export function resolveCanonicalPath(target: string, label: string): string {
  const { real, rest } = nearestExistingRealpath(path.resolve(target), label);
  return rest.length > 0 ? path.join(real, ...rest) : real;
}

function assertNoSymlinkComponents(
  absoluteTarget: string,
  absoluteRoot: string,
  rootReal: string,
  label: string
): void {
  const walkRoot = isWithinOrEqual(absoluteTarget, absoluteRoot)
    ? absoluteRoot
    : isWithinOrEqual(absoluteTarget, rootReal)
      ? rootReal
      : null;
  if (walkRoot === null) return;
  const relative = path.relative(walkRoot, absoluteTarget);
  let current = walkRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw new PathContainmentError(
        `cannot establish containment for ${absoluteTarget}: ${current} could not be inspected.`,
        label
      );
    }
    if (stats.isSymbolicLink()) {
      throw new PathContainmentError(
        `${label} traverses symbolic link ${current}; managed storage paths must not contain symlinks.`,
        label
      );
    }
  }
}

function isWithinOrEqual(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep))
  );
}

function nearestExistingRealpath(
  absolute: string,
  label: string
): { real: string; rest: string[] } {
  let current = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      // A dangling symlink exists even though realpath reports ENOENT. Treating
      // that as an uncreated suffix lets the later filesystem operation follow
      // the link and create its target outside the root.
      lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new PathContainmentError(
          `cannot establish containment for ${absolute}: ${current} could not be inspected.`,
          label
        );
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { real: absolute, rest: [] };
      }
      rest.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return { real: realpathSync(current), rest };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        try {
          lstatSync(current);
        } catch (recheckError) {
          const recheckCode = (recheckError as NodeJS.ErrnoException).code;
          if (recheckCode === 'ENOENT' || recheckCode === 'ENOTDIR') {
            const parent = path.dirname(current);
            if (parent === current) return { real: absolute, rest: [] };
            rest.unshift(path.basename(current));
            current = parent;
            continue;
          }
        }
      }
      throw new PathContainmentError(
        `cannot establish containment for ${absolute}: existing path ${current} could not be resolved.`,
        label
      );
    }
  }
}
