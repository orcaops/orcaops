// Claim ledger v2 — the deterministic account-vs-reality
// confrontation engine. Zero model calls. Consumes the floor plus normalized
// checkpoint claims (loaded from the artifact store by the CLI adapter,
// restricted to the floor's artifact scope). Claims stay outside the floor
// schema so this derived check does not widen the floor's persisted contract.
//
// ## Spec (ledger-v2)
//
// Determinism contract: the promise covers `entries` — same floor + same
// checkpoint claims produce byte-identical `entries` JSON regardless of input
// ordering, locale, or wall clock. `generated_at` is transport metadata
// supplied by the caller and explicitly OUTSIDE the deterministic artifact.
// All ordering is code-point (never locale-collated); every evidence array is
// sorted; numbers are compared numerically, not lexically.
//
// Entry identity: `ldg:<kind>:<sha256(canonical).slice(0,16)>` where
// canonical = JSON.stringify([kind, discriminator, sortedCitations,
// sortedAnchors]) — length-delimited by construction, so no join ambiguity.
// `discriminator` is a per-kind stable key (checkpoint ref, disclosure text,
// citation pair, …) making same-shaped entries distinct. buildClaimLedger
// throws on a duplicate id — collisions are implementation bugs, never
// silently merged output.
//
// ## The adjudication boundary
//
// The ledger may assert structural and directly measured facts. Anything
// requiring semantic interpretation is reported as a LEAD and stays
// unadjudicated. No entry this file emits may cause a consumer to treat a
// captured claim as settled — see `adjudicationInvariant.test.ts`, which
// asserts the absence of that capability.
//
// Lexical similarity cannot establish that a decision supersedes an
// uncertainty or that changed code violates a non-goal. Those relations need
// semantic adjudication and are never inferred here.
//
// Entries are either measured (VERIFICATION_GAP, COVERAGE_GAP,
// UNTRACKED_EVIDENCE, the integrity CLAIM_CONTRADICTION) or explicitly named
// as a lead (POSSIBLE_TEXT_DUPLICATE, ATTRIBUTION_MISMATCH_CANDIDATE). The
// naming carries the epistemic status, because the name is what a reader sees.
//
// Statuses: `CANDIDATE` (deterministic evidence supports the relation; a
// human or bounded adjudication must confirm it) or `INCONCLUSIVE` (the check
// ran and could not decide — recorded instead of silently skipped).
// INCONCLUSIVE is emitted in exactly these bounded cases:
//   - ATTRIBUTION_MISMATCH_CANDIDATE: a files_changed claim names a path absent
//     from the ENTIRE review scope (renames, reverted work, out-of-scope files
//     — the floor cannot arbitrate the claim);
//   - POSSIBLE_TEXT_DUPLICATE: the pairwise scan hit the size cap and later
//     pairs were not compared.
// The ledger NEVER auto-resolves, rewrites, or deletes captured content.
//
// State-awareness limitation: floor citations carry no disposition, so every
// captured uncertainty participates regardless of narrative-level resolution.
// Consumers with review state are responsible for filtering resolved items.
//
// ## Checks and their deterministic algorithms
//
// Text normalization (shared): lowercase; split on /[^a-z0-9]+/ so compound
// spellings decompose to comparable parts ("pg/mysql" and "pg.test.ts" both
// yield pg + mysql/test); drop tokens shorter than 2 chars; drop pure
// stopwords (STOPWORDS below); strip one trailing 's' from purely alphabetic
// tokens longer than 3 chars.
//
// 1. POSSIBLE_TEXT_DUPLICATE — pairwise over captured uncertainty citations
//    (all artifacts in scope): containment ≥ 0.5 AND ≥3 shared tokens. One
//    entry per pair, citations sorted. This is the ONE lexical rule kept, and
//    its name says so: near-boilerplate pairs differing in one discriminative
//    token can match, so it surfaces a possible duplicate for a reader to
//    judge and never folds, resolves, or dedupes anything. Pairwise scan caps
//    at DUPLICATE_SCAN_CAP uncertainties (sorted by id); overflow emits one
//    INCONCLUSIVE entry naming the cap.
// 2. UNTRACKED_EVIDENCE — one entry per untracked-evidence-excluded
//    disclosure: workspace litter OUTSIDE review scope (never described as
//    shipped branch content), anchored to the path-looking tokens of the
//    disclosure. Factual — it reports what the floor already measured and
//    excluded, with no matching involved.
// 3. VERIFICATION_GAP — from checkpoint claims: (a) a closed checkpoint
//    claiming completed steps with zero verification entries; (b) a closed
//    checkpoint whose files_changed include a test-looking path
//    (/(^|\/)(tests?|__tests__)\// or /\.(test|spec)\./) while its
//    verification[] is empty; (c) command-to-test-file linkage: when every
//    recorded command is path-scoped (contains a test-path-looking token),
//    each claimed test file whose basename appears in no command string is
//    measured as un-named and one entry lists exactly those files. A command
//    with NO test-path token (a broad runner like `pnpm test`) is treated as
//    potentially exercising every claimed test file — absence of path
//    scoping is never converted into a lead. Basename containment is a
//    lexical measurement, not a semantic verdict: the entry reports that no
//    recorded command NAMES the file; whether some differently-spelled
//    command exercised it is the reader's judgment (CANDIDATE, like every
//    lead here).
// 4. CLAIM_CONTRADICTION — a floor integrity entry with `verified: false`: a
//    checkpoint's captured manifest does not reproduce against the tree. This
//    is a MEASURED contradiction — the tree either reproduces the manifest or
//    it does not — which is why this rule alone keeps the name.
// 5. ATTRIBUTION_MISMATCH_CANDIDATE — a checkpoint's files_changed claim
//    disagrees with floor attribution: the claimed file IS in the review scope
//    but NONE of its owned slices belong to the claiming checkpoint →
//    CANDIDATE; the claimed file is absent from the review scope entirely →
//    INCONCLUSIVE (rename/revert/out-of-scope — cannot arbitrate). A
//    checkpoint owning zero rows anywhere is skipped (facet-only). NOT called
//    a contradiction: snapshot outages, rebases, and overlapping checkpoint
//    windows explain this shape as readily as a false claim does, and the
//    ledger cannot tell which it is looking at.
// 6. COVERAGE_GAP — unexplained or ambiguous rows exist: one entry carrying
//    exact counts and gap files as anchors. (This asserts the gap EXISTS and
//    must be faced by any account; whether an account disclosed it is a
//    narrative-level question v1 does not judge.)

import { createHash } from 'node:crypto';

import type { Floor } from '@orcaops/review-core';
import { CITATION_KIND } from '@orcaops/review-core';

export const CLAIM_LEDGER_SCHEMA_VERSION = 1;

export const DUPLICATE_SCAN_CAP = 200;

export const CLAIM_LEDGER_ENTRY_KIND = {
  POSSIBLE_TEXT_DUPLICATE: 'POSSIBLE_TEXT_DUPLICATE',
  UNTRACKED_EVIDENCE: 'UNTRACKED_EVIDENCE',
  VERIFICATION_GAP: 'VERIFICATION_GAP',
  CLAIM_CONTRADICTION: 'CLAIM_CONTRADICTION',
  ATTRIBUTION_MISMATCH_CANDIDATE: 'ATTRIBUTION_MISMATCH_CANDIDATE',
  COVERAGE_GAP: 'COVERAGE_GAP',
} as const;
export type ClaimLedgerEntryKind =
  (typeof CLAIM_LEDGER_ENTRY_KIND)[keyof typeof CLAIM_LEDGER_ENTRY_KIND];

/**
 * Exact, registered prose shared by every measured attribution-mismatch
 * candidate. Keeping it next to the rule prevents the account renderer from
 * heuristically deciding that two explanations merely look alike.
 */
export const ATTRIBUTION_MISMATCH_SHARED_EXPLANATION =
  'A missed snapshot, a rebase, or an overlapping checkpoint window explains this as readily as an inaccurate claim.';

export const CLAIM_LEDGER_SHARED_EXPLANATIONS: Readonly<
  Partial<Record<ClaimLedgerEntryKind, string>>
> = {
  [CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE]: ATTRIBUTION_MISMATCH_SHARED_EXPLANATION,
};

export interface ClaimLedgerEntry {
  id: string;
  kind: ClaimLedgerEntryKind;
  status: 'CANDIDATE' | 'INCONCLUSIVE';
  /** One-sentence human statement of the relation. */
  message: string;
  /** Floor citation ids this entry relates — code-point sorted. */
  citations: string[];
  /** Code/checkpoint anchors (files, checkpoint refs) — code-point sorted. */
  anchors: string[];
  /** Per-kind structured evidence — matched tokens/numbers/counts, sorted. */
  evidence: Record<string, unknown>;
}

export interface ClaimLedger {
  schema_version: typeof CLAIM_LEDGER_SCHEMA_VERSION;
  branch: string;
  floor_input_hash: string;
  /** Transport metadata — OUTSIDE the deterministic artifact (see spec). */
  generated_at: string;
  entries: ClaimLedgerEntry[];
}

/**
 * Checkpoint claims the ledger needs that the floor does not carry. The CLI
 * adapter loads these from the artifact store, restricted to the floor's
 * artifact scope; tests construct them directly.
 */
export interface CheckpointClaims {
  artifact: string;
  cp: number;
  status: 'closed' | 'open' | 'abandoned';
  completedStepIds: string[];
  filesChanged: string[];
  /**
   * Recorded verification command strings (closed checkpoints; [] otherwise).
   * The count checks derive from `length`; the linkage check reads the
   * strings themselves.
   */
  verificationCommands: string[];
}

export interface BuildClaimLedgerInput {
  floor: Floor;
  checkpoints: CheckpointClaims[];
  generatedAt: string;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'with',
  'without',
  'by',
  'at',
  'from',
  'as',
  'not',
  'no',
  'they',
  'them',
  'their',
  'we',
  'our',
  'has',
  'have',
  'had',
  'may',
  'must',
  'should',
  'can',
  'could',
  'will',
  'would',
  'later',
  'need',
  'needs',
  'only',
  'still',
  'yet',
  'before',
  'after',
]);

export function normalizeClaimTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    const stemmed =
      raw.length > 3 && raw.endsWith('s') && /^[a-z]+$/.test(raw) ? raw.slice(0, -1) : raw;
    tokens.add(stemmed);
  }
  return tokens;
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(codePointCompare);
}

function containment(a: Set<string>, b: Set<string>): { ratio: number; shared: string[] } {
  const shared: string[] = [];
  for (const token of a) if (b.has(token)) shared.push(token);
  const min = Math.min(a.size, b.size);
  return { ratio: min === 0 ? 0 : shared.length / min, shared: sorted(shared) };
}

function entryId(
  kind: ClaimLedgerEntryKind,
  discriminator: string,
  citations: string[],
  anchors: string[]
): string {
  const canonical = JSON.stringify([kind, discriminator, citations, anchors]);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `ldg:${kind}:${hash}`;
}

function makeEntry(
  kind: ClaimLedgerEntryKind,
  discriminator: string,
  status: ClaimLedgerEntry['status'],
  message: string,
  citations: string[],
  anchors: string[],
  evidence: Record<string, unknown>
): ClaimLedgerEntry {
  const sortedCitations = sorted(citations);
  const sortedAnchors = sorted(anchors);
  return {
    id: entryId(kind, discriminator, sortedCitations, sortedAnchors),
    kind,
    status,
    message,
    citations: sortedCitations,
    anchors: sortedAnchors,
    evidence,
  };
}

interface UncertaintyRecord {
  id: string;
  artifact: string;
  cp: number;
  text: string;
  tokens: Set<string>;
}

function capturedUncertainties(floor: Floor): UncertaintyRecord[] {
  return floor.citations
    .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
    .map((citation) => ({
      id: citation.id,
      artifact: citation.artifact,
      cp: 'cp' in citation && typeof citation.cp === 'number' ? citation.cp : 0,
      text: citation.text,
      tokens: normalizeClaimTokens(citation.text),
    }))
    .sort((a, b) => codePointCompare(a.id, b.id));
}

function possibleTextDuplicates(floor: Floor): ClaimLedgerEntry[] {
  const entries: ClaimLedgerEntry[] = [];
  const uncertainties = capturedUncertainties(floor);
  const scanned = uncertainties.slice(0, DUPLICATE_SCAN_CAP);
  if (uncertainties.length > DUPLICATE_SCAN_CAP) {
    entries.push(
      makeEntry(
        CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE,
        `scan-cap:${String(uncertainties.length)}`,
        'INCONCLUSIVE',
        `${String(uncertainties.length)} captured uncertainties exceed the pairwise scan cap (${String(DUPLICATE_SCAN_CAP)}); pairs beyond the cap were not compared.`,
        [],
        [],
        { total: uncertainties.length, cap: DUPLICATE_SCAN_CAP }
      )
    );
  }
  for (let i = 0; i < scanned.length; i += 1) {
    for (let j = i + 1; j < scanned.length; j += 1) {
      const first = scanned[i]!;
      const second = scanned[j]!;
      const overlap = containment(first.tokens, second.tokens);
      if (overlap.ratio < 0.5 || overlap.shared.length < 3) continue;
      entries.push(
        makeEntry(
          CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE,
          `${first.id}≈${second.id}`,
          'CANDIDATE',
          // Report the measured overlap without converting it into a semantic
          // verdict. Whether the uncertainties mean the same thing belongs to
          // the reader.
          `Two captured uncertainties share ${String(overlap.shared.length)} terms (containment ${overlap.ratio.toFixed(2)}); text overlap alone cannot tell whether they mean the same thing — if they do, the reviewer is asked the same question twice.`,
          [first.id, second.id],
          [],
          {
            containment: Number(overlap.ratio.toFixed(3)),
            sharedTokens: overlap.shared,
          }
        )
      );
    }
  }
  return entries;
}

const PATHISH_TOKEN = /[/.]/;

/**
 * Reports what the floor measured and excluded. It does not compare path
 * tokens with plan non-goals: a file named `snapshots.ts` can share a token
 * with a non-goal mentioning "snapshot" without violating that promise.
 * Checking a non-goal is a semantic question, not a token intersection.
 */
function untrackedEvidence(floor: Floor): ClaimLedgerEntry[] {
  const entries: ClaimLedgerEntry[] = [];
  for (const disclosure of floor.disclosure) {
    if (disclosure.code !== 'untracked_evidence_excluded') continue;
    const anchors = sorted(
      disclosure.message.split(/[\s,]+/).filter((token) => PATHISH_TOKEN.test(token))
    );
    entries.push(
      makeEntry(
        CLAIM_LEDGER_ENTRY_KIND.UNTRACKED_EVIDENCE,
        `untracked:${disclosure.message}`,
        'CANDIDATE',
        // Untracked, non-ignored files may be unstaged work; the floor can
        // report their scope status but cannot characterize their intent.
        'Non-ignored untracked files sit in the workspace OUTSIDE review scope; whether they are meant to ship is not something the floor can determine.',
        [],
        anchors,
        { disclosure: disclosure.message }
      )
    );
  }
  return entries;
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;

/** Last path segment — the token a runner invocation would name. */
function basenameOf(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut === -1 ? file : file.slice(cut + 1);
}

/**
 * A command is path-scoped when it names at least one test-path-looking
 * token; a command with none (a broad runner like `pnpm test`) cannot be
 * shown NOT to run the claimed tests and is treated as covering them all.
 */
function isPathScoped(command: string): boolean {
  return command.split(/\s+/).some((token) => TEST_PATH_PATTERN.test(token));
}

function verificationGaps(checkpoints: CheckpointClaims[]): ClaimLedgerEntry[] {
  const entries: ClaimLedgerEntry[] = [];
  const ordered = [...checkpoints].sort(
    (a, b) => codePointCompare(a.artifact, b.artifact) || a.cp - b.cp
  );
  for (const checkpoint of ordered) {
    if (checkpoint.status !== 'closed') continue;
    const ref = `${checkpoint.artifact}:cp${String(checkpoint.cp)}`;
    const commands = checkpoint.verificationCommands;
    if (checkpoint.completedStepIds.length > 0 && commands.length === 0) {
      entries.push(
        makeEntry(
          CLAIM_LEDGER_ENTRY_KIND.VERIFICATION_GAP,
          `completion:${ref}`,
          'CANDIDATE',
          `Checkpoint ${ref} claims completed work with zero verification commands recorded — the claim rests on narrative alone.`,
          [],
          [ref],
          { checkpoint: ref, completedSteps: checkpoint.completedStepIds.length }
        )
      );
    }
    const testFiles = sorted(
      checkpoint.filesChanged.filter((file) => TEST_PATH_PATTERN.test(file))
    );
    if (testFiles.length > 0 && commands.length === 0) {
      entries.push(
        makeEntry(
          CLAIM_LEDGER_ENTRY_KIND.VERIFICATION_GAP,
          `tests:${ref}`,
          'CANDIDATE',
          `Checkpoint ${ref} changed test files but recorded no verification run — tests that were written may never have executed.`,
          [],
          [ref, ...testFiles],
          { checkpoint: ref, testFiles }
        )
      );
    }
    // (c) Linkage: only when EVERY recorded command is path-scoped can the
    // ledger measure that a claimed test file was named by none of them; one
    // broad command makes the whole set potentially covering.
    if (testFiles.length > 0 && commands.length > 0 && commands.every(isPathScoped)) {
      const unlinked = testFiles.filter(
        (file) => !commands.some((command) => command.includes(basenameOf(file)))
      );
      if (unlinked.length > 0) {
        const commandTestTokens = sorted(
          new Set(
            commands.flatMap((command) =>
              command.split(/\s+/).filter((token) => TEST_PATH_PATTERN.test(token))
            )
          )
        );
        entries.push(
          makeEntry(
            CLAIM_LEDGER_ENTRY_KIND.VERIFICATION_GAP,
            `tests-unlinked:${ref}`,
            'CANDIDATE',
            `Checkpoint ${ref} changed test files that no recorded verification command names (${unlinked.join(', ')}); every recorded command names other tests — the changed tests may never have executed.`,
            [],
            [ref, ...unlinked],
            { checkpoint: ref, unlinkedTestFiles: unlinked, commandTestTokens }
          )
        );
      }
    }
  }
  return entries;
}

/** MEASURED: the tree either reproduces a captured manifest or it does not. */
function integrityContradictions(floor: Floor): ClaimLedgerEntry[] {
  const entries: ClaimLedgerEntry[] = [];
  const orderedIntegrity = [...floor.integrity].sort(
    (a, b) => codePointCompare(a.artifact, b.artifact) || a.cp - b.cp
  );
  for (const integrity of orderedIntegrity) {
    if (integrity.verified !== false) continue;
    const ref = `${integrity.artifact}:cp${String(integrity.cp)}`;
    entries.push(
      makeEntry(
        CLAIM_LEDGER_ENTRY_KIND.CLAIM_CONTRADICTION,
        `integrity:${ref}`,
        'CANDIDATE',
        `Checkpoint ${ref}'s captured manifest does not reproduce against the tree — its account disagrees with reality at the integrity level.`,
        [],
        [ref],
        { checkpoint: ref, integrity: 'MISMATCH' }
      )
    );
  }
  return entries;
}

/**
 * A LEAD, not a verdict: a files_changed claim disagreeing with floor
 * attribution has several innocent explanations the floor cannot distinguish
 * between, so the kind name commits to the observation and not the cause.
 */
function attributionMismatchCandidates(
  floor: Floor,
  checkpoints: CheckpointClaims[]
): ClaimLedgerEntry[] {
  const entries: ClaimLedgerEntry[] = [];
  const scopeFiles = new Set(floor.coverage.items.map((item) => item.file));
  const ownedFilesByCheckpoint = new Map<string, Set<string>>();
  for (const item of floor.coverage.items) {
    for (const unit of item.units) {
      if (unit.kind !== 'owned_slice') continue;
      const owner = unit.owner;
      if (owner.kind !== 'checkpoint') continue;
      const ref = `${owner.artifact}:cp${String(owner.cp)}`;
      const set = ownedFilesByCheckpoint.get(ref) ?? new Set<string>();
      set.add(item.file);
      ownedFilesByCheckpoint.set(ref, set);
    }
  }
  const ordered = [...checkpoints].sort(
    (a, b) => codePointCompare(a.artifact, b.artifact) || a.cp - b.cp
  );
  for (const checkpoint of ordered) {
    if (checkpoint.status !== 'closed') continue;
    const ref = `${checkpoint.artifact}:cp${String(checkpoint.cp)}`;
    const owned = ownedFilesByCheckpoint.get(ref);
    // A checkpoint owning zero rows anywhere is facet-only — its files may
    // legitimately be outside the review scope; not an over-claim case.
    if (owned === undefined) continue;
    const claimed = checkpoint.filesChanged.filter((file) => !owned.has(file));
    if (claimed.length === 0) continue;
    // Files inside the review scope but owned by someone else: a genuine
    // over-claim CANDIDATE. Files absent from the scope entirely (renames,
    // reverted or out-of-scope work): the floor cannot arbitrate the claim.
    const inScope = sorted(claimed.filter((file) => scopeFiles.has(file)));
    const outOfScope = sorted(claimed.filter((file) => !scopeFiles.has(file)));
    if (inScope.length > 0) {
      entries.push(
        makeEntry(
          CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
          `overclaim:${ref}`,
          'CANDIDATE',
          `Checkpoint ${ref} claims files the floor attributes to none of its changes: ${inScope.join(', ')}. ${ATTRIBUTION_MISMATCH_SHARED_EXPLANATION}`,
          [],
          [ref, ...inScope],
          { checkpoint: ref, overclaimedFiles: inScope }
        )
      );
    }
    if (outOfScope.length > 0) {
      entries.push(
        makeEntry(
          CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
          `unarbitrable:${ref}`,
          'INCONCLUSIVE',
          `Checkpoint ${ref} claims files absent from the review scope (${outOfScope.join(', ')}) — renamed, reverted, or out-of-scope work the floor cannot arbitrate.`,
          [],
          [ref, ...outOfScope],
          { checkpoint: ref, unarbitrableFiles: outOfScope }
        )
      );
    }
  }
  return entries;
}

function coverageGaps(floor: Floor): ClaimLedgerEntry[] {
  const { unexplained_rows, ambiguous_rows } = floor.coverage.summary;
  if (unexplained_rows === 0 && ambiguous_rows === 0) return [];
  const gapFiles = sorted(floor.outline.unassigned.gap.files.map((file) => file.file));
  return [
    makeEntry(
      CLAIM_LEDGER_ENTRY_KIND.COVERAGE_GAP,
      `coverage:${String(unexplained_rows)}:${String(ambiguous_rows)}`,
      'CANDIDATE',
      `${String(unexplained_rows)} unexplained and ${String(ambiguous_rows)} ambiguous changed row(s) — any account that does not face them is incomplete.`,
      [],
      gapFiles,
      { unexplainedRows: unexplained_rows, ambiguousRows: ambiguous_rows, files: gapFiles }
    ),
  ];
}

/**
 * Pure and model-free. Same floor + claims → byte-identical `entries`
 * regardless of input order; `generated_at` is caller-supplied transport
 * metadata. Throws on duplicate entry ids (an implementation bug, never
 * silently merged).
 */
export function buildClaimLedger(input: BuildClaimLedgerInput): ClaimLedger {
  const entries = [
    ...possibleTextDuplicates(input.floor),
    ...untrackedEvidence(input.floor),
    ...verificationGaps(input.checkpoints),
    ...integrityContradictions(input.floor),
    ...attributionMismatchCandidates(input.floor, input.checkpoints),
    ...coverageGaps(input.floor),
  ].sort((a, b) => codePointCompare(a.kind, b.kind) || codePointCompare(a.id, b.id));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`claim ledger produced duplicate entry id ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return {
    schema_version: CLAIM_LEDGER_SCHEMA_VERSION,
    branch: input.floor.scope.branch,
    floor_input_hash: input.floor.input_hash,
    generated_at: input.generatedAt,
    entries,
  };
}
