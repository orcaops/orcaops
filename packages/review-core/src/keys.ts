// Identity keys + the citation-id grammar.
//
// Every human- or agent-authored piece of review state (thread/checkpoint
// progress, finding & uncertainty dispositions, comments) keys off a
// regeneration-STABLE identity so the re-derivable floor and installed Story
// projections can be rebuilt freely without orphaning that state. The keys are
// content hashes over canonicalized member/anchor sets — never over ordinals
// or boundary shas, which move on every re-floor.
//
// "Regeneration-stable" has to mean stable under the regenerations that ACTUALLY
// happen. Hashing a thread's checkpoint set is stable under re-ordering (a thing
// that never happens) and NOT under a checkpoint being closed (a thing that
// happens constantly) — such a key would silently orphan reviewer coverage. Read
// each recipe below against that test: what real event changes this input?
//
// All keys share ONE hash family: BLAKE3-XOF, domain-separated, base64url
// (no pad) — the same family the captured line/patch hashes use, reached
// through the already-present diff-fingerprint primitives. No second hashing
// dependency enters, and a future sibling can reproduce these keys from the
// documented recipe below.

import {
  blake3Bytes,
  encodeBase64UrlNoPad,
  lenPrefix,
  lenPrefixUtf8,
  LINE_HASH_ALGORITHM,
  LINE_NORMALIZATION_VERSION,
  lineHash,
  normalizeLineBody,
} from '@orcaops/diff-fingerprint';

import {
  CHECKPOINT_SCOPED_CITATION_KINDS,
  CITATION_KIND,
  type CitationKind,
  type FindingKind,
  type FindingOrigin,
  type FindingScope,
} from './enums.js';

// Line-membership primitives re-exported for the attribution engine,
// the comment/finding anchors, and disclosure — one hashing surface for the
// whole surface.
export { lineHash, normalizeLineBody, LINE_HASH_ALGORITHM, LINE_NORMALIZATION_VERSION };

// ---------------------------------------------------------------------------
// stableHash64 — the shared recipe
// ---------------------------------------------------------------------------

const LF = 0x0a;
const textEncoder = new TextEncoder();

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Domain-separated 64-bit stable hash. Framing is
 * `utf8(domain) || 0x0A || concat(len_prefix(part_i))`, then BLAKE3-XOF-64,
 * then base64url without padding — matching the captured line/patch hash
 * framing exactly so keys never drift from the hash family they cite. String
 * parts are UTF-8 length-prefixed; byte parts are length-prefixed as-is. The
 * caller is responsible for canonicalizing an unordered part set (see
 * `canonicalMembers`).
 */
export async function stableHash64(
  domain: string,
  parts: ReadonlyArray<string | Uint8Array>
): Promise<string> {
  const framed: Uint8Array[] = [textEncoder.encode(domain), Uint8Array.of(LF)];
  for (const part of parts) {
    framed.push(typeof part === 'string' ? lenPrefixUtf8(part) : lenPrefix(part));
  }
  return encodeBase64UrlNoPad(await blake3Bytes(concatBytes(framed), 64));
}

/** Sort + dedup a member/anchor set so identity is independent of input order. */
export function canonicalMembers(members: readonly string[]): string[] {
  return Array.from(new Set(members)).sort();
}

// Domain separators — one per key kind so the same member set never collides
// across kinds. Versioned; bump the suffix on any recipe change.
export const DOMAIN_SECTION = 'orcaops.review.section.v1';
export const DOMAIN_CHAPTER = 'orcaops.review.chapter.v1';
export const DOMAIN_FINDING = 'orcaops.review.finding.v1';
export const DOMAIN_HUNK = 'orcaops.review.hunk.v1';
export const DOMAIN_PROMPT = 'orcaops.review.prompt.v1';
export const DOMAIN_PLACEMENT_TARGET = 'orcaops.review.placement_target.v1';
export const DOMAIN_CONTEXT_LINE = 'orcaops.review.context_line.v1';

// ---------------------------------------------------------------------------
// Member refs — the canonical strings thread/checkpoint keys hash over
// ---------------------------------------------------------------------------

/** Canonical checkpoint member ref: `<artifact>:cp<n>`. */
export function checkpointRef(artifactId: string, n: number): string {
  return `${artifactId}:cp${n}`;
}

/**
 * Canonical thread member ref: `<artifact>:thread`. A thread IS its artifact, so
 * this is the artifact's identity and nothing else — deliberately not derivable
 * from the checkpoints inside it. The `:thread` suffix keeps it from colliding
 * with a `checkpointRef` or `stepRef` for the same artifact.
 */
export function threadRef(artifactId: string): string {
  return `${artifactId}:thread`;
}

/** Canonical plan-step member ref: `<artifact>:step:<stepId>`. */
export function stepRef(artifactId: string, stepId: string): string {
  return `${artifactId}:step:${stepId}`;
}

// ---------------------------------------------------------------------------
// The identity keys
// ---------------------------------------------------------------------------

/**
 * Thread key — the durable identity of one artifact-as-thread, and the bucket
 * every piece of reviewer state (coverage, placements, dispositions) hangs off.
 *
 * It hashes the artifact id and NOTHING else. It deliberately does not accept a
 * member set: a key that moved when a checkpoint closed would leave
 * `replayReviewLedgerV2` dropping every ledger entry whose key no longer
 * matched, destroying reviewer progress on a thread that had merely grown. Rows
 * are content-addressed and survive a re-floor; the bucket they live in has to
 * survive it too. Taking the id directly makes that class of bug unrepresentable
 * rather than merely discouraged.
 *
 * The `sec_` prefix stays: persisted review state already carries these
 * tokens, and the value is an opaque token that nothing parses.
 */
export async function threadKey(artifactId: string): Promise<string> {
  return `sec_${await stableHash64(DOMAIN_SECTION, [threadRef(artifactId)])}`;
}

/**
 * Checkpoint key — identity of one checkpoint within a thread. This one DOES
 * hash a member set, and safely: a checkpoint's members are fixed when it closes
 * and never grow afterwards, so the set cannot move beneath it the way a
 * thread's could. Order- and duplicate-independent.
 */
export async function checkpointKey(members: readonly string[]): Promise<string> {
  return `chap_${await stableHash64(DOMAIN_CHAPTER, canonicalMembers(members))}`;
}

export interface FindingKeyInput {
  kind: FindingKind;
  scope: FindingScope;
  origin: FindingOrigin;
  /** Citation ids / hunkKeys / code-anchor refs the finding points at. Order-independent. */
  anchors: readonly string[];
  /** Optional tie-breaker when two same-kind findings share the same anchors. */
  discriminator?: string;
}

/**
 * Finding key — content/origin-based: a hash over `kind`, `scope`,
 * `origin`, and the finding's canonicalized anchor set (plus an optional
 * discriminator). Deliberately excludes the prose so re-wording a finding does
 * not orphan its disposition, while a genuinely different concern (new kind or
 * new anchors) gets a new key.
 */
export async function findingKey(input: FindingKeyInput): Promise<string> {
  const parts: string[] = [
    input.kind,
    input.scope,
    input.origin,
    ...canonicalMembers(input.anchors),
  ];
  if (input.discriminator !== undefined) {
    parts.push(`disc:${input.discriminator}`);
  }
  return `find_${await stableHash64(DOMAIN_FINDING, parts)}`;
}

/** Stable prompt identity excludes rewordable question prose and placement. */
export async function promptKey(input: {
  sourceIdentity: string;
  discriminator?: string;
}): Promise<string> {
  const parts = [input.sourceIdentity];
  if (input.discriminator !== undefined) parts.push(`disc:${input.discriminator}`);
  return `prompt_${await stableHash64(DOMAIN_PROMPT, parts)}`;
}

export interface ChangedRangeTargetKeyInput {
  file: string;
  hunkKey: string;
  ranges: readonly {
    side: 'add' | 'delete';
    startLine: number;
    endLine: number;
    lineHashes: readonly string[];
  }[];
}

/**
 * Content-addressed CHANGED_RANGE target identity. No floor slice ordinal is
 * accepted by this recipe. Range order is canonicalized by side and bounds.
 */
export async function changedRangeTargetKey(input: ChangedRangeTargetKeyInput): Promise<string> {
  const ranges = [...input.ranges]
    .sort(
      (a, b) => a.side.localeCompare(b.side) || a.startLine - b.startLine || a.endLine - b.endLine
    )
    .map(
      (range) => `${range.side}:${range.startLine}:${range.endLine}:${range.lineHashes.join(',')}`
    );
  return `target_${await stableHash64(DOMAIN_PLACEMENT_TARGET, [
    'CHANGED_RANGE',
    input.file,
    input.hunkKey,
    ...ranges,
  ])}`;
}

/** Content identity for one unchanged pinned-head source line. */
export async function contextLineHash(body: string): Promise<string> {
  return stableHash64(DOMAIN_CONTEXT_LINE, [body]);
}

export interface HunkKeyInput {
  filePath: string;
  /** Content hash of the hunk (its patch hash or a body hash) — opaque here. */
  contentHash: string;
  /** 0-based ordinal disambiguating identical-content hunks within one file. */
  occurrence: number;
}

/**
 * Hunk key — `filePath + content-hash + occurrence-ordinal`. The occurrence
 * ordinal is what separates two byte-identical hunks in the same
 * file; without it their keys would collide.
 */
export async function hunkKey(input: HunkKeyInput): Promise<string> {
  return `hunk_${await stableHash64(DOMAIN_HUNK, [
    input.filePath,
    input.contentHash,
    String(input.occurrence),
  ])}`;
}

/**
 * Slice key — `<parentHunkKey>:s<ordinal>`, the display identity of one unit
 * within a parent hunk's slice partition. NON-DURABLE by contract: the ordinal
 * shifts whenever attribution re-partitions the hunk, so this key must never
 * be persisted in durable reviewer records or installed Story models — durable
 * anchoring stays in the parent `hunkKey` + lineHash spaces.
 */
export function sliceKey(hunkKey: string, ordinal: number): string {
  return `${hunkKey}:s${ordinal}`;
}

// ---------------------------------------------------------------------------
// Citation-id grammar
// ---------------------------------------------------------------------------
//
// `cite:<artifact>:cp<n>:<kind>:<i>`   (checkpoint-scoped kinds)
// `cite:<artifact>:<kind>:<i>`          (artifact-scoped kinds)
//
// The `<kind>` token is a stable lowercase slug per citation kind. Checkpoint
// kinds carry a `cp<n>` locus; artifact-scoped kinds must not. Artifact ids are
// UUIDv7 (hex + hyphen), so ':' is an unambiguous delimiter.

const CITATION_KIND_TOKEN: Readonly<Record<CitationKind, string>> = {
  [CITATION_KIND.CHECKPOINT_DECISION]: 'decision',
  [CITATION_KIND.CHECKPOINT_UNCERTAINTY]: 'uncertainty',
  [CITATION_KIND.CHECKPOINT_ALTERNATIVE]: 'alternative',
  [CITATION_KIND.CRITERION_EVIDENCE]: 'criterion_evidence',
  [CITATION_KIND.CHECKPOINT_VERIFICATION]: 'verification',
  [CITATION_KIND.PLAN_STEP]: 'plan_step',
  [CITATION_KIND.PLAN_NON_GOAL]: 'plan_non_goal',
  [CITATION_KIND.PLAN_DECISION]: 'plan_decision',
  [CITATION_KIND.PLAN_ALTERNATIVE]: 'plan_alternative',
  [CITATION_KIND.ACCEPTANCE_CRITERION]: 'acceptance',
  [CITATION_KIND.SUMMARY]: 'summary',
  [CITATION_KIND.EVALUATOR_RUN]: 'evaluator_run',
};

const TOKEN_TO_CITATION_KIND: Readonly<Record<string, CitationKind>> = Object.fromEntries(
  Object.entries(CITATION_KIND_TOKEN).map(([kind, token]) => [token, kind as CitationKind])
);

export interface CitationIdParts {
  artifact: string;
  /** Checkpoint number for checkpoint-scoped kinds; null for artifact-scoped kinds. */
  checkpointN: number | null;
  kind: CitationKind;
  /** Index into the underlying record array (decisions, steps, …). */
  index: number;
}

function isCheckpointScoped(kind: CitationKind): boolean {
  return CHECKPOINT_SCOPED_CITATION_KINDS.includes(kind);
}

/** Build a citation id, enforcing the cp-required / cp-forbidden split per kind. */
export function formatCitationId(parts: CitationIdParts): string {
  const token = CITATION_KIND_TOKEN[parts.kind];
  const cpScoped = isCheckpointScoped(parts.kind);
  if (cpScoped && (parts.checkpointN == null || parts.checkpointN < 1)) {
    throw new Error(`citation kind ${parts.kind} requires a checkpoint number >= 1`);
  }
  if (!cpScoped && parts.checkpointN != null) {
    throw new Error(`citation kind ${parts.kind} is artifact-scoped; drop the checkpoint`);
  }
  if (!Number.isInteger(parts.index) || parts.index < 0) {
    throw new Error(`citation index must be a non-negative integer`);
  }
  const locus = parts.checkpointN != null ? `cp${parts.checkpointN}:` : '';
  return `cite:${parts.artifact}:${locus}${token}:${parts.index}`;
}

/** Parse a citation id, returning null when the grammar or cp-scoping is violated. */
export function parseCitationId(id: string): CitationIdParts | null {
  const seg = id.split(':');
  if (seg.length < 4 || seg[0] !== 'cite') return null;
  const artifact = seg[1];
  if (!artifact) return null;

  let rest = seg.slice(2);
  let checkpointN: number | null = null;
  if (rest[0] && /^cp\d+$/.test(rest[0])) {
    checkpointN = Number(rest[0].slice(2));
    if (checkpointN < 1) return null;
    rest = rest.slice(1);
  }
  if (rest.length !== 2) return null;

  const [token, idxStr] = rest;
  const kind = TOKEN_TO_CITATION_KIND[token];
  if (!kind) return null;
  if (!/^\d+$/.test(idxStr)) return null;

  const cpScoped = isCheckpointScoped(kind);
  if (cpScoped && checkpointN == null) return null;
  if (!cpScoped && checkpointN != null) return null;

  return { artifact, checkpointN, kind, index: Number(idxStr) };
}

/** Whether a string is a well-formed citation id. */
export function isCitationId(id: string): boolean {
  return parseCitationId(id) !== null;
}
