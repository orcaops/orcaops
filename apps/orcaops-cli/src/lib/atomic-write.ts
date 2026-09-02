import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin } from '@orcaops/storage';

export interface AtomicWriteFileOptions {
  mode?: number;
  /** Runs after the temp write, immediately before the rename — a last-moment
   * pre-image check so a concurrent editor's change is detected rather than
   * clobbered. */
  beforeRename?: () => Promise<void>;
  containmentRoot?: string;
}

/**
 * Write a file atomically: write to a sibling temp file, then rename onto the
 * target. rename(2) is atomic on POSIX and NTFS, so a crash mid-write can never
 * leave the target half-written — a reader (or the next CLI run) sees either the
 * complete old bytes or the complete new bytes, never a torn file.
 *
 * Mirrors packages/storage/src/artifacts/atomic-write.ts; kept CLI-local rather
 * than imported because that copy is not part of @orcaops/storage's public API,
 * and the codebase already follows "each package owns its copy" (cf.
 * packages/core/src/credentials/file-store.ts).
 *
 * On a write/rename failure the sibling `*.tmp.*` is unlinked (best-effort)
 * before the original error is rethrown, so a failed write leaves nothing
 * behind. The target is never touched on failure.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  containmentRootOrOptions?: string | AtomicWriteFileOptions
): Promise<void> {
  const options: AtomicWriteFileOptions =
    typeof containmentRootOrOptions === 'string'
      ? { containmentRoot: containmentRootOrOptions }
      : (containmentRootOrOptions ?? {});
  const { containmentRoot } = options;
  const resolveTarget = (target: string, label: string): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  let targetPath = resolveTarget(filePath, 'CLI atomic write target');
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  targetPath = resolveTarget(filePath, 'CLI atomic write target');
  let tmpPath = resolveTarget(
    `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    'CLI atomic write temporary file'
  );
  try {
    await writeFile(
      tmpPath,
      content,
      typeof content === 'string'
        ? { encoding: 'utf8', mode: options.mode }
        : { mode: options.mode }
    );
    if (options.mode !== undefined) await chmod(tmpPath, options.mode);
    tmpPath = resolveTarget(tmpPath, 'CLI atomic write temporary file');
    targetPath = resolveTarget(filePath, 'CLI atomic write target');
    await options.beforeRename?.();
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(resolveTarget(tmpPath, 'CLI atomic write temporary file')).catch(() => {});
    } catch {
      // Refusing an unsafe cleanup is preferable to masking the write failure.
    }
    throw err;
  }
}
