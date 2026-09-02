import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  COMMAND_TEMPLATES,
  extractStamp,
  getAgentOverlay,
  getAgentSkillsDirs,
  getToolAdapter,
  isVersionAhead,
  SKILL_TEMPLATES,
  type SkillTemplate,
} from '@orcaops/adapters';
import {
  ArtifactLock,
  assertResolvedWithin,
  PathContainmentError,
  resolveCanonicalPath,
  sha256Hex,
  type SupportedAgentId,
} from '@orcaops/storage';

import { getInvocationEnv } from './invocation-context.js';
import { formatZodIssues } from './zod-issues.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * GLOBAL scope. Skills (and, where an overlay declares a global command
 * root, commands) materialize into per-user global dirs instead of the repo, tracked
 * in a single global manifest at `~/.orcaops/install.local.json` (override:
 * `ORCAOPS_GLOBAL_ROOT`, which also makes the whole footprint hermetic for tests).
 *
 * Global is PER-USER CURRENT state, not per-repo ownership: one materialization at
 * the user's current CLI version, reference-counted per MATERIALIZED KEY
 * `{agent, surface, prefix, path}`. A repo changing prefix/install-set decrements its
 * old keys and increments the new; a key drops only when its ref count hits zero.
 *
 * Instruction blocks, git hooks, and the committed `install.json` are NEVER global —
 * those stay project-scoped (handled by the project planner).
 */

export const GLOBAL_MANIFEST_VERSION = 1;

export type GlobalSurface = 'skill' | 'command';

export interface GlobalInstallEntry {
  agent: SupportedAgentId;
  surface: GlobalSurface;
  prefix: string;
  /** Absolute path the artifact is materialized at (under a global dir). */
  path: string;
  materialization: 'copy' | 'symlink';
  /** Relative symlink target (the canonical store) when materialization==='symlink'. */
  symlinkTarget?: string | null;
  /** orcaops's expected content hash (for a copy); null for a symlink. */
  expectedHash: string | null;
  /** Stable repo ids referencing this key; the ref count is `refs.length`. */
  refs: string[];
}

export interface GlobalInstallManifest {
  manifest_version: number;
  /** CLI version that last materialized global state (the per-user-current marker). */
  materialized_by: string;
  entries: GlobalInstallEntry[];
  /**
   * Count of symlink targets the READER repaired to their derived spelling.
   * Populated by `readGlobalManifest` only — never persisted (the writer
   * builds a fresh object) — so callers can surface that the recorded
   * manifest disagreed with derivation (stale upgrade or tampering).
   */
  repaired_targets?: number;
  /**
   * Entries recorded under a global root that is not the live one. Populated by
   * `readGlobalManifest` only, never persisted — they stay in `entries`, which
   * is what preserves them across a write.
   */
  inert_entries?: GlobalInstallEntry[];
}

export type LinkMode = 'copy' | 'symlink';

const trimmedEnv = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
};

/** `$ORCAOPS_GLOBAL_ROOT`, absolutized — a relative override would make the
 *  writer emit entry paths the strict (absolute-path) reader rejects. */
function globalRootOverride(): string | null {
  const raw = trimmedEnv(getInvocationEnv().ORCAOPS_GLOBAL_ROOT);
  return raw === null ? null : path.resolve(raw);
}

/** The global state root: `$ORCAOPS_GLOBAL_ROOT` or `~/.orcaops`. */
export function resolveGlobalRoot(): string {
  return globalRootOverride() ?? path.join(os.homedir(), '.orcaops');
}

export function globalManifestPath(): string {
  return path.join(resolveGlobalRoot(), 'install.local.json');
}

export interface GlobalInstallLockScope {
  readonly manifest: GlobalInstallManifest | null;
  assert(): Promise<void>;
}

export async function withGlobalInstallLock<T>(
  fn: (scope: GlobalInstallLockScope) => Promise<T>
): Promise<T> {
  await readGlobalManifest();
  const root = resolveGlobalRoot();
  await mkdir(root, { recursive: true });
  await readGlobalManifest();
  const lock = new ArtifactLock({
    locksDir: path.join(root, 'locks'),
    containmentRoot: root,
    heartbeatIntervalMs: 30_000,
  });
  return lock.withLock('install-state', async (lease) => {
    const manifest = await readGlobalManifest();
    return fn({ manifest, assert: () => lease.assert() });
  });
}

/**
 * The global skills dir for an agent. Under `ORCAOPS_GLOBAL_ROOT` orcaops owns a
 * self-contained tree (`<root>/<agent>/skills`); otherwise it defers to the
 * registry's native `globalSkillsDir` (e.g. `~/.claude/skills`). `null` when the
 * agent has no global skills dir.
 */
export function resolveGlobalSkillsDir(agent: SupportedAgentId): string | null {
  const override = globalRootOverride();
  if (override) return path.join(override, agent, 'skills');
  return getAgentSkillsDirs(agent)?.globalSkillsDir ?? null;
}

/**
 * The global command root for an agent (commands are project-only when neither an
 * override nor an overlay `globalCommandRoot` is set — faithful to "absent → project-only").
 */
export function resolveGlobalCommandRoot(agent: SupportedAgentId): string | null {
  const overlay = getAgentOverlay(agent);
  if (!overlay?.supportsCommands) return null;
  const override = globalRootOverride();
  if (override) return path.join(override, agent, 'commands');
  return overlay.globalCommandRoot ?? null;
}

const keyOf = (e: { agent: string; surface: string; prefix: string; path: string }): string =>
  `${e.agent}\u0000${e.surface}\u0000${e.prefix}\u0000${e.path}`;

// ── desired global artifacts for one repo ────────────────────────────────────

interface DesiredArtifact {
  agent: SupportedAgentId;
  surface: GlobalSurface;
  prefix: string;
  /** Absolute path of the materialized file. */
  filePath: string;
  /** The directory that is symlinked/copied as a unit (the per-skill / per-command dir). */
  dir: string;
  /** Relative path of the file within `dir`. */
  relInDir: string;
  content: string;
  hash: string;
}

/** Render the global skill + command artifacts the install set wants, with absolute paths. */
function desiredArtifacts(
  agents: SupportedAgentId[],
  prefix: string,
  generatedBy: string,
  skills: ReadonlyArray<SkillTemplate>
): { artifacts: DesiredArtifact[]; warnings: string[] } {
  const artifacts: DesiredArtifact[] = [];
  const warnings: string[] = [];
  for (const agent of agents) {
    const adapter = getToolAdapter(agent);
    if (!adapter) continue;
    const skillsDir = resolveGlobalSkillsDir(agent);
    if (adapter.skills && skillsDir) {
      const projDir = getAgentSkillsDirs(agent)!.skillsDir;
      for (const skill of skills) {
        const rel = path.relative(projDir, adapter.skills.filePath(skill.id, prefix));
        const filePath = path.join(skillsDir, rel);
        const content = adapter.skills.format(skill, { generatedBy, prefix });
        artifacts.push({
          agent,
          surface: 'skill',
          prefix,
          filePath,
          dir: path.dirname(filePath),
          relInDir: path.basename(filePath),
          content,
          hash: sha256Hex(content),
        });
      }
    } else if (adapter.skills && !skillsDir) {
      warnings.push(`${agent}: no global skills dir — skipped (use --scope project)`);
    }
    const cmdRoot = resolveGlobalCommandRoot(agent);
    if (adapter.commands && cmdRoot) {
      // project command path is `${commandRoot}/${prefix}/${id}.md`; remap onto the global root.
      const projRoot = getAgentOverlay(agent)!.commandRoot!;
      for (const cmd of COMMAND_TEMPLATES) {
        const rel = path.relative(projRoot, adapter.commands.filePath(cmd.id, prefix));
        const filePath = path.join(cmdRoot, rel);
        const content = adapter.commands.format(cmd, { generatedBy, prefix });
        artifacts.push({
          agent,
          surface: 'command',
          prefix,
          filePath,
          dir: path.dirname(filePath),
          relInDir: path.basename(filePath),
          content,
          hash: sha256Hex(content),
        });
      }
    }
  }
  return { artifacts, warnings };
}

// ── manifest IO (fail-closed, D7 root policy) ────────────────────────────────

const globalEntrySchema = z
  .object({
    agent: z.string().min(1),
    surface: z.enum(['skill', 'command']),
    prefix: z.string().min(1),
    path: z.string().min(1).refine(path.isAbsolute, 'entry path must be absolute'),
    materialization: z.enum(['copy', 'symlink']),
    symlinkTarget: z.string().min(1).nullable().optional(),
    expectedHash: z.string().min(1).nullable(),
    refs: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.materialization === 'copy') {
      if (entry.expectedHash === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a copy materialization must record its expected content hash',
        });
      }
      if (entry.symlinkTarget) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'symlinkTarget is only valid when materialization is "symlink"',
        });
      }
    } else {
      if (entry.expectedHash !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a symlink materialization carries no content hash (expectedHash must be null)',
        });
      }
      if (!entry.symlinkTarget) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a symlink entry must record its target (symlinkTarget is null/absent)',
        });
      }
    }
  });

const globalManifestSchema = z
  .object({
    manifest_version: z.literal(GLOBAL_MANIFEST_VERSION),
    materialized_by: z.string().min(1),
    entries: z.array(globalEntrySchema),
  })
  .strict();

/**
 * Symlink-aware containment for a mutation target: the parent chain must
 * resolve inside `root` with no symlinked components below it (an ancestor
 * symlink is exactly the escape a corrupt manifest would use), while the LEAF
 * may be a symlink — orcaops's own symlink-mode artifacts are leaf symlinks.
 * Returns the canonical path the protected operation must use. The root
 * itself may legitimately be a symlink (dotfile setups); it is realpath'd
 * consistently on both sides. A root that does not exist yet (first
 * materialization) has no ancestors a symlink could hide in, so an exact
 * lexical check is sufficient there — callers that mkdir re-validate after.
 */
function containedMutationPath(target: string, root: string, label: string): string {
  const absRoot = path.resolve(root);
  // Resolve BEFORE splitting parent/leaf: `path.resolve` normalizes dot
  // segments away, so a `..` leaf can never validate its parent as the root
  // and then rejoin an escape.
  const absTarget = path.resolve(target);
  if (existsSync(absRoot)) {
    const parent = assertResolvedWithin(path.dirname(absTarget), absRoot, `${label} parent`, {
      allowRoot: true,
      rejectSymlinks: true,
    });
    return path.join(parent, path.basename(absTarget));
  }
  // Both sides still canonicalize through the nearest EXISTING ancestor so the
  // returned spelling matches what the exists-branch would produce once the
  // tree is created (macOS /var vs /private/var must never split).
  const abs = resolveCanonicalPath(absTarget, label);
  const rootCanonical = resolveCanonicalPath(absRoot, `${label} root`);
  const rel = path.relative(rootCanonical, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathContainmentError(
      `${label} resolves outside ${rootCanonical}; got ${abs}.`,
      label
    );
  }
  return abs;
}

/** The canonical Orcaops store — the only legal home for symlink-store targets. */
function canonicalStoreRoot(): string {
  return path.join(resolveGlobalRoot(), 'store');
}

/**
 * D7 root selection: an entry's allowed root comes from its agent/surface —
 * the agent-native (or ORCAOPS_GLOBAL_ROOT-overridden) skills/commands dir.
 * `null` means the registry grants this agent no such root, so no path can
 * be legal for it.
 */
function allowedRootFor(entry: { agent: string; surface: GlobalSurface }): string | null {
  const adapter = getToolAdapter(entry.agent as SupportedAgentId);
  if (!adapter) return null;
  return entry.surface === 'skill'
    ? resolveGlobalSkillsDir(entry.agent as SupportedAgentId)
    : resolveGlobalCommandRoot(entry.agent as SupportedAgentId);
}

function globalManifestError(detail: string): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `${globalManifestPath()} is not a valid global install manifest: ${detail}. ` +
      `No changes were made. Repair the file by hand and retry; \`orcaops doctor\` reports ` +
      `what it found. Deleting it also unblocks the command, but any global skills it ` +
      `still tracks become unreferenced and no later uninstall can clean them up. To work ` +
      `in an isolated global tree instead, set ORCAOPS_GLOBAL_ROOT.`,
    'global install manifest'
  );
}

function globalInstallRefusal(detail: string): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Refusing global installation: ${detail}. The conflicting path was not changed; ` +
      'earlier generated paths may already have been reconciled and retry is safe. ' +
      'Move the conflicting path or restore its Orcaops-owned bytes, then retry.',
    'global install ownership'
  );
}

/**
 * Enforce the D7 root policy on one entry: its materialized path must sit
 * under the allowed root for its agent/surface (symlink-aware — an ancestor
 * symlink below the root is an escape), and a symlink entry's resolved store
 * target must sit under the canonical Orcaops store. Runs at read time (fail
 * closed before planning) AND again in `removeIfOwned` as defense in depth —
 * cleanup mutates paths outside the repository, so a corrupt or hand-edited
 * manifest must never be able to aim it elsewhere. Returns the canonical
 * paths every subsequent filesystem operation on the entry must use.
 */
function assertEntryWithinRoots(entry: {
  agent: string;
  surface: GlobalSurface;
  path: string;
  materialization: 'copy' | 'symlink';
  symlinkTarget?: string | null;
}): { safeEntryPath: string; safeStorePath: string | null; repairedSymlinkTarget: string | null } {
  const root = allowedRootFor(entry);
  if (root === null) {
    throw globalManifestError(
      `entry "${entry.path}" names agent "${entry.agent}" (surface ${entry.surface}) with no allowed global root`
    );
  }
  let safeEntryPath: string;
  try {
    safeEntryPath = containedMutationPath(
      entry.path,
      root,
      `${entry.agent}/${entry.surface} entry`
    );
  } catch (err) {
    throw globalManifestError(
      `entry path "${entry.path}" falls outside its allowed ${entry.agent}/${entry.surface} root "${root}"` +
        (err instanceof PathContainmentError ? ` (${err.message})` : '')
    );
  }
  let safeStorePath: string | null = null;
  let repairedSymlinkTarget: string | null = null;
  if (entry.materialization === 'symlink' && entry.symlinkTarget) {
    // The recorded target is NEVER followed: the entry's true store location
    // is fully derivable from its own fields, so cleanup and ownership can
    // only ever act on the derived path. A recorded spelling that disagrees
    // — stale (pre-canonicalization manifest, re-pointed root) or hostile
    // (aimed at a sibling artifact's store file or outside the store) — is
    // repaired, and the repair is surfaced to callers as a count. Rejecting
    // instead would brick every command through the preflight with a remedy
    // that destroys other repos' ref-counts.
    // IDENTITY with the writer's canonicalStore(): the writer keys the store
    // on basename(a.dir) of the LEXICAL dirname while this derives from the
    // CANONICAL one. They agree because every artifact parent is an
    // orcaops-created `<prefix>-<id>` (or `<prefix>`) real directory and a
    // symlinked component below an allowed root is refused — if a future
    // overlay ships a flat native command root, revisit this coupling.
    // The identity's real dependent is this derived path (and the resolved
    // ownership clause and blob deletion built on it): if it ever breaks,
    // the resolved comparison stops matching and a stale link is LEAKED,
    // never wrongly deleted — the safe direction.
    const derived = path.join(
      canonicalStoreRoot(),
      entry.agent,
      entry.surface,
      path.basename(path.dirname(safeEntryPath)),
      path.basename(safeEntryPath)
    );
    try {
      safeStorePath = containedMutationPath(derived, canonicalStoreRoot(), 'derived store target');
    } catch (err) {
      throw globalManifestError(
        `derived store target for "${entry.path}" is unresolvable under "${canonicalStoreRoot()}"` +
          (err instanceof PathContainmentError ? ` (${err.message})` : '')
      );
    }
    const canonicalRelative = path.relative(path.dirname(safeEntryPath), safeStorePath);
    const recordedResolved = path.resolve(path.dirname(safeEntryPath), entry.symlinkTarget);
    if (recordedResolved !== safeStorePath) {
      repairedSymlinkTarget = canonicalRelative;
    }
  }
  return { safeEntryPath, safeStorePath, repairedSymlinkTarget };
}

/**
 * Which environment an entry belongs to. The agent root moves with its env var
 * while the manifest is pinned to the global root, so one manifest legitimately
 * holds entries from several roots; an entry under a foreign root is INERT —
 * never planned, owned, ref-counted, or deleted here.
 *
 * Membership is DERIVED rather than stored: the schema is strict with a literal
 * version and no migration, so an additive field would hard-fail older CLIs.
 *
 * Only ACTIVE entries reach `removeIfOwned`, so the deletion guarantee is
 * unchanged. A fabricated path and a genuine foreign root are indistinguishable
 * from the manifest alone, so both park here rather than one throwing.
 */
type ClassifiedEntry =
  | ({ kind: 'active' } & ReturnType<typeof assertEntryWithinRoots>)
  | { kind: 'inert'; root: string | null };

function classifyEntry(entry: {
  agent: string;
  surface: GlobalSurface;
  path: string;
  materialization: 'copy' | 'symlink';
  symlinkTarget?: string | null;
}): ClassifiedEntry {
  const root = allowedRootFor(entry);
  // No allowed root: nothing can act on the entry, so parking beats refusing
  // to read the whole manifest.
  if (root === null) return { kind: 'inert', root: null };
  // Deliberately permissive: this decides which ENVIRONMENT the entry belongs
  // to, never whether it is legal. Lexical or canonical spelling both count —
  // the root may be a symlink. Anything claiming the live root still goes
  // through the full symlink-aware check, which throws: an ancestor symlink
  // escaping the live root is corruption, not a foreign root.
  const under = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + path.sep);
  const lexicalRoot = path.resolve(root);
  const lexicalEntry = path.resolve(entry.path);
  let claimsRoot = under(lexicalEntry, lexicalRoot);
  if (!claimsRoot) {
    try {
      const canonicalRoot = resolveCanonicalPath(lexicalRoot, 'allowed global root');
      claimsRoot =
        under(lexicalEntry, canonicalRoot) ||
        under(resolveCanonicalPath(lexicalEntry, 'entry path'), canonicalRoot);
    } catch {
      // An unresolvable root cannot be claimed; park rather than brick the read.
      claimsRoot = false;
    }
  }
  if (!claimsRoot) return { kind: 'inert', root };
  return { kind: 'active', ...assertEntryWithinRoots(entry) };
}

export async function readGlobalManifest(): Promise<GlobalInstallManifest | null> {
  const globalRoot = resolveGlobalRoot();
  if (existsSync(globalRoot)) {
    // An EXISTING root must be a directory — a regular file cannot hold the
    // manifest, and letting readFile surface a raw ENOTDIR would break the
    // typed reader boundary the nested-file walk below already enforces.
    let rootSt: ReturnType<typeof statSync>;
    try {
      rootSt = statSync(globalRoot);
    } catch (err) {
      throw globalManifestError(
        `cannot inspect the global root "${globalRoot}" (${(err as Error).message})`
      );
    }
    if (!rootSt.isDirectory()) {
      throw globalManifestError(
        `the global root "${globalRoot}" is not a directory — move or remove it`
      );
    }
  }
  if (!existsSync(globalRoot)) {
    // existsSync follows symlinks, so a dangling symlink AT OR ABOVE the
    // root also reads false — but that is a broken configuration, not an
    // absent one, and treating it as absent would let mutations start and
    // fail mid-run. Walk up until something resolves: a dangling component
    // anywhere on the way is rejected; a chain of plain-absent directories
    // is the genuine first-run case. Permission failures while inspecting
    // map onto the typed envelope rather than escaping raw.
    let cursor = path.resolve(globalRoot);
    for (;;) {
      // Inspect directly: only genuine absence (ENOENT) may read as absent;
      // a dangling symlink or a file ancestor is a broken configuration and
      // any other inspection failure (EACCES) must not masquerade as either.
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(cursor);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') {
          // An ancestor is a regular FILE: mkdir can never create this root,
          // so reading it as first-run absence would defer the failure until
          // after project mutations.
          throw globalManifestError(
            `the global root "${globalRoot}" crosses a non-directory at or below "${cursor}" — move or remove it`
          );
        }
        if (code !== 'ENOENT') {
          throw globalManifestError(
            `cannot inspect the global root "${globalRoot}" at "${cursor}" (${(err as Error).message})`
          );
        }
      }
      if (st !== null && st.isSymbolicLink()) {
        try {
          statSync(cursor);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          throw globalManifestError(
            code === 'ENOENT' || code === 'ENOTDIR'
              ? `the global root "${globalRoot}" crosses a dangling symlink at "${cursor}" — repair or remove it`
              : `cannot inspect the global root "${globalRoot}" at "${cursor}" (${(err as Error).message})`
          );
        }
      }
      const parent = path.dirname(cursor);
      if (st !== null || parent === cursor) break;
      cursor = parent;
    }
    return null;
  }
  // The manifest FILE itself must not be reachable through a symlink — its
  // write is already containment-guarded, and an unguarded read would let a
  // planted link substitute a foreign-but-valid manifest.
  let manifestFile: string;
  try {
    manifestFile = assertResolvedWithin(globalManifestPath(), globalRoot, 'global manifest file', {
      rejectSymlinks: true,
    });
  } catch (err) {
    if (err instanceof PathContainmentError) throw globalManifestError(err.message);
    throw err;
  }
  let raw: string;
  try {
    raw = await readFile(manifestFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw globalManifestError(`malformed JSON (${(err as Error).message})`);
  }
  const result = globalManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw globalManifestError(formatZodIssues(result.error.issues));
  }
  let repairedCount = 0;
  const metadataOf = (e: { materialization: string; expectedHash: string | null }): string =>
    `${e.materialization}\u0000${e.expectedHash ?? ''}`;
  const seenCanonicalPaths = new Map<string, { recordedPath: string; key: string; meta: string }>();
  const seenStorePaths = new Map<string, { recordedPath: string; key: string }>();
  const inertEntries: (typeof result.data.entries)[number][] = [];
  // Inert entries have no canonical path to dedup on, so they get their own
  // lexical namespace; they can never collide with an active entry.
  const seenInertPaths = new Map<string, { recordedPath: string; key: string }>();
  const entries = result.data.entries.map((entry) => {
    const classified = classifyEntry(entry);
    if (classified.kind === 'inert') {
      const lexical = path.resolve(entry.path);
      const priorInert = seenInertPaths.get(lexical);
      const key = keyOf(entry);
      if (priorInert !== undefined && priorInert.key !== key) {
        throw globalManifestError(
          `entries "${priorInert.recordedPath}" and "${entry.path}" both claim the materialized path "${lexical}" under different ownership keys`
        );
      }
      if (priorInert === undefined) seenInertPaths.set(lexical, { recordedPath: entry.path, key });
      inertEntries.push(entry);
      return entry;
    }
    const { safeEntryPath, safeStorePath, repairedSymlinkTarget } = classified;
    // One materialized path, one OWNER KEY: two spellings of one artifact
    // under the same canonical key are coherent duplicates (planning merges
    // their refs), but two DIFFERENT keys claiming one path could release
    // each other's blob — no legitimate writer produces that shape (a prefix
    // change renames the path), so it is corruption and fails closed.
    const canonicalKey = keyOf({
      agent: entry.agent,
      surface: entry.surface,
      prefix: entry.prefix,
      path: safeEntryPath,
    });
    const meta = metadataOf(entry);
    const prior = seenCanonicalPaths.get(safeEntryPath);
    if (prior !== undefined && prior.key !== canonicalKey) {
      throw globalManifestError(
        `entries "${prior.recordedPath}" and "${entry.path}" both claim the materialized path "${safeEntryPath}" under different ownership keys`
      );
    }
    if (prior !== undefined && prior.meta !== meta) {
      throw globalManifestError(
        `entries "${prior.recordedPath}" and "${entry.path}" claim "${safeEntryPath}" with conflicting materialization metadata`
      );
    }
    if (prior === undefined) {
      seenCanonicalPaths.set(safeEntryPath, { recordedPath: entry.path, key: canonicalKey, meta });
    }
    // The DERIVED STORE path is subject to the same one-owner rule: a corrupt
    // nested entry path can derive the same blob as a legitimate entry, and a
    // cross-key claim on a blob could release what the other still references.
    if (safeStorePath !== null) {
      const priorStore = seenStorePaths.get(safeStorePath);
      if (priorStore !== undefined && priorStore.key !== canonicalKey) {
        throw globalManifestError(
          `entries "${priorStore.recordedPath}" and "${entry.path}" both derive the store file "${safeStorePath}" under different ownership keys`
        );
      }
      if (priorStore === undefined) {
        seenStorePaths.set(safeStorePath, { recordedPath: entry.path, key: canonicalKey });
      }
    }
    if (repairedSymlinkTarget === null) return entry;
    repairedCount += 1;
    return { ...entry, symlinkTarget: repairedSymlinkTarget };
  });
  const manifest = { ...result.data, entries } as GlobalInstallManifest;
  if (repairedCount > 0) manifest.repaired_targets = repairedCount;
  if (inertEntries.length > 0) manifest.inert_entries = inertEntries as GlobalInstallEntry[];
  return manifest;
}

/** The entries belonging to the live environment — the only set planning acts on. */
/**
 * The store blob a symlink entry points at.
 *
 * The store hangs off the GLOBAL root, which does not move with the agent's env
 * var — so two entries naming one skill under different agent roots derive the
 * same blob and both symlinks point at it. Deleting it for one root dangles the
 * other. Does no containment check, so it can be asked about a foreign entry.
 */
function derivedStorePath(entry: {
  agent: string;
  surface: GlobalSurface;
  path: string;
  materialization: 'copy' | 'symlink';
}): string | null {
  if (entry.materialization !== 'symlink') return null;
  const abs = path.resolve(entry.path);
  const derived = path.join(
    canonicalStoreRoot(),
    entry.agent,
    entry.surface,
    path.basename(path.dirname(abs)),
    path.basename(abs)
  );
  // Canonicalize like `assertEntryWithinRoots` does, or this never matches the
  // path the deletion path actually uses — on macOS a store under `/var/...`
  // realpaths to `/private/var/...` and a lexical comparison silently misses.
  try {
    return resolveCanonicalPath(derived, 'derived store target');
  } catch {
    return derived;
  }
}

export function activeEntries(manifest: GlobalInstallManifest | null): GlobalInstallEntry[] {
  if (manifest === null) return [];
  const inert = new Set(manifest.inert_entries ?? []);
  return manifest.entries.filter((e) => !inert.has(e));
}

// ── plan + apply ─────────────────────────────────────────────────────────────

export interface PlanGlobalInstallInput {
  repoId: string;
  agents: SupportedAgentId[];
  prefix: string;
  generatedBy: string;
  link: LinkMode;
  /** The running CLI version (the per-user-current authority). */
  cliVersion: string;
  /**
   * The enabled skill set — which skill dirs materialize globally.
   * Omitted ⇒ every shipped template.
   */
  skills?: ReadonlyArray<SkillTemplate>;
  /**
   * Skills this repo holds but must not create, because the gate is closed on
   * this machine. A held key keeps its existing ref, so the decrement below
   * never reaches zero and `removeIfOwned` never runs on it.
   *
   * Never renders bytes and never adds a ref that was not already recorded.
   * Derived from `gateWithheldSkillTemplates`, so a skill the USER disabled is
   * not held and its removal proceeds normally.
   */
  heldSkills?: ReadonlyArray<SkillTemplate>;
  /**
   * Prefixes to hold under. Defaults to the current prefix plus every prefix
   * this repo already holds, so a rename cannot delete an old-prefix skill the
   * gate forbids re-creating.
   *
   * Derived rather than passed: a current-prefix-only default fails open when a
   * caller forgets it, and personal scope has no committed manifest to read a
   * prior prefix from.
   */
  heldPrefixes?: ReadonlyArray<string>;
  /**
   * Override the per-user-current skip for a BEHIND/differing global version
   * (proceed with the rewrite). Does NOT bypass the ahead guard below.
   */
  force?: boolean;
  /**
   * Additionally allow rewriting global state stamped NEWER than this CLI — a
   * deliberate downgrade. Only `update --force` passes true.
   */
  overrideAhead?: boolean;
}

export interface GlobalInstallResult {
  /** Keys materialized/refreshed for this repo (paths). */
  materialized: string[];
  /** Keys whose ref dropped to zero and were removed (paths). */
  removed: string[];
  /** Keys whose decrement was suppressed because the gate withholds them (paths). */
  held: string[];
  /** Retained structured field; exact-path collisions now refuse instead of falling back. */
  copyFallbacks: string[];
  warnings: string[];
  /** The version mismatch caused a warn+skip of the whole global rewrite. */
  skippedVersionMismatch: boolean;
  /** The skip was the AHEAD guard specifically — plain force cannot clear it. */
  skippedAhead: boolean;
  manifest: GlobalInstallManifest;
}

/**
 * Plan + (when mode==='apply') execute the global skill/command materialization +
 * ref-count update for one repo. Self-contained fs ops (absolute paths sit outside
 * the repo-relative mutation layer), with a `preview` mode for `--dry-run`.
 */
export async function planGlobalInstall(
  input: PlanGlobalInstallInput,
  mode: 'apply' | 'preview',
  /** Pre-validated manifest from a caller's preflight — closes the
   *  check/use window (a re-read here could see different bytes than the
   *  preflight validated). `undefined` reads; `null` means preflighted-absent. */
  prevManifest?: GlobalInstallManifest | null,
  lockScope?: GlobalInstallLockScope
): Promise<GlobalInstallResult> {
  if (mode === 'apply' && lockScope === undefined) {
    return withGlobalInstallLock((scope) => planGlobalInstall(input, mode, scope.manifest, scope));
  }
  const prev =
    lockScope?.manifest ?? (prevManifest !== undefined ? prevManifest : await readGlobalManifest());
  const warnings: string[] = [];
  if (prev?.repaired_targets) {
    // Tampering and staleness are indistinguishable here — either way the
    // recorded targets disagreed with derivation and were normalized.
    warnings.push(
      `repaired ${prev.repaired_targets} stale symlink target(s) in the global manifest (recorded spelling disagreed with the derived store path)`
    );
  }

  const { artifacts, warnings: renderWarnings } = desiredArtifacts(
    input.agents,
    input.prefix,
    input.generatedBy,
    input.skills ?? SKILL_TEMPLATES
  );

  warnings.push(...renderWarnings);

  const refuseUntouched = (ahead: boolean): GlobalInstallResult => ({
    materialized: [],
    removed: [],
    held: [],
    copyFallbacks: [],
    warnings,
    skippedVersionMismatch: true,
    skippedAhead: ahead,
    manifest: prev ?? {
      manifest_version: GLOBAL_MANIFEST_VERSION,
      materialized_by: input.cliVersion,
      entries: [],
    },
  });

  // Ahead guard. The manifest alone cannot prove the tree is not ahead:
  // artifacts are written before it, so an interrupted newer run leaves ahead
  // files under a stale manifest — hence the fallback to on-disk stamps. The
  // scan obeys the same containment and leaf rules as the write path: no
  // uncontained traversal, no symlink following (no-follow handle reads), no
  // non-file reads.
  const canonicalStore = (a: DesiredArtifact): string =>
    path.join(resolveGlobalRoot(), 'store', a.agent, a.surface, path.basename(a.dir), a.relInDir);
  let aheadVersion: string | null =
    prev !== null && isVersionAhead(prev.materialized_by, input.cliVersion)
      ? prev.materialized_by
      : null;
  if (aheadVersion === null && !input.overrideAhead) {
    const scanTargets = new Set<string>();
    for (const a of artifacts) {
      const root = allowedRootFor(a);
      if (root === null) continue;
      scanTargets.add(containedMutationPath(a.filePath, root, 'global artifact ahead scan'));
      // The canonical store too: under symlink materialization the visible
      // path is a link (skipped by the no-follow read), and with no manifest
      // — an interrupted newer FIRST install — only the store bytes can
      // reveal the ahead stamp.
      scanTargets.add(
        containedMutationPath(canonicalStore(a), canonicalStoreRoot(), 'global store ahead scan')
      );
    }
    // Prior entries too: an entry this invocation no longer desires (a prefix
    // or skill-set change) is about to lose its ref and manifest row, and an
    // interrupted newer run may have restamped exactly those paths — scan them
    // (and their stores) before their ownership records would be discarded.
    for (const entry of activeEntries(prev)) {
      try {
        const { safeEntryPath, safeStorePath } = assertEntryWithinRoots(entry);
        scanTargets.add(safeEntryPath);
        if (safeStorePath !== null) scanTargets.add(safeStorePath);
      } catch {
        // An uncontainable recorded path cannot be scanned here; the write
        // path's own validation owns refusing it.
      }
    }
    for (const target of scanTargets) {
      const onDisk = await readRegularFileNoFollow(target);
      if (onDisk === null) continue;
      const stamp = extractStamp(onDisk).version;
      if (isVersionAhead(stamp, input.cliVersion)) {
        aheadVersion = stamp;
        break;
      }
    }
  }
  if (aheadVersion !== null && !input.overrideAhead) {
    warnings.push(
      `global orcaops state is stamped by a NEWER orcaops (v${aheadVersion}) than this CLI ` +
        `(v${input.cliVersion}). Skipping the global rewrite — upgrade orcaops, or run ` +
        '`orcaops update --force` to deliberately downgrade.'
    );
    return refuseUntouched(true);
  }

  // Enforce per-user-current: a global tree materialized by a DIFFERENT CLI version is
  // not rewritten by this one (prevents two repos on different binaries ping-ponging
  // the shared bytes). Refcounts are part of that tree's ownership state, so a refusal
  // must leave them unchanged too.
  if (prev !== null && prev.materialized_by !== input.cliVersion && !input.force) {
    warnings.push(
      `global orcaops was materialized by CLI v${prev.materialized_by}; you are on v${input.cliVersion}. ` +
        `No global state was changed (run that CLI, use --scope project, or pass --force).`
    );
    return refuseUntouched(false);
  }

  const renderedHashes = new Map<string, Map<string, string>>();
  const expectedSymlinkStoreHash = (entry: GlobalInstallEntry): string | null => {
    const renderKey = `${entry.agent}\u0000${entry.prefix}`;
    let hashes = renderedHashes.get(renderKey);
    if (hashes === undefined) {
      hashes = new Map<string, string>();
      const rendered = desiredArtifacts(
        [entry.agent],
        entry.prefix,
        prev?.materialized_by ?? input.generatedBy,
        SKILL_TEMPLATES
      ).artifacts;
      for (const artifact of rendered) {
        const root = allowedRootFor(artifact);
        if (root === null) continue;
        hashes.set(
          containedMutationPath(artifact.filePath, root, 'rendered global artifact'),
          artifact.hash
        );
      }
      renderedHashes.set(renderKey, hashes);
    }
    const { safeEntryPath } = assertEntryWithinRoots(entry);
    return hashes.get(safeEntryPath) ?? null;
  };

  // Build the next manifest entry set from the prior one (ref-count
  // bookkeeping). Prior entries are re-keyed through the SAME canonicalization
  // the new keys use, so a raw-vs-realpath spelling difference (e.g. macOS
  // /var vs /private/var) can never split one artifact into two keys and
  // delete-then-recreate it.
  const byKey = new Map<string, GlobalInstallEntry>();
  const plannedPaths = new Map<
    string,
    { key: string; agent: string; entry: GlobalInstallEntry | null }
  >();
  const plannedStorePaths = new Map<string, { key: string; owner: string }>();
  const plannedDecisions = new Map<
    DesiredArtifact,
    {
      materialization: 'copy' | 'symlink';
      safeStore: string | null;
      ownershipStore: string;
      priorEntry: GlobalInstallEntry | null;
      priorStoreHash: string | null;
    }
  >();
  // Carried through untouched and re-appended below: dropping them would strand
  // that root's files with no record of who references them.
  const carriedInert = prev?.inert_entries ?? [];
  // Blobs foreign symlinks still resolve to; a live-root release would
  // otherwise reclaim them.
  const retainedStorePaths = new Set(
    carriedInert.map(derivedStorePath).filter((p): p is string => p !== null)
  );
  for (const e of activeEntries(prev)) {
    const { safeEntryPath, safeStorePath } = assertEntryWithinRoots(e);
    const key = keyOf({
      agent: e.agent,
      surface: e.surface,
      prefix: e.prefix,
      path: safeEntryPath,
    });
    const existing = byKey.get(key);
    if (existing) {
      // Two spellings of one artifact (raw vs canonical) collapse onto one
      // canonical key — union the ref sets, never drop the earlier one.
      existing.refs = [...new Set([...existing.refs, ...e.refs])];
    } else {
      byKey.set(key, { ...e, refs: [...e.refs] });
    }
    plannedPaths.set(safeEntryPath, { key, agent: e.agent, entry: byKey.get(key)! });
    if (safeStorePath !== null) {
      plannedStorePaths.set(safeStorePath, { key, owner: e.path });
    }
  }

  // PREFLIGHT, before any filesystem mutation: refuse to plan two ownership
  // keys onto one materialized path. Env-var-aliased agent roots (e.g.
  // CLAUDE_CONFIG_DIR=$CODEX_HOME) can collapse two agents onto one file,
  // and a prior entry can already own the path under a different key. The
  // reader rejects that manifest shape, so the writer must never produce it
  // — and must refuse with zero bytes moved, which is why this cannot live
  // inside the materialization loop.
  for (const a of artifacts) {
    const artifactRoot = allowedRootFor({ agent: a.agent, surface: a.surface });
    if (artifactRoot === null) {
      throw globalManifestError(
        `refusing to materialize "${a.filePath}" — no allowed ${a.agent}/${a.surface} root`
      );
    }
    let candidate: string;
    try {
      candidate = containedMutationPath(
        a.filePath,
        artifactRoot,
        `${a.agent}/${a.surface} artifact`
      );
    } catch (err) {
      throw globalManifestError(
        `refusing to materialize "${a.filePath}" outside its allowed ${a.agent}/${a.surface} root` +
          (err instanceof PathContainmentError ? ` (${err.message})` : '')
      );
    }
    const key = keyOf({ agent: a.agent, surface: a.surface, prefix: a.prefix, path: candidate });
    const prior = plannedPaths.get(candidate);
    if (prior !== undefined && prior.key !== key) {
      throw globalManifestError(
        `artifacts for "${prior.agent}" and "${a.agent}" both materialize at "${candidate}" — ` +
          `their global roots alias to one directory (check CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME)`
      );
    }
    const priorEntry = prior?.entry ?? byKey.get(key) ?? null;
    const priorStoreHash =
      priorEntry?.materialization === 'symlink' ? expectedSymlinkStoreHash(priorEntry) : null;
    const ownershipStore = containedMutationPath(
      canonicalStore(a),
      canonicalStoreRoot(),
      'canonical store file'
    );
    await assertDesiredArtifactOwnership(a, candidate, priorEntry, ownershipStore, input);
    plannedPaths.set(candidate, { key, agent: a.agent, entry: priorEntry });
    // The DERIVED STORE path mirrors the reader's second one-owner dimension:
    // a corrupt nested prior entry can derive the blob a legitimate desired
    // artifact derives while their entry paths differ — writing both would
    // brick every subsequent read. The copy/symlink decision is made HERE,
    // once, and cached: only an ACTUAL symlink touches the store (a
    // copy-fallback artifact records no store path the reader could collide
    // on), and materialization consumes the same plan so the two phases can
    // never diverge on a racing filesystem.
    const decidedMaterialization: 'copy' | 'symlink' = input.link;
    let decidedStore: string | null = null;
    if (decidedMaterialization === 'symlink' || priorEntry?.materialization === 'symlink') {
      await assertDesiredStoreOwnership(a, ownershipStore, priorEntry, priorStoreHash, input);
    }
    if (decidedMaterialization === 'symlink') {
      decidedStore = ownershipStore;
      const priorStore = plannedStorePaths.get(decidedStore);
      if (priorStore !== undefined && priorStore.key !== key) {
        throw globalManifestError(
          `the artifact "${a.filePath}" and the recorded entry "${priorStore.owner}" both derive ` +
            `the store file "${decidedStore}" under different ownership keys`
        );
      }
      plannedStorePaths.set(decidedStore, { key, owner: a.filePath });
    }
    plannedDecisions.set(a, {
      materialization: decidedMaterialization,
      safeStore: decidedStore,
      ownershipStore,
      priorEntry,
      priorStoreHash,
    });
  }

  const desiredKeys = new Set<string>();
  const materialized: string[] = [];
  const copyFallbacks: string[] = [];

  // Keys the gate withholds: derived exactly like the desired keys, but never
  // materialized and never registered in the collision preflight — refusing on
  // state we are not writing would be a regression. `releaseGlobalRefs` passes
  // `agents: []`, so a scope exit renders nothing here and still releases.
  const heldKeys = new Set<string>();
  if (input.heldSkills?.length) {
    // The prior manifest answers this without a committed project manifest, so
    // it works under personal scope too.
    const heldPrefixes = input.heldPrefixes ?? [
      ...new Set([
        input.prefix,
        ...activeEntries(prev)
          .filter((e) => e.refs.includes(input.repoId))
          .map((e) => e.prefix),
      ]),
    ];
    for (const prefix of heldPrefixes) {
      const held = desiredArtifacts(input.agents, prefix, input.generatedBy, input.heldSkills);
      for (const a of held.artifacts) {
        // Commands are never cloud-gated; holding one would suppress a
        // legitimate decrement.
        if (a.surface !== 'skill') continue;
        const root = allowedRootFor({ agent: a.agent, surface: a.surface });
        if (root === null) continue;
        try {
          const safe = containedMutationPath(a.filePath, root, `${a.agent}/${a.surface} held`);
          heldKeys.add(keyOf({ agent: a.agent, surface: a.surface, prefix: a.prefix, path: safe }));
        } catch {
          // Never written, so a key the reader would reject cannot match a
          // recorded entry either.
        }
      }
    }
  }

  for (const a of artifacts) {
    // D7: canonicalize + validate the artifact path and its store path up
    // front — one canonical spelling drives the key, every filesystem
    // operation, the recorded entry, and the symlink content, so the
    // on-disk link target always byte-matches the recorded one.
    const artifactRoot = allowedRootFor({ agent: a.agent, surface: a.surface });
    if (artifactRoot === null) {
      throw globalManifestError(
        `refusing to materialize "${a.filePath}" — no allowed ${a.agent}/${a.surface} root`
      );
    }
    const safeArtifactPath = (): string => {
      try {
        return containedMutationPath(a.filePath, artifactRoot, `${a.agent}/${a.surface} artifact`);
      } catch (err) {
        throw globalManifestError(
          `refusing to materialize "${a.filePath}" outside its allowed ${a.agent}/${a.surface} root` +
            (err instanceof PathContainmentError ? ` (${err.message})` : '')
        );
      }
    };
    let safeFilePath = safeArtifactPath();
    const k = keyOf({ agent: a.agent, surface: a.surface, prefix: a.prefix, path: safeFilePath });
    desiredKeys.add(k);

    // The copy/symlink decision (file granularity: symlinking the file — not
    // its parent dir — keeps `${dir}/SKILL.md` a real lookup and removal
    // per-file under the hash guard) was made ONCE in the preflight; consume
    // that plan here. Link CONTENT must be canonical-derived: a relative
    // target computed from the lexical spelling would dangle when an agent
    // root is a symlink at a different depth. The persisted entry PATH stays
    // lexical (registry-stable across re-points); only comparisons key on
    // the canonical form.
    const planned = plannedDecisions.get(a)!;
    const materialization = planned.materialization;
    const safeStore = planned.safeStore;
    let symlinkTarget: string | null = null;
    if (materialization === 'symlink' && safeStore !== null) {
      symlinkTarget = path.relative(path.dirname(safeFilePath), safeStore);
    }

    if (mode === 'apply') {
      await lockScope?.assert();
      await mkdir(path.dirname(safeFilePath), { recursive: true }); // a REAL dir — never symlinked
      // Re-derive after mkdir so the post-creation ancestors are the ones verified.
      safeFilePath = safeArtifactPath();
      await assertDesiredArtifactOwnership(
        a,
        safeFilePath,
        planned.priorEntry,
        planned.ownershipStore,
        input
      );
      if (materialization === 'symlink' && safeStore !== null) {
        await mkdir(path.dirname(safeStore), { recursive: true });
        await atomicGlobalFile(a.content, safeStore, canonicalStoreRoot(), async () => {
          await lockScope?.assert();
          await assertDesiredStoreOwnership(
            a,
            safeStore,
            planned.priorEntry,
            planned.priorStoreHash,
            input
          );
        });
        await atomicSymlinkFile(
          path.relative(path.dirname(safeFilePath), safeStore),
          safeFilePath,
          artifactRoot,
          async () => {
            await lockScope?.assert();
            await assertDesiredArtifactOwnership(
              a,
              safeFilePath,
              planned.priorEntry,
              planned.ownershipStore,
              input
            );
          }
        );
      } else {
        await atomicGlobalFile(a.content, safeFilePath, artifactRoot, async () => {
          await lockScope?.assert();
          if (planned.priorEntry?.materialization === 'symlink') {
            await assertDesiredStoreOwnership(
              a,
              planned.ownershipStore,
              planned.priorEntry,
              planned.priorStoreHash,
              input
            );
          }
          await assertDesiredArtifactOwnership(
            a,
            safeFilePath,
            planned.priorEntry,
            planned.ownershipStore,
            input
          );
        });
        if (planned.priorEntry?.materialization === 'symlink') {
          const priorStore = assertEntryWithinRoots(planned.priorEntry).safeStorePath;
          // Same sharing hazard as the refcount-zero path.
          if (priorStore !== null && retainedStorePaths.has(priorStore)) {
            warnings.push(
              `kept the shared global store artifact "${priorStore}" after switching its ` +
                `visible path to copy mode — an entry under another agent root still points at it`
            );
          } else if (priorStore !== null) {
            const removedStore = await removeStoreIfOwned(
              priorStore,
              planned.priorStoreHash,
              () => lockScope?.assert() ?? Promise.resolve()
            );
            if (!removedStore) {
              warnings.push(
                `preserved modified global store artifact "${priorStore}" after switching its visible path to copy mode`
              );
            }
          }
        }
      }
    }

    const priorEntry = byKey.get(k);
    const entry: GlobalInstallEntry = priorEntry ?? {
      agent: a.agent,
      surface: a.surface,
      prefix: a.prefix,
      path: a.filePath,
      materialization,
      symlinkTarget,
      expectedHash: materialization === 'copy' ? a.hash : null,
      refs: [],
    };
    // Persist the DECLARED registry spelling — canonical forms are compared,
    // never stored, so re-pointing a symlinked agent root cannot brick reads.
    entry.path = a.filePath;
    entry.materialization = materialization;
    entry.symlinkTarget = symlinkTarget;
    entry.expectedHash = materialization === 'copy' ? a.hash : null;
    if (!entry.refs.includes(input.repoId)) entry.refs.push(input.repoId);
    byKey.set(k, entry);
    materialized.push(a.filePath);
  }

  // Decrement keys this repo USED to reference but no longer does (prefix/install-set change).
  const removed: string[] = [];
  const held: string[] = [];
  for (const [k, entry] of byKey) {
    if (desiredKeys.has(k)) continue;
    // Absence from `desiredKeys` is a credential state here, not a decision to
    // stop using the skill — keep the ref and the bytes as recorded.
    if (heldKeys.has(k)) {
      if (entry.refs.includes(input.repoId)) held.push(entry.path);
      continue;
    }
    if (!entry.refs.includes(input.repoId)) continue;
    entry.refs = entry.refs.filter((r) => r !== input.repoId);
    if (entry.refs.length === 0) {
      // Last referencing repo gone → remove the materialized artifact (ownership-guarded:
      // a copy only when on-disk hash still matches; a symlink only when it is still ours).
      let removal: { removed: boolean; warning: string | null } = {
        removed: false,
        warning: null,
      };
      if (mode === 'apply') await lockScope?.assert();
      removal = await removeIfOwned(
        entry,
        entry.materialization === 'symlink' ? expectedSymlinkStoreHash(entry) : null,
        mode,
        () => lockScope?.assert() ?? Promise.resolve(),
        retainedStorePaths
      );
      if (removal.removed) removed.push(entry.path);
      if (removal.warning !== null) warnings.push(removal.warning);
      byKey.delete(k);
    }
  }

  const manifest: GlobalInstallManifest = {
    manifest_version: GLOBAL_MANIFEST_VERSION,
    materialized_by:
      artifacts.length === 0 && prev !== null ? prev.materialized_by : input.cliVersion,
    entries: [...byKey.values(), ...carriedInert].sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
  };

  if (mode === 'apply') {
    await lockScope?.assert();
    await mkdir(resolveGlobalRoot(), { recursive: true });
    await atomicGlobalFile(
      `${JSON.stringify(manifest, null, 2)}\n`,
      globalManifestPath(),
      resolveGlobalRoot(),
      () => lockScope?.assert() ?? Promise.resolve()
    );
  }

  return {
    materialized,
    removed,
    held,
    copyFallbacks,
    warnings,
    skippedVersionMismatch: false,
    skippedAhead: false,
    manifest,
  };
}

/**
 * Decrement a repo's global refs when it LEAVES global scope (scope flipped to project, or an
 * empty install set). `planGlobalInstall` only runs on the GLOBAL path, so without this a
 * repo's refs would leak forever and a phantom ref would block a genuine last-repo cleanup by
 * another repo. A no-op (returns null) when no global manifest references this repo, so the
 * common project-scope `update` pays only one cheap ENOENT-fast manifest read.
 */
export async function releaseGlobalRefs(
  input: { repoId: string; cliVersion: string; force?: boolean; overrideAhead?: boolean },
  mode: 'apply' | 'preview',
  /** Pre-validated manifest from a caller's preflight (see planGlobalInstall). */
  prevManifest?: GlobalInstallManifest | null,
  lockScope?: GlobalInstallLockScope
): Promise<GlobalInstallResult | null> {
  if (mode === 'apply' && lockScope === undefined) {
    return withGlobalInstallLock((scope) => releaseGlobalRefs(input, mode, scope.manifest, scope));
  }
  const prev =
    lockScope?.manifest ?? (prevManifest !== undefined ? prevManifest : await readGlobalManifest());
  // Only the live root's entries can be released here; a ref held by another
  // root's entry is released by a run under that root.
  if (!prev || !activeEntries(prev).some((e) => e.refs.includes(input.repoId))) return null;
  // An empty desired set → desiredKeys is empty → planGlobalInstall's decrement loop releases
  // every key this repo references and removes any that hit zero (ownership-guarded).
  // A release renders no artifacts, but it is NOT downgrade-free: releasing
  // the LAST reference deletes hash-owned files, and a newer tree's own
  // manifest records hashes its bytes match — so plain `force` must not carry
  // downgrade authority here. Only `update --force` passes `overrideAhead`.
  return planGlobalInstall(
    {
      repoId: input.repoId,
      agents: [],
      prefix: 'orcaops',
      generatedBy: input.cliVersion,
      link: 'copy',
      cliVersion: input.cliVersion,
      force: input.force,
      overrideAhead: input.overrideAhead,
    },
    mode,
    prev,
    lockScope
  );
}

/**
 * Read a REGULAR file without following a symlink leaf: O_NOFOLLOW makes the
 * open itself fail on a symlink, and the handle fstat closes the lstat→read
 * race a path-based read would leave open. Returns null for absence, a
 * symlink leaf, or a non-file. (On platforms without O_NOFOLLOW the flag is a
 * no-op and the fstat check still rejects non-files.)
 */
async function readRegularFileNoFollow(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function lstatOrNull(
  filePath: string,
  label: string
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw globalInstallRefusal(
      `cannot inspect ${label} "${filePath}" (${(error as Error).message})`
    );
  }
}

/**
 * True when the on-disk FILE at `safePath` carries a stamp NEWER than this
 * CLI. Non-file leaves are never ahead here — a symlink's bytes live in the
 * store, which the store assertion inspects itself.
 */
async function currentFileIsAhead(
  safePath: string,
  current: Awaited<ReturnType<typeof lstat>>,
  cliVersion: string
): Promise<boolean> {
  if (!current.isFile()) return false;
  const raw = await readFile(safePath, 'utf8').catch(() => null);
  return raw !== null && isVersionAhead(extractStamp(raw).version, cliVersion);
}

async function assertDesiredArtifactOwnership(
  artifact: DesiredArtifact,
  safePath: string,
  priorEntry: GlobalInstallEntry | null,
  ownershipStore: string,
  input: { force?: boolean; overrideAhead?: boolean; cliVersion: string }
): Promise<void> {
  const current = await lstatOrNull(safePath, 'global artifact');
  if (current === null) return;
  // `force` bypasses ownership conflicts only in the non-ahead direction:
  // state stamped NEWER than this CLI (e.g. appearing between the preflight
  // scan and this assertion) yields only to the explicit downgrade override.
  const forceBypass =
    priorEntry !== null &&
    input.force === true &&
    (input.overrideAhead === true ||
      !(await currentFileIsAhead(safePath, current, input.cliVersion)));
  if (
    (await matchesDesiredArtifact(artifact, safePath, current, ownershipStore)) ||
    (priorEntry !== null && (await matchesRecordedOwnership(priorEntry, safePath, current))) ||
    forceBypass
  ) {
    return;
  }
  // Ahead-flavored refusal only when the direction is what blocked the caller:
  // with the override already supplied, the remaining problem is ownership,
  // and advising `update --force` again would be a dead end.
  if (
    input.overrideAhead !== true &&
    (await currentFileIsAhead(safePath, current, input.cliVersion))
  ) {
    throw globalInstallRefusal(
      `the global artifact "${artifact.filePath}" is stamped by a NEWER orcaops than this CLI ` +
        `(v${input.cliVersion}) — upgrade orcaops, or run \`orcaops update --force\` to ` +
        `deliberately downgrade`
    );
  }
  throw globalInstallRefusal(
    `the global artifact "${artifact.filePath}" is unowned or modified — ` +
      `the existing path has neither current manifest ownership nor the exact generated identity`
  );
}

async function matchesDesiredArtifact(
  artifact: DesiredArtifact,
  safePath: string,
  current: Awaited<ReturnType<typeof lstat>>,
  ownershipStore: string
): Promise<boolean> {
  if (current.isFile()) {
    return sha256Hex(await readFile(safePath, 'utf8')) === artifact.hash;
  }
  if (!current.isSymbolicLink()) return false;
  const target = await readlink(safePath);
  if (path.resolve(path.dirname(safePath), target) !== ownershipStore) return false;
  const store = await lstatOrNull(ownershipStore, 'global store artifact');
  return (
    store?.isFile() === true && sha256Hex(await readFile(ownershipStore, 'utf8')) === artifact.hash
  );
}

async function matchesRecordedOwnership(
  entry: GlobalInstallEntry,
  safePath: string,
  current: Awaited<ReturnType<typeof lstat>>
): Promise<boolean> {
  if (entry.materialization === 'copy') {
    return (
      current.isFile() &&
      entry.expectedHash !== null &&
      sha256Hex(await readFile(safePath, 'utf8')) === entry.expectedHash
    );
  }
  if (!current.isSymbolicLink()) return false;
  const safeStore = assertEntryWithinRoots(entry).safeStorePath;
  const target = await readlink(safePath);
  return safeStore !== null && path.resolve(path.dirname(safePath), target) === safeStore;
}

async function assertDesiredStoreOwnership(
  artifact: DesiredArtifact,
  safeStore: string,
  priorEntry: GlobalInstallEntry | null,
  priorStoreHash: string | null,
  input: { force?: boolean; overrideAhead?: boolean; cliVersion: string }
): Promise<void> {
  const current = await lstatOrNull(safeStore, 'global store artifact');
  if (current === null) return;
  const raw = current.isFile() ? await readFile(safeStore, 'utf8') : null;
  const currentHash = raw === null ? null : sha256Hex(raw);
  if (currentHash === artifact.hash) return;
  // Same direction rule as the artifact assertion: plain `force` never
  // authorizes overwriting store bytes stamped NEWER than this CLI.
  const currentAhead = raw !== null && isVersionAhead(extractStamp(raw).version, input.cliVersion);
  const priorStore =
    priorEntry?.materialization === 'symlink'
      ? assertEntryWithinRoots(priorEntry).safeStorePath
      : null;
  if (
    priorStore === safeStore &&
    ((priorStoreHash !== null && currentHash === priorStoreHash) ||
      (input.force === true && (input.overrideAhead === true || !currentAhead)))
  ) {
    return;
  }
  if (input.overrideAhead !== true && currentAhead) {
    throw globalInstallRefusal(
      `the global store artifact "${safeStore}" is stamped by a NEWER orcaops than this CLI ` +
        `(v${input.cliVersion}) — upgrade orcaops, or run \`orcaops update --force\` to ` +
        `deliberately downgrade`
    );
  }
  throw globalInstallRefusal(`the global store artifact "${safeStore}" is unowned or modified`);
}

async function atomicSymlinkFile(
  target: string,
  filePath: string,
  containmentRoot: string,
  assertTarget: () => Promise<void>
): Promise<void> {
  const temporary = containedMutationPath(
    `${filePath}.tmp.${process.pid}.${randomUUID()}`,
    containmentRoot,
    'global symlink temporary file'
  );
  try {
    await symlink(target, temporary);
    await assertTarget();
    await rename(temporary, filePath);
    await syncGlobalDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicGlobalFile(
  content: string,
  filePath: string,
  containmentRoot: string,
  assertTarget: () => Promise<void>
): Promise<void> {
  const temporary = containedMutationPath(
    `${filePath}.tmp.${process.pid}.${randomUUID()}`,
    containmentRoot,
    'global artifact temporary file'
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await assertTarget();
    await rename(temporary, filePath);
    await syncGlobalDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncGlobalDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
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

/** `rmdir` a dir only when it is empty — ENOTEMPTY (siblings remain) / ENOENT are no-ops. */
async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err;
  }
}

/**
 * Remove a refcount-zero global artifact, ownership-guarded and FILE-granular: delete only
 * the materialized FILE (a copy whose on-disk hash still matches, or a symlink still pointing
 * at its recorded store), then `rmdir` the now-empty parent. NEVER `rm -rf` the parent dir —
 * that would take sibling commands / foreign files with it and bypass the per-file hash guard.
 */
async function removeIfOwned(
  entry: GlobalInstallEntry,
  expectedStoreHash: string | null,
  mode: 'apply' | 'preview',
  assertLease: () => Promise<void>,
  /** Store blobs an entry under ANOTHER agent root still points at — never deleted. */
  retainedStorePaths: ReadonlySet<string> = new Set()
): Promise<{ removed: boolean; warning: string | null }> {
  // Revalidate containment before inspecting ownership. Every operation below
  // uses these canonical paths, so a symlinked ancestor cannot redirect deletion.
  const { safeEntryPath, safeStorePath } = assertEntryWithinRoots(entry);
  const st = await lstatOrNull(safeEntryPath, 'global artifact');
  if (entry.materialization === 'symlink') {
    const store =
      safeStorePath === null ? null : await lstatOrNull(safeStorePath, 'global store artifact');
    const storeOwned =
      store?.isFile() === true &&
      expectedStoreHash !== null &&
      sha256Hex(await readFile(safeStorePath!, 'utf8')) === expectedStoreHash;
    // Left in place: breaking links under a root we cannot repair is worse than
    // leaking a blob, which is this file's documented safe direction.
    const storeShared = safeStorePath !== null && retainedStorePaths.has(safeStorePath);
    let removeStore = st === null && storeOwned && !storeShared;
    let removed = false;
    let resolvedLinkTarget: string | null = null;
    if (st?.isSymbolicLink()) {
      const target = await readlink(safeEntryPath);
      // Ownership is a RESOLVED comparison against the DERIVED store path —
      // spelling-insensitive (a repaired entry still matches its own link)
      // and immune to a recorded target aimed at a sibling's store file.
      resolvedLinkTarget = path.resolve(path.dirname(safeEntryPath), target);
      if (safeStorePath !== null && resolvedLinkTarget === safeStorePath) {
        if (store === null || storeOwned) {
          if (mode === 'apply') {
            await removeFileIfPresent(safeEntryPath, assertLease);
            await rmdirIfEmpty(path.dirname(safeEntryPath));
          }
          removed = true;
          removeStore = storeOwned && !storeShared;
        } else {
          return {
            removed: false,
            warning:
              `preserved modified global symlink artifact "${safeEntryPath}" and its store ` +
              `"${safeStorePath}" while dropping the final repository reference`,
          };
        }
      }
    }
    if (mode === 'apply' && removeStore && safeStorePath !== null) {
      await removeFileIfPresent(safeStorePath, assertLease);
      await rmdirIfEmpty(path.dirname(safeStorePath));
    }
    if (st === null && store !== null && !storeOwned) {
      return {
        removed: false,
        warning: `preserved modified global store artifact "${safeStorePath}" while dropping its final repository reference`,
      };
    }
    if (st !== null && !st.isSymbolicLink()) {
      return {
        removed: false,
        warning: `preserved non-symlink global artifact "${safeEntryPath}" while dropping its final repository reference`,
      };
    }
    if (storeShared && storeOwned) {
      return {
        removed,
        warning:
          `kept the shared global store artifact "${safeStorePath}" — an entry under another ` +
          `agent root still points at it. Release that root's reference to reclaim it.`,
      };
    }
    if (st?.isSymbolicLink() && (safeStorePath === null || resolvedLinkTarget !== safeStorePath)) {
      return {
        removed: false,
        warning: `preserved re-pointed global symlink "${safeEntryPath}" while dropping its final repository reference`,
      };
    }
    return { removed, warning: null };
  }
  if (st?.isFile() && entry.expectedHash) {
    const onDisk = sha256Hex(await readFile(safeEntryPath, 'utf8'));
    if (onDisk === entry.expectedHash) {
      if (mode === 'apply') {
        await removeFileIfPresent(safeEntryPath, assertLease);
        await rmdirIfEmpty(path.dirname(safeEntryPath));
      }
      return { removed: true, warning: null };
    }
  }
  if (st !== null) {
    return {
      removed: false,
      warning: `preserved modified global artifact "${safeEntryPath}" while dropping its final repository reference`,
    };
  }
  return { removed: false, warning: null };
}

async function removeStoreIfOwned(
  storePath: string,
  expectedHash: string | null,
  assertLease: () => Promise<void>
): Promise<boolean> {
  const store = await lstatOrNull(storePath, 'global store artifact');
  if (store === null) return true;
  if (
    !store.isFile() ||
    expectedHash === null ||
    sha256Hex(await readFile(storePath, 'utf8')) !== expectedHash
  ) {
    return false;
  }
  await removeFileIfPresent(storePath, assertLease);
  await rmdirIfEmpty(path.dirname(storePath));
  return true;
}

async function removeFileIfPresent(
  filePath: string,
  assertLease: () => Promise<void>
): Promise<void> {
  await assertLease();
  try {
    await rm(filePath, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
