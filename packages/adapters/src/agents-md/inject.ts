import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertResolvedWithin,
  isDanglingFinalSymlink,
  PathContainmentError,
  sha256Hex,
} from '@orcaops/storage';

import { isVersionAhead, type StampDivergence } from '../renderers.js';
import { ORCAOPS_AGENTS_MD_MARKER_END, ORCAOPS_AGENTS_MD_MARKER_START_RE } from './template.js';

export type InjectAction = 'created' | 'inserted' | 'replaced' | 'unchanged';

export interface InjectOrcaopsSectionOptions {
  /** Absolute path to the file to write (e.g. <repoRoot>/AGENTS.md). */
  filePath: string;
  /** Owning worktree root. */
  containmentRoot: string;
  /**
   * Pre-rendered managed block. The CALLER — which holds the config
   * (naming prefix, workflow hints) — renders it via `renderOrcaopsAgentsMdSection`
   * and passes it in, so the planner never reaches back for config.
   */
  desiredBlock: string;
  /**
   * When true, replace even if the existing stamp matches (used by
   * `orcaops update --force`). Default false: same-stamp = unchanged.
   */
  force?: boolean;
  /** Replace a malformed marker layout, discarding everything after its first start marker. */
  repairMalformed?: boolean;
  /**
   * Allow replacing a block whose `v=` stamp is NEWER than the one
   * `desiredBlock` carries — a deliberate downgrade (`update --force` only).
   */
  overrideAhead?: boolean;
}

export interface InjectResult {
  filePath: string;
  action: InjectAction;
}

/**
 * A planned instruction-file injection. Pure data — computing one reads the file
 * but writes nothing, so the mutation/preview layer can show exactly what
 * `inject` would do. `desiredContent` is the FULL next file; `desiredBlock` /
 * `blockHash` describe just the managed marker region (the manifest's
 * block-region hash, since instruction files are mixed-ownership).
 */
export interface InjectPlan {
  filePath: string;
  action: InjectAction;
  /** Full file content after injection — what `execute` writes. */
  desiredContent: string;
  /** Current full file content, or null if the file is absent. */
  currentContent: string | null;
  /** The managed block region orcaops owns (markers included). */
  desiredBlock: string;
  /** sha-256 (hex) of `desiredBlock` — the expected managed-block hash. */
  blockHash: string;
  /** The input contained an ambiguous or unbalanced marker layout. */
  malformed: boolean;
  /** Set when the block's on-disk `v=` stamp is NEWER than `desiredBlock`'s. */
  reason?: StampDivergence;
  /** The block's on-disk `v=` stamp that triggered `reason`. */
  onDiskVersion?: string;
}

type MarkerParse =
  | { kind: 'absent' }
  | { kind: 'malformed'; firstStart: number | null; versions: string[] }
  | { kind: 'valid'; start: number; end: number; version: string };

function parseMarkers(content: string): MarkerParse {
  const startRe = new RegExp(ORCAOPS_AGENTS_MD_MARKER_START_RE.source, 'g');
  const starts = [...content.matchAll(startRe)];
  const ends: number[] = [];
  let end = content.indexOf(ORCAOPS_AGENTS_MD_MARKER_END);
  while (end !== -1) {
    ends.push(end);
    end = content.indexOf(ORCAOPS_AGENTS_MD_MARKER_END, end + ORCAOPS_AGENTS_MD_MARKER_END.length);
  }

  if (starts.length === 0 && ends.length === 0) return { kind: 'absent' };
  const firstStart = starts[0]?.index ?? null;
  if (starts.length !== 1 || ends.length !== 1 || firstStart === null || ends[0] < firstStart) {
    return { kind: 'malformed', firstStart, versions: starts.map((m) => m[1]) };
  }
  return {
    kind: 'valid',
    start: firstStart,
    end: ends[0] + ORCAOPS_AGENTS_MD_MARKER_END.length,
    version: starts[0][1],
  };
}

function withoutTerminalNewline(content: string): string {
  if (content.endsWith('\r\n')) return content.slice(0, -2);
  if (content.endsWith('\n')) return content.slice(0, -1);
  return content;
}

/** Stable identity for a managed marker region, independent of its trailing line break. */
export function hashOrcaopsSection(content: string): string {
  return sha256Hex(withoutTerminalNewline(content));
}

function endIncludingLineBreak(content: string, markerEnd: number): number {
  if (content.startsWith('\r\n', markerEnd)) return markerEnd + 2;
  if (content.startsWith('\n', markerEnd)) return markerEnd + 1;
  return markerEnd;
}

/**
 * Compute the orcaops bootstrap-section injection WITHOUT touching disk (beyond
 * reading the current file). The pure planner half of `injectOrcaopsSection`.
 *
 *   - File missing            → create it with just the section.
 *   - File exists, no markers → append the section to the end.
 *   - File exists, markers    → replace contents between markers.
 *   - Stamp NEWER than ours   → preserve unless the downgrade override is explicit.
 *   - Unterminated marker     → preserve unless destructive repair is explicit.
 *   - Same stamp + same body  → unchanged (the wrapper then preserves mtime).
 *
 * Content outside a well-formed marker block is never touched.
 */
export async function planInjectOrcaopsSection(
  opts: InjectOrcaopsSectionOptions
): Promise<InjectPlan> {
  const safeFilePath = assertResolvedWithin(
    opts.filePath,
    opts.containmentRoot,
    'instruction file',
    { rejectSymlinks: true }
  );
  const desiredBlock = opts.desiredBlock;

  let existing: string | null = null;
  let exists = false;
  let isRegularFile = false;
  try {
    const stats = await lstat(safeFilePath);
    exists = true;
    isRegularFile = stats.isFile();
    if (isRegularFile) existing = await readFile(safeFilePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const base = {
    filePath: opts.filePath,
    currentContent: existing,
    desiredBlock,
    blockHash: sha256Hex(desiredBlock),
    malformed: false,
  };

  if (exists && !isRegularFile) {
    return { ...base, action: 'unchanged', desiredContent: desiredBlock };
  }

  if (existing === null) {
    return { ...base, action: 'created', desiredContent: desiredBlock };
  }

  const markers = parseMarkers(existing);
  if (markers.kind === 'absent') {
    // No managed section yet → append. Add a separating blank line if the
    // existing content doesn't end with one.
    const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { ...base, action: 'inserted', desiredContent: existing + sep + desiredBlock };
  }

  // Ahead guard: runs BEFORE malformed repair and the body comparison, so a
  // block stamped NEWER than `desiredBlock` — well-formed or malformed — is
  // preserved without the explicit downgrade override. A malformed layout
  // checks every start stamp in the region: repair discards everything after
  // the first start, so any newer stamp there blocks unoverridden repair.
  const desiredVersion = desiredBlock.match(ORCAOPS_AGENTS_MD_MARKER_START_RE)?.[1] ?? null;
  const stampVersions = markers.kind === 'valid' ? [markers.version] : markers.versions;
  const aheadVersion =
    desiredVersion === null
      ? undefined
      : stampVersions.find((v) => isVersionAhead(v, desiredVersion));
  if (aheadVersion !== undefined && !opts.overrideAhead) {
    return {
      ...base,
      action: 'unchanged',
      reason: 'preserved-ahead',
      onDiskVersion: aheadVersion,
      desiredContent: existing,
      malformed: markers.kind === 'malformed',
    };
  }
  const downgrade: Pick<InjectPlan, 'reason' | 'onDiskVersion'> =
    aheadVersion !== undefined ? { reason: 'forced-downgrade', onDiskVersion: aheadVersion } : {};

  if (markers.kind === 'malformed') {
    if (!opts.repairMalformed || markers.firstStart === null) {
      return { ...base, action: 'unchanged', desiredContent: existing, malformed: true };
    }
    const before = existing.slice(0, markers.firstStart);
    const sep = before.endsWith('\n') || before === '' ? '' : '\n';
    return {
      ...base,
      ...downgrade,
      action: 'replaced',
      desiredContent: before + sep + desiredBlock,
      malformed: true,
    };
  }

  const existingSection = existing.slice(markers.start, markers.end);
  const desiredSection = withoutTerminalNewline(desiredBlock);

  if (!opts.force && existingSection === desiredSection) {
    return { ...base, action: 'unchanged', desiredContent: existing };
  }

  const before = existing.slice(0, markers.start);
  const after = existing.slice(markers.end);
  return {
    ...base,
    ...downgrade,
    action: 'replaced',
    desiredContent: before + desiredSection + after,
  };
}

/**
 * Idempotently inject the orcaops bootstrap section into AGENTS.md / CLAUDE.md.
 * A thin plan → execute wrapper over `planInjectOrcaopsSection`.
 */
export async function injectOrcaopsSection(
  opts: InjectOrcaopsSectionOptions
): Promise<InjectResult> {
  const plan = await planInjectOrcaopsSection(opts);
  if (plan.action !== 'unchanged') {
    const resolveTarget = (): string =>
      assertResolvedWithin(plan.filePath, opts.containmentRoot, 'instruction file', {
        rejectSymlinks: true,
      });
    await mkdir(path.dirname(resolveTarget()), { recursive: true });
    const target = resolveTarget();
    await writeFile(target, plan.desiredContent, 'utf8');
  }
  return { filePath: plan.filePath, action: plan.action };
}

export type RemoveAction = 'removed' | 'absent' | 'preserved-modified';

export interface RemovePlan {
  filePath: string;
  action: RemoveAction;
  /** Writable only for `removed`; `''` can mean absent, non-file, or removal of the only content. */
  desiredContent: string;
  currentContent: string | null;
}

/**
 * Plan the REMOVAL of orcaops's managed block from an instruction file (for a
 * `managed → manual` bootstrap flip). Hash-guarded: the block is stripped
 * only when it byte-matches `expectedBlock` (orcaops's own current output) — a
 * present-but-modified or stale block is preserved and reported (`preserved-modified`)
 * so a user edit is never silently dropped. Content outside the markers is untouched.
 */
export async function planRemoveOrcaopsSection(opts: {
  filePath: string;
  expectedBlock: string;
  containmentRoot: string;
}): Promise<RemovePlan> {
  const safeFilePath = assertResolvedWithin(
    opts.filePath,
    opts.containmentRoot,
    'instruction file',
    { rejectSymlinks: true }
  );
  let existing: string | null = null;
  let exists = false;
  let isRegularFile = false;
  try {
    const stats = await lstat(safeFilePath);
    exists = true;
    isRegularFile = stats.isFile();
    if (isRegularFile) existing = await readFile(safeFilePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const base = { filePath: opts.filePath, currentContent: existing };
  if (exists && !isRegularFile) {
    return { ...base, action: 'preserved-modified', desiredContent: '' };
  }
  if (existing === null) return { ...base, action: 'absent', desiredContent: '' };

  const markers = parseMarkers(existing);
  if (markers.kind === 'absent') {
    return { ...base, action: 'absent', desiredContent: existing };
  }
  if (markers.kind === 'malformed') {
    return { ...base, action: 'preserved-modified', desiredContent: existing };
  }

  const section = existing.slice(markers.start, markers.end);
  if (section !== withoutTerminalNewline(opts.expectedBlock)) {
    return { ...base, action: 'preserved-modified', desiredContent: existing };
  }
  const before = existing.slice(0, markers.start);
  const after = existing.slice(endIncludingLineBreak(existing, markers.end));
  return { ...base, action: 'removed', desiredContent: before + after };
}

/**
 * Read just the version stamp from a file's marker, or null if no managed
 * section is present. Used by `orcaops doctor` to detect stale stamps.
 */
export async function readOrcaopsSectionStamp(
  filePath: string,
  containmentRoot: string
): Promise<string | null> {
  return (await readOrcaopsSectionIdentity(filePath, containmentRoot))?.version ?? null;
}

export interface OrcaopsSectionIdentity {
  version: string;
  contentHash: string;
}

/**
 * Read EVERY start-marker stamp in a file, malformed layouts included.
 * `readOrcaopsSectionIdentity` returns null for malformed markers, which
 * would hide an ahead stamp exactly where destructive repair/removal advice
 * is decided — this reader never does.
 */
export async function readOrcaopsSectionStampVersions(
  filePath: string,
  containmentRoot: string
): Promise<string[]> {
  let content: string;
  try {
    const safePath = assertResolvedWithin(filePath, containmentRoot, 'instruction file');
    if (!(await lstat(safePath)).isFile()) return [];
    content = await readFile(safePath, 'utf8');
  } catch (err) {
    if (err instanceof PathContainmentError && isDanglingFinalSymlink(filePath)) return [];
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const startRe = new RegExp(ORCAOPS_AGENTS_MD_MARKER_START_RE.source, 'g');
  return [...content.matchAll(startRe)].map((m) => m[1]);
}

/** Read the managed marker region's version and exact content identity. */
export async function readOrcaopsSectionIdentity(
  filePath: string,
  containmentRoot: string
): Promise<OrcaopsSectionIdentity | null> {
  let content: string;
  try {
    const safePath = assertResolvedWithin(filePath, containmentRoot, 'instruction file');
    if (!(await lstat(safePath)).isFile()) return null;
    content = await readFile(safePath, 'utf8');
  } catch (err) {
    if (err instanceof PathContainmentError && isDanglingFinalSymlink(filePath)) return null;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const markers = parseMarkers(content);
  if (markers.kind !== 'valid') return null;
  return {
    version: markers.version,
    contentHash: hashOrcaopsSection(content.slice(markers.start, markers.end)),
  };
}
