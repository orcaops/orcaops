/**
 * Shared real-application harness for Task Review v2.
 *
 * Both the PTY probe and the mounted-app render tests build their `ReviewApp`
 * props from THIS module. That is deliberate: a probe that constructs its own
 * fixture wiring and asserts a hand-written text renderer makes the thing under
 * test and the thing asserted two different programs that silently drift. One
 * builder, one app, one set of observable effects.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import {
  type Floor,
  type JournalEvent,
  replayReviewLedgerV2,
  type ReviewGenerationIdentity,
  sliceKey,
} from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '@orcaops/review-engine';

import {
  buildWatchReviewFixture,
  WATCH_REVIEW_FIXTURE_SCENARIOS,
  type WatchReviewFixture,
  type WatchReviewFixtureScenario,
} from './reviewExperienceFixtures';
import type { CommentsPayload, EnrichedComment } from '../../src/data/commentsSource';
import type {
  ReviewData,
  ReviewTargetsStatus,
  RoutineStoryOverlay,
} from '../../src/data/reviewSource';
import type {
  LoadedReview,
  ReviewCommentEffects,
  ReviewJournalEffects,
} from '../../src/tui/review/ReviewApp';
import type { StoryReviewScreen } from '../../src/tui/review/keymap';
import {
  initialFocusForReviewScreen,
  initialReviewControllerState,
  type ReviewControllerCommand,
  type ReviewControllerState,
} from '../../src/tui/review/readerReviewController';

/** Install a Story fixture with the same floor-derived projections production loads. */
export async function loadedReviewWithStoryFixture(input: {
  base: LoadedReview;
  floor: Floor;
  reviewDiff: string;
  routineStory: RoutineStoryOverlay;
}): Promise<LoadedReview> {
  const eligibleTargets = await buildEligibleNarrativeTargets(input.floor, input.reviewDiff);
  const currentThreads = await buildCurrentThreadManifests(input.floor, eligibleTargets);
  const currentGapRows = await buildCurrentGapRows(input.floor, input.reviewDiff);
  const ledger = await replayReviewLedgerV2({
    events: [],
    currentThreads,
    currentGeneration: {
      floorInputHash: input.floor.input_hash,
      storyGeneration: input.routineStory.status === 'ok' ? input.routineStory.generation : null,
    },
  });
  return {
    ...input.base,
    data: {
      ...input.base.data,
      floor: input.floor,
      eligibleTargets,
      currentThreads,
      currentGapRows,
      targetsStatus: { ok: true },
      reviewDiff: input.reviewDiff,
      worktreeHeadSha: input.floor.scope.head_sha ?? null,
      routineStory: input.routineStory,
    },
    ledger,
  };
}

/** In-memory durable journal bound to an arbitrary production-shaped review. */
export async function loadedReviewJournalHarness(
  loaded: LoadedReview,
  initialEvents: readonly JournalEvent[] = []
): Promise<{
  loaded: LoadedReview;
  journalEffects: ReviewJournalEffects;
  journalEvents: JournalEvent[];
}> {
  const journalEvents = [...initialEvents];
  const currentGeneration: ReviewGenerationIdentity = {
    floorInputHash: loaded.data.floor.input_hash,
    storyGeneration:
      loaded.data.routineStory.status === 'ok' ? loaded.data.routineStory.generation : null,
  };
  const replay = () =>
    replayReviewLedgerV2({
      events: journalEvents,
      currentThreads: loaded.data.currentThreads,
      currentGeneration,
    });
  const journalEffects: ReviewJournalEffects = {
    load: replay,
    append: async (_opts, event) => {
      journalEvents.push(event);
      return { status: 'appended', ledger: await replay() };
    },
    appendMany: async (_opts, events) => {
      journalEvents.push(...events);
      return { status: 'appended', ledger: await replay() };
    },
  };
  return {
    loaded: { ...loaded, ledger: await replay() },
    journalEffects,
    journalEvents,
  };
}

/**
 * The patch every harness scenario reviews against. Three hunks across two
 * files, so slice-grain movement crosses parent-hunk and file boundaries.
 */
export const HARNESS_DIFF = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '@@ -10,0 +11 @@',
  '+second fixture hunk',
  'diff --git a/src/second.ts b/src/second.ts',
  '--- a/src/second.ts',
  '+++ b/src/second.ts',
  '@@ -1,0 +1 @@',
  '+third fixture hunk',
  '',
].join('\n');

/**
 * The same three hunks, but `hunk_fixture_second` is `rows` lines tall.
 *
 * Deliberately the SAME hunk keys and the same `additionStart`s, so the golden
 * floor still matches it hunk-for-hunk and no new scenario is needed. Only row 11
 * is an owned row — the rest are context the mask subdues — which is exactly the
 * shape virtualization has to survive: a huge parent hunk holding one small slice.
 */
export function tallHarnessDiff(rows: number): string {
  const adds = Array.from({ length: rows }, (_, i) =>
    // ONE row is deliberately far wider than any terminal this app supports, so
    // `w` (wrap lines) has something to actually wrap. Without it the toggle flips
    // a boolean that changes no pixel, and a key that changes no pixel is
    // indistinguishable from a dead one.
    i === 3 ? `+tall fixture row ${i} ${'x'.repeat(400)}` : `+tall fixture row ${i}`
  );
  return [
    'diff --git a/src/fixture.ts b/src/fixture.ts',
    '--- a/src/fixture.ts',
    '+++ b/src/fixture.ts',
    '@@ -1,0 +1 @@',
    '+stable fixture row',
    `@@ -10,0 +11,${rows} @@`,
    ...adds,
    'diff --git a/src/second.ts b/src/second.ts',
    '--- a/src/second.ts',
    '+++ b/src/second.ts',
    '@@ -1,0 +1 @@',
    '+third fixture hunk',
    '',
  ].join('\n');
}

/** Two independently tall files, for sticky handoff and native-drag coverage. */
export function tallTwoFileHarnessDiff(
  firstRows: number,
  secondRows: number,
  includeWideRow = false
): string {
  return [
    'diff --git a/src/fixture.ts b/src/fixture.ts',
    '--- a/src/fixture.ts',
    '+++ b/src/fixture.ts',
    '@@ -1,0 +1 @@',
    '+stable fixture row',
    `@@ -10,0 +11,${firstRows} @@`,
    ...Array.from({ length: firstRows }, (_, index) =>
      includeWideRow && index === 3
        ? `+first file row ${index} ${'x'.repeat(400)}`
        : `+first file row ${index}`
    ),
    'diff --git a/src/second.ts b/src/second.ts',
    '--- a/src/second.ts',
    '+++ b/src/second.ts',
    `@@ -1,0 +1,${secondRows} @@`,
    ...Array.from({ length: secondRows }, (_, index) => `+second file row ${index}`),
    '',
  ].join('\n');
}

/** Patch backing the canonical Unassigned page, including its ambiguous hunk. */
export function unassignedHarnessDiff(rows: number): string {
  return [
    'diff --git a/src/unassigned.ts b/src/unassigned.ts',
    '--- /dev/null',
    '+++ b/src/unassigned.ts',
    `@@ -0,0 +1,${rows} @@`,
    ...Array.from({ length: rows }, (_, index) =>
      index === 1
        ? `+unassigned row ${index + 1} ${'x'.repeat(400)}`
        : `+unassigned row ${index + 1}`
    ),
    'diff --git a/src/ambiguous.ts b/src/ambiguous.ts',
    '--- a/src/ambiguous.ts',
    '+++ b/src/ambiguous.ts',
    '@@ -3 +3 @@',
    '-ambiguous before',
    '+ambiguous after',
    '',
  ].join('\n');
}

/**
 * The patch `two-checkpoints` reviews: `hunk_fixture_second` carries TWO added rows,
 * because cp1 owns one of them and cp2 owns the other.
 *
 * The floor and the patch must agree: a floor that claims a row the patch does not
 * have is a floor the diff column cannot render and the anchor builder cannot hash.
 */
export function sharedHunkHarnessDiff(): string {
  return [
    'diff --git a/src/fixture.ts b/src/fixture.ts',
    '--- a/src/fixture.ts',
    '+++ b/src/fixture.ts',
    '@@ -1,0 +1 @@',
    '+stable fixture row',
    '@@ -10,0 +11,2 @@',
    '+second fixture hunk',
    '+cp2 added this row',
    'diff --git a/src/second.ts b/src/second.ts',
    '--- a/src/second.ts',
    '+++ b/src/second.ts',
    '@@ -1,0 +1 @@',
    '+third fixture hunk',
    '',
  ].join('\n');
}

export function multiRowHarnessDiff(): string {
  return [
    'diff --git a/src/fixture.ts b/src/fixture.ts',
    '--- a/src/fixture.ts',
    '+++ b/src/fixture.ts',
    '@@ -1,0 +1,2 @@',
    '+stable fixture row',
    '+second stable row',
    '@@ -10,0 +11 @@',
    '+second fixture hunk',
    'diff --git a/src/second.ts b/src/second.ts',
    '--- a/src/second.ts',
    '+++ b/src/second.ts',
    '@@ -1,0 +1 @@',
    '+third fixture hunk',
    '',
  ].join('\n');
}

export interface ReviewAppHarness {
  fixture: WatchReviewFixture;
  loaded: LoadedReview;
  initialState: ReviewControllerState;
  journalEffects: ReviewJournalEffects;
  /** Durable events the app actually appended, in order. */
  journalEvents: JournalEvent[];
  commentEffects: ReviewCommentEffects;
  /** The comment sidecar's live contents — what the CLI track would have written. */
  sidecar: () => EnrichedComment[];
  /**
   * Append a reply the way an AGENT does: out-of-band, through the CLI track, while
   * the reviewer's TUI is open. This is the half of the loop the reader cannot
   * initiate.
   */
  agentReplies: (commentId: string, body: string) => void;
}

function mergeLedgerEntries<T>(
  base: readonly T[],
  updates: readonly T[],
  keyOf: (entry: T) => string
): T[] {
  const merged = new Map(base.map((entry) => [keyOf(entry), entry] as const));
  for (const entry of updates) merged.set(keyOf(entry), entry);
  return [...merged.values()];
}

export function assertScenario(value: string): WatchReviewFixtureScenario {
  if (!WATCH_REVIEW_FIXTURE_SCENARIOS.includes(value as WatchReviewFixtureScenario)) {
    throw new Error(`unknown review fixture scenario ${value}`);
  }
  return value as WatchReviewFixtureScenario;
}

/**
 * Build the exact props the real `ReviewApp` runs on. `screen` is a request, not
 * a guarantee: a scenario with no narrative has no synthesized screens to open,
 * so it always boots on the floor route.
 */
export async function buildReviewAppHarness(options: {
  scenario: WatchReviewFixtureScenario;
  screen?: StoryReviewScreen;
  branch?: string;
  root?: string;
  /** Override the patch under review — see `tallHarnessDiff`. */
  reviewDiff?: string;
  /**
   * The comment sidecar, as the engine's re-anchor ladder would hand it over.
   * Pre-resolved `position`s, because re-anchoring is the engine's job and is
   * covered there; what the reader owes is placing and DRAWING them.
   */
  comments?: readonly EnrichedComment[];
  /** Test-only entry state for routes that cannot be reached from the default page. */
  controllerState?: Partial<ReviewControllerState>;
  /** Test-only routine Story overlay (the version-dispatched second lens). */
  routineStory?: ReviewData['routineStory'];
}): Promise<ReviewAppHarness> {
  const fixture = await buildWatchReviewFixture(options.scenario);
  const branch = options.branch ?? 'probe';
  // The reader decides which screens a lens supports; the harness only says where
  // to start. Forcing `brief` whenever there is no narrative encodes the very
  // assumption under test ("without a Story there is nowhere to be but the floor"),
  // so no test could contradict it.
  const screen = options.screen ?? 'brief';
  const comments = options.comments ?? [];
  const reviewDiff =
    options.reviewDiff ??
    (options.scenario === 'two-checkpoints' ||
    options.scenario === 'cross-artifact-shared-hunk' ||
    options.scenario === 'same-hunk-slices'
      ? sharedHunkHarnessDiff()
      : options.scenario === 'unassigned-huge'
        ? `${HARNESS_DIFF}${unassignedHarnessDiff(4_057)}`
        : options.scenario === 'unassigned' || options.scenario === 'unassigned-floor-only'
          ? `${HARNESS_DIFF}${unassignedHarnessDiff(2)}`
          : HARNESS_DIFF);
  let targetsStatus: ReviewTargetsStatus = { ok: true };
  let eligibleTargets = fixture.eligibleTargets;
  let currentThreads = fixture.currentThreads;
  let currentGapRows = fixture.currentGapRows;
  // Normal scenarios already carry projections minted by the same engine in
  // buildWatchReviewFixture. An explicit empty patch is the mounted degraded
  // case: derive it here through the production projection and keep the actual
  // failure, rather than injecting a test-only status string.
  if (options.reviewDiff === '') {
    try {
      eligibleTargets = await buildEligibleNarrativeTargets(fixture.source.floor, reviewDiff);
      currentThreads = await buildCurrentThreadManifests(fixture.source.floor, eligibleTargets);
      currentGapRows = await buildCurrentGapRows(fixture.source.floor, reviewDiff);
    } catch (error) {
      targetsStatus = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      eligibleTargets = [];
      currentThreads = fixture.source.floor.outline.threads.map((thread) => ({
        threadKey: thread.threadKey,
        rows: null,
        digest: null,
      }));
      currentGapRows = [];
    }
  }
  const initialState: ReviewControllerState = {
    ...initialReviewControllerState(),
    screen,
    // The initial controller state is the BRIEF's, focus included. Swapping the
    // screen without the focus mounts Walk on the Brief's pane — the same class
    // of harness-answers-an-unasked-question as the note below.
    focus: initialFocusForReviewScreen(screen),
    // A DIFF SCREEN WITH NO HUNK SELECTED IS NOT A DIFF SCREEN.
    //
    // The router requires a `selectedFloorHunkKey` to render the diff column, so
    // asking the harness for `floor-diff` and giving it nothing to show lands the
    // test on the Brief — silently, and looking exactly like the diff was broken.
    // Every diff key then reads as dead against a screen that was never there.
    //
    // That is the same trap: the harness answering a question the test did not ask.
    // Selecting the first hunk is what `activate` from the Brief does, so this puts
    // the reviewer exactly where pressing Enter would have.
    ...(screen === 'floor-diff'
      ? {
          diffHunkKey: fixture.source.floor.coverage.items[0]?.hunkKey ?? null,
          diffSliceKey: (() => {
            const ref = fixture.source.floor.outline.threads[0]?.checkpoints[0]?.sliceRefs[0];
            return ref === undefined ? null : sliceKey(ref.hunkKey, ref.slice);
          })(),
          focus: 'diff',
        }
      : {}),
    ...options.controllerState,
  };
  const loaded: LoadedReview = {
    data: {
      floor: fixture.source.floor,
      targetsStatus,
      eligibleTargets,
      currentThreads,
      currentGapRows,
      reviewDiff,
      root: options.root ?? process.cwd(),
      slug: 'probe',
      worktreeDigest: 'probe',
      worktreeHeadSha: fixture.source.floor.scope.head_sha ?? null,
      routineStory: options.routineStory ?? {
        model: null,
        status: 'absent',
        issue: null,
        runId: null,
        generation: null,
        installationToken: null,
        anchors: { model: null, status: 'absent', issue: null, generation: null },
      },
    },
    ledger: fixture.ledger,
    comments: {
      schema_version: 1,
      branch,
      open_count: comments.filter((comment) => comment.status === 'open').length,
      disclosure: [],
      comments: [...comments],
    },
  };

  const journalEvents: JournalEvent[] = [];
  const currentGeneration: ReviewGenerationIdentity = {
    floorInputHash: loaded.data.floor.input_hash,
    storyGeneration:
      loaded.data.routineStory.status === 'ok' ? loaded.data.routineStory.generation : null,
  };
  const replay = async () => {
    const replayed = await replayReviewLedgerV2({
      events: journalEvents,
      currentThreads: loaded.data.currentThreads,
      currentGeneration,
    });
    return {
      ...replayed,
      sections: mergeLedgerEntries(
        fixture.ledger.sections,
        replayed.sections,
        (entry) => entry.threadKey
      ),
      findings: mergeLedgerEntries(
        fixture.ledger.findings,
        replayed.findings,
        (entry) => entry.findingKey
      ),
      uncertainties: mergeLedgerEntries(
        fixture.ledger.uncertainties,
        replayed.uncertainties,
        (entry) => entry.citationId
      ),
      coverage: mergeLedgerEntries(
        fixture.ledger.coverage,
        replayed.coverage,
        (entry) => entry.threadKey
      ),
      prompts: mergeLedgerEntries(
        fixture.ledger.prompts,
        replayed.prompts,
        (entry) => entry.promptKey
      ),
      unassigned: {
        gapRows:
          replayed.unassigned.gapRowsDigest === null
            ? fixture.ledger.unassigned.gapRows
            : replayed.unassigned.gapRows,
        gapRowsDigest: replayed.unassigned.gapRowsDigest ?? fixture.ledger.unassigned.gapRowsDigest,
        ambiguousHunkKeys: [
          ...new Set([
            ...fixture.ledger.unassigned.ambiguousHunkKeys,
            ...replayed.unassigned.ambiguousHunkKeys,
          ]),
        ],
      },
    };
  };
  const journalEffects: ReviewJournalEffects = {
    load: replay,
    append: async (_opts, event) => {
      journalEvents.push(event);
      return { status: 'appended', ledger: await replay() };
    },
    appendMany: async (_opts, events) => {
      journalEvents.push(...events);
      return { status: 'appended', ledger: await replay() };
    },
  };

  // The comment sidecar, in memory. Production shells out to `orcaops review comment`;
  // this stands in for the file the CLI would write, so the reviewer's authoring, the
  // AGENT's out-of-band reply, and the reviewer's resolve all land in one place and the
  // round-trip is actually observable.
  const live: EnrichedComment[] = [...comments];
  let nextId = live.length + 1;
  const payload = (): CommentsPayload => ({
    schema_version: 1,
    branch,
    open_count: live.filter((comment) => comment.status === 'open').length,
    disclosure: [],
    comments: live.map((comment) => ({ ...comment })),
  });
  const find = (id: string): EnrichedComment | undefined =>
    live.find((comment) => comment.comment_id === id);
  const resolvedOwner = (anchor: EnrichedComment['anchor']): EnrichedComment['owner'] => {
    if (anchor.kind !== 'DIFF_LINE' && anchor.kind !== 'DIFF_RANGE') return null;
    const item = fixture.source.floor.coverage.items.find(
      (candidate) => candidate.hunkKey === anchor.hunkKey && candidate.file === anchor.file
    );
    const unit = item?.units.find((candidate) => {
      if (candidate.kind !== 'owned_slice') return false;
      const range = anchor.side === 'add' ? candidate.add_range : candidate.del_range;
      return range !== null && anchor.line >= range.start && anchor.line <= range.end;
    });
    if (unit?.kind !== 'owned_slice') return null;
    const checkpoint = fixture.source.floor.outline.threads
      .flatMap((thread) => thread.checkpoints)
      .find(
        (candidate) =>
          candidate.checkpoint.artifact === unit.owner.artifact &&
          candidate.checkpoint.cp === unit.owner.cp
      );
    return {
      artifact: unit.owner.artifact,
      cp: unit.owner.cp,
      label: checkpoint?.checkpoint.label ?? null,
    };
  };

  const commentEffects: ReviewCommentEffects = {
    add: async (_opts, input) => {
      // The engine re-anchors on read; here the anchor IS the position, because the
      // patch has not moved since it was authored. A re-floor is what makes them
      // differ, and that is what `driftComment` below simulates.
      const anchor = input.anchor;
      const position =
        anchor.kind === 'DIFF_LINE' || anchor.kind === 'DIFF_RANGE'
          ? {
              rung: 'line_hash' as const,
              file: anchor.file,
              side: anchor.side,
              line: anchor.line,
              endLine: anchor.kind === 'DIFF_RANGE' ? anchor.endLine : null,
              hunkKey: anchor.hunkKey ?? null,
              threadKey: null,
              drifted: false,
            }
          : null;
      live.push({
        comment_id: `c${nextId++}`,
        ts: '2026-01-01T00:00:00.000Z',
        author: 'reviewer',
        body: input.body,
        status: 'open',
        anchor,
        replies: [],
        position,
        context: [],
        owner: resolvedOwner(anchor),
        trail: [],
      });
      return payload();
    },
    reply: async (_opts, input) => {
      find(input.id)?.replies.push({
        ts: '2026-01-02T00:00:00.000Z',
        author: input.author ?? 'reviewer',
        body: input.body,
      });
      return payload();
    },
    resolve: async (_opts, input) => {
      const comment = find(input.id);
      if (comment !== undefined) comment.status = 'resolved';
      return payload();
    },
    reopen: async (_opts, input) => {
      const comment = find(input.id);
      if (comment !== undefined) comment.status = 'open';
      return payload();
    },
  };

  return {
    fixture,
    loaded,
    initialState,
    journalEffects,
    journalEvents,
    commentEffects,
    sidecar: () => live.map((comment) => ({ ...comment })),
    agentReplies: (commentId, body) => {
      find(commentId)?.replies.push({
        ts: '2026-01-03T00:00:00.000Z',
        author: 'agent',
        body,
      });
    },
  };
}

/** Stable one-line identity for a command, used by the PTY's state log. */
export function commandLabel(command: ReviewControllerCommand): string {
  if (command.kind === 'story-item-action') return `${command.kind}:${command.action}`;
  if (command.kind === 'expand-hidden')
    return `${command.kind}:${command.wholeFile ? 'file' : 'next'}`;
  // Paging carries its direction in the label: a command name without one makes a
  // missing page-DOWN unobservable.
  if (command.kind === 'page')
    return `${command.kind}:${command.direction === 1 ? 'down' : 'up'}:${command.half ? 'half' : 'full'}`;
  if (command.kind === 'scroll-diff-edge') return `${command.kind}:${command.edge}`;
  if (
    command.kind === 'move-diff-slice' ||
    command.kind === 'move-diff-row' ||
    command.kind === 'move-diff-file' ||
    command.kind === 'move-list' ||
    command.kind === 'move-page'
  )
    return `${command.kind}:${command.direction}`;
  return command.kind;
}

/**
 * Append-only structured log of REAL effects: the command the controller ran,
 * the state it produced, and the durable journal events it appended. Nothing
 * here re-renders the UI — the rendered frame is asserted by the mounted-app
 * tests, against the actual renderer.
 */
export function createHarnessLog(file: string): (line: string) => void {
  writeFileSync(file, '');
  return (line: string) => appendFileSync(file, `${line}\n`);
}
