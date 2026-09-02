import {
  COMPLETION_STATE,
  PROMPT_DISPOSITION,
  PROMPT_STATE,
  type PromptState,
  REVIEW_BASIS,
  REVIEW_COVERAGE_ACTION,
  REVIEW_ITEM_STATE,
  type ReviewBasis,
  type ReviewItemState,
} from './enums.js';
import { stableHash64 } from './keys.js';
import { replayJournal, type ReviewLedger, type ThreadLedgerEntry } from './ledger.js';
import { matchReviewedRows, reviewedRowsDigest } from './reviewState.js';
import type {
  Disclosure,
  JournalEvent,
  ReviewCoverageJournalEvent,
  ReviewedRow,
  ReviewLifecycleJournalEvent,
} from './schema.js';
import { DISCLOSURE_CODE } from './schema.js';

export interface CurrentThreadManifest {
  threadKey: string;
  /** Null while the current manifest is still computing (fail closed). */
  rows: ReviewedRow[] | null;
  digest: string | null;
}

export interface ReviewCoverageLedgerEntry {
  threadKey: string;
  /** Latest cumulative coverage snapshot for this section. */
  coveredRows: ReviewedRow[];
  coveredRowsDigest: string;
  ts: string;
  /** Most recent explicit full-coverage milestone; retained across later snapshots. */
  fullCoverageRows: ReviewedRow[] | null;
  fullCoverageRowsDigest: string | null;
  fullCoverageTs: string | null;
}

export interface ReviewLedgerV2 extends ReviewLedger {
  ledgerGeneration: string;
  coverage: ReviewCoverageLedgerEntry[];
  prompts: PromptLedgerEntry[];
  unassigned: UnassignedInspectionLedger;
  lifecycle: ReviewLifecycleLedger;
}

export interface ReviewGenerationIdentity {
  floorInputHash: string;
  /**
   * The current routine Story's validated content generation, or NULL when the
   * resolver reports ABSENT/STALE.
   */
  storyGeneration: string | null;
}

export interface ReviewLifecycleTransition {
  action: ReviewLifecycleJournalEvent['action'];
  /** Which lens the reviewer read. Decides how this transition goes stale. */
  reviewBasis: ReviewBasis;
  ts: string;
  floorInputHash: string;
  /** Null exactly when `reviewBasis` is FLOOR_ONLY (bound by the schema). */
  storyGeneration: string | null;
  actor: ReviewLifecycleJournalEvent['actor'];
  source: ReviewLifecycleJournalEvent['source'];
  remainingWork: string | null;
}

export interface ReviewLifecycleLedger {
  state: 'OPEN' | 'COMPLETE' | 'PARTIAL';
  stale: boolean;
  current: ReviewLifecycleTransition | null;
  history: ReviewLifecycleTransition[];
}

export interface PromptLedgerEntry {
  promptKey: string;
  state: PromptState;
  reason: string | null;
  ts: string;
}

export interface UnassignedInspectionLedger {
  gapRows: ReviewedRow[];
  gapRowsDigest: string | null;
  ambiguousHunkKeys: string[];
}

const PROMPT_ACTION_STATE: Readonly<Record<string, PromptState>> = {
  [PROMPT_DISPOSITION.ACKNOWLEDGE]: PROMPT_STATE.ACKNOWLEDGED,
  [PROMPT_DISPOSITION.RESOLVE]: PROMPT_STATE.RESOLVED,
  [PROMPT_DISPOSITION.DISMISS]: PROMPT_STATE.DISMISSED,
  [PROMPT_DISPOSITION.REOPEN]: PROMPT_STATE.OPEN,
};

/** Generation token over valid append-order events; used by the atomic CLI guard. */
export async function reviewLedgerGeneration(events: readonly JournalEvent[]): Promise<string> {
  return stableHash64(
    'orcaops.review.ledger_generation.v1',
    events.map((event) => JSON.stringify(event))
  );
}

/**
 * Does a finished review still describe the tree in front of the reviewer?
 *
 * Staleness is "THE MATERIAL GENERATION CHANGED", never "a rebuild happened":
 * `floor_input_hash` is content-addressed, so re-running the sidecar over an
 * unchanged tree reproduces the same hash and stales nothing. Only real movement
 * in the reviewed content invalidates a completion.
 *
 * The two bases go stale differently, and that asymmetry is the whole point:
 *
 * - STORY — the reviewer read a routine Story, so both the floor under it and
 *   the Story content itself must still be the ones they read.
 *
 * - FLOOR_ONLY — the reviewer read the captured checkpoints. The floor must
 *   still be the one they read, AND no current Story may have appeared since. A
 *   Story arriving over the same floor is a lens over that code they have not
 *   read, so the completion goes stale — but it STAYS RECORDED. Appearance is
 *   the trigger, deliberately: "the Story introduced new obligations" is
 *   unfalsifiable, and a rule nobody can check is a rule that silently rots.
 *
 * Note the corollary, which is intended: if that Story is later removed or
 * goes stale against the floor, the floor-only completion reads
 * non-stale again. Nothing about the code they reviewed has changed, and there
 * is no longer an unread lens over it.
 */
function lifecycleStale(
  current: ReviewLifecycleTransition,
  currentGeneration: ReviewGenerationIdentity | null
): boolean {
  // No readable floor: we cannot prove the completion still describes anything.
  if (currentGeneration === null) return true;
  if (current.floorInputHash !== currentGeneration.floorInputHash) return true;
  return current.reviewBasis === REVIEW_BASIS.STORY
    ? current.storyGeneration !== currentGeneration.storyGeneration
    : currentGeneration.storyGeneration !== null;
}

function replayLifecycle(
  events: readonly JournalEvent[],
  currentGeneration: ReviewGenerationIdentity | null
): ReviewLifecycleLedger {
  const history = events.flatMap((event): ReviewLifecycleTransition[] =>
    event.type === 'review_lifecycle'
      ? [
          {
            action: event.action,
            reviewBasis: event.review_basis,
            ts: event.ts,
            floorInputHash: event.floor_input_hash,
            storyGeneration: event.story_generation,
            actor: event.actor,
            source: event.source,
            remainingWork: event.remaining_work ?? null,
          },
        ]
      : []
  );
  const current = history.at(-1) ?? null;
  if (current === null || current.action === 'REOPEN') {
    return { state: 'OPEN', stale: false, current, history };
  }
  return {
    state: current.action,
    stale: lifecycleStale(current, currentGeneration),
    current,
    history,
  };
}

function byThreadKey(a: { threadKey: string }, b: { threadKey: string }): number {
  return a.threadKey < b.threadKey ? -1 : a.threadKey > b.threadKey ? 1 : 0;
}

function currentByKey(
  manifests: readonly CurrentThreadManifest[]
): Map<string, CurrentThreadManifest> {
  return new Map(manifests.map((manifest) => [manifest.threadKey, manifest]));
}

/**
 * Current-schema replay. Coverage comes only from explicit row-coverage
 * events; section dispositions never seed or infer it. Later snapshots are
 * cumulative and never implicitly reset another section.
 */
export async function replayReviewLedgerV2(input: {
  events: readonly JournalEvent[];
  currentThreads: readonly CurrentThreadManifest[];
  currentGeneration?: ReviewGenerationIdentity | null;
}): Promise<ReviewLedgerV2> {
  const base = replayJournal(input.events);
  const coverage = new Map<string, ReviewCoverageLedgerEntry>();
  const prompts = new Map<string, PromptLedgerEntry>();
  let gapRows: ReviewedRow[] = [];
  let gapRowsDigest: string | null = null;
  const ambiguousHunkKeys = new Set<string>();

  const ordered = [...input.events]
    .map((event, appendIndex) => ({ event, appendIndex }))
    .sort(
      (a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts) || a.appendIndex - b.appendIndex
    );
  for (const { event } of ordered) {
    if (event.type === 'prompt') {
      prompts.set(event.promptKey, {
        promptKey: event.promptKey,
        state: PROMPT_ACTION_STATE[event.action] ?? PROMPT_STATE.OPEN,
        reason: event.action === PROMPT_DISPOSITION.DISMISS ? (event.reason ?? null) : null,
        ts: event.ts,
      });
      continue;
    }
    if (event.type === 'unassigned') {
      if (event.target.kind === 'GAP_ROWS') {
        gapRows = [...event.target.coveredRows];
        gapRowsDigest = event.target.coveredRowsDigest;
      } else {
        ambiguousHunkKeys.add(event.target.hunkKey);
      }
      continue;
    }
    if (event.type !== 'review_coverage') continue;
    for (const thread of event.threads) {
      const prior = coverage.get(thread.threadKey);
      coverage.set(thread.threadKey, {
        threadKey: thread.threadKey,
        coveredRows: [...thread.coveredRows],
        coveredRowsDigest: thread.coveredRowsDigest,
        ts: event.ts,
        fullCoverageRows:
          thread.completedRows !== undefined
            ? [...thread.completedRows]
            : (prior?.fullCoverageRows ?? null),
        fullCoverageRowsDigest: thread.completedRowsDigest ?? prior?.fullCoverageRowsDigest ?? null,
        fullCoverageTs:
          thread.completedRows !== undefined ? event.ts : (prior?.fullCoverageTs ?? null),
      });
    }
  }

  return {
    ...base,
    ledgerGeneration: await reviewLedgerGeneration(input.events),
    coverage: [...coverage.values()].sort(byThreadKey),
    prompts: [...prompts.values()].sort((a, b) =>
      a.promptKey < b.promptKey ? -1 : a.promptKey > b.promptKey ? 1 : 0
    ),
    unassigned: {
      gapRows,
      gapRowsDigest,
      ambiguousHunkKeys: [...ambiguousHunkKeys].sort(),
    },
    lifecycle: replayLifecycle(
      ordered.map(({ event }) => event),
      input.currentGeneration ?? null
    ),
  };
}

export type EffectiveCoverageState =
  | (typeof COMPLETION_STATE)[keyof typeof COMPLETION_STATE]
  | 'stale'
  | 'checking';

export interface EffectiveThreadCoverage {
  state: EffectiveCoverageState;
  newRows?: number;
}

/** Intentional partial vs. post-completion stale, with growth-stale/shrink-safe matching. */
export function effectiveThreadCoverage(input: {
  base?: ThreadLedgerEntry;
  coverage?: ReviewCoverageLedgerEntry;
  current?: CurrentThreadManifest;
}): EffectiveThreadCoverage {
  if (input.coverage === undefined) {
    return { state: input.base?.state ?? COMPLETION_STATE.UNREAD };
  }
  const current = input.current;
  if (current === undefined || current.rows === null || current.digest === null) {
    return { state: 'checking' };
  }
  if (input.coverage.coveredRowsDigest === current.digest) {
    return { state: COMPLETION_STATE.REVIEWED };
  }
  const matched = matchReviewedRows(input.coverage.coveredRows, current.rows);
  if (matched.newRows === 0) return { state: COMPLETION_STATE.REVIEWED };
  if (input.coverage.fullCoverageRows !== null) {
    return { state: 'stale', newRows: matched.newRows };
  }
  return matched.matched === 0
    ? { state: COMPLETION_STATE.UNREAD }
    : { state: COMPLETION_STATE.PARTIAL };
}

function bucketKey(row: ReviewedRow): string {
  return `${row.file}\u0000${row.side}\u0000${row.lineHash}`;
}

/** Select current-row indexes matched one-to-one by re-anchorable content identities. */
function selectCurrentIndexes(
  records: readonly ReviewedRow[],
  current: readonly ReviewedRow[]
): Set<number> {
  const buckets = new Map<string, number[]>();
  current.forEach((row, index) => {
    const bucket = buckets.get(bucketKey(row));
    if (bucket) bucket.push(index);
    else buckets.set(bucketKey(row), [index]);
  });
  const selected = new Set<number>();
  for (const record of records) {
    const candidates = (buckets.get(bucketKey(record)) ?? []).filter(
      (index) => !selected.has(index)
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const rowA = current[a]!;
      const rowB = current[b]!;
      const sameA = record.hunkKey !== undefined && rowA.hunkKey === record.hunkKey ? 0 : 1;
      const sameB = record.hunkKey !== undefined && rowB.hunkKey === record.hunkKey ? 0 : 1;
      return (
        sameA - sameB ||
        Math.abs(rowA.line - record.line) - Math.abs(rowB.line - record.line) ||
        a - b
      );
    });
    selected.add(candidates[0]!);
  }
  return selected;
}

export type PrepareCoverageResult =
  | { status: 'ready'; event: ReviewCoverageJournalEvent }
  | { status: 'no_rows'; event: null }
  | { status: 'invalid'; event: null; message: string };

/**
 * Re-anchor prior cumulative coverage, union the current Part rows, and prepare
 * one generation-guarded multi-section event. No additions means there are no
 * rows to record and intentionally emits no event.
 */
export async function prepareReviewCoverageEvent(input: {
  floorInputHash: string;
  ledgerGeneration: string;
  priorCoverage: readonly ReviewCoverageLedgerEntry[];
  currentThreads: readonly CurrentThreadManifest[];
  partRowsByThread: ReadonlyMap<string, readonly ReviewedRow[]>;
  now?: string;
}): Promise<PrepareCoverageResult> {
  if (input.partRowsByThread.size === 0) return { status: 'no_rows', event: null };
  const prior = new Map(input.priorCoverage.map((entry) => [entry.threadKey, entry]));
  const current = currentByKey(input.currentThreads);
  const threads: ReviewCoverageJournalEvent['threads'] = [];
  for (const [threadKey, additions] of input.partRowsByThread) {
    if (additions.length === 0) {
      return {
        status: 'invalid',
        event: null,
        message: `${threadKey} has no rows; coverage batches cannot contain empty thread entries`,
      };
    }
    const manifest = current.get(threadKey);
    if (manifest === undefined || manifest.rows === null || manifest.digest === null) {
      return {
        status: 'invalid',
        event: null,
        message: `${threadKey} current manifest is unavailable (checking)`,
      };
    }
    const additionIndexes = selectCurrentIndexes(additions, manifest.rows);
    if (additionIndexes.size !== additions.length) {
      return {
        status: 'invalid',
        event: null,
        message: `${threadKey} Part rows are not a one-to-one subset of the current floor manifest`,
      };
    }
    const coveredIndexes = selectCurrentIndexes(
      prior.get(threadKey)?.coveredRows ?? [],
      manifest.rows
    );
    for (const index of additionIndexes) coveredIndexes.add(index);
    const coveredRows = manifest.rows.filter((_row, index) => coveredIndexes.has(index));
    const coveredRowsDigest = await reviewedRowsDigest(coveredRows);
    const complete = coveredRows.length === manifest.rows.length;
    threads.push({
      threadKey,
      coveredRows,
      coveredRowsDigest,
      ...(complete
        ? { completedRows: [...coveredRows], completedRowsDigest: coveredRowsDigest }
        : {}),
    });
  }
  return {
    status: 'ready',
    event: {
      type: 'review_coverage',
      ts: input.now ?? new Date().toISOString(),
      action: REVIEW_COVERAGE_ACTION.RECORD_REVIEW_COVERAGE,
      floor_input_hash: input.floorInputHash,
      ledger_generation: input.ledgerGeneration,
      threads,
    },
  };
}

// ---------------------------------------------------------------------------
// The canonical finish gate — ONE definition, checked twice
// ---------------------------------------------------------------------------

/**
 * Why a floor-only review cannot be marked COMPLETE. Each arm names the
 * obligation and carries enough to say how much of it is left, because a gate
 * that only says "no" sends the reviewer hunting for what they missed.
 */
export type FinishBlocker =
  /** The obligations themselves could not be derived — every other check is a lie. */
  | { kind: 'targets'; reason: string }
  /** This thread's current row manifest is still unknown. Fails closed. */
  | { kind: 'checking'; threadKey: string }
  | { kind: 'rows'; threadKey: string; newRows: number }
  | { kind: 'gap_rows'; newRows: number }
  | { kind: 'ambiguous_hunks'; hunkKeys: readonly string[] }
  | { kind: 'comments'; open: number }
  | { kind: 'uncertainties'; citationIds: readonly string[] }
  /**
   * The routine Story lens's own required findings/questions. It is in this
   * union rather than beside it because a reviewer asking "why can't I finish?"
   * is asking one question, and deserves one list.
   */
  | { kind: 'story_items'; open: number };

export interface FinishGateResult {
  allowed: boolean;
  blockers: FinishBlocker[];
}

export interface FloorOnlyFinishGateInput {
  /**
   * Could the current obligations be derived at all?
   *
   * Passed EXPLICITLY rather than inferred from empty/null inputs, because a
   * failed target build is precisely what makes every other input here
   * untrustworthy: it leaves `currentGapRows` empty (so "all unexplained rows
   * inspected" reads vacuously true) and every manifest null. The one fact that
   * invalidates the rest cannot be something we hope to notice downstream.
   */
  targets: { ok: true } | { ok: false; reason: string };
  currentThreads: readonly CurrentThreadManifest[];
  coverage: readonly ReviewCoverageLedgerEntry[];
  /** Unexplained rows the floor currently carries, vs. the ones inspected. */
  currentGapRows: readonly ReviewedRow[];
  inspectedGapRows: readonly ReviewedRow[];
  /** Attribution-ambiguous hunks the floor currently carries, vs. inspected. */
  currentAmbiguousHunkKeys: readonly string[];
  inspectedAmbiguousHunkKeys: readonly string[];
  /** Reviewer-authored open comments, BRANCH-WIDE (`openReviewerCommentCount`). */
  openReviewerComments: number;
  /** Captured uncertainties (floor citations) still OPEN in the ledger. */
  openUncertaintyCitationIds: readonly string[];
}

/**
 * CAN THIS FLOOR-ONLY REVIEW BE CALLED DONE?
 *
 * The five obligations, enumerated exactly, and pure over already-derived facts
 * — the same shape as `evaluateMarkReviewedGate`, and for the same reason: it
 * lets the reader and the journal transport reach the identical verdict from
 * their own load paths, instead of the transport trusting whatever the reader
 * claims. The transport does not independently enforce the reader's completion
 * model; this function is what makes both sides agree, and it is only worth
 * anything because BOTH sides call it.
 */
export function evaluateFloorOnlyFinishGate(input: FloorOnlyFinishGateInput): FinishGateResult {
  const blockers: FinishBlocker[] = [];

  if (!input.targets.ok) {
    // Fail closed and STOP. Reporting "0 rows outstanding" underneath a failed
    // target build would be worse than saying nothing.
    return { allowed: false, blockers: [{ kind: 'targets', reason: input.targets.reason }] };
  }

  const covered = new Map(input.coverage.map((entry) => [entry.threadKey, entry]));
  for (const manifest of input.currentThreads) {
    if (manifest.rows === null) {
      blockers.push({ kind: 'checking', threadKey: manifest.threadKey });
      continue;
    }
    if (manifest.rows.length === 0) continue;
    const entry = covered.get(manifest.threadKey);
    const matched = matchReviewedRows(entry?.coveredRows ?? [], manifest.rows);
    if (matched.newRows > 0) {
      blockers.push({ kind: 'rows', threadKey: manifest.threadKey, newRows: matched.newRows });
    }
  }

  if (input.currentGapRows.length > 0) {
    const matched = matchReviewedRows(input.inspectedGapRows, input.currentGapRows);
    if (matched.newRows > 0) blockers.push({ kind: 'gap_rows', newRows: matched.newRows });
  }

  const inspected = new Set(input.inspectedAmbiguousHunkKeys);
  const uninspected = input.currentAmbiguousHunkKeys.filter((key) => !inspected.has(key));
  if (uninspected.length > 0) blockers.push({ kind: 'ambiguous_hunks', hunkKeys: uninspected });

  if (input.openReviewerComments > 0) {
    blockers.push({ kind: 'comments', open: input.openReviewerComments });
  }
  if (input.openUncertaintyCitationIds.length > 0) {
    blockers.push({ kind: 'uncertainties', citationIds: [...input.openUncertaintyCitationIds] });
  }

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Add the obligations introduced by the current routine Story to the canonical
 * floor gate. The engine and Watch each derive `openRequiredStoryItems` from
 * the same stable finding/question ids and call this function independently.
 */
export function evaluateStoryFinishGate(input: {
  floor: FinishGateResult;
  openRequiredStoryItems: number;
}): FinishGateResult {
  const blockers = [...input.floor.blockers];
  if (input.openRequiredStoryItems > 0) {
    blockers.push({ kind: 'story_items', open: input.openRequiredStoryItems });
  }
  return { allowed: blockers.length === 0, blockers };
}

/** One sentence per blocker — the reader renders it and the engine writes it to stderr. */
export function describeFinishBlocker(blocker: FinishBlocker): string {
  switch (blocker.kind) {
    case 'targets':
      return `the current review obligations could not be derived (${blocker.reason})`;
    case 'checking':
      return `${blocker.threadKey}: its current rows are still unknown`;
    case 'rows':
      return `${blocker.threadKey}: ${blocker.newRows} row(s) not covered`;
    case 'gap_rows':
      return `${blocker.newRows} unexplained row(s) not inspected`;
    case 'ambiguous_hunks':
      return `${blocker.hunkKeys.length} attribution-ambiguous hunk(s) not inspected`;
    case 'comments':
      return `${blocker.open} open reviewer comment(s)`;
    case 'uncertainties':
      return `${blocker.citationIds.length} captured uncertaint(y/ies) not dispositioned`;
    case 'story_items':
      return `${blocker.open} required Story item(s)`;
  }
}

export interface PartCompletionResult {
  complete: boolean;
  coverageEventRequired: boolean;
  blockers: Array<'rows' | 'items' | 'comments' | 'disclosures'>;
}

/**
 * Floor disclosures that make the evidence boundary untrustworthy. These gate
 * completion even when no narrative item happens to represent the disclosure.
 * Attribution-quality and scope notices remain visible but non-blocking.
 */
export const BLOCKING_DISCLOSURE_CODES = new Set<Disclosure['code']>([
  DISCLOSURE_CODE.MANIFESTLESS_CHECKPOINT,
  DISCLOSURE_CODE.TRUNCATED_MANIFEST,
  DISCLOSURE_CODE.LIVE_DIFF_TRUNCATED,
  DISCLOSURE_CODE.INTEGRITY_MISMATCH,
  DISCLOSURE_CODE.INTEGRITY_UNAVAILABLE,
]);

export function blockingDisclosureCount(disclosures: readonly Disclosure[]): number {
  return disclosures.filter((disclosure) => BLOCKING_DISCLOSURE_CODES.has(disclosure.code)).length;
}

function itemSatisfied(state: ReviewItemState): boolean {
  const blocking: ReviewItemState[] = [
    REVIEW_ITEM_STATE.OPEN,
    REVIEW_ITEM_STATE.STALE,
    REVIEW_ITEM_STATE.CONFLICT,
  ];
  return !blocking.includes(state);
}

/** Derived only; marking a Part never mutates item/comment/disclosure state. */
export function derivePartCompletion(input: {
  eligibleRows: readonly ReviewedRow[];
  coveredRows: readonly ReviewedRow[];
  requiredItemStates: readonly ReviewItemState[];
  ownOpenComments?: number;
  blockingDisclosures?: number;
}): PartCompletionResult {
  const hasEligibleRows = input.eligibleRows.length > 0;
  const rowsSatisfied =
    hasEligibleRows && matchReviewedRows(input.coveredRows, input.eligibleRows).newRows === 0;
  const itemsSatisfied = input.requiredItemStates.every(itemSatisfied);
  const commentsSatisfied = (input.ownOpenComments ?? 0) === 0;
  const disclosuresSatisfied = (input.blockingDisclosures ?? 0) === 0;
  const blockers: PartCompletionResult['blockers'] = [];
  if (!rowsSatisfied) blockers.push('rows');
  if (!itemsSatisfied) blockers.push('items');
  if (!commentsSatisfied) blockers.push('comments');
  if (!disclosuresSatisfied) blockers.push('disclosures');
  return {
    complete: blockers.length === 0,
    /** Invalid zero-row Parts cannot manufacture an empty coverage event. */
    coverageEventRequired: hasEligibleRows && !rowsSatisfied,
    blockers,
  };
}
