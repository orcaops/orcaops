import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { PlannedFile } from '@orcaops/adapters';
import {
  assertCanonicalRelativePath,
  assertResolvedWithin,
  PathContainmentError,
} from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
// Type-only, so the resolver's runtime import of this module is not a cycle.
import type { CloudPreservation } from './install-cloud-preserve.js';
import type { InstructionPlacement } from './instruction-placement.js';
import { formatZodIssues } from './zod-issues.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * The hash-guarded two-layer install manifest.
 *
 *   - `install.json` (committed, churn-free, PROJECT scope) records WHAT orcaops
 *     manages — typed by ownership kind — plus the install-agent set and the
 *     manifest schema version. NO per-file hashes and NO CLI version (either would
 *     churn the committed file every release).
 *   - `install.local.json` (gitignored, per-machine) records the materialization +
 *     safe-mutation state: the expected managed hash, provenance, and the
 *     per-entry delete guard. Hashes churn and absolute paths break on a clone, so
 *     it is never committed; prune/uninstall reconstruct it when absent.
 */
export const MANIFEST_VERSION = 1;
export const INSTALL_MANIFEST_REL = path.join('.orcaops', 'install.json');
export const LOCAL_MANIFEST_REL = path.join('.orcaops', 'install.local.json');

export type OwnershipKind = 'generated-file' | 'injected-block' | 'gitignore-entry';
export type Provenance = 'created' | 'adopted' | 'pre-existing';
/** The per-entry delete guard. Replaces the overloaded `prunable` flag. */
export type DeleteMode = 'hash' | 'confirm' | 'never';

export interface InstallEntry {
  kind: OwnershipKind;
  /** Repo-relative path or pattern. */
  path: string;
}

export interface InstallManifest {
  manifest_version: number;
  /** Which agents orcaops installed for (SupportedAgentId[]). Project scope only. */
  install_agents: string[];
  /**
   * The naming prefix the recorded paths were generated under. Lets
   * `update` detect a prefix CHANGE (prev `naming_prefix` !== current
   * `config.naming.prefix`) and prune the OLD `<old>-*` footprint.
   */
  naming_prefix: string;
  entries: InstallEntry[];
}

export interface LocalEntry {
  kind: OwnershipKind;
  path: string;
  /**
   * orcaops's EXPECTED managed hash (whole-file for generated-file, block-region
   * for injected-block) — NOT the observed on-disk bytes. `null` when the bytes
   * are unreproducible (removed template) or for a symlink.
   */
  expectedHash: string | null;
  provenance: Provenance;
  deleteMode: DeleteMode;
  /**
   * How an `injected-block` entry is MATERIALIZED on THIS machine.
   * `'block'` (default) holds the managed block in the file; `'symlink'` is a
   * pointer to the canonical instruction file. Per-machine — the committed
   * `install.json` records every instruction file as `injected-block` regardless,
   * so it stays identical whether a machine symlinked or dual-wrote.
   */
  materialization?: 'block' | 'symlink';
  /** Relative symlink target — set when `materialization === 'symlink'`. */
  symlinkTarget?: string | null;
}

export interface LocalManifest {
  manifest_version: number;
  entries: LocalEntry[];
  /**
   * `info/exclude` lines the last run managed on THIS machine. The exclude
   * file is per-checkout git-dir state, so the committed `install.json`
   * never records these (deliberately NOT a new `OwnershipKind` — the
   * entry-driven prune/uninstall switches must not learn a kind that isn't
   * a worktree file). The field is optional — a fresh clone has no local
   * manifest yet — and readers fall back to the canonical personal set.
   */
  info_exclude?: string[];
}

/**
 * Slash-normalize an adapter-produced path for manifest comparison. Manifest
 * paths are slash-canonical and the read schema rejects a backslash, so a
 * platform-separator path never matches — failure-OPEN for a preservation rule.
 */
export function toPortableManifestPath(rel: string): string {
  return rel.replaceAll('\\', '/');
}

function portableManagedPath(value: string, label: string): string {
  return assertCanonicalRelativePath(toPortableManifestPath(value), label);
}

// ── strict read-side schemas ─────────────────────────────────────────────────
//
// Readers are FAIL-CLOSED: manifest_version must be exactly the supported
// version, unknown keys are rejected, discriminants and cross-field
// invariants are enforced, and managed paths must already be canonical
// slash-relative. Backslash paths must be regenerated, not silently normalized
// (writers still normalize); the strict read contract prevents malformed
// ownership metadata from weakening downstream mutation guards.
//
// The committed install.json is thereby a CLOSED contract: any additive field
// requires a manifest_version bump, and a teammate on an older CLI will
// hard-fail on the newer file rather than silently dropping it.

/** Canonical slash-relative managed path; rejects backslashes and traversal. */
const managedPathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `backslash path "${value}" — managed paths must be canonical slash-relative; regenerate with \`orcaops update\``,
      });
      return;
    }
    try {
      assertCanonicalRelativePath(value, 'managed path');
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

const installEntrySchema = z
  .discriminatedUnion('kind', [
    // gitignore patterns are literal text, not paths — no canonical check.
    z.object({ kind: z.literal('gitignore-entry'), path: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('generated-file'), path: managedPathSchema }).strict(),
    z.object({ kind: z.literal('injected-block'), path: managedPathSchema }).strict(),
  ])
  .transform((entry) => entry as InstallEntry);

const installManifestSchema = z
  .object({
    manifest_version: z.literal(MANIFEST_VERSION),
    install_agents: z.array(z.string().min(1)),
    naming_prefix: z.string().min(1),
    entries: z.array(installEntrySchema),
  })
  .strict();

const localEntryBase = {
  path: managedPathSchema,
  expectedHash: z.string().min(1).nullable(),
  provenance: z.enum(['created', 'adopted', 'pre-existing']),
  deleteMode: z.enum(['hash', 'confirm', 'never']),
};

const localEntrySchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('gitignore-entry'),
        ...localEntryBase,
        path: z.string().min(1),
      })
      .strict(),
    z.object({ kind: z.literal('generated-file'), ...localEntryBase }).strict(),
    z
      .object({
        kind: z.literal('injected-block'),
        ...localEntryBase,
        materialization: z.enum(['block', 'symlink']).optional(),
        symlinkTarget: z.string().min(1).nullable().optional(),
      })
      .strict(),
  ])
  .superRefine((entry, ctx) => {
    if (entry.kind !== 'injected-block') return;
    const materialization = entry.materialization ?? 'block';
    if (materialization === 'symlink') {
      if (entry.expectedHash !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a symlink materialization carries no content hash (expectedHash must be null)',
        });
      }
      // The null-target + hash-deletable combination is exactly the shape the
      // delete guard must never trust — reject it before mutation planning.
      if (entry.deleteMode === 'hash' && !entry.symlinkTarget) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'a hash-deletable symlink entry must record its target (symlinkTarget is null/absent)',
        });
      }
    } else if (entry.symlinkTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'symlinkTarget is only valid when materialization is "symlink"',
      });
    }
  })
  .transform((entry) => entry as LocalEntry);

const localManifestSchema = z
  .object({
    manifest_version: z.literal(MANIFEST_VERSION),
    entries: z.array(localEntrySchema),
    // Per-checkout `info/exclude` bookkeeping written by the personal-scope
    // install. Optional because a fresh clone has no local manifest yet; the
    // strict object would otherwise reject every file the installer writes.
    info_exclude: z.array(z.string()).optional(),
  })
  .strict();

/** Fail-closed manifest rejection: one typed, actionable error per bad file.
 *  The remedy must NOT be circular — every regenerating command reads this
 *  file first, so the message names deletion/repair as the working escape
 *  (a deleted install.json is re-planned by `orcaops update`; a deleted
 *  install.local.json is reconstructed automatically). */
function manifestReadError(relPath: string, label: string, detail: string): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `${relPath} is not a valid ${label}: ${detail}. No changes were made. ` +
      `Repair the file by hand, or delete it and run \`orcaops update\` to regenerate it, then retry.`,
    label
  );
}

function formatIssues(error: z.ZodError): string {
  return formatZodIssues(error.issues);
}

function normalizeInstallEntry(entry: InstallEntry): InstallEntry {
  if (entry.kind === 'gitignore-entry') return entry;
  return {
    ...entry,
    path: portableManagedPath(entry.path, `${entry.kind} install entry path`),
  };
}

function normalizeLocalEntry(entry: LocalEntry): LocalEntry {
  if (entry.kind === 'gitignore-entry') return entry;
  return {
    ...entry,
    path: portableManagedPath(entry.path, `${entry.kind} local entry path`),
  };
}

function normalizeInstallManifest(manifest: InstallManifest): InstallManifest {
  return { ...manifest, entries: manifest.entries.map(normalizeInstallEntry) };
}

function normalizeLocalManifest(manifest: LocalManifest): LocalManifest {
  return { ...manifest, entries: manifest.entries.map(normalizeLocalEntry) };
}

// ── stamp extraction ─────────────────────────────────────────────────────────

const GENERATED_STAMP_RE = /generatedBy:\s*"orcaops@([^"\n]+)"/;
const BLOCK_STAMP_RE = /<!-- orcaops:start v=([^\s]+) -->/;

/** Read the orcaops version stamp out of managed content, or null if unstamped. */
export function extractStamp(kind: OwnershipKind, content: string): string | null {
  const re = kind === 'injected-block' ? BLOCK_STAMP_RE : GENERATED_STAMP_RE;
  const m = content.match(re);
  return m ? m[1] : null;
}

// ── adoption classifier ───────────────────────────────────────────────────────

export interface ClassifyInput {
  kind: OwnershipKind;
  /** Current on-disk content (the block region for injected-block), or null. */
  currentContent: string | null;
  /** The hash orcaops currently produces for this entry. */
  desiredHash: string;
  /** Whether the on-disk content byte-equals the current desired output. */
  contentMatchesDesired: boolean;
  /** The running CLI version (the "current" stamp). */
  currentVersion: string;
}

export interface Classification {
  provenance: Provenance;
  deleteMode: DeleteMode;
  expectedHash: string | null;
}

/**
 * Classify a managed-looking artifact for adoption or reconstruction. Only a
 * current stamp can establish a relationship to the current generated output:
 *
 *   - absent                          → created, hash (orcaops will materialize it)
 *   - current stamp + content matches → created, hash (clean owned)
 *   - current stamp + content differs → adopted, never (a user edit — preserve)
 *   - non-current or absent stamp     → pre-existing, never (ownership unproven)
 */
export function classifyAdoption(input: ClassifyInput): Classification {
  const { currentContent, desiredHash, contentMatchesDesired, currentVersion } = input;
  if (currentContent === null) {
    return { provenance: 'created', deleteMode: 'hash', expectedHash: desiredHash };
  }
  const stamp = extractStamp(input.kind, currentContent);
  if (stamp === null) {
    return { provenance: 'pre-existing', deleteMode: 'never', expectedHash: null };
  }
  if (stamp === currentVersion) {
    return contentMatchesDesired
      ? { provenance: 'created', deleteMode: 'hash', expectedHash: desiredHash }
      : { provenance: 'adopted', deleteMode: 'never', expectedHash: desiredHash };
  }
  return { provenance: 'pre-existing', deleteMode: 'never', expectedHash: null };
}

// ── derive entries from a just-executed plan (init/update path) ──────────────

/**
 * A LocalEntry for an entry orcaops just generated. Post-execute the on-disk
 * bytes equal the desired output for anything orcaops wrote, so a written entry
 * gets a hash guard; a stamp-matched user edit or non-file entry that
 * `generate` preserved gets the never guard.
 */
export function localEntryFromPlannedFile(pf: PlannedFile): LocalEntry {
  if (pf.reason === 'preserved-ahead') {
    // A NEWER orcaops wrote these bytes; this CLI cannot verify or own them.
    // pre-existing/never — matching classifyAdoption for non-current stamps —
    // so an older CLI never acquires deletion authority over ahead state.
    return {
      kind: 'generated-file',
      path: portableManagedPath(pf.path, 'generated local entry path'),
      expectedHash: null,
      provenance: 'pre-existing',
      deleteMode: 'never',
    };
  }
  // Post-execute, orcaops has written the desired bytes for any changed entry, so
  // on-disk == expected → a hash guard is valid. Preserved user replacements
  // and stamp-matched edits are never automatically deleted.
  const userReplacementPreserved =
    pf.preservedReason === 'non-file' ||
    (pf.action === 'unchanged' && pf.currentContent !== pf.desiredContent);
  return {
    kind: 'generated-file',
    path: portableManagedPath(pf.path, 'generated local entry path'),
    expectedHash: pf.hash,
    provenance: userReplacementPreserved ? 'adopted' : 'created',
    deleteMode: userReplacementPreserved ? 'never' : 'hash',
  };
}

export function localEntryFromPlacement(pl: InstructionPlacement): LocalEntry {
  if (pl.materialization === 'symlink') {
    // A symlink to the canonical: no block bytes of its own, so no expected hash.
    // `deleteMode: 'hash'` + `materialization: 'symlink'` tells prune/uninstall it
    // is safe to remove while it still points at the canonical.
    return {
      kind: 'injected-block',
      path: portableManagedPath(pl.path, 'instruction local entry path'),
      expectedHash: null,
      provenance: 'created',
      deleteMode: 'hash',
      materialization: 'symlink',
      symlinkTarget: pl.symlinkTarget ?? null,
    };
  }
  if (pl.reason === 'preserved-ahead') {
    // A NEWER orcaops wrote this block; recording it as CLI-created would
    // claim ownership of ahead state. pre-existing/never, like generated files.
    return {
      kind: 'injected-block',
      path: portableManagedPath(pl.path, 'instruction local entry path'),
      expectedHash: null,
      provenance: 'pre-existing',
      deleteMode: 'never',
      materialization: 'block',
    };
  }
  return {
    kind: 'injected-block',
    path: portableManagedPath(pl.path, 'instruction local entry path'),
    expectedHash: pl.blockHash ?? null,
    provenance: 'created',
    deleteMode: 'hash',
    materialization: 'block',
  };
}

// ── build / read / write ─────────────────────────────────────────────────────

export interface BuildManifestsInput {
  repoRoot: string;
  installAgents: string[];
  files: PlannedFile[];
  /** Resolved instruction-file placements — one per physical file. */
  instructionPlacements: InstructionPlacement[];
  /** orcaops-managed `.gitignore` lines (tracked so uninstall removes exactly them). */
  gitignoreLines: string[];
  /** Managed `info/exclude` lines — recorded in the LOCAL manifest only. */
  infoExcludeLines?: string[];
  /** The naming prefix these paths were generated under — recorded in install.json. */
  namingPrefix: string;
  /**
   * Generated files this run must RECORD but will not write — skills the cloud
   * gate withholds on this machine that a teammate committed. They land in BOTH
   * manifests through the same lockstep every other entry kind uses, so no
   * caller can record ownership without the matching delete guard.
   */
  preserved?: CloudPreservation;
}

export function buildManifests(input: BuildManifestsInput): {
  install: InstallManifest;
  local: LocalManifest;
} {
  const installEntries: InstallEntry[] = [];
  const localEntries: LocalEntry[] = [];

  // Two ordered streams merged rather than concat-then-sort: the planned
  // sequence is a subsequence of the reference order, so walking both in step
  // reproduces a credentialed run's order without a shared sort key that an
  // unknown path could scramble.
  const preservedFiles = input.preserved?.files ?? [];
  let p = 0;
  const pushPreservedThrough = (limit: number): void => {
    while (p < preservedFiles.length && preservedFiles[p]!.ordinal <= limit) {
      const pres = preservedFiles[p]!;
      installEntries.push({
        kind: 'generated-file',
        path: portableManagedPath(pres.path, 'preserved install entry path'),
      });
      localEntries.push(pres.local);
      p += 1;
    }
  };
  let planned = -1;
  for (const pf of input.files) {
    const rel = portableManagedPath(pf.path, 'generated install entry path');
    // Running max: monotonic even if a planned path is absent from the reference.
    planned = Math.max(planned, input.preserved?.ordinalOf(rel) ?? planned);
    pushPreservedThrough(planned);
    installEntries.push({ kind: 'generated-file', path: rel });
    localEntries.push(localEntryFromPlannedFile(pf));
  }
  pushPreservedThrough(Number.MAX_SAFE_INTEGER);
  // Sort placements by path so the committed `install.json` instruction-entry order
  // is MACHINE-INDEPENDENT. The placement order is canonical-first, and the canonical
  // file is chosen from on-disk state (which instruction file pre-exists), so without
  // this the committed entry order is filesystem-dependent → spurious git churn across
  // teammates. Generated-file and gitignore order are already deterministic, so only
  // the placements need sorting. `localEntries` inherit the same order in lockstep;
  // downstream lookups are by `entryKey(kind,path)` (not index), so this is safe.
  const sortedPlacements = [...input.instructionPlacements].sort((a, b) =>
    portableManagedPath(a.path, 'instruction placement path').localeCompare(
      portableManagedPath(b.path, 'instruction placement path')
    )
  );
  for (const pl of sortedPlacements) {
    // Logical ownership is machine-stable (always injected-block); the physical
    // symlink-vs-block mechanism lives only in the local entry.
    installEntries.push({
      kind: 'injected-block',
      path: portableManagedPath(pl.path, 'instruction install entry path'),
    });
    localEntries.push(localEntryFromPlacement(pl));
  }
  for (const line of input.gitignoreLines) {
    installEntries.push({ kind: 'gitignore-entry', path: line });
    localEntries.push({
      kind: 'gitignore-entry',
      path: line,
      expectedHash: null,
      provenance: 'created',
      deleteMode: 'never',
    });
  }

  return {
    install: {
      manifest_version: MANIFEST_VERSION,
      install_agents: input.installAgents,
      naming_prefix: input.namingPrefix,
      entries: installEntries,
    },
    local: {
      manifest_version: MANIFEST_VERSION,
      entries: localEntries,
      ...(input.infoExcludeLines && input.infoExcludeLines.length > 0
        ? { info_exclude: input.infoExcludeLines }
        : {}),
    },
  };
}

async function readValidated<T>(
  relPath: string,
  repoRoot: string,
  label: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  let safePath: string;
  try {
    safePath = assertResolvedWithin(path.join(repoRoot, relPath), repoRoot, label, {
      rejectSymlinks: true,
    });
  } catch (err) {
    // A containment refusal on the manifest FILE is a manifest problem, not
    // an internal fault — surface it through the same typed envelope.
    if (err instanceof PathContainmentError) {
      throw manifestReadError(relPath, label, err.message);
    }
    throw err;
  }
  let raw: string;
  try {
    raw = await readFile(safePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw manifestReadError(relPath, label, `malformed JSON (${(err as Error).message})`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw manifestReadError(relPath, label, formatIssues(result.error));
  }
  return result.data;
}

export async function readInstallManifest(repoRoot: string): Promise<InstallManifest | null> {
  return readValidated(INSTALL_MANIFEST_REL, repoRoot, 'install manifest', installManifestSchema);
}

export async function readLocalManifest(repoRoot: string): Promise<LocalManifest | null> {
  return readValidated(LOCAL_MANIFEST_REL, repoRoot, 'local install manifest', localManifestSchema);
}

export async function writeInstallManifest(repoRoot: string, m: InstallManifest): Promise<void> {
  await atomicWriteFile(
    path.join(repoRoot, INSTALL_MANIFEST_REL),
    `${JSON.stringify(normalizeInstallManifest(m), null, 2)}\n`,
    repoRoot
  );
}

export async function writeLocalManifest(repoRoot: string, m: LocalManifest): Promise<void> {
  await atomicWriteFile(
    path.join(repoRoot, LOCAL_MANIFEST_REL),
    `${JSON.stringify(normalizeLocalManifest(m), null, 2)}\n`,
    repoRoot
  );
}

// ── reconstruction (fresh clone / deleted local state) ───────────────────────

/**
 * Rebuild `install.local.json` from the committed `install.json` + on-disk files
 * + the current generation output, using the adoption classifier. Generated-file
 * entries reconstruct from a matching current plan (by path); a managed path with
 * no current template is treated as pre-existing because its ownership cannot be
 * verified. Non-generated kinds (gitignore / injected-block) carry forward
 * conservatively.
 */
export async function reconstructLocalManifest(
  repoRoot: string,
  install: InstallManifest,
  currentFiles: PlannedFile[],
  currentVersion: string
): Promise<LocalManifest> {
  const normalizedInstall = normalizeInstallManifest(install);
  const byPath = new Map(
    currentFiles.map((f) => [portableManagedPath(f.path, 'generated plan path'), f])
  );
  const entries: LocalEntry[] = [];

  for (const e of normalizedInstall.entries) {
    if (e.kind === 'generated-file') {
      const current = byPath.get(e.path);
      let onDisk: string | null = null;
      assertCanonicalRelativePath(e.path, 'generated install entry path');
      const declaredPath = path.join(repoRoot, e.path);
      const generatedParent = assertResolvedWithin(
        path.dirname(declaredPath),
        repoRoot,
        `generated install entry ${e.path} parent`,
        { allowRoot: true, rejectSymlinks: true }
      );
      const generatedEntry = path.join(generatedParent, path.basename(declaredPath));
      let stats;
      try {
        stats = await lstat(generatedEntry);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        stats = null;
      }
      if (stats !== null && !stats.isFile()) {
        entries.push({
          kind: e.kind,
          path: e.path,
          expectedHash: null,
          provenance: 'pre-existing',
          deleteMode: 'never',
        });
        continue;
      }
      const generatedPath = assertResolvedWithin(
        generatedEntry,
        repoRoot,
        `generated install entry ${e.path}`,
        { rejectSymlinks: true }
      );
      try {
        onDisk = await readFile(generatedPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (!current) {
        entries.push({
          kind: e.kind,
          path: e.path,
          expectedHash: null,
          provenance: 'pre-existing',
          deleteMode: 'never',
        });
        continue;
      }
      const cls = classifyAdoption({
        kind: e.kind,
        currentContent: onDisk,
        desiredHash: current.hash,
        contentMatchesDesired: onDisk === current.desiredContent,
        currentVersion,
      });
      entries.push({ kind: e.kind, path: e.path, ...cls });
    } else if (e.kind === 'gitignore-entry') {
      entries.push({
        kind: e.kind,
        path: e.path,
        expectedHash: null,
        provenance: 'created',
        deleteMode: 'never',
      });
    } else {
      // injected-block on reconstruct (no local manifest present): we cannot prove
      // orcaops owns this path without the local manifest, so it is confirm-gated
      // regardless of materialization. A symlink still records its target for
      // accurate state, but degrades to deleteMode 'confirm' (not 'hash') — the
      // observed target is self-referential here, so a 'hash' guard would always
      // pass and could remove a user-re-pointed link. The steady-state prevLocal
      // path keeps a symlink at deleteMode 'hash' (localEntryFromPlacement), so
      // update still prunes orphaned symlinks; only this fresh-clone fallback is
      // conservative. (Removing a symlink never touches its target regardless.)
      let linkTarget: string | null = null;
      assertCanonicalRelativePath(e.path, 'instruction install entry path');
      const entryParent = assertResolvedWithin(
        path.dirname(path.join(repoRoot, e.path)),
        repoRoot,
        `instruction install entry ${e.path} parent`,
        { allowRoot: true, rejectSymlinks: true }
      );
      const entryPath = path.join(entryParent, path.basename(e.path));
      try {
        const st = await lstat(entryPath);
        if (st.isSymbolicLink()) linkTarget = await readlink(entryPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (linkTarget !== null) {
        entries.push({
          kind: e.kind,
          path: e.path,
          expectedHash: null,
          provenance: 'adopted',
          deleteMode: 'confirm',
          materialization: 'symlink',
          symlinkTarget: linkTarget,
        });
      } else {
        entries.push({
          kind: e.kind,
          path: e.path,
          expectedHash: null,
          provenance: 'adopted',
          deleteMode: 'confirm',
        });
      }
    }
  }

  return { manifest_version: MANIFEST_VERSION, entries };
}

// ── diff (consumed by prune/uninstall in later slices) ───────────────────────

export interface ManifestDiff {
  /** Entries present in `prev` but not `next` — orphan candidates. */
  removed: InstallEntry[];
  /** Entries present in `next` but not `prev`. */
  added: InstallEntry[];
}

const entryKey = (e: InstallEntry): string => `${e.kind}\u0000${e.path}`;

export function diffInstallManifests(prev: InstallManifest, next: InstallManifest): ManifestDiff {
  const prevEntries = normalizeInstallManifest(prev).entries;
  const nextEntries = normalizeInstallManifest(next).entries;
  const nextKeys = new Set(nextEntries.map(entryKey));
  const prevKeys = new Set(prevEntries.map(entryKey));
  return {
    removed: prevEntries.filter((e) => !nextKeys.has(entryKey(e))),
    added: nextEntries.filter((e) => !prevKeys.has(entryKey(e))),
  };
}
