import { describe, expect, it } from 'vitest';

import {
  COMPLETION_STATE,
  type CurrentThreadManifest,
  derivePartCompletion,
  describeFinishBlocker,
  effectiveThreadCoverage,
  evaluateFloorOnlyFinishGate,
  evaluateStoryFinishGate,
  type FloorOnlyFinishGateInput,
  type JournalEvent,
  journalEventSchema,
  matchReviewedRows,
  prepareReviewCoverageEvent,
  replayReviewLedgerV2,
  type ReviewCoverageJournalEvent,
  reviewCoverageJournalSchema,
  type ReviewedRow,
  reviewedRowsDigest,
  reviewLedgerGeneration,
  reviewLifecycleJournalSchema,
} from './index.js';

const TS = '2026-07-12T00:00:00.000Z';

function row(section: string, line: number, lineHash = `hash_${section}_${line}`): ReviewedRow {
  return {
    file: `src/${section}.ts`,
    side: 'add',
    lineHash,
    line,
    hunkKey: `hunk_${section}`,
  };
}

async function manifest(
  threadKey: string,
  rows: ReviewedRow[] | null
): Promise<CurrentThreadManifest> {
  return {
    threadKey,
    rows,
    digest: rows === null ? null : await reviewedRowsDigest(rows),
  };
}

async function coverageEvent(input: {
  ts?: string;
  threads: Array<{ threadKey: string; covered: ReviewedRow[]; complete?: boolean }>;
}): Promise<ReviewCoverageJournalEvent> {
  return {
    type: 'review_coverage',
    ts: input.ts ?? TS,
    action: 'RECORD_REVIEW_COVERAGE',
    floor_input_hash: 'floor_hash',
    ledger_generation: 'ledger_generation',
    threads: await Promise.all(
      input.threads.map(async (entry) => {
        const digest = await reviewedRowsDigest(entry.covered);
        return {
          threadKey: entry.threadKey,
          coveredRows: entry.covered,
          coveredRowsDigest: digest,
          ...(entry.complete
            ? { completedRows: [...entry.covered], completedRowsDigest: digest }
            : {}),
        };
      })
    ),
  };
}

describe('RECORD_REVIEW_COVERAGE schema', () => {
  it('is one strict, non-empty, unique-thread atomic event', async () => {
    const valid = await coverageEvent({
      threads: [
        { threadKey: 'sec_a', covered: [row('a', 1)] },
        { threadKey: 'sec_b', covered: [row('b', 1)], complete: true },
      ],
    });
    expect(journalEventSchema.parse(valid)).toEqual(valid);

    expect(
      reviewCoverageJournalSchema.safeParse({
        ...valid,
        threads: [...valid.threads, valid.threads[0]],
      }).success
    ).toBe(false);
    expect(
      reviewCoverageJournalSchema.safeParse({ ...valid, threads: [], partKey: 'part_x' }).success
    ).toBe(false);
  });

  it('rejects slice, checkpoint, and generated grouping identity anywhere durable', async () => {
    const valid = await coverageEvent({
      threads: [{ threadKey: 'sec_a', covered: [row('a', 1)] }],
    });
    for (const extra of [
      { slice: 0 },
      { checkpoint: { artifact: 'a', cp: 1 } },
      { storyKey: 'story_x' },
      { actKey: 'act_x' },
      { partKey: 'part_x' },
    ]) {
      expect(
        reviewCoverageJournalSchema.safeParse({
          ...valid,
          threads: [{ ...valid.threads[0], ...extra }],
        }).success,
        JSON.stringify(extra)
      ).toBe(false);
    }
  });
});

describe('review lifecycle schema and replay', () => {
  const lifecycle = (
    action: 'COMPLETE' | 'PARTIAL' | 'REOPEN',
    overrides: Partial<JournalEvent> = {}
  ): JournalEvent =>
    ({
      type: 'review_lifecycle',
      ts: TS,
      action,
      review_basis: 'STORY',
      floor_input_hash: 'floor_hash',
      story_generation: 'story_generation',
      ledger_generation: 'ledger_generation',
      actor: 'REVIEWER',
      source: 'WATCH',
      ...(action === 'PARTIAL' ? { remaining_work: 'Verify the release fixture.' } : {}),
      ...overrides,
    }) as JournalEvent;

  /** The DEFAULT basis: the reviewer read the captured checkpoints, not a Story. */
  const floorOnly = (
    action: 'COMPLETE' | 'PARTIAL' | 'REOPEN',
    overrides: Partial<JournalEvent> = {}
  ) =>
    lifecycle(action, {
      review_basis: 'FLOOR_ONLY',
      story_generation: null,
      ...overrides,
    } as Partial<JournalEvent>);

  it('requires remaining work only for PARTIAL', () => {
    expect(reviewLifecycleJournalSchema.parse(lifecycle('PARTIAL'))).toMatchObject({
      action: 'PARTIAL',
      remaining_work: 'Verify the release fixture.',
    });
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...lifecycle('PARTIAL'),
        remaining_work: undefined,
      }).success
    ).toBe(false);
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...lifecycle('COMPLETE'),
        remaining_work: 'not allowed',
      }).success
    ).toBe(false);
  });

  it('reconstructs completion, staleness, and reopen history without deleting transitions', async () => {
    const complete = lifecycle('COMPLETE');
    const currentGeneration = {
      floorInputHash: 'floor_hash',
      storyGeneration: 'story_generation',
    };
    const completed = await replayReviewLedgerV2({
      events: [complete],
      currentThreads: [],
      currentGeneration,
    });
    expect(completed.lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });
    expect(completed.lifecycle.history).toHaveLength(1);

    const stale = await replayReviewLedgerV2({
      events: [complete],
      currentThreads: [],
      currentGeneration: { ...currentGeneration, floorInputHash: 'new_floor' },
    });
    expect(stale.lifecycle).toMatchObject({ state: 'COMPLETE', stale: true });

    const reopened = await replayReviewLedgerV2({
      events: [
        complete,
        lifecycle('REOPEN', { ts: '2026-07-12T00:00:01.000Z' } as Partial<JournalEvent>),
      ],
      currentThreads: [],
      currentGeneration,
    });
    expect(reopened.lifecycle).toMatchObject({ state: 'OPEN', stale: false });
    expect(reopened.lifecycle.history.map((entry) => entry.action)).toEqual(['COMPLETE', 'REOPEN']);
  });

  it('binds review_basis to story_generation, both directions', () => {
    // Without the basis, a null generation is ambiguous between "there was no
    // Story to pin" and "there was one and it was not pinned" — and no replay
    // could tell an honest floor-only completion from a corrupt Story claim.
    expect(reviewLifecycleJournalSchema.safeParse(floorOnly('COMPLETE')).success).toBe(true);
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...floorOnly('COMPLETE'),
        story_generation: 'a_story_it_did_not_read',
      }).success
    ).toBe(false);
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...lifecycle('COMPLETE'),
        story_generation: null,
      }).success
    ).toBe(false);
    // And the basis is not optional. There is no legacy default: an event that
    // does not say which lens it read is not an event.
    const { review_basis: _dropped, ...basisless } = lifecycle('COMPLETE') as Record<
      string,
      unknown
    >;
    expect(reviewLifecycleJournalSchema.safeParse(basisless).success).toBe(false);
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...floorOnly('COMPLETE'),
        review_basis: 'NARRATIVE',
      }).success
    ).toBe(false);
    const { story_generation: _story, ...withoutStoryGeneration } = lifecycle('COMPLETE') as Record<
      string,
      unknown
    >;
    expect(
      reviewLifecycleJournalSchema.safeParse({
        ...withoutStoryGeneration,
        narrative_generation: 'legacy-generation',
      }).success
    ).toBe(false);
  });

  it('reads a floor-only COMPLETE as NON-stale — that is the branch’s default state', async () => {
    // Without an explicit basis, a floor-only COMPLETE cannot be expressed: it
    // would demand a synthesized generation, and would read stale forever
    // (`storyGeneration` could never match a null current identity).
    const completed = await replayReviewLedgerV2({
      events: [floorOnly('COMPLETE')],
      currentThreads: [],
      currentGeneration: { floorInputHash: 'floor_hash', storyGeneration: null },
    });
    expect(completed.lifecycle).toMatchObject({
      state: 'COMPLETE',
      stale: false,
      current: { reviewBasis: 'FLOOR_ONLY', storyGeneration: null },
    });
  });

  it('stales a floor-only COMPLETE when a Story APPEARS — without erasing it', async () => {
    // Appearance is the trigger. "The Story introduced new obligations" is
    // unfalsifiable, and a rule nobody can check is a rule that silently rots.
    const replayed = await replayReviewLedgerV2({
      events: [floorOnly('COMPLETE')],
      currentThreads: [],
      currentGeneration: {
        floorInputHash: 'floor_hash',
        storyGeneration: 'a_story_arrived',
      },
    });
    expect(replayed.lifecycle.stale).toBe(true);
    // The reviewer DID complete this review, and no later event makes that untrue.
    expect(replayed.lifecycle.state).toBe('COMPLETE');
    expect(replayed.lifecycle.history).toHaveLength(1);
    expect(replayed.lifecycle.current).toMatchObject({ action: 'COMPLETE' });
  });

  it('un-stales it if that Story goes away — nothing they read has changed', async () => {
    // The corollary, and it is intended. The floor is the one they reviewed, and
    // there is no longer an unread lens over it.
    const replayed = await replayReviewLedgerV2({
      events: [floorOnly('COMPLETE')],
      currentThreads: [],
      currentGeneration: { floorInputHash: 'floor_hash', storyGeneration: null },
    });
    expect(replayed.lifecycle.stale).toBe(false);
  });

  it('stales a STORY completion when its current Story disappears', async () => {
    // The two bases go stale differently, and each must read its OWN rule. A
    // Story completion with no current Story is stale (the Story it read
    // is gone); a floor-only one in the same situation is not.
    const storyBasis = await replayReviewLedgerV2({
      events: [lifecycle('COMPLETE')],
      currentThreads: [],
      currentGeneration: { floorInputHash: 'floor_hash', storyGeneration: null },
    });
    expect(storyBasis.lifecycle.stale).toBe(true);

    const floorBasis = await replayReviewLedgerV2({
      events: [floorOnly('COMPLETE')],
      currentThreads: [],
      currentGeneration: { floorInputHash: 'floor_hash', storyGeneration: null },
    });
    expect(floorBasis.lifecycle.stale).toBe(false);
  });

  it('stales either basis on a material floor change', async () => {
    for (const event of [lifecycle('COMPLETE'), floorOnly('COMPLETE')]) {
      const replayed = await replayReviewLedgerV2({
        events: [event],
        currentThreads: [],
        currentGeneration: {
          floorInputHash: 'the_tree_moved',
          storyGeneration: event.type === 'review_lifecycle' ? event.story_generation : null,
        },
      });
      expect(replayed.lifecycle.stale).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The canonical finish gate
//
// ONE definition of "can this be called done", so the reader and the journal
// transport reach the same verdict from their own load paths. The transport does
// not independently enforce the reader's completion model on its own — it would
// take the reader's word for it, so a durable COMPLETE would only ever be as
// true as the reader that sent it.
// ---------------------------------------------------------------------------
describe('the canonical finish gate', () => {
  const CLEAN: FloorOnlyFinishGateInput = {
    targets: { ok: true },
    currentThreads: [],
    coverage: [],
    currentGapRows: [],
    inspectedGapRows: [],
    currentAmbiguousHunkKeys: [],
    inspectedAmbiguousHunkKeys: [],
    openReviewerComments: 0,
    openUncertaintyCitationIds: [],
  };

  it('allows a finish when every enumerated obligation is met', async () => {
    const a = row('a', 1);
    expect(
      evaluateFloorOnlyFinishGate({
        ...CLEAN,
        currentThreads: [await manifest('sec_a', [a])],
        coverage: [
          {
            threadKey: 'sec_a',
            coveredRows: [a],
            coveredRowsDigest: await reviewedRowsDigest([a]),
            ts: TS,
            fullCoverageRows: [a],
            fullCoverageRowsDigest: await reviewedRowsDigest([a]),
            fullCoverageTs: TS,
          },
        ],
      })
    ).toEqual({ allowed: true, blockers: [] });
  });

  it('blocks on each obligation independently, and names it', async () => {
    const a = row('a', 1);
    const cases: Array<[Partial<FloorOnlyFinishGateInput>, string]> = [
      [{ currentThreads: [await manifest('sec_a', [a])] }, 'rows'],
      [{ currentGapRows: [a] }, 'gap_rows'],
      [{ currentAmbiguousHunkKeys: ['hunk_1'] }, 'ambiguous_hunks'],
      [{ openReviewerComments: 1 }, 'comments'],
      [{ openUncertaintyCitationIds: ['cite:a:cp1:uncertainty:0'] }, 'uncertainties'],
      [{ currentThreads: [{ threadKey: 'sec_a', rows: null, digest: null }] }, 'checking'],
    ];
    for (const [override, kind] of cases) {
      const result = evaluateFloorOnlyFinishGate({ ...CLEAN, ...override });
      expect(result.allowed, kind).toBe(false);
      expect(result.blockers.map((blocker) => blocker.kind)).toEqual([kind]);
      expect(describeFinishBlocker(result.blockers[0]!)).toBeTruthy();
    }
  });

  it('fails CLOSED and stops when the obligations cannot be derived', async () => {
    // A failed target build is what makes every other input untrustworthy: it
    // leaves the gap rows empty (so "all inspected" reads vacuously true) and
    // every manifest null. Reporting "nothing outstanding" underneath it would be
    // worse than saying nothing at all.
    const result = evaluateFloorOnlyFinishGate({
      ...CLEAN,
      targets: { ok: false, reason: 'diff.patch is missing' },
      // Everything else looks pristine — precisely because nothing was derived.
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toEqual([{ kind: 'targets', reason: 'diff.patch is missing' }]);
  });

  it('ignores an inspected gap row and an inspected ambiguous hunk', async () => {
    const a = row('a', 1);
    expect(
      evaluateFloorOnlyFinishGate({
        ...CLEAN,
        currentGapRows: [a],
        inspectedGapRows: [a],
        currentAmbiguousHunkKeys: ['hunk_1'],
        inspectedAmbiguousHunkKeys: ['hunk_1'],
      })
    ).toEqual({ allowed: true, blockers: [] });
  });

  it('a thread with no rows is not an obligation', () => {
    // A thread whose checkpoints all landed in excluded files owns nothing. If it
    // gated the finish, such a branch could never be completed at all.
    expect(
      evaluateFloorOnlyFinishGate({
        ...CLEAN,
        currentThreads: [{ threadKey: 'sec_empty', rows: [], digest: 'empty' }],
      })
    ).toEqual({ allowed: true, blockers: [] });
  });

  it('adds required Story items without mutating the floor verdict', () => {
    const floor = evaluateFloorOnlyFinishGate(CLEAN);
    expect(evaluateStoryFinishGate({ floor, openRequiredStoryItems: 2 })).toEqual({
      allowed: false,
      blockers: [{ kind: 'story_items', open: 2 }],
    });
    expect(floor).toEqual({ allowed: true, blockers: [] });
    expect(evaluateStoryFinishGate({ floor, openRequiredStoryItems: 0 })).toEqual(floor);
  });
});

describe('cumulative coverage replay and effective truth', () => {
  it('distinguishes a split thread intentional partial from a later full milestone', async () => {
    const a = row('a', 1);
    const b = row('a', 2);
    const current = await manifest('sec_a', [a, b]);
    const first = await coverageEvent({ threads: [{ threadKey: 'sec_a', covered: [a] }] });
    const partial = await replayReviewLedgerV2({ events: [first], currentThreads: [current] });
    expect(
      effectiveThreadCoverage({
        coverage: partial.coverage[0],
        current,
      })
    ).toEqual({ state: COMPLETION_STATE.PARTIAL });
    expect(partial.coverage[0]!.fullCoverageRows).toBeNull();

    const second = await coverageEvent({
      ts: '2026-07-12T00:00:01.000Z',
      threads: [{ threadKey: 'sec_a', covered: [a, b], complete: true }],
    });
    const complete = await replayReviewLedgerV2({
      events: [first, second],
      currentThreads: [current],
    });
    expect(effectiveThreadCoverage({ coverage: complete.coverage[0], current })).toEqual({
      state: COMPLETION_STATE.REVIEWED,
    });
    expect(complete.coverage[0]!.fullCoverageRows).toEqual([a, b]);
  });

  it('is growth-stale after a full milestone and shrink-safe', async () => {
    const a = row('a', 1);
    const b = row('a', 2);
    const event = await coverageEvent({
      threads: [{ threadKey: 'sec_a', covered: [a, b], complete: true }],
    });
    const grown = await manifest('sec_a', [a, b, row('a', 3)]);
    const ledger = await replayReviewLedgerV2({ events: [event], currentThreads: [grown] });
    expect(effectiveThreadCoverage({ coverage: ledger.coverage[0], current: grown })).toEqual({
      state: 'stale',
      newRows: 1,
    });

    const shrunk = await manifest('sec_a', [a]);
    expect(effectiveThreadCoverage({ coverage: ledger.coverage[0], current: shrunk })).toEqual({
      state: COMPLETION_STATE.REVIEWED,
    });
  });

  it('retains the full milestone when a later cumulative snapshot is not complete', async () => {
    const a = row('a', 1);
    const b = row('a', 2);
    const full = await coverageEvent({
      threads: [{ threadKey: 'sec_a', covered: [a], complete: true }],
    });
    const later = await coverageEvent({
      ts: '2026-07-12T00:00:01.000Z',
      threads: [{ threadKey: 'sec_a', covered: [a] }],
    });
    const current = await manifest('sec_a', [a, b]);
    const ledger = await replayReviewLedgerV2({
      events: [full, later],
      currentThreads: [current],
    });
    expect(ledger.coverage[0]!.fullCoverageRows).toEqual([a]);
    expect(effectiveThreadCoverage({ coverage: ledger.coverage[0], current })).toEqual({
      state: 'stale',
      newRows: 1,
    });
  });

  it('updates several threads from one event and repeated cumulative state is idempotent', async () => {
    const a = row('a', 1);
    const b = row('b', 1);
    const event = await coverageEvent({
      threads: [
        { threadKey: 'sec_a', covered: [a], complete: true },
        { threadKey: 'sec_b', covered: [b], complete: true },
      ],
    });
    const currents = [await manifest('sec_a', [a]), await manifest('sec_b', [b])];
    const once = await replayReviewLedgerV2({ events: [event], currentThreads: currents });
    const twice = await replayReviewLedgerV2({ events: [event, event], currentThreads: currents });
    expect(twice.coverage).toEqual(once.coverage);
    expect(twice.coverage.map((entry) => entry.threadKey)).toEqual(['sec_a', 'sec_b']);
  });

  it('uses multiset identity for duplicate-content rows', async () => {
    const first = row('a', 1, 'same_hash');
    const second = row('a', 2, 'same_hash');
    expect(matchReviewedRows([first], [first, second]).newRows).toBe(1);
    const partialEvent = await coverageEvent({
      threads: [{ threadKey: 'sec_a', covered: [first] }],
    });
    const current = await manifest('sec_a', [first, second]);
    const partial = await replayReviewLedgerV2({
      events: [partialEvent],
      currentThreads: [current],
    });
    expect(effectiveThreadCoverage({ coverage: partial.coverage[0], current })).toEqual({
      state: COMPLETION_STATE.PARTIAL,
    });
  });
});

describe('current-schema coverage only', () => {
  it('never infers row coverage from section dispositions', async () => {
    const events: JournalEvent[] = [
      { type: 'section', ts: TS, threadKey: 'sec_partial', action: 'PARTIAL', reason: 'later' },
      { type: 'section', ts: TS, threadKey: 'sec_skipped', action: 'SKIP', reason: 'generated' },
    ];
    const ledger = await replayReviewLedgerV2({
      events,
      currentThreads: [await manifest('sec_partial', [row('a', 1)])],
    });
    expect(ledger.coverage).toEqual([]);
    expect(
      effectiveThreadCoverage({
        base: ledger.sections.find((entry) => entry.threadKey === 'sec_partial'),
      })
    ).toEqual({ state: COMPLETION_STATE.PARTIAL });
    expect(
      effectiveThreadCoverage({
        base: ledger.sections.find((entry) => entry.threadKey === 'sec_skipped'),
      })
    ).toEqual({ state: COMPLETION_STATE.SKIPPED });
  });
});

describe('coverage preparation and items-only completion', () => {
  it('prepares one cumulative multi-thread event and re-anchors prior coverage', async () => {
    const a = row('a', 1);
    const b = row('a', 2);
    const x = row('b', 1);
    const priorEvent = await coverageEvent({ threads: [{ threadKey: 'sec_a', covered: [a] }] });
    const currents = [await manifest('sec_a', [a, b]), await manifest('sec_b', [x])];
    const replayed = await replayReviewLedgerV2({
      events: [priorEvent],
      currentThreads: currents,
    });
    const prepared = await prepareReviewCoverageEvent({
      floorInputHash: 'floor_hash',
      ledgerGeneration: replayed.ledgerGeneration,
      priorCoverage: replayed.coverage,
      currentThreads: currents,
      partRowsByThread: new Map([
        ['sec_a', [b]],
        ['sec_b', [x]],
      ]),
      now: '2026-07-12T00:00:02.000Z',
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    expect(prepared.event.threads).toHaveLength(2);
    expect(prepared.event.threads[0]!.coveredRows).toEqual([a, b]);
    expect(prepared.event.threads.every((entry) => entry.completedRows !== undefined)).toBe(true);
  });

  it('replays prompt dispositions and content/hunk-based Unassigned inspection', async () => {
    const gap = row('gap', 4);
    const gapDigest = await reviewedRowsDigest([gap]);
    const events: JournalEvent[] = [
      {
        type: 'prompt',
        ts: TS,
        promptKey: 'prompt_stable',
        action: 'DISMISS',
        reason: 'Product choice is out of scope.',
      },
      {
        type: 'unassigned',
        ts: TS,
        action: 'MARK_INSPECTED',
        target: { kind: 'GAP_ROWS', coveredRows: [gap], coveredRowsDigest: gapDigest },
      },
      {
        type: 'unassigned',
        ts: TS,
        action: 'MARK_INSPECTED',
        target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'hunk_ambiguous' },
      },
    ];
    const ledger = await replayReviewLedgerV2({ events, currentThreads: [] });
    expect(ledger.prompts).toEqual([
      {
        promptKey: 'prompt_stable',
        state: 'DISMISSED',
        reason: 'Product choice is out of scope.',
        ts: TS,
      },
    ]);
    expect(ledger.unassigned).toEqual({
      gapRows: [gap],
      gapRowsDigest: gapDigest,
      ambiguousHunkKeys: ['hunk_ambiguous'],
    });
    expect(JSON.stringify(events)).not.toMatch(/slice|partKey|actKey|storyKey/);
  });

  it('rejects a stale/missing row set before producing any partial batch', async () => {
    const current = await manifest('sec_a', [row('a', 1)]);
    const prepared = await prepareReviewCoverageEvent({
      floorInputHash: 'floor_hash',
      ledgerGeneration: 'generation',
      priorCoverage: [],
      currentThreads: [current],
      partRowsByThread: new Map([
        ['sec_a', [row('a', 9, 'not_current')]],
        ['sec_missing', [row('missing', 1)]],
      ]),
    });
    expect(prepared).toMatchObject({ status: 'invalid', event: null });
  });

  it('emits no empty coverage event and fails closed for an invalid zero-row Part', async () => {
    expect(
      await prepareReviewCoverageEvent({
        floorInputHash: 'floor_hash',
        ledgerGeneration: 'generation',
        priorCoverage: [],
        currentThreads: [],
        partRowsByThread: new Map(),
      })
    ).toEqual({ status: 'no_rows', event: null });
    expect(
      derivePartCompletion({
        eligibleRows: [],
        coveredRows: [],
        requiredItemStates: ['OPEN'],
      })
    ).toEqual({
      complete: false,
      coverageEventRequired: false,
      blockers: ['rows', 'items'],
    });
    expect(
      derivePartCompletion({
        eligibleRows: [],
        coveredRows: [],
        requiredItemStates: ['RESOLVED'],
        ownOpenComments: 2,
        blockingDisclosures: 1,
      })
    ).toEqual({
      complete: false,
      coverageEventRequired: false,
      blockers: ['rows', 'comments', 'disclosures'],
    });

    const owned = row('owned', 1);
    expect(
      derivePartCompletion({
        eligibleRows: [owned],
        coveredRows: [owned],
        requiredItemStates: ['RESOLVED'],
        ownOpenComments: 1,
        blockingDisclosures: 1,
      })
    ).toEqual({
      complete: false,
      coverageEventRequired: false,
      blockers: ['comments', 'disclosures'],
    });
  });

  it('changes the ledger generation for any additional valid event', async () => {
    const first: JournalEvent[] = [
      { type: 'section', ts: TS, threadKey: 'sec_a', action: 'VISIT' },
    ];
    expect(await reviewLedgerGeneration(first)).not.toBe(
      await reviewLedgerGeneration([
        ...first,
        {
          type: 'uncertainty',
          ts: '2026-07-12T00:00:01.000Z',
          citationId: 'cite:artifact:cp1:uncertainty:0',
          action: 'ACKNOWLEDGE',
        },
      ])
    );
  });
});
