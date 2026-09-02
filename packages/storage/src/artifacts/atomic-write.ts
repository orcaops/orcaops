import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin } from '../paths/containment.js';

/**
 * Write a file atomically: write to a sibling temp file, then rename onto the
 * target. Rename is atomic on POSIX and on NTFS. Creates parent directories.
 *
 * On a write/rename failure the sibling `*.tmp.*` is unlinked (best-effort)
 * before the original error is rethrown, so a failed write leaves nothing
 * behind. Mirrors apps/orcaops-cli/src/lib/atomic-write.ts.
 */
/**
 * **Durability contract — REBUILDABLE CACHE, deliberately.** This helper
 * gives atomicity, not durability: the bytes are not fsynced and neither is
 * the parent directory, so a power loss can leave the previous contents (or
 * none). That is sufficient because every consumer writes state re-derivable
 * from the event log — projections, digests, resume text, caches — and the
 * read paths already recover by comparing `source_event_id` and rebuilding.
 * Anything that ACKNOWLEDGES to a caller must not use this; see
 * `fs/durable.ts`.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  containmentRoot?: string
): Promise<void> {
  const resolveTarget = (target: string, label: string): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  let targetPath = resolveTarget(filePath, 'atomic write target');
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  targetPath = resolveTarget(filePath, 'atomic write target');
  let tmpPath = resolveTarget(
    `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    'atomic write temporary file'
  );
  try {
    await writeFile(tmpPath, content, 'utf8');
    tmpPath = resolveTarget(tmpPath, 'atomic write temporary file');
    targetPath = resolveTarget(filePath, 'atomic write target');
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      const cleanupPath = resolveTarget(tmpPath, 'atomic write temporary file');
      await unlink(cleanupPath).catch(() => {});
    } catch {
      // Refusing an unsafe cleanup is preferable to masking the write failure.
    }
    throw err;
  }
}
