import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';

import { isVersionAhead } from '@orcaops/adapters';
import type { InjectPlan, PlannedFile } from '@orcaops/adapters';
import {
  assertCanonicalMutationPath,
  assertCanonicalRelativePath,
  assertResolvedWithin,
  assertSafePathSegment,
  isDanglingFinalSymlink,
  PathContainmentError,
} from '@orcaops/storage';

import type { GitignorePlan } from './gitignore.js';

/**
 * One shared mutation vocabulary every repo-mutating operation routes through, so
 * the risky commands (init/update/link/fix/prune/uninstall) get dry-run for free
 * and a single executor owns all disk writes.
 */
export type MutationKind =
  | 'create'
  | 'replace'
  | 'delete'
  | 'symlink'
  | 'inject-replace'
  | 'gitignore-entry';

export interface PlannedMutation {
  kind: MutationKind;
  /** Repo-relative path (for display). */
  path: string;
  /** Absolute target path. */
  absPath: string;
  /** Root that owns this worktree or Git-managed target. */
  containmentRoot: string;
  /** Content to write; null for delete / symlink / directory / no-op. */
  desiredContent: string | null;
  /** Current on-disk content, or null if absent / not applicable. */
  currentContent: string | null;
  /** Whether applying this actually changes the worktree (false = no-op). */
  changed: boolean;
  /** Create an (empty) directory rather than write a file. */
  isDir?: boolean;
  /** File mode, e.g. 0o755 for a git hook. */
  mode?: number;
  /** Symlink target (relative) for kind 'symlink'. */
  symlinkTarget?: string;
  /** Exact entry identity a delete must still match when it is applied. */
  deleteExpectation?: DeleteExpectation;
  /** Optional note surfaced in the preview (e.g. 'preserved-conflict'). */
  note?: string;
}

export type DeleteExpectation =
  | { kind: 'file'; content: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' };

export type MutationMode = 'apply' | 'preview';

export interface ExecuteResult {
  mode: MutationMode;
  /** Mutations that change the worktree (written when mode === 'apply'). */
  changed: PlannedMutation[];
  /** No-op mutations (already in the desired state). */
  unchanged: PlannedMutation[];
}

export const FILE_OWNERSHIP_UNVERIFIED = Symbol('file-ownership-unverified');
export type FileOwnershipRead = string | null | typeof FILE_OWNERSHIP_UNVERIFIED;

export function resolveRepositoryPath(target: string, root: string, label: string): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new PathContainmentError(`${label} requires a non-empty containment root.`, label);
  }
  return assertResolvedWithin(target, root, label, { rejectSymlinks: true });
}

export function resolveContainedRepositoryPath(
  target: string,
  root: string,
  label: string
): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new PathContainmentError(`${label} requires a non-empty containment root.`, label);
  }
  return assertResolvedWithin(target, root, label);
}

export async function readRepositoryFileOrNull(
  target: string,
  root: string,
  label: string
): Promise<string | null> {
  const safePath = resolveRepositoryPath(target, root, label);
  try {
    return await readFile(safePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readRepositoryRegularFileOrNull(
  target: string,
  root: string,
  label: string
): Promise<string | null> {
  const parent = assertResolvedWithin(path.dirname(target), root, `${label} parent`, {
    allowRoot: true,
    rejectSymlinks: true,
  });
  const entry = assertSafePathSegment(path.basename(target), `${label} entry`);
  const entryPath = path.join(parent, entry);
  let stats;
  try {
    stats = await lstat(entryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!stats.isFile()) return null;
  return readRepositoryFileOrNull(entryPath, root, label);
}

export async function repositoryRegularFileExists(
  target: string,
  root: string,
  label: string
): Promise<boolean> {
  const parent = assertResolvedWithin(path.dirname(target), root, `${label} parent`, {
    allowRoot: true,
    rejectSymlinks: true,
  });
  const entry = assertSafePathSegment(path.basename(target), `${label} entry`);
  try {
    return (await lstat(path.join(parent, entry))).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function readContainedRepositoryRegularFileOrNull(
  target: string,
  root: string,
  label: string
): Promise<string | null> {
  let safePath: string;
  try {
    safePath = resolveContainedRepositoryPath(target, root, label);
  } catch (err) {
    if (err instanceof PathContainmentError && isDanglingFinalSymlink(target)) return null;
    throw err;
  }
  try {
    if (!(await lstat(safePath)).isFile()) return null;
    return await readFile(safePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readRepositoryFileForOwnership(
  target: string,
  root: string,
  label: string
): Promise<FileOwnershipRead> {
  let parent: string;
  try {
    parent = assertResolvedWithin(path.dirname(target), root, `${label} parent`, {
      allowRoot: true,
      rejectSymlinks: true,
    });
  } catch (err) {
    if (err instanceof PathContainmentError) {
      return FILE_OWNERSHIP_UNVERIFIED;
    }
    throw err;
  }
  const entry = assertSafePathSegment(path.basename(target), `${label} entry`);
  const entryPath = path.join(parent, entry);
  let stats;
  try {
    stats = await lstat(entryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!stats.isFile()) {
    return FILE_OWNERSHIP_UNVERIFIED;
  }
  return readRepositoryFileOrNull(entryPath, root, label);
}

/**
 * Apply or preview a list of planned mutations. In 'preview' mode NOTHING is
 * written — the executor only partitions the list. In 'apply' mode each changed
 * mutation is written through the one seam here.
 */
export async function executeMutations(
  mutations: ReadonlyArray<PlannedMutation>,
  mode: MutationMode
): Promise<ExecuteResult> {
  const changed: PlannedMutation[] = [];
  const unchanged: PlannedMutation[] = [];

  if (mode === 'preview') {
    for (const mutation of mutations) {
      (mutation.changed ? changed : unchanged).push(mutation);
    }
    return { mode, changed, unchanged };
  }

  const changing = mutations.filter((mutation) => mutation.changed);
  for (const mutation of mutations) {
    if (!mutation.changed) unchanged.push(mutation);
  }
  await preflightMutations(changing);

  const applied: AppliedMutation[] = [];
  const stagePaths = new Set<string>();
  try {
    for (const mutation of changing) {
      await applyMutation(mutation, applied, stagePaths);
      changed.push(mutation);
    }
  } catch (error) {
    const cleanupErrors = await removePaths(stagePaths);
    const rollbackErrors = await rollbackMutations(applied);
    if (cleanupErrors.length > 0 || rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors, ...rollbackErrors],
        `Mutation batch failed and rollback requires inspection: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }

  const cleanupErrors = await removeMutationBackups(applied);
  cleanupErrors.push(...(await removePaths(stagePaths)));
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Mutation batch committed but cleanup failed.');
  }
  return { mode, changed, unchanged };
}

type MutationEntryState =
  | { kind: 'absent' }
  | { kind: 'file'; content: Buffer; mode: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory'; entries: string[] }
  | { kind: 'other'; mode: number };

interface AppliedMutation {
  target: string;
  before: MutationEntryState;
  expected: MutationEntryState;
  backupPath: string | null;
}

async function preflightMutations(mutations: readonly PlannedMutation[]): Promise<void> {
  for (const mutation of mutations) {
    if (mutation.kind === 'delete') await assertDeleteExpectation(mutation);
  }

  const priorTargets = new Set<string>();
  for (const mutation of mutations) {
    const targetKey = path.resolve(mutation.absPath);
    if (mutation.kind === 'delete') {
      priorTargets.add(targetKey);
      continue;
    }
    if (mutation.kind === 'symlink') {
      assertSymlinkTarget(mutation);
      resolveSymlinkPayload(mutation, path.dirname(mutation.absPath));
      const parent = resolveMutationParent(mutation);
      resolveSymlinkPayload(mutation, parent);
      if (!priorTargets.has(targetKey)) {
        const target = resolveMutationTarget(mutation);
        assertAbsentMutationTarget(mutation, await inspectMutationEntry(target));
      }
    } else if (mutation.isDir) {
      resolveMutationParent(mutation);
      if (!priorTargets.has(targetKey)) {
        const target = resolveMutationTarget(mutation);
        assertAbsentMutationTarget(mutation, await inspectMutationEntry(target));
      }
    } else {
      resolveMutationParent(mutation);
      if (!priorTargets.has(targetKey)) {
        const target = resolveMutationTarget(mutation);
        assertFileMutationTarget(mutation, await inspectMutationEntry(target));
      }
    }
    priorTargets.add(targetKey);
  }
}

async function applyMutation(
  mutation: PlannedMutation,
  applied: AppliedMutation[],
  stagePaths: Set<string>
): Promise<void> {
  if (mutation.kind === 'delete') {
    await applyDeleteMutation(mutation, applied);
    return;
  }
  if (mutation.isDir) {
    const parent = resolveMutationParent(mutation);
    await ensureMutationDirectories(parent, mutation.containmentRoot, applied);
    const target = resolveMutationTarget(mutation);
    const before = await inspectMutationEntry(target);
    assertAbsentMutationTarget(mutation, before);
    await mkdir(target);
    applied.push({
      target,
      before,
      expected: { kind: 'directory', entries: [] },
      backupPath: null,
    });
    return;
  }
  if (mutation.kind === 'symlink') {
    assertSymlinkTarget(mutation);
    const parent = resolveMutationParent(mutation);
    await ensureMutationDirectories(parent, mutation.containmentRoot, applied);
    const target = resolveMutationTarget(mutation);
    resolveSymlinkPayload(mutation, parent);
    const before = await inspectMutationEntry(target);
    assertAbsentMutationTarget(mutation, before);
    await symlink(mutation.symlinkTarget!, target);
    applied.push({
      target,
      before,
      expected: { kind: 'symlink', target: mutation.symlinkTarget! },
      backupPath: null,
    });
    return;
  }
  await applyFileMutation(mutation, applied, stagePaths);
}

async function applyDeleteMutation(
  mutation: PlannedMutation,
  applied: AppliedMutation[]
): Promise<void> {
  // Mutation-path variant: linked-worktree git-hook deletes legally lead with
  // `..` (their containment root is the hooks dir, not the repo root), and the
  // apply-time gate must accept exactly what the plan-time gate accepted.
  assertCanonicalMutationPath(mutation.path, `${mutationLabel(mutation)} path`);
  await assertDeleteExpectation(mutation);
  const target = resolveMutationEntry(mutation);
  const before = await inspectMutationEntry(target);
  if (before.kind === 'absent') {
    throw new Error(`Refusing to delete ${mutation.path}: entry disappeared after planning.`);
  }
  const entry = await detachMutationEntry(target, before, applied);
  entry.expected = { kind: 'absent' };
}

async function applyFileMutation(
  mutation: PlannedMutation,
  applied: AppliedMutation[],
  stagePaths: Set<string>
): Promise<void> {
  const parent = resolveMutationParent(mutation);
  await ensureMutationDirectories(parent, mutation.containmentRoot, applied);
  const target = resolveMutationTarget(mutation);
  const before = await inspectMutationEntry(target);
  assertFileMutationTarget(mutation, before);

  const stagePath = temporaryMutationSibling(target, 'stage');
  stagePaths.add(stagePath);
  const writeMode = mutation.mode ?? (before.kind === 'file' ? before.mode : undefined);
  await writeMutationStage(stagePath, mutation.desiredContent ?? '', writeMode);
  const expected = await inspectMutationEntry(stagePath);

  if (before.kind === 'absent') {
    await link(stagePath, target);
    applied.push({ target, before, expected, backupPath: null });
    await syncMutationDirectory(parent);
    await rm(stagePath);
    await syncMutationDirectory(parent);
    stagePaths.delete(stagePath);
    return;
  }
  if (before.kind !== 'file') {
    throw new Error(`Refusing to replace ${mutation.path}: entry kind changed after planning.`);
  }

  const entry = await preserveMutationFile(target, before, applied);
  await syncMutationDirectory(parent);
  const current = await inspectMutationEntry(target);
  if (!sameMutationEntry(before, current)) {
    throw new Error(`Refusing to mutate ${mutation.path}: entry changed during application.`);
  }
  await rename(stagePath, target);
  entry.expected = expected;
  await syncMutationDirectory(parent);
  stagePaths.delete(stagePath);
}

async function writeMutationStage(
  stagePath: string,
  content: string,
  mode: number | undefined
): Promise<void> {
  const handle = await open(stagePath, 'wx', mode ?? 0o666);
  try {
    await handle.writeFile(content, 'utf8');
    if (mode !== undefined) await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncMutationDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function preserveMutationFile(
  target: string,
  before: Extract<MutationEntryState, { kind: 'file' }>,
  applied: AppliedMutation[]
): Promise<AppliedMutation> {
  const backupPath = temporaryMutationSibling(target, 'backup');
  await link(target, backupPath);
  const actual = await inspectMutationEntry(backupPath);
  if (!sameMutationEntry(before, actual)) {
    await rm(backupPath, { force: true });
    throw new Error(`Refusing to mutate ${target}: entry changed during application.`);
  }
  const entry: AppliedMutation = {
    target,
    before,
    expected: before,
    backupPath,
  };
  applied.push(entry);
  return entry;
}

async function detachMutationEntry(
  target: string,
  before: Exclude<MutationEntryState, { kind: 'absent' }>,
  applied: AppliedMutation[]
): Promise<AppliedMutation> {
  const backupPath = temporaryMutationSibling(target, 'backup');
  await rename(target, backupPath);
  const entry: AppliedMutation = {
    target,
    before,
    expected: { kind: 'absent' },
    backupPath,
  };
  applied.push(entry);
  const actual = await inspectMutationEntry(backupPath);
  entry.before = actual;
  if (!sameMutationEntry(before, actual)) {
    throw new Error(`Refusing to mutate ${target}: entry changed during application.`);
  }
  return entry;
}

async function ensureMutationDirectories(
  parent: string,
  containmentRoot: string,
  applied: AppliedMutation[]
): Promise<void> {
  const root = await realpath(containmentRoot);
  const missing: string[] = [];
  let cursor = parent;
  while (true) {
    const state = await inspectMutationEntry(cursor);
    if (state.kind === 'directory') break;
    if (state.kind !== 'absent') {
      throw new Error(`Cannot create mutation parent ${cursor}: existing entry is ${state.kind}.`);
    }
    if (cursor === root) {
      throw new PathContainmentError(
        `Mutation containment root does not exist: ${containmentRoot}`,
        containmentRoot
      );
    }
    missing.push(cursor);
    const next = path.dirname(cursor);
    const relative = path.relative(root, next);
    if (
      next === cursor ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new PathContainmentError(
        `Mutation parent resolves outside containment root: ${parent}`,
        parent
      );
    }
    cursor = next;
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if ((await inspectMutationEntry(directory)).kind === 'directory') continue;
      }
      throw error;
    }
    applied.push({
      target: directory,
      before: { kind: 'absent' },
      expected: { kind: 'directory', entries: [] },
      backupPath: null,
    });
  }
}

async function rollbackMutations(applied: readonly AppliedMutation[]): Promise<Error[]> {
  const errors: Error[] = [];
  for (const entry of [...applied].reverse()) {
    try {
      const current = await inspectMutationEntry(entry.target);
      if (!sameMutationEntry(current, entry.expected)) {
        throw new Error(
          `Refusing to roll back ${entry.target}: entry changed after it was applied.`
        );
      }
      if (entry.backupPath === null) {
        await removeMutationEntry(entry.target, current);
        continue;
      }
      const backup = await inspectMutationEntry(entry.backupPath);
      if (!sameMutationEntry(backup, entry.before)) {
        throw new Error(`Refusing to roll back ${entry.target}: backup identity changed.`);
      }
      await removeMutationEntry(entry.target, current);
      await rename(entry.backupPath, entry.target);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

async function removeMutationEntry(target: string, state: MutationEntryState): Promise<void> {
  if (state.kind === 'absent') return;
  if (state.kind === 'directory') {
    await rmdir(target);
    return;
  }
  await rm(target, { force: false });
}

async function removePaths(paths: ReadonlySet<string>): Promise<Error[]> {
  const errors: Error[] = [];
  for (const target of paths) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

async function removeMutationBackups(applied: readonly AppliedMutation[]): Promise<Error[]> {
  const errors: Error[] = [];
  for (const entry of [...applied].reverse()) {
    if (entry.backupPath === null) continue;
    try {
      const backup = await inspectMutationEntry(entry.backupPath);
      if (backup.kind === 'absent') continue;
      if (!sameMutationEntry(backup, entry.before)) {
        throw new Error(`Refusing to remove ${entry.backupPath}: backup identity changed.`);
      }
      await rm(entry.backupPath, { recursive: backup.kind === 'directory', force: false });
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

async function inspectMutationEntry(target: string): Promise<MutationEntryState> {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (stats.isFile()) {
    return { kind: 'file', content: await readFile(target), mode: stats.mode & 0o777 };
  }
  if (stats.isSymbolicLink()) return { kind: 'symlink', target: await readlink(target) };
  if (stats.isDirectory()) return { kind: 'directory', entries: (await readdir(target)).sort() };
  return { kind: 'other', mode: stats.mode };
}

function sameMutationEntry(left: MutationEntryState, right: MutationEntryState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'absent') return true;
  if (left.kind === 'file' && right.kind === 'file') {
    return left.mode === right.mode && left.content.equals(right.content);
  }
  if (left.kind === 'symlink' && right.kind === 'symlink') return left.target === right.target;
  if (left.kind === 'directory' && right.kind === 'directory') {
    return (
      left.entries.length === right.entries.length &&
      left.entries.every((entry, index) => entry === right.entries[index])
    );
  }
  return left.kind === 'other' && right.kind === 'other' && left.mode === right.mode;
}

function assertFileMutationTarget(mutation: PlannedMutation, state: MutationEntryState): void {
  if (mutation.kind === 'create') {
    assertAbsentMutationTarget(mutation, state);
    return;
  }
  if (state.kind === 'absent' && mutation.currentContent === '') {
    return;
  }
  if (state.kind !== 'file') {
    throw new Error(`Refusing to replace ${mutation.path}: entry kind changed after planning.`);
  }
  if (mutation.currentContent === null) {
    throw new Error(`replace mutation for ${mutation.path} has no currentContent (planner bug)`);
  }
  if (state.content.toString('utf8') !== mutation.currentContent) {
    throw new Error(`Refusing to replace ${mutation.path}: file content changed after planning.`);
  }
}

function assertAbsentMutationTarget(mutation: PlannedMutation, state: MutationEntryState): void {
  if (state.kind !== 'absent') {
    throw new Error(`Refusing to create ${mutation.path}: entry appeared after planning.`);
  }
}

function assertSymlinkTarget(mutation: PlannedMutation): void {
  if (!mutation.symlinkTarget) {
    throw new Error(`symlink mutation for ${mutation.path} has no symlinkTarget (planner bug)`);
  }
}

function temporaryMutationSibling(target: string, suffix: 'stage' | 'backup'): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.orcaops-mutation-${randomUUID()}.${suffix}`
  );
}

async function assertDeleteExpectation(m: PlannedMutation): Promise<void> {
  const expected = m.deleteExpectation;
  if (expected === undefined) {
    throw new Error(`delete mutation for ${m.path} has no deleteExpectation (planner bug)`);
  }
  assertCanonicalMutationPath(m.path, `${mutationLabel(m)} path`);
  const entry = resolveMutationEntry(m);
  let stats;
  try {
    stats = await lstat(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Refusing to delete ${m.path}: entry disappeared after planning.`);
    }
    throw error;
  }

  if (expected.kind === 'file') {
    if (!stats.isFile()) {
      throw new Error(`Refusing to delete ${m.path}: entry kind changed after planning.`);
    }
    const current = await readFile(entry, 'utf8');
    if (current !== expected.content) {
      throw new Error(`Refusing to delete ${m.path}: file content changed after planning.`);
    }
    return;
  }
  if (expected.kind === 'symlink') {
    if (!stats.isSymbolicLink()) {
      throw new Error(`Refusing to delete ${m.path}: entry kind changed after planning.`);
    }
    const currentTarget = await readlink(entry);
    if (currentTarget !== expected.target) {
      throw new Error(`Refusing to delete ${m.path}: symlink target changed after planning.`);
    }
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to delete ${m.path}: entry kind changed after planning.`);
  }
}

function mutationLabel(m: PlannedMutation): string {
  return `repository mutation ${m.path}`;
}

function assertMutationRoot(m: PlannedMutation): void {
  if (typeof m.containmentRoot !== 'string' || m.containmentRoot.length === 0) {
    throw new PathContainmentError(
      `${mutationLabel(m)} requires a non-empty containment root.`,
      mutationLabel(m)
    );
  }
}

function resolveMutationTarget(m: PlannedMutation): string {
  assertMutationRoot(m);
  return assertResolvedWithin(m.absPath, m.containmentRoot, mutationLabel(m), {
    rejectSymlinks: true,
  });
}

function resolveMutationParent(m: PlannedMutation): string {
  assertMutationRoot(m);
  return assertResolvedWithin(
    path.dirname(m.absPath),
    m.containmentRoot,
    `${mutationLabel(m)} parent`,
    { allowRoot: true, rejectSymlinks: true }
  );
}

function resolveMutationEntry(m: PlannedMutation): string {
  const entry = assertSafePathSegment(path.basename(m.absPath), `${mutationLabel(m)} entry`);
  const parent = resolveMutationParent(m);
  return path.join(parent, entry);
}

function resolveSymlinkPayload(m: PlannedMutation, parent: string): string {
  return assertResolvedWithin(
    path.resolve(parent, m.symlinkTarget as string),
    m.containmentRoot,
    `symlink target for ${m.path}`,
    { rejectSymlinks: true }
  );
}

/** A `+`/`~`/`-` glyph for a mutation, for human preview output. */
export function mutationGlyph(m: PlannedMutation): string {
  if (m.kind === 'delete') return '-';
  if (m.kind === 'replace' || m.kind === 'inject-replace') return '~';
  // A gitignore create has currentContent '' (absent file), not null → treat as create.
  if (m.kind === 'gitignore-entry' && m.currentContent === '') return '+';
  if (m.currentContent === null && !m.isDir) return '+';
  if (m.isDir) return '+';
  return '~';
}

/** One human-readable preview line for a mutation. */
export function describeMutation(m: PlannedMutation): string {
  const suffix = m.note ? ` (${m.note})` : ` (${m.kind})`;
  return `  ${mutationGlyph(m)} ${m.path}${suffix}`;
}

/** Render a `--dry-run` preview block from a mutation list. */
export function formatDryRunPreview(mutations: ReadonlyArray<PlannedMutation>): string {
  const changed = mutations.filter((m) => m.changed);
  if (changed.length === 0) return 'Dry run: nothing to change.\n';
  const lines = ['Dry run — would make the following changes (nothing written):', ''];
  for (const m of changed) lines.push(describeMutation(m));
  lines.push('');
  return lines.join('\n');
}

// ── converters: planner output → PlannedMutation ─────────────────────────────

/** A generated skill/command file (from the adapters generate planner). */
export function fileMutation(repoRoot: string, pf: PlannedFile): PlannedMutation {
  return {
    kind: pf.action === 'create' ? 'create' : 'replace',
    path: pf.path,
    absPath: path.join(repoRoot, pf.path),
    containmentRoot: repoRoot,
    desiredContent: pf.desiredContent,
    currentContent: pf.currentContent,
    changed: pf.action !== 'unchanged',
    note: pf.reason,
  };
}

/** An instruction-file bootstrap-block injection (from the adapters inject planner). */
export function injectMutation(repoRoot: string, ip: InjectPlan): PlannedMutation {
  return {
    kind: ip.action === 'created' ? 'create' : 'inject-replace',
    path: path.relative(repoRoot, ip.filePath),
    absPath: ip.filePath,
    containmentRoot: repoRoot,
    desiredContent: ip.desiredContent,
    currentContent: ip.currentContent,
    changed: ip.action !== 'unchanged',
    note: ip.reason,
  };
}

/**
 * A symlink an instruction-file placement collapses to. The executor
 * creates it with a raw `fs.symlink` (throws EEXIST, never `rm`s) — so a
 * conflicting real file must be removed by a preceding `deleteMutation`.
 */
export function symlinkMutation(
  repoRoot: string,
  linkRel: string,
  targetRel: string,
  changed: boolean,
  currentContent: string | null = null
): PlannedMutation {
  return {
    kind: 'symlink',
    path: linkRel,
    absPath: path.join(repoRoot, linkRel),
    containmentRoot: repoRoot,
    desiredContent: null,
    currentContent,
    changed,
    symlinkTarget: targetRel,
    note: `symlink → ${targetRel}`,
  };
}

/**
 * A guarded delete (placement collapse). Only ever emitted for a secondary that is
 * provably safe to remove — absent, an already-correct symlink, byte-identical to
 * the canonical, or an explicit `orcaops link --yes` consolidation.
 */
export function deleteMutation(
  repoRoot: string,
  rel: string,
  expectation: DeleteExpectation,
  changed: boolean,
  containmentRoot?: string,
  absoluteTarget?: string
): PlannedMutation {
  // A target under its own containment root (the git common dir's orcaops/
  // files) is upward-relative from every linked worktree, so the repo-rooted
  // canonical check would refuse the very path it is meant to guard. Contain
  // it against the root it was planned under instead — the executor repeats
  // that same check before touching anything.
  if (absoluteTarget === undefined) {
    assertCanonicalRelativePath(rel, 'repository delete path');
  } else {
    assertResolvedWithin(absoluteTarget, containmentRoot ?? repoRoot, 'repository delete path', {
      rejectSymlinks: true,
    });
  }
  return {
    kind: 'delete',
    path: rel,
    absPath: absoluteTarget ?? path.join(repoRoot, rel),
    containmentRoot: containmentRoot ?? repoRoot,
    desiredContent: null,
    currentContent: expectation.kind === 'file' ? expectation.content : null,
    changed,
    deleteExpectation: expectation,
    note: 'collapse',
  };
}

/** The orcaops `.gitignore` block (from the CLI gitignore planner). */
export function gitignoreMutation(repoRoot: string, gp: GitignorePlan): PlannedMutation {
  return {
    kind: 'gitignore-entry',
    path: '.gitignore',
    absPath: gp.gitignorePath,
    containmentRoot: repoRoot,
    desiredContent: gp.desiredContent,
    currentContent: gp.currentContent,
    changed: gp.added.length > 0,
    note: gp.added.length > 0 ? `+${gp.added.join(', ')}` : undefined,
  };
}

/** An (empty) directory orcaops creates, e.g. `.orcaops/artifacts/`. */
export function dirMutation(repoRoot: string, rel: string, exists: boolean): PlannedMutation {
  return {
    kind: 'create',
    path: rel.endsWith(path.sep) ? rel : rel + path.sep,
    absPath: path.join(repoRoot, rel),
    containmentRoot: repoRoot,
    desiredContent: null,
    currentContent: null,
    changed: !exists,
    isDir: true,
  };
}

/** A plain file write (e.g. `.orcaops/config.json`). */
export function writeMutation(
  repoRoot: string,
  rel: string,
  desiredContent: string,
  currentContent: string | null,
  shouldWrite: boolean,
  containmentRoot: string = repoRoot,
  absoluteTarget: string = path.join(repoRoot, rel)
): PlannedMutation {
  return {
    kind: currentContent === null ? 'create' : 'replace',
    path: rel,
    absPath: absoluteTarget,
    containmentRoot,
    desiredContent,
    currentContent,
    changed: shouldWrite,
  };
}

// ── git-hook planner ─────────────────────────────────────────────────────────

export type GitHookAction =
  | 'created'
  | 'refreshed'
  | 'unchanged'
  | 'preserved-conflict'
  // `core.hooksPath` points at a tool-owned dir (husky/lefthook) orcaops
  // refuses to write into; callers report the skip instead of planning.
  | 'skipped-external-hooks-path';

/** The exact post-merge / post-rewrite hook body orcaops installs. */
export function gitHookBody(version: string): string {
  return (
    [
      '#!/bin/sh',
      `# orcaops-hook v=${version}`,
      '# Auto-installed by `orcaops init --with-hooks`. Re-runs',
      '# `orcaops lineage` after merge / rebase / amend so artifact',
      '# lineage stays current. Best-effort: never fails git ops.',
      '',
      'orcaops lineage >/dev/null 2>&1 || true',
    ].join('\n') + '\n'
  );
}

export interface GitHookPlan {
  action: GitHookAction;
  mutation: PlannedMutation;
  /** Set when the hook was preserved because its stamp is NEWER than the CLI. */
  aheadStamp?: string;
}

export type GitHookName = 'post-merge' | 'post-rewrite';

function gitHookTarget(
  repoRoot: string,
  hooksDirAbs: string,
  name: GitHookName
): { path: string; absPath: string; containmentRoot: string } {
  const absPath = path.join(hooksDirAbs, name);
  return {
    path: path.relative(repoRoot, absPath),
    absPath,
    // Hook files are direct children of the resolved hooks dir and the entry
    // names are trusted GitHookName constants, so the dir itself is the
    // containment boundary — it may legitimately live outside the common dir
    // under core.hooksPath.
    containmentRoot: hooksDirAbs,
  };
}

/** The version a stamped orcaops hook was written by, or null when unstamped. */
export function gitHookStampVersion(content: string): string | null {
  return content.match(/# orcaops-hook v=([^\s]+)/)?.[1] ?? null;
}

/**
 * Plan a git-hook install WITHOUT writing. Only stamped hooks are refreshed;
 * an unstamped pre-existing hook is left intact (`preserved-conflict`), and a
 * hook stamped NEWER than the running CLI is preserved the same way — the
 * hook stamp shares the version-skew invariant with every other stamped
 * surface, and no hook caller carries downgrade authority.
 *
 * `hooksDirAbs` is the RESOLVED hooks dir (callers resolve it via
 * `Repo.getHooksDir()` — never a hand-joined `.git/hooks`, which is wrong in
 * linked worktrees). The planner stays a pure path function; the mutation's
 * display `path` is repo-relative and may be `../…` from a linked worktree.
 */
export async function planGitHookMutation(
  repoRoot: string,
  hooksDirAbs: string,
  name: GitHookName,
  version: string,
  readExisting: (absPath: string) => Promise<FileOwnershipRead>
): Promise<GitHookPlan> {
  const target = gitHookTarget(repoRoot, hooksDirAbs, name);
  const body = gitHookBody(version);
  const existing = await readExisting(target.absPath);

  let action: GitHookAction;
  let changed: boolean;
  let aheadStamp: string | null = null;
  if (existing === FILE_OWNERSHIP_UNVERIFIED) {
    action = 'preserved-conflict';
    changed = false;
  } else if (existing === null) {
    action = 'created';
    changed = true;
  } else if (existing.includes('# orcaops-hook v=')) {
    // A hook stamped NEWER than this CLI is not this binary's to touch —
    // the same direction rule every other stamped surface enforces.
    const stamp = gitHookStampVersion(existing);
    if (isVersionAhead(stamp, version)) {
      aheadStamp = stamp;
      action = 'preserved-conflict';
      changed = false;
    } else if (existing === body) {
      // Content-identical is not enough: a hook that lost its exec bits never
      // runs, and the executor honors the planned mode only when a mutation
      // is planned — so mode drift is refresh-worthy on its own.
      let executable = true;
      try {
        executable = ((await lstat(target.absPath)).mode & 0o111) !== 0;
      } catch {
        /* raced away — the created branch would have caught true absence */
      }
      if (executable) {
        action = 'unchanged';
        changed = false;
      } else {
        action = 'refreshed';
        changed = true;
      }
    } else {
      action = 'refreshed';
      changed = true;
    }
  } else {
    action = 'preserved-conflict';
    changed = false;
  }

  return {
    action,
    mutation: {
      kind: existing === null ? 'create' : 'replace',
      path: target.path,
      absPath: target.absPath,
      containmentRoot: target.containmentRoot,
      desiredContent: changed ? body : null,
      currentContent: typeof existing === 'string' ? existing : null,
      changed,
      mode: 0o755,
      note:
        aheadStamp !== null
          ? 'preserved-ahead'
          : action === 'preserved-conflict'
            ? 'preserved-conflict'
            : undefined,
    },
    ...(aheadStamp !== null ? { aheadStamp } : {}),
  };
}

export async function planManagedGitHookRefreshMutations(
  repoRoot: string,
  hooksDirAbs: string,
  version: string
): Promise<PlannedMutation[]> {
  const mutations: PlannedMutation[] = [];
  for (const name of ['post-merge', 'post-rewrite'] as const) {
    const plan = await planGitHookMutation(repoRoot, hooksDirAbs, name, version, (absPath) =>
      readRepositoryFileForOwnership(absPath, hooksDirAbs, `Git hook ${name}`)
    );
    if (plan.action === 'refreshed') mutations.push(plan.mutation);
  }
  return mutations;
}

export interface RemoveGitHooksResult {
  /** Delete mutations for stamped orcaops hooks. */
  mutations: PlannedMutation[];
  /** Repo-relative paths of the stamped hooks being removed. */
  removed: string[];
  /** Repo-relative paths of hooks left intact (no orcaops stamp, or ahead). */
  preserved: string[];
  /**
   * The `preserved` subset whose stamp is NEWER than the running CLI — the
   * caller surfaces these directionally (upgrade advice) instead of leaving
   * a managed hook behind silently.
   */
  preservedAhead: { path: string; stampedVersion: string }[];
  /** Repo-relative paths left untouched because ownership could not be inspected. */
  unverified: string[];
}

/**
 * Plan removal of orcaops's `post-merge` / `post-rewrite` git hooks for
 * `orcaops uninstall`. Hooks are NOT manifest-tracked (they live in the git
 * dir, never committed), so ownership is detected by the `# orcaops-hook v=`
 * stamp `gitHookBody` writes: a stamped hook is removed, an unstamped
 * (user-authored) hook is preserved.
 *
 * `hooksDirsAbs` is the resolved candidate UNION (callers pass
 * `hooksDirCandidates(repo)`): the dir git currently runs hooks from plus the
 * default common-dir `hooks/`, so a hook stranded by a later `core.hooksPath`
 * adoption is still removed.
 */
export async function planRemoveGitHooks(
  repoRoot: string,
  hooksDirsAbs: string[],
  readExisting: (absPath: string) => Promise<FileOwnershipRead>,
  currentVersion: string
): Promise<RemoveGitHooksResult> {
  const mutations: PlannedMutation[] = [];
  const removed: string[] = [];
  const preserved: string[] = [];
  const preservedAhead: { path: string; stampedVersion: string }[] = [];
  const unverified: string[] = [];
  const seen = new Set<string>();
  for (const dir of hooksDirsAbs) {
    for (const name of ['post-merge', 'post-rewrite'] as const) {
      const target = gitHookTarget(repoRoot, dir, name);
      if (seen.has(target.absPath)) continue;
      seen.add(target.absPath);
      const existing = await readExisting(target.absPath);
      if (existing === FILE_OWNERSHIP_UNVERIFIED) {
        unverified.push(target.path);
        continue;
      }
      if (existing === null) continue; // no hook installed
      if (existing.includes('# orcaops-hook v=')) {
        // A hook stamped NEWER than this CLI is not this binary's to delete —
        // the same direction rule every other stamped surface enforces.
        const stamp = gitHookStampVersion(existing);
        if (isVersionAhead(stamp, currentVersion)) {
          preserved.push(target.path);
          preservedAhead.push({ path: target.path, stampedVersion: stamp ?? '' });
          continue;
        }
        mutations.push({
          kind: 'delete',
          path: target.path,
          absPath: target.absPath,
          containmentRoot: target.containmentRoot,
          desiredContent: null,
          currentContent: existing,
          changed: true,
          deleteExpectation: { kind: 'file', content: existing },
        });
        removed.push(target.path);
      } else {
        preserved.push(target.path); // unstamped / user hook — never touched
      }
    }
  }
  return { mutations, removed, preserved, preservedAhead, unverified };
}
