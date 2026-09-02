// Journal replay → the review ledger + the mark-reviewed gate.
//
// The journal (`journal.ndjson`) is an append-only log of reviewer disposition
// events (see `journalEventSchema` in schema.ts). This module folds that log
// into derived, last-writer-wins state — the LEDGER the TUI renders and the
// gate reads — and evaluates the truthful-completion gate.
//
// Everything here is PURE (events in, state out): the sidecar reads the file
// and injects the parsed events; the Bun UI consumes the ledger the sidecar
// emits. State is keyed by STABLE identity (threadKey / findingKey /
// citationId), never by position, so it survives a re-floor + re-compose.

import {
  COMPLETION_STATE,
  type CompletionState,
  FINDING_DISPOSITION,
  THREAD_DISPOSITION,
  UNCERTAINTY_DISPOSITION,
  UNCERTAINTY_STATE,
  type UncertaintyState,
} from './enums.js';
import type { JournalEvent } from './schema.js';

// ---------------------------------------------------------------------------
// Finding state — derived vocabulary, not part of the vocabulary contract
// ---------------------------------------------------------------------------

/**
 * Replay-derived finding state. The shared vocabulary contract pins the
 * disposition ACTIONS (`FINDING_DISPOSITION`) but no finding STATE enum, so —
 * like the floor's attribution rungs — the derived state lives here. Mirrors `UNCERTAINTY_STATE`:
 * only `OPEN` gates `mark reviewed`; acknowledging is enough to clear the gate
 * (the reviewer has engaged with it), and dismiss/resolve close it outright.
 */
export const FINDING_STATE = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;
export type FindingState = (typeof FINDING_STATE)[keyof typeof FINDING_STATE];

/** A finding gates until it is engaged with; only a raw/reopened finding is OPEN. */
export const OPEN_FINDING_STATE: FindingState = FINDING_STATE.OPEN;
/** An uncertainty gates only while OPEN; acknowledging clears the gate. */
export const OPEN_UNCERTAINTY_STATE: UncertaintyState = UNCERTAINTY_STATE.OPEN;

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** One section's replayed state + the reason/ts of the event that set it. */
export interface ThreadLedgerEntry {
  threadKey: string;
  state: CompletionState;
  /** Reason from the last SKIP/PARTIAL, else null. */
  reason: string | null;
  ts: string;
}

export interface FindingLedgerEntry {
  findingKey: string;
  state: FindingState;
  /** Reason from the last DISMISS, else null. */
  reason: string | null;
  ts: string;
}

export interface UncertaintyLedgerEntry {
  citationId: string;
  state: UncertaintyState;
  reason: string | null;
  ts: string;
}

/**
 * The replayed review ledger — JSON-friendly arrays sorted by key (the sidecar
 * emits this straight to the TUI). Absent a key, the default state applies:
 * sections `unread`, findings `OPEN`, uncertainties `OPEN`.
 */
export interface ReviewLedger {
  sections: ThreadLedgerEntry[];
  findings: FindingLedgerEntry[];
  uncertainties: UncertaintyLedgerEntry[];
}

const SECTION_ACTION_STATE: Readonly<Record<string, CompletionState>> = {
  [THREAD_DISPOSITION.SKIP]: COMPLETION_STATE.SKIPPED,
  [THREAD_DISPOSITION.PARTIAL]: COMPLETION_STATE.PARTIAL,
};

const FINDING_ACTION_STATE: Readonly<Record<string, FindingState>> = {
  [FINDING_DISPOSITION.ACKNOWLEDGE]: FINDING_STATE.ACKNOWLEDGED,
  [FINDING_DISPOSITION.RESOLVE]: FINDING_STATE.RESOLVED,
  [FINDING_DISPOSITION.DISMISS]: FINDING_STATE.DISMISSED,
  [FINDING_DISPOSITION.REOPEN]: FINDING_STATE.OPEN,
};

const UNCERTAINTY_ACTION_STATE: Readonly<Record<string, UncertaintyState>> = {
  [UNCERTAINTY_DISPOSITION.ACKNOWLEDGE]: UNCERTAINTY_STATE.ACKNOWLEDGED,
  [UNCERTAINTY_DISPOSITION.RESOLVE]: UNCERTAINTY_STATE.RESOLVED,
  [UNCERTAINTY_DISPOSITION.REOPEN]: UNCERTAINTY_STATE.OPEN,
};

/** Parse an event ts to epoch ms; unparseable → 0 (sorts first, never crashes). */
function tsValue(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Fold a journal into the ledger. Events are replayed in chronological order
 * (stable NUMERIC sort on the parsed `ts` — lexicographic comparison would
 * misorder mixed fractional-second precision, e.g. `…00.500Z` < `…00Z`;
 * equal-instant events keep append order), last event wins per key.
 *
 * Sections are the one non-last-wins case: `VISIT` (fired on every open) only
 * promotes `unread → visited` — it never downgrades an explicitly-dispositioned
 * section (a re-visited `reviewed`/`partial`/`skipped` section keeps its state).
 * Every explicit action (SKIP/PARTIAL) is last-wins. Row-level completion is
 * recorded only through current-schema `review_coverage` events.
 */
export function replayJournal(events: readonly JournalEvent[]): ReviewLedger {
  const ordered = [...events].sort((a, b) => tsValue(a.ts) - tsValue(b.ts));

  const sections = new Map<string, ThreadLedgerEntry>();
  const findings = new Map<string, FindingLedgerEntry>();
  const uncertainties = new Map<string, UncertaintyLedgerEntry>();

  for (const ev of ordered) {
    if (ev.type === 'section') {
      const prev = sections.get(ev.threadKey);
      if (ev.action === THREAD_DISPOSITION.VISIT) {
        // VISIT bootstraps only — never downgrades an explicit disposition.
        if (!prev) {
          sections.set(ev.threadKey, {
            threadKey: ev.threadKey,
            state: COMPLETION_STATE.VISITED,
            reason: null,
            ts: ev.ts,
          });
        }
        continue;
      }
      sections.set(ev.threadKey, {
        threadKey: ev.threadKey,
        state: SECTION_ACTION_STATE[ev.action] ?? COMPLETION_STATE.VISITED,
        reason: ev.reason ?? null,
        ts: ev.ts,
      });
    } else if (ev.type === 'finding') {
      findings.set(ev.findingKey, {
        findingKey: ev.findingKey,
        state: FINDING_ACTION_STATE[ev.action] ?? FINDING_STATE.OPEN,
        reason: ev.reason ?? null,
        ts: ev.ts,
      });
    } else if (ev.type === 'uncertainty') {
      uncertainties.set(ev.citationId, {
        citationId: ev.citationId,
        state: UNCERTAINTY_ACTION_STATE[ev.action] ?? UNCERTAINTY_STATE.OPEN,
        reason: ev.reason ?? null,
        ts: ev.ts,
      });
    }
  }

  return {
    sections: [...sections.values()].sort(byKey('threadKey')),
    findings: [...findings.values()].sort(byKey('findingKey')),
    uncertainties: [...uncertainties.values()].sort(byKey('citationId')),
  };
}

function byKey<K extends string>(key: K) {
  return (a: Record<K, string>, b: Record<K, string>): number =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Ledger accessors — apply the defaults for keys with no event
// ---------------------------------------------------------------------------

/** A section with no journal event is `unread`. */
export function threadState(ledger: ReviewLedger, threadKey: string): CompletionState {
  return ledger.sections.find((s) => s.threadKey === threadKey)?.state ?? COMPLETION_STATE.UNREAD;
}

/** A finding with no journal event is `OPEN` (raw, surfaced by the floor/narrative). */
export function findingState(ledger: ReviewLedger, findingKey: string): FindingState {
  return ledger.findings.find((f) => f.findingKey === findingKey)?.state ?? FINDING_STATE.OPEN;
}

/** An uncertainty with no journal event is `OPEN` (a captured, unaddressed doubt). */
export function uncertaintyState(ledger: ReviewLedger, citationId: string): UncertaintyState {
  return (
    ledger.uncertainties.find((u) => u.citationId === citationId)?.state ?? UNCERTAINTY_STATE.OPEN
  );
}

// ---------------------------------------------------------------------------
// The mark-reviewed gate (truthful completion)
// ---------------------------------------------------------------------------

/** Why a section cannot be marked reviewed. */
export interface GateBlocker {
  kind: 'finding' | 'uncertainty' | 'comment';
  /** How many items of this kind are still open. */
  count: number;
}

export interface GateResult {
  allowed: boolean;
  blockers: GateBlocker[];
}

/**
 * The primitive completion gate is blocked while any of the section's
 * findings or uncertainties is OPEN, or the reviewer has an own open comment
 * anchored in it. Pure over already-resolved states — the caller maps the
 * section's items to their states first (`threadGate` does that off a ledger).
 */
export function evaluateMarkReviewedGate(input: {
  findingStates: readonly FindingState[];
  uncertaintyStates: readonly UncertaintyState[];
  ownOpenComments: number;
}): GateResult {
  const openFindings = input.findingStates.filter((s) => s === FINDING_STATE.OPEN).length;
  const openUncertainties = input.uncertaintyStates.filter(
    (s) => s === UNCERTAINTY_STATE.OPEN
  ).length;
  const openComments = Math.max(0, input.ownOpenComments);

  const blockers: GateBlocker[] = [];
  if (openFindings > 0) blockers.push({ kind: 'finding', count: openFindings });
  if (openUncertainties > 0) blockers.push({ kind: 'uncertainty', count: openUncertainties });
  if (openComments > 0) blockers.push({ kind: 'comment', count: openComments });

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Convenience gate over a ledger: given the section's finding/uncertainty keys
 * (resolved from the floor + narrative by the caller) and the count of the
 * reviewer's own open comments anchored in the section, look up each item's
 * current state and evaluate the gate.
 */
export function threadGate(
  ledger: ReviewLedger,
  section: {
    findingKeys: readonly string[];
    uncertaintyCitationIds: readonly string[];
    ownOpenComments?: number;
  }
): GateResult {
  return evaluateMarkReviewedGate({
    findingStates: section.findingKeys.map((k) => findingState(ledger, k)),
    uncertaintyStates: section.uncertaintyCitationIds.map((c) => uncertaintyState(ledger, c)),
    ownOpenComments: section.ownOpenComments ?? 0,
  });
}
