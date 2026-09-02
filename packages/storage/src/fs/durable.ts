import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin } from '../paths/containment.js';

/**
 * Durability primitives for ACKNOWLEDGED writes.
 *
 * The distinction that matters: `rename(2)` gives atomic VISIBILITY, not
 * durability. A tmp-then-rename write is safe against a torn file, but after
 * a power loss it can leave neither the old nor the new bytes on disk. Paths
 * that acknowledge to a caller — "the checkpoint closed", "this usage is
 * recorded" — need the bytes fsynced before the rename and the directory
 * entry fsynced after it. Paths whose contents are rebuildable from such a
 * log do NOT need this and deliberately do not use it.
 */

const IS_WINDOWS = process.platform === 'win32';

/**
 * fsync a directory so a create/rename within it survives a crash.
 *
 * BEST-EFFORT, and callers must not describe it otherwise: some platforms and
 * filesystems refuse to open a directory for this, and there is no portable
 * fallback. When it fails the rename is still atomic and the file's own bytes
 * are still fsynced; only the durability of the directory ENTRY is
 * unconfirmed. Windows has no directory-fsync concept at all.
 */
export async function fsyncDir(dir: string, containmentRoot?: string): Promise<void> {
  if (IS_WINDOWS) return;
  const target =
    containmentRoot === undefined
      ? dir
      : assertResolvedWithin(dir, containmentRoot, 'directory fsync', {
          allowRoot: true,
          rejectSymlinks: true,
        });
  let handle;
  try {
    handle = await open(target, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Directory fsync unsupported here.
  } finally {
    await handle.close();
  }
}

/**
 * Confirm a directory fsync or throw before a caller destroys unique prior
 * state. Windows has no directory-fsync primitive, so only file-byte sync and
 * atomic rename are available there.
 */
export async function fsyncDirStrict(dir: string, containmentRoot?: string): Promise<void> {
  if (IS_WINDOWS) return;
  const target =
    containmentRoot === undefined
      ? dir
      : assertResolvedWithin(dir, containmentRoot, 'strict directory fsync', {
          allowRoot: true,
          rejectSymlinks: true,
        });
  const handle = await open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Create every directory in `dir`, fsyncing each newly created level's
 * PARENT so the new links themselves survive a crash. `mkdir -p` followed by
 * syncing only the deepest directory leaves the intermediate links
 * unsynced — a first capture in a fresh clone could lose the containing
 * directory and, with it, everything inside.
 */
export async function mkdirDurable(
  dir: string,
  mode = 0o700,
  ownedRoot?: string,
  containmentRoot?: string
): Promise<void> {
  const resolveDir = (target: string, label: string, allowRoot = false): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, {
          allowRoot,
          rejectSymlinks: true,
        });
  let targetDir = resolveDir(dir, 'durable directory');
  const created = await mkdir(targetDir, { recursive: true, mode });
  targetDir = resolveDir(dir, 'durable directory');
  const targetOwnedRoot =
    ownedRoot === undefined ? undefined : resolveDir(ownedRoot, 'owned directory root', true);
  // `mkdir` applies its mode only to directories it CREATES, so any level
  // that predates this call keeps whatever mode it had — including an
  // ancestor. Tighten from `ownedRoot` down to `dir` (or just `dir` when no
  // root is given), because creating `<artifacts>/<id>` must not leave a
  // permissive `<artifacts>` behind it.
  //
  // `ownedRoot` is a GRANT from a caller that knows what it owns — never
  // derived from `dir`'s shape here. Inferring it would mean chmod'ing (or
  // refusing to use) whatever happens to sit above the target, which for a
  // caller working in an mkdtemp is the OS temp directory. Omit it and only
  // the target itself is tightened.
  for (const level of levelsToTighten(targetDir, targetOwnedRoot)) {
    await tightenDir(resolveDir(level, 'directory chmod', true), mode);
  }
  if (created === undefined) return; // nothing new; parents already durable
  // `mkdir` returns the FIRST directory it created; every level from there
  // down is new, so sync each new level's parent.
  let current = targetDir;
  while (current.length >= created.length) {
    await fsyncDir(path.dirname(current), containmentRoot);
    if (current === created) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** `ownedRoot`..`dir` inclusive, deepest first; just `dir` when unbounded. */
function levelsToTighten(dir: string, ownedRoot?: string): string[] {
  if (ownedRoot === undefined) return [dir];
  const levels: string[] = [];
  let current = path.resolve(dir);
  const root = path.resolve(ownedRoot);
  for (;;) {
    levels.push(current);
    if (current === root) break;
    const parent = path.dirname(current);
    // `dir` outside `ownedRoot` (or a bad root): tighten only what we were
    // asked for rather than walking to the filesystem root.
    if (parent === current) return [path.resolve(dir)];
    current = parent;
  }
  return levels;
}

/**
 * Narrow a directory that is more permissive than `mode`. THROWS when it
 * cannot: "tightened or refused" is the requirement, and silently proceeding
 * over a world-writable directory we failed to chmod would be neither.
 * A directory that vanished underneath us is not a failure.
 */
async function tightenDir(dir: string, mode: number): Promise<void> {
  if (IS_WINDOWS) return;
  let current: number;
  try {
    current = (await stat(dir)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if ((current & ~mode & 0o777) === 0) return;
  try {
    await chmod(dir, mode);
  } catch (cause) {
    throw new Error(
      `refusing to use ${dir}: mode ${current.toString(8)} is more permissive than ` +
        `${mode.toString(8)} and could not be tightened`,
      { cause }
    );
  }
}

/** Write `data` to `file` (creating it with `mode`) and fsync the bytes. */
export async function writeDurable(
  file: string,
  data: Buffer | string,
  mode = 0o600,
  containmentRoot?: string
): Promise<void> {
  const target =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'durable write target', {
          rejectSymlinks: true,
        });
  const handle = await open(target, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomically REPLACE `file` with `data`, durably: the bytes are fsynced to a
 * sibling temp file, renamed into place, and the directory entry fsynced
 * (best-effort, per `fsyncDir`). The durable counterpart of the
 * rebuildable-cache `atomicWriteFile` — for precious single-file state
 * (nothing re-derives it) that must survive both a torn write and a power
 * loss. A failed write unlinks the temp sibling and rethrows.
 */
export async function replaceDurable(
  file: string,
  data: Buffer | string,
  mode = 0o600,
  containmentRoot?: string
): Promise<void> {
  const resolveTarget = (target: string, label: string): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  const targetPath = resolveTarget(file, 'durable replace target');
  const tmpPath = resolveTarget(
    `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    'durable replace temporary file'
  );
  try {
    await writeDurable(tmpPath, data, mode, containmentRoot);
    await rename(tmpPath, targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  await fsyncDir(path.dirname(targetPath), containmentRoot);
}

/**
 * Append `line` to `file` and fsync it, creating the file 0600 if absent.
 * Used for the append-only logs whose returns are acknowledgements.
 */
export async function appendDurable(
  file: string,
  line: string,
  containmentRoot?: string
): Promise<void> {
  const appended = await appendLine(file, line, containmentRoot, true);
  if (appended.created) await fsyncDir(path.dirname(appended.target), containmentRoot);
}

/**
 * Append without acknowledging durability. The owning store must call
 * `flushDurableAppend` before the surrounding operation returns success.
 */
export async function appendUnflushed(
  file: string,
  line: string,
  containmentRoot?: string
): Promise<void> {
  await appendLine(file, line, containmentRoot, false);
}

async function appendLine(
  file: string,
  line: string,
  containmentRoot: string | undefined,
  sync: boolean
): Promise<{ created: boolean; target: string }> {
  const target =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'durable append target', {
          rejectSymlinks: true,
        });
  // 'a+' rather than 'a': the newline guard below needs to READ the final
  // byte, and appends still land at end-of-file regardless of position.
  const handle = await open(target, 'a+', 0o600);
  let created = false;
  try {
    // Stat BEFORE writing: a file this call just created is size 0. Comparing
    // against the line length instead (as an earlier version did) is both
    // never true for a new file and occasionally true for an existing one.
    const size = (await handle.stat()).size;
    created = size === 0;
    // Newline guard: a crash can leave the final line without its
    // terminator (in the worst benign case a fully-flushed valid line
    // missing only the '\n'). Appending directly would merge this line
    // into it — terminate the predecessor first so both stay parseable.
    let prefix = '';
    if (size > 0) {
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, size - 1);
      if (lastByte.toString('utf8') !== '\n') prefix = '\n';
    }
    await handle.writeFile(prefix + line);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  return { created, target };
}

/** Flush all prior unflushed appends and the log's directory entry. */
export async function flushDurableAppend(file: string, containmentRoot?: string): Promise<void> {
  const target =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'durable append flush target', {
          rejectSymlinks: true,
        });
  const handle = await open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDir(path.dirname(target), containmentRoot);
}
