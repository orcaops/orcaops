// Vendored from vercel-labs/skills@9a7d8ac (v1.5.13), MIT License.
// Upstream: https://github.com/vercel-labs/skills  — reduced to data + detection for orcaops.
//
// Sourced from upstream src/installer.ts: createSymlink + its transitive
// helpers (resolveParentSymlinks, resolveSymlinkTarget) and sanitizeName.

import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * Sanitizes a filename/directory name to prevent path traversal attacks
 * and ensures it follows kebab-case convention
 * @param name - The name to sanitize
 * @returns Sanitized name safe for use in file paths
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    // Replace any sequence of characters that are NOT lowercase letters (a-z),
    // digits (0-9), dots (.), or underscores (_) with a single hyphen.
    // This converts spaces, special chars, and path traversal attempts (../) into hyphens.
    .replace(/[^a-z0-9._]+/g, '-')
    // Remove leading/trailing dots and hyphens to prevent hidden files (.) and
    // ensure clean directory names. The pattern matches:
    // - ^[.\-]+ : one or more dots or hyphens at the start
    // - [.\-]+$ : one or more dots or hyphens at the end
    // eslint-disable-next-line no-useless-escape -- regex body kept byte-for-byte from upstream
    .replace(/^[.\-]+|[.\-]+$/g, '');

  // Limit to 255 chars (common filesystem limit), fallback to 'unnamed-skill' if empty
  return sanitized.substring(0, 255) || 'unnamed-skill';
}

function resolveSymlinkTarget(linkPath: string, linkTarget: string): string {
  return resolve(dirname(linkPath), linkTarget);
}

/**
 * Resolve a path's parent directory through symlinks, keeping the final component.
 * This handles the case where a parent directory (e.g., ~/.claude/skills) is a symlink
 * to another location (e.g., ~/.agents/skills). In that case, computing relative paths
 * from the symlink path produces broken symlinks.
 *
 * Returns the real path of the parent + the original basename.
 * If realpath fails (parent doesn't exist), returns the original resolved path.
 */
async function resolveParentSymlinks(path: string): Promise<string> {
  const resolved = resolve(path);
  const dir = dirname(resolved);
  const base = basename(resolved);
  try {
    const realDir = await realpath(dir);
    return join(realDir, base);
  } catch {
    return resolved;
  }
}

/**
 * Creates a symlink, handling cross-platform differences
 * Returns true if symlink was created, false if fallback to copy is needed
 */
export async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    const resolvedTarget = resolve(target);
    const resolvedLinkPath = resolve(linkPath);

    // Use realpath to handle cases where parent directories are symlinked.
    // This prevents deleting the canonical directory if the agent directory
    // is a symlink to the canonical location.
    const [realTarget, realLinkPath] = await Promise.all([
      realpath(resolvedTarget).catch(() => resolvedTarget),
      realpath(resolvedLinkPath).catch(() => resolvedLinkPath),
    ]);

    if (realTarget === realLinkPath) {
      return true;
    }

    // Also check with symlinks resolved in parent directories.
    // This handles cases where e.g. ~/.claude/skills is a symlink to ~/.agents/skills,
    // so ~/.claude/skills/<skill> and ~/.agents/skills/<skill> are physically the same.
    const realTargetWithParents = await resolveParentSymlinks(target);
    const realLinkPathWithParents = await resolveParentSymlinks(linkPath);

    if (realTargetWithParents === realLinkPathWithParents) {
      return true;
    }

    try {
      const stats = await lstat(linkPath);
      if (stats.isSymbolicLink()) {
        const existingTarget = await readlink(linkPath);
        if (resolveSymlinkTarget(linkPath, existingTarget) === resolvedTarget) {
          return true;
        }
        await rm(linkPath);
      } else {
        await rm(linkPath, { recursive: true });
      }
    } catch (err: unknown) {
      // ELOOP = circular symlink, ENOENT = doesn't exist
      // For ELOOP, try to remove the broken symlink
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP') {
        try {
          await rm(linkPath, { force: true });
        } catch {
          // If we can't remove it, symlink creation will fail and trigger copy fallback
        }
      }
      // For ENOENT or other errors, continue to symlink creation
    }

    const linkDir = dirname(linkPath);
    await mkdir(linkDir, { recursive: true });

    // Use the real (symlink-resolved) parent directory for computing the relative path.
    // This ensures the symlink target is correct even when the link's parent dir is a symlink.
    const realLinkDir = await resolveParentSymlinks(linkDir);
    const relativePath = relative(realLinkDir, target);
    const symlinkType = platform() === 'win32' ? 'junction' : undefined;
    const symlinkTarget = symlinkType === 'junction' ? resolvedTarget : relativePath;

    await symlink(symlinkTarget, linkPath, symlinkType);
    return true;
  } catch {
    return false;
  }
}
