import { describe, expect, it } from 'vitest';

import {
  CITATION_KIND,
  COMPLETION_STATE,
  FINDING_DISPOSITION,
  THREAD_DISPOSITION,
  UNCERTAINTY_DISPOSITION,
  UNCERTAINTY_STATE,
} from './enums.js';
import { formatCitationId } from './keys.js';
import {
  evaluateMarkReviewedGate,
  FINDING_STATE,
  findingState,
  replayJournal,
  type ReviewLedger,
  threadGate,
  threadState,
  uncertaintyState,
} from './ledger.js';
import type { JournalEvent } from './schema.js';

// --- fixtures --------------------------------------------------------------

const A = '019f38b7-1111-7000-8000-000000000001';
const uncCite = (i: number) =>
  formatCitationId({
    artifact: A,
    checkpointN: 1,
    kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
    index: i,
  });

const UNC0 = uncCite(0);
const UNC1 = uncCite(1);

/** Terse event builders — ts is a monotone counter unless overridden. */
let clock = 0;
const at = () => `2026-07-09T00:00:${String(clock++).padStart(2, '0')}.000Z`;
const sec = (threadKey: string, action: string, reason?: string, ts = at()): JournalEvent =>
  ({ type: 'section', ts, threadKey, action, ...(reason ? { reason } : {}) }) as JournalEvent;
const find = (findingKey: string, action: string, reason?: string, ts = at()): JournalEvent =>
  ({ type: 'finding', ts, findingKey, action, ...(reason ? { reason } : {}) }) as JournalEvent;
const unc = (citationId: string, action: string, ts = at()): JournalEvent =>
  ({ type: 'uncertainty', ts, citationId, action }) as JournalEvent;

describe('replayJournal — sections', () => {
  it('an empty journal yields empty arrays and default states', () => {
    const l = replayJournal([]);
    expect(l).toEqual({ sections: [], findings: [], uncertainties: [] });
    expect(threadState(l, 'sec:x')).toBe(COMPLETION_STATE.UNREAD);
    expect(findingState(l, 'find:x')).toBe(FINDING_STATE.OPEN);
    expect(uncertaintyState(l, UNC0)).toBe(UNCERTAINTY_STATE.OPEN);
  });

  it('VISIT bootstraps unread → visited', () => {
    const l = replayJournal([sec('S', THREAD_DISPOSITION.VISIT)]);
    expect(threadState(l, 'S')).toBe(COMPLETION_STATE.VISITED);
  });

  it('VISIT never downgrades an explicit disposition', () => {
    const l = replayJournal([
      sec('S', THREAD_DISPOSITION.VISIT),
      sec('S', THREAD_DISPOSITION.PARTIAL, 'work remains'),
      sec('S', THREAD_DISPOSITION.VISIT),
    ]);
    expect(threadState(l, 'S')).toBe(COMPLETION_STATE.PARTIAL);
  });

  it('explicit section dispositions are last-wins and carry the reason', () => {
    const l = replayJournal([
      sec('S', THREAD_DISPOSITION.SKIP, 'generated'),
      sec('S', THREAD_DISPOSITION.PARTIAL, 'ran out of time'),
    ]);
    const entry = l.sections.find((s) => s.threadKey === 'S');
    expect(entry?.state).toBe(COMPLETION_STATE.PARTIAL);
    expect(entry?.reason).toBe('ran out of time');
  });

  it('SKIP wins last and records its reason', () => {
    const l = replayJournal([sec('S', THREAD_DISPOSITION.SKIP, 'generated file, not reviewing')]);
    expect(threadState(l, 'S')).toBe(COMPLETION_STATE.SKIPPED);
    expect(l.sections[0].reason).toBe('generated file, not reviewing');
  });
});

describe('replayJournal — findings & uncertainties', () => {
  it('maps each finding action to its state, last-wins', () => {
    expect(findingState(replayJournal([find('F', FINDING_DISPOSITION.ACKNOWLEDGE)]), 'F')).toBe(
      FINDING_STATE.ACKNOWLEDGED
    );
    expect(findingState(replayJournal([find('F', FINDING_DISPOSITION.RESOLVE)]), 'F')).toBe(
      FINDING_STATE.RESOLVED
    );
    const dismissed = replayJournal([
      find('F', FINDING_DISPOSITION.DISMISS, 'not applicable here'),
    ]);
    expect(findingState(dismissed, 'F')).toBe(FINDING_STATE.DISMISSED);
    expect(dismissed.findings[0].reason).toBe('not applicable here');
    // resolve then reopen → back to OPEN
    const reopened = replayJournal([
      find('F', FINDING_DISPOSITION.RESOLVE),
      find('F', FINDING_DISPOSITION.REOPEN),
    ]);
    expect(findingState(reopened, 'F')).toBe(FINDING_STATE.OPEN);
  });

  it('maps each uncertainty action to its state, last-wins (no dismiss)', () => {
    expect(
      uncertaintyState(replayJournal([unc(UNC0, UNCERTAINTY_DISPOSITION.ACKNOWLEDGE)]), UNC0)
    ).toBe(UNCERTAINTY_STATE.ACKNOWLEDGED);
    const reopened = replayJournal([
      unc(UNC0, UNCERTAINTY_DISPOSITION.RESOLVE),
      unc(UNC0, UNCERTAINTY_DISPOSITION.REOPEN),
    ]);
    expect(uncertaintyState(reopened, UNC0)).toBe(UNCERTAINTY_STATE.OPEN);
  });

  it('orders numerically, not lexicographically — mixed fractional precision', () => {
    // "…05.500Z" < "…05Z" as strings ('.' < 'Z') but is chronologically LATER;
    // a lexicographic fold would let the earlier ACKNOWLEDGE win.
    const l = replayJournal([
      unc(UNC0, UNCERTAINTY_DISPOSITION.RESOLVE, '2026-07-09T00:00:05.500Z'),
      unc(UNC0, UNCERTAINTY_DISPOSITION.ACKNOWLEDGE, '2026-07-09T00:00:05Z'),
    ]);
    expect(uncertaintyState(l, UNC0)).toBe(UNCERTAINTY_STATE.RESOLVED);
  });

  it('folds chronologically by ts even when appended out of order', () => {
    // Later ts appears first in the array; a stable ts-sort must still let it win.
    const l = replayJournal([
      find('F', FINDING_DISPOSITION.REOPEN, undefined, '2026-07-09T00:00:10.000Z'),
      find('F', FINDING_DISPOSITION.RESOLVE, undefined, '2026-07-09T00:00:05.000Z'),
    ]);
    expect(findingState(l, 'F')).toBe(FINDING_STATE.OPEN); // the 00:00:10 REOPEN is newest
  });
});

describe('evaluateMarkReviewedGate', () => {
  it('allows when nothing is open', () => {
    const g = evaluateMarkReviewedGate({
      findingStates: [FINDING_STATE.RESOLVED, FINDING_STATE.DISMISSED, FINDING_STATE.ACKNOWLEDGED],
      uncertaintyStates: [UNCERTAINTY_STATE.ACKNOWLEDGED, UNCERTAINTY_STATE.RESOLVED],
      ownOpenComments: 0,
    });
    expect(g.allowed).toBe(true);
    expect(g.blockers).toEqual([]);
  });

  it('an OPEN finding blocks; ACKNOWLEDGED does not', () => {
    expect(
      evaluateMarkReviewedGate({
        findingStates: [FINDING_STATE.OPEN],
        uncertaintyStates: [],
        ownOpenComments: 0,
      }).allowed
    ).toBe(false);
    expect(
      evaluateMarkReviewedGate({
        findingStates: [FINDING_STATE.ACKNOWLEDGED],
        uncertaintyStates: [],
        ownOpenComments: 0,
      }).allowed
    ).toBe(true);
  });

  it('an OPEN uncertainty blocks; a reviewer own-open comment blocks', () => {
    expect(
      evaluateMarkReviewedGate({
        findingStates: [],
        uncertaintyStates: [UNCERTAINTY_STATE.OPEN],
        ownOpenComments: 0,
      }).allowed
    ).toBe(false);
    expect(
      evaluateMarkReviewedGate({ findingStates: [], uncertaintyStates: [], ownOpenComments: 2 })
        .allowed
    ).toBe(false);
  });

  it('reports every blocker kind with its open count', () => {
    const g = evaluateMarkReviewedGate({
      findingStates: [FINDING_STATE.OPEN, FINDING_STATE.OPEN, FINDING_STATE.RESOLVED],
      uncertaintyStates: [UNCERTAINTY_STATE.OPEN],
      ownOpenComments: 1,
    });
    expect(g.allowed).toBe(false);
    expect(g.blockers).toEqual([
      { kind: 'finding', count: 2 },
      { kind: 'uncertainty', count: 1 },
      { kind: 'comment', count: 1 },
    ]);
  });
});

describe('threadGate — over a ledger, defaults applied', () => {
  it('an un-dispositioned finding key blocks; resolving it clears the gate', () => {
    const blocked: ReviewLedger = replayJournal([]);
    expect(threadGate(blocked, { findingKeys: ['F1'], uncertaintyCitationIds: [] }).allowed).toBe(
      false
    ); // F1 has no event → OPEN → blocks

    const cleared = replayJournal([find('F1', FINDING_DISPOSITION.RESOLVE)]);
    expect(threadGate(cleared, { findingKeys: ['F1'], uncertaintyCitationIds: [] }).allowed).toBe(
      true
    );
  });

  it('blocks on an open captured uncertainty until acknowledged', () => {
    const open = replayJournal([]);
    expect(threadGate(open, { findingKeys: [], uncertaintyCitationIds: [UNC1] }).allowed).toBe(
      false
    );
    const ack = replayJournal([unc(UNC1, UNCERTAINTY_DISPOSITION.ACKNOWLEDGE)]);
    expect(threadGate(ack, { findingKeys: [], uncertaintyCitationIds: [UNC1] }).allowed).toBe(true);
  });

  it('threads own-open-comment count into the gate', () => {
    const l = replayJournal([]);
    expect(
      threadGate(l, { findingKeys: [], uncertaintyCitationIds: [], ownOpenComments: 1 }).allowed
    ).toBe(false);
  });
});

describe('re-floor / re-compose survival', () => {
  it('is keyed by stable identity — same events in any order derive the same ledger', () => {
    const events: JournalEvent[] = [
      sec('secA', THREAD_DISPOSITION.PARTIAL, 'remaining', '2026-07-09T00:00:03.000Z'),
      find('findX', FINDING_DISPOSITION.DISMISS, 'wontfix', '2026-07-09T00:00:02.000Z'),
      unc(UNC0, UNCERTAINTY_DISPOSITION.RESOLVE, '2026-07-09T00:00:01.000Z'),
    ];
    const forward = replayJournal(events);
    const shuffled = replayJournal([events[2], events[0], events[1]]);
    expect(shuffled).toEqual(forward); // arrays sorted by key + folded by ts → identical
    expect(threadState(forward, 'secA')).toBe(COMPLETION_STATE.PARTIAL);
    expect(findingState(forward, 'findX')).toBe(FINDING_STATE.DISMISSED);
    expect(uncertaintyState(forward, UNC0)).toBe(UNCERTAINTY_STATE.RESOLVED);
  });
});
