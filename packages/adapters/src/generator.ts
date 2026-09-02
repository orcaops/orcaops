import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin, sha256Hex } from '@orcaops/storage';

import { COMMAND_TEMPLATES } from './commands/index.js';
import { extractStamp, isVersionAhead, type StampDivergence } from './renderers.js';
import { SKILL_TEMPLATES } from './skills/index.js';
import type { CommandTemplate, SkillTemplate, ToolAdapter } from './types.js';

export interface GenerateOptions {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Adapter to render for. */
  adapter: ToolAdapter;
  /** orcaops package version stamped into generated files. */
  generatedBy: string;
  /**
   * When true, overwrite files even if their generatedBy stamp matches the
   * current version. Default false — idempotent re-runs are no-ops.
   */
  force?: boolean;
  /**
   * Allow overwriting files stamped NEWER than `generatedBy` — a deliberate
   * downgrade. Only `update --force` passes true; `init --force` merely
   * re-initializes and must not.
   */
  overrideAhead?: boolean;
  /** Restrict to a subset of skills. Default: all. */
  skills?: ReadonlyArray<SkillTemplate>;
  /** Restrict to a subset of commands. Default: all. */
  commands?: ReadonlyArray<CommandTemplate>;
  /** Naming prefix for skill/command ids (default `orcaops`). */
  prefix?: string;
}

export interface GenerateResult {
  installed: string[];
  refreshed: string[];
  unchanged: string[];
  skipped: string[];
}

/** What executing a planned file write would do. */
export type FileAction = 'create' | 'replace' | 'unchanged';

/**
 * A planned generated-file write. Pure data — computing one touches no disk
 * beyond reading the current content. The mutation/preview layer consumes these
 * so `--dry-run` can show exactly what `generate` would write.
 */
export interface PlannedFile {
  /** Repo-relative path. */
  path: string;
  kind: 'generated-file';
  /** The content orcaops wants on disk. */
  desiredContent: string;
  /** Current on-disk content, or null if absent or preserved as a non-file entry. */
  currentContent: string | null;
  /** What `execute` would do (respects the stamp-preservation guard + `force`). */
  action: FileAction;
  /** Why a non-file entry was preserved instead of read or replaced. */
  preservedReason?: 'non-file';
  /** Set when the on-disk stamp is NEWER than `generatedBy`. */
  reason?: StampDivergence;
  /** The on-disk stamp version that triggered `reason`. */
  onDiskVersion?: string;
  /** sha-256 (hex) of `desiredContent` — the expected managed hash for the manifest. */
  hash: string;
}

export interface GeneratePlan {
  files: PlannedFile[];
  /** Adapter-capability skips (e.g. codex ships no commands). */
  skipped: string[];
}

/**
 * Compute the generated-file writes for an adapter WITHOUT touching disk (beyond
 * reading current content). The pure planner half of `generateForTool`.
 */
export async function planGenerateForTool(opts: GenerateOptions): Promise<GeneratePlan> {
  const files: PlannedFile[] = [];
  const skipped: string[] = [];
  const skills = opts.skills ?? SKILL_TEMPLATES;
  const commands = opts.commands ?? COMMAND_TEMPLATES;

  if (opts.adapter.skills) {
    const renderer = opts.adapter.skills;
    for (const skill of skills) {
      const rel = renderer.filePath(skill.id, opts.prefix);
      const desired = renderer.format(skill, {
        generatedBy: opts.generatedBy,
        prefix: opts.prefix,
      });
      files.push(await planFile(opts, rel, desired));
    }
  } else {
    skipped.push(`${opts.adapter.id}:skills (adapter does not support skills)`);
  }

  if (opts.adapter.commands) {
    const renderer = opts.adapter.commands;
    for (const command of commands) {
      const rel = renderer.filePath(command.id, opts.prefix);
      const desired = renderer.format(command, {
        generatedBy: opts.generatedBy,
        prefix: opts.prefix,
      });
      files.push(await planFile(opts, rel, desired));
    }
  } else {
    skipped.push(`${opts.adapter.id}:commands (adapter does not support commands)`);
  }

  return { files, skipped };
}

/**
 * Plan one generated-file write (stamp-preservation and ahead guards
 * included). Exported for artifact types planned outside
 * `planGenerateForTool`'s skill/command loops — the OpenCode session plugin —
 * so they get the identical user-edit-respecting semantics.
 */
export async function planFile(
  opts: Pick<GenerateOptions, 'repoRoot' | 'generatedBy' | 'force' | 'overrideAhead'>,
  rel: string,
  desired: string
): Promise<PlannedFile> {
  const repoRoot = opts.repoRoot;
  const declaredPath = path.join(repoRoot, rel);
  const parent = assertResolvedWithin(
    path.dirname(declaredPath),
    repoRoot,
    `generated file ${rel} parent`,
    { allowRoot: true, rejectSymlinks: true }
  );
  const entryPath = path.join(parent, path.basename(declaredPath));
  let stats;
  try {
    stats = await lstat(entryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    stats = null;
  }
  if (stats !== null && !stats.isFile()) {
    return {
      path: rel,
      kind: 'generated-file',
      desiredContent: desired,
      currentContent: null,
      action: 'unchanged',
      preservedReason: 'non-file',
      hash: sha256Hex(desired),
    };
  }
  const abs = assertResolvedWithin(entryPath, repoRoot, `generated file ${rel}`, {
    rejectSymlinks: true,
  });
  let currentContent: string | null = null;
  try {
    currentContent = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const stamp = currentContent === null ? null : extractStamp(currentContent).version;
  const ahead = stamp !== null && isVersionAhead(stamp, opts.generatedBy);

  let action: FileAction;
  let reason: StampDivergence | undefined;
  if (currentContent === null) {
    action = 'create';
  } else if (currentContent === desired) {
    action = 'unchanged';
  } else if (!opts.overrideAhead && ahead) {
    action = 'unchanged';
    reason = 'preserved-ahead';
  } else if (!opts.force && shouldPreserveExisting(currentContent, desired)) {
    action = 'unchanged';
  } else {
    action = 'replace';
    if (ahead) reason = 'forced-downgrade';
  }

  return {
    path: rel,
    kind: 'generated-file',
    desiredContent: desired,
    currentContent,
    action,
    ...(reason !== undefined ? { reason, onDiskVersion: stamp ?? undefined } : {}),
    hash: sha256Hex(desired),
  };
}

/**
 * Render every skill + command for the given adapter into the repo. Files are
 * written under the adapter's per-tool paths (e.g. `.claude/skills/<id>/SKILL.md`).
 *
 * Idempotent by default: a file already at the current generatedBy stamp is left
 * alone. Pass `--force` to overwrite. A thin plan → execute wrapper over
 * `planGenerateForTool`.
 */
export async function generateForTool(opts: GenerateOptions): Promise<GenerateResult> {
  const plan = await planGenerateForTool(opts);
  const result: GenerateResult = {
    installed: [],
    refreshed: [],
    unchanged: [],
    skipped: [...plan.skipped],
  };

  for (const f of plan.files) {
    if (f.action === 'unchanged') {
      result.unchanged.push(f.path);
      continue;
    }
    const resolveTarget = (): string =>
      assertResolvedWithin(
        path.join(opts.repoRoot, f.path),
        opts.repoRoot,
        `generated file ${f.path}`,
        { rejectSymlinks: true }
      );
    await mkdir(path.dirname(resolveTarget()), { recursive: true });
    await writeFile(resolveTarget(), f.desiredContent, 'utf8');
    if (f.action === 'create') result.installed.push(f.path);
    else result.refreshed.push(f.path);
  }

  return result;
}

/**
 * Preserve a same-version file when its complete generation stamp matches, or
 * when its current fingerprint is absent and ownership cannot be verified.
 * A complete fingerprint mismatch identifies a different generated render and
 * is refreshed; `--force` bypasses this guard.
 */
function shouldPreserveExisting(current: string, desired: string): boolean {
  const currentStamp = extractStamp(current);
  const desiredStamp = extractStamp(desired);
  if (
    currentStamp.version === null ||
    desiredStamp.version === null ||
    currentStamp.version !== desiredStamp.version
  ) {
    return false;
  }
  if (currentStamp.fingerprint === null) return true;
  return desiredStamp.fingerprint !== null && currentStamp.fingerprint === desiredStamp.fingerprint;
}
