// ReaderModel — one shell, two lenses.
//
// The deterministic floor (threads → checkpoints) and the routine Story
// (Acts → Parts) both project into this contract. The reader carries only stable
// page, row, route and presentation identities; neither lens gets a private diff
// renderer or an adapter through the narrative-v2 model.
//
// The load-bearing idea is `ReaderPage`. A Checkpoint and a Part are different
// things, but they answer the same four questions — what am I called, which rows
// do I own, am I complete, and can I be marked — and that is exactly the
// interface the diff column, the coverage ledger, the comment loop and Finish
// need. Answering those four for both is what lets one shell serve both lenses.

import {
  blockingDisclosureCount,
  CITATION_KIND,
  type CommentRecord,
  type CurrentThreadManifest,
  effectiveThreadCoverage,
  type EligibleNarrativeTarget,
  evaluateFloorOnlyFinishGate,
  evaluateStoryFinishGate,
  FINDING_STATE,
  findingState,
  type FinishGateResult,
  type Floor,
  type FloorOnlyFinishGateInput,
  formatCitationId,
  matchReviewedRows,
  type MemberRef,
  openReviewerCommentCount,
  ownOpenCommentCountForCheckpoint,
  parseCitationId,
  type PrepareCoverageResult,
  prepareReviewCoverageEvent,
  PROMPT_STATE,
  type ReviewedRow,
  type ReviewLedgerV2,
  threadGate,
  UNCERTAINTY_STATE,
  uncertaintyState,
} from '@orcaops/review-core';
import {
  buildSemanticAnchorChangeBlockCatalog,
  type ChangedRowSegment,
  ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS,
  rowsForEligibleTarget,
  type SemanticAnchorChangeBlockCatalog,
  type SemanticAnchorModel,
  type SemanticAnchorResolvedTarget,
  type StoryReviewModel,
  type StoryReviewPart,
} from '@orcaops/review-engine';

import {
  projectCheckpointReaderPage,
  projectResidueReaderPage,
  projectStoryPartReaderPage,
  projectUnassignedReaderPage,
  type ReaderDiffProjection,
  type ReaderSliceStop,
  rowsOfProjectedHunk,
} from './pageProjection';

export type ReaderLens = 'deterministic' | 'story';

export type ReaderPageBlocker =
  | 'rows'
  | 'items'
  | 'comments'
  | 'disclosures'
  | 'uncertainties'
  | 'ambiguity'
  | 'checking';

export type ReaderRailItemKind = 'citation' | 'uncertainty' | 'finding' | 'question' | 'ledger';

export type ReaderItemPlacementState = 'anchored' | 'unplaced' | 'part-context' | 'file-scope';

/** Lens-neutral rail/Attention record. Full prose lives on the canonical item. */
export interface ReaderRailItem {
  id: string;
  kind: ReaderRailItemKind;
  text: string;
  shortText: string;
  state: string;
  required: boolean;
  pageKey: string | null;
  file: string | null;
  source: string;
  /** Durable citation identity, when this row represents captured context. */
  citationId?: string;
  /** Where this projection came from; never changes canonical body/state identity. */
  context?: string;
  placementState?: ReaderItemPlacementState;
  targetCount?: number;
  locationCount?: number;
  disposition?: SemanticAnchorModel['items'][number]['disposition'];
}

/** What every page owes the shell, whichever lens minted it. */
export interface ReaderPageBase {
  /** Durable identity. A checkpointKey under the floor lens, a partKey under synthesis. */
  key: string;
  label: string;
  /** Full-context input for the canonical diff shell. */
  projection: ReaderDiffProjection;
  /** Ordered cursor stops. Never deduplicated by parent hunk. */
  sliceStops: readonly ReaderSliceStop[];
  /**
   * The rows this page owns, grouped by the thread that owns them — the shape
   * `prepareReviewCoverageEvent` consumes, so both lenses record coverage through
   * ONE preparer against ONE covered-row set.
   */
  ownedRows: ReadonlyMap<string, readonly ReviewedRow[]>;
  rowCount: number;
  /** No rows to cover — completion rests entirely on this page's items. */
  hasNoRows: boolean;
  complete: boolean;
  /** Why `complete` is false, in the vocabulary the ledger already uses. */
  blockers: ReaderPageBlocker[];
  markReviewedEnabled: boolean;
  /**
   * Stale-projection degradation, present only on stale pages: 'current' means
   * every code link survived (still non-authoritative), 'partial' some,
   * 'narrative-only' none.
   *
   * A code link is an owned segment OR an in-Part ambiguous hunk: both become
   * cursor stops on the projected page, so counting segments alone reported
   * 'narrative-only' on a Part whose ambiguous stop still navigated, and
   * 'current' on a Part that had just lost one.
   *
   * ABSENT when the Part authored NO code links at all. With zero of them
   * "all survived" and "none survived" are both vacuously true, so the enum
   * cannot tell them apart, and 'narrative-only' would report a loss that never
   * happened. Note the gate is zero LINKS, not the `contextOnly` flag: that flag
   * means zero segments, and a Part with an ambiguous hunk and no segments owns
   * a link that can still die.
   */
  projectionHealth?: 'current' | 'partial' | 'narrative-only';
  /** Durable floor threads whose VISIT state represents opening this page. */
  visitThreadKeys: readonly string[];
  /** True once every represented durable thread has left UNREAD. */
  visited: boolean;
}

export interface CheckpointPage extends ReaderPageBase {
  kind: 'checkpoint';
  threadKey: string;
  threadTitle: string;
  /** The checkpoint's own member ref — the back-link the captured trail reads. */
  member: MemberRef;
}

export interface PartPage extends ReaderPageBase {
  kind: 'part';
  actKey: string | null;
  actTitle: string | null;
  actInterpretation: string | null;
  /** Disposable coordinates for presentation only; page key remains primary. */
  actIndex: number;
  partIndex: number;
  part: StoryReviewPart;
  railItems: readonly ReaderRailItem[];
  ambiguousHunkKeys: readonly string[];
}

export type ReaderPage = CheckpointPage | PartPage;

/**
 * Unassigned is a page projection too, but is not coverage-markable: its rows
 * are inspected through the unassigned journal contract rather than attributed
 * to a thread's review coverage.
 */
export interface UnassignedPage {
  kind: 'unassigned';
  key: 'unassigned';
  label: string;
  projection: ReaderDiffProjection;
  sliceStops: readonly ReaderSliceStop[];
  inspectionRows: readonly ReviewedRow[];
  ambiguousHunkKeys: readonly string[];
  complete: boolean;
}

/** Story residue is explained cross-Part evidence, not deterministic Unassigned. */
export interface StoryResiduePage {
  kind: 'story-residue';
  key: 'story-residue';
  label: 'Residue';
  projection: ReaderDiffProjection;
  sliceStops: readonly ReaderSliceStop[];
  inspectionRows: readonly ReviewedRow[];
  ambiguousHunkKeys: readonly string[];
  complete: boolean;
  railItems: readonly ReaderRailItem[];
}

export type ReaderAuxiliaryPage = UnassignedPage | StoryResiduePage;

export type ReaderRouteDestination =
  | {
      kind: 'page';
      pageIndex: number;
      pageKey: string;
      hunkKey: string | null;
      sliceKey: string | null;
      semanticPlacementId?: string;
    }
  | {
      kind: 'auxiliary';
      pageKey: ReaderAuxiliaryPage['key'];
      hunkKey: string | null;
      sliceKey: string | null;
      semanticPlacementId?: string;
    }
  | {
      kind: 'deterministic-page';
      pageIndex: number;
      pageKey: string;
      hunkKey: string;
      sliceKey: string | null;
      semanticPlacementId: string;
    }
  | { kind: 'item-detail'; itemId: string }
  | { kind: 'attention'; itemId: string }
  | { kind: 'finish' }
  | { kind: 'flat-file'; file: string };

export interface ReaderBriefRow {
  id: string;
  kind: 'attention' | 'context' | 'act' | 'page' | 'auxiliary' | 'finish';
  label: string;
  level: 0 | 1;
  destination: ReaderRouteDestination;
}

export interface ReaderSemanticRow {
  side: 'add' | 'delete';
  line: number;
  lineHash: string;
}

export type ReaderSemanticDisplayTarget =
  | { kind: 'slice'; sliceKey: string }
  | { kind: 'line'; sliceKey: string; side: 'add' | 'delete'; line: number };

/**
 * One real placement of a semantic target. The immutable target remains
 * separate from the single display anchor where the measured card is inserted.
 */
export interface ReaderSemanticPlacement {
  id: string;
  itemId: string;
  citationId: string;
  targetIndex: number;
  locationIndex: number;
  target: SemanticAnchorResolvedTarget;
  displayTarget: ReaderSemanticDisplayTarget;
  /** Cursor index for the exact display row in this destination's projection. */
  rowCursor: number;
  highlightedRows: readonly ReaderSemanticRow[];
  destination:
    | {
        kind: 'page';
        pageIndex: number;
        pageKey: string;
        hunkKey: string;
        sliceKey: string;
      }
    | {
        kind: 'auxiliary';
        pageKey: ReaderAuxiliaryPage['key'];
        hunkKey: string;
        sliceKey: string;
      }
    | {
        kind: 'deterministic-page';
        pageIndex: number;
        pageKey: string;
        hunkKey: string;
        sliceKey: string | null;
      };
}

/**
 * Ephemeral routing derived from durable page/slice/hunk/item identities.
 * Generated indexes are disposable; snapshots retain the durable identities.
 */
export interface ReaderRouteIndex {
  pageIndexByKey: ReadonlyMap<string, number>;
  pageIndexesBySliceKey: ReadonlyMap<string, readonly number[]>;
  pageIndexesByHunkKey: ReadonlyMap<string, readonly number[]>;
  auxiliarySliceKeys: ReadonlySet<string>;
  auxiliaryHunkKeys: ReadonlySet<string>;
  briefRows: readonly ReaderBriefRow[];
  railItemsByPageKey: ReadonlyMap<string, readonly ReaderRailItem[]>;
  attentionItems: readonly ReaderRailItem[];
  capturedContextItems: readonly ReaderRailItem[];
  itemById: ReadonlyMap<string, ReaderRailItem>;
  destinationsByItemId: ReadonlyMap<string, readonly ReaderRouteDestination[]>;
  semanticPlacementsByItemId: ReadonlyMap<string, readonly ReaderSemanticPlacement[]>;
  semanticPlacementById: ReadonlyMap<string, ReaderSemanticPlacement>;
}

/** Coverage as the shell reads it, derived from the ONE covered-row set. */
export interface CoverageView {
  /** threadKey → the ledger's effective state for that thread against the current floor. */
  byThread: ReadonlyMap<string, ReturnType<typeof effectiveThreadCoverage>>;
  pagesComplete: number;
  pagesTotal: number;
}

interface ReviewUnassignedPresentation {
  gap: {
    currentRows: readonly ReviewedRow[];
    coveredRows: readonly ReviewedRow[];
    complete: boolean;
  };
  ambiguous: Array<{ hunkKey: string; complete: boolean }>;
  total: number;
  reviewed: number;
  complete: boolean;
}

export interface ReaderModel {
  lens: ReaderLens;
  /** Authored Story presentation, present exactly on the Story lens. */
  story: StoryReviewModel | null;
  /** True when this is a best-effort projection of a STALE Story (read-only). */
  staleProjection?: boolean;
  /**
   * Match health of a stale projection: how many code links survived.
   *
   * A "mapping" is every code link the pane can navigate — owned segments AND
   * in-Part ambiguous hunks, which `projectStoryPartReaderPage` turns into
   * whole-hunk cursor stops — so the count and the pane's own cursor cannot
   * disagree. Counting segments alone would report a different number.
   */
  staleHealth?: {
    survivingMappings: number;
    totalMappings: number;
    anchorsUnavailable: boolean;
  };
  pages: ReaderPage[];
  routeIndex: ReaderRouteIndex;
  coverage: CoverageView;
  /**
   * Can this review be called done, and if not, why? The CANONICAL gate — the
   * same `evaluateFloorOnlyFinishGate` the journal transport re-checks under its
   * lock, so the reader can never offer a Finish that the transport will reject.
   */
  finish: FinishGateResult;
  /**
   * The deterministic Unassigned presentation retained for finish accounting
   * and floor-lens rendering. Story exposes its distinct explained residue
   * through `auxiliaryPage`; it must not relabel that evidence as Unassigned.
   */
  unassigned: ReviewUnassignedPresentation;
  /** Canonical-shell projection of lens-specific non-page evidence. */
  auxiliaryPage: ReaderAuxiliaryPage;
}

/**
 * Unexplained rows and ambiguous hunks are floor/ledger facts, independent of
 * either review lens. Keep their projection beside the readers that consume it.
 */
function buildUnassigned(input: {
  floor: Floor;
  ledger: ReviewLedgerV2;
  currentGapRows?: readonly ReviewedRow[];
}): ReviewUnassignedPresentation {
  const currentGapRows = input.currentGapRows ?? [];
  const coveredGapRows = input.ledger.unassigned.gapRows;
  const gapComplete =
    currentGapRows.length === 0 || matchReviewedRows(coveredGapRows, currentGapRows).newRows === 0;
  const inspected = new Set(input.ledger.unassigned.ambiguousHunkKeys);
  const ambiguous = input.floor.outline.unassigned.ambiguous.hunkKeys.map((hunkKey) => ({
    hunkKey,
    complete: inspected.has(hunkKey),
  }));
  const total = (currentGapRows.length > 0 ? 1 : 0) + ambiguous.length;
  const reviewed =
    (currentGapRows.length > 0 && gapComplete ? 1 : 0) +
    ambiguous.filter((unit) => unit.complete).length;
  return {
    gap: { currentRows: currentGapRows, coveredRows: coveredGapRows, complete: gapComplete },
    ambiguous,
    total,
    reviewed,
    complete: reviewed === total,
  };
}

function shortText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}…`;
}

function pageDestination(page: ReaderPage, pageIndex: number): ReaderRouteDestination {
  const first = page.sliceStops[0];
  return {
    kind: 'page',
    pageIndex,
    pageKey: page.key,
    hunkKey: first?.hunkKey ?? null,
    sliceKey: first?.sliceKey ?? null,
  };
}

function auxiliaryDestination(page: ReaderAuxiliaryPage): ReaderRouteDestination {
  const first = page.sliceStops[0];
  return {
    kind: 'auxiliary',
    pageKey: page.key,
    hunkKey: first?.hunkKey ?? null,
    sliceKey: first?.sliceKey ?? null,
  };
}

/** Build the one routing index consumed by keyboard, command and pointer paths. */
export function buildReaderRouteIndex(input: {
  lens: ReaderLens;
  pages: readonly ReaderPage[];
  auxiliaryPage: ReaderAuxiliaryPage;
  story?: StoryReviewModel;
  attentionItems?: readonly ReaderRailItem[];
  capturedContextItems?: readonly ReaderRailItem[];
  semanticPlacements?: readonly ReaderSemanticPlacement[];
}): ReaderRouteIndex {
  const pageIndexByKey = new Map<string, number>();
  const pageIndexesBySliceKeyMutable = new Map<string, number[]>();
  const pageIndexesByHunkKeyMutable = new Map<string, number[]>();
  const railItemsByPageKey = new Map<string, readonly ReaderRailItem[]>();

  input.pages.forEach((page, pageIndex) => {
    if (pageIndexByKey.has(page.key)) {
      throw new Error(`reader contains duplicate page key ${page.key}`);
    }
    pageIndexByKey.set(page.key, pageIndex);
    if (page.kind === 'part') railItemsByPageKey.set(page.key, page.railItems);
    for (const stop of page.sliceStops) {
      const slicePageIndexes = pageIndexesBySliceKeyMutable.get(stop.sliceKey) ?? [];
      if (!slicePageIndexes.includes(pageIndex)) slicePageIndexes.push(pageIndex);
      pageIndexesBySliceKeyMutable.set(stop.sliceKey, slicePageIndexes);
      const pageIndexes = pageIndexesByHunkKeyMutable.get(stop.hunkKey) ?? [];
      if (!pageIndexes.includes(pageIndex)) pageIndexes.push(pageIndex);
      pageIndexesByHunkKeyMutable.set(stop.hunkKey, pageIndexes);
    }
  });

  const auxiliarySliceKeys = new Set(input.auxiliaryPage.sliceStops.map((stop) => stop.sliceKey));
  const auxiliaryHunkKeys = new Set(input.auxiliaryPage.sliceStops.map((stop) => stop.hunkKey));
  const attentionItems = [...(input.attentionItems ?? [])];
  const capturedContextItems = [...(input.capturedContextItems ?? [])];
  const allItems = [
    ...input.pages.flatMap((page) => (page.kind === 'part' ? page.railItems : [])),
    ...(input.auxiliaryPage.kind === 'story-residue' ? input.auxiliaryPage.railItems : []),
    ...attentionItems,
    ...capturedContextItems,
  ];
  const canonicalItem = (item: ReaderRailItem): ReaderRailItem => ({
    ...item,
    pageKey: null,
    context: undefined,
    placementState: item.placementState,
  });
  const itemById = new Map<string, ReaderRailItem>();
  for (const item of allItems) {
    const existing = itemById.get(item.id);
    if (existing !== undefined) {
      const semanticItem = canonicalItem(item);
      if (JSON.stringify(existing) !== JSON.stringify(semanticItem)) {
        throw new Error(`reader item ${item.id} has conflicting presentations`);
      }
      continue;
    }
    itemById.set(item.id, canonicalItem(item));
  }

  const semanticPlacementsByItemIdMutable = new Map<string, ReaderSemanticPlacement[]>();
  const semanticPlacementById = new Map<string, ReaderSemanticPlacement>();
  for (const placement of input.semanticPlacements ?? []) {
    if (semanticPlacementById.has(placement.id)) {
      throw new Error(`reader contains duplicate semantic placement ${placement.id}`);
    }
    semanticPlacementById.set(placement.id, placement);
    const at = semanticPlacementsByItemIdMutable.get(placement.itemId) ?? [];
    at.push(placement);
    semanticPlacementsByItemIdMutable.set(placement.itemId, at);
  }

  const destinationsByItemId = new Map<string, readonly ReaderRouteDestination[]>();
  for (const item of itemById.values()) {
    const destinations: ReaderRouteDestination[] = [];
    const semanticPlacements = semanticPlacementsByItemIdMutable.get(item.id) ?? [];
    for (const placement of semanticPlacements) {
      destinations.push({
        ...placement.destination,
        semanticPlacementId: placement.id,
      });
    }
    for (const occurrence of allItems.filter((candidate) => candidate.id === item.id)) {
      if (semanticPlacements.length > 0) {
        continue;
      } else if (
        occurrence.kind === 'citation' ||
        occurrence.kind === 'uncertainty' ||
        (occurrence.pageKey === null && occurrence.file === null)
      ) {
        destinations.push({ kind: 'item-detail', itemId: item.id });
      } else if (occurrence.file !== null) {
        // File provenance is readable scope, not a fabricated Story hunk anchor.
        destinations.push({ kind: 'flat-file', file: occurrence.file });
      } else if (occurrence.pageKey === input.auxiliaryPage.key) {
        destinations.push(auxiliaryDestination(input.auxiliaryPage));
      } else if (occurrence.pageKey !== null) {
        const pageIndex = pageIndexByKey.get(occurrence.pageKey);
        if (pageIndex === undefined) {
          throw new Error(`reader item ${item.id} references unknown page ${occurrence.pageKey}`);
        }
        destinations.push(pageDestination(input.pages[pageIndex]!, pageIndex));
      } else {
        destinations.push({ kind: 'item-detail', itemId: item.id });
      }
    }
    const unique = destinations.filter(
      (destination, index) =>
        destinations.findIndex(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(destination)
        ) === index
    );
    destinationsByItemId.set(item.id, unique);
  }

  const briefRows: ReaderBriefRow[] = [];
  for (const item of attentionItems) {
    briefRows.push({
      id: `attention:${item.id}`,
      kind: 'attention',
      label: `${item.state} · ${item.shortText}`,
      level: 0,
      destination: { kind: 'attention', itemId: item.id },
    });
  }
  for (const item of capturedContextItems) {
    const destination =
      destinationsByItemId.get(item.id)?.[0] ?? ({ kind: 'item-detail', itemId: item.id } as const);
    briefRows.push({
      id: `context:${item.id}`,
      kind: 'context',
      label: `Captured context · ${item.shortText}`,
      level: 0,
      destination,
    });
  }
  if (input.lens === 'story' && input.story !== undefined) {
    for (const act of input.story.acts) {
      const actPages = act.partIds.flatMap((partId) => {
        const pageIndex = pageIndexByKey.get(partId);
        return pageIndex === undefined ? [] : [{ pageIndex, page: input.pages[pageIndex]! }];
      });
      if (actPages.length === 0) continue;
      if (actPages.length > 1) {
        briefRows.push({
          id: `act:${act.id}`,
          kind: 'act',
          label: act.title,
          level: 0,
          destination: pageDestination(actPages[0]!.page, actPages[0]!.pageIndex),
        });
      }
      for (const { page, pageIndex } of actPages) {
        briefRows.push({
          id: `page:${page.key}`,
          kind: 'page',
          label: actPages.length === 1 ? `${act.title} · ${page.label}` : page.label,
          level: actPages.length > 1 ? 1 : 0,
          destination: pageDestination(page, pageIndex),
        });
      }
    }
    for (const page of input.pages) {
      if (
        page.kind !== 'part' ||
        page.actKey !== null ||
        briefRows.some((row) => row.id === `page:${page.key}`)
      ) {
        continue;
      }
      const pageIndex = pageIndexByKey.get(page.key)!;
      briefRows.push({
        id: `page:${page.key}`,
        kind: 'page',
        label: page.label,
        level: 0,
        destination: pageDestination(page, pageIndex),
      });
    }
    let previousThread: string | null = null;
    input.pages.forEach((page, pageIndex) => {
      if (page.kind !== 'checkpoint') return;
      if (page.threadKey !== previousThread) {
        briefRows.push({
          id: `captured-thread:${page.threadKey}`,
          kind: 'act',
          label: `Captured code · ${page.threadTitle}`,
          level: 0,
          destination: pageDestination(page, pageIndex),
        });
        previousThread = page.threadKey;
      }
      briefRows.push({
        id: `page:${page.key}`,
        kind: 'page',
        label: page.label,
        level: 1,
        destination: pageDestination(page, pageIndex),
      });
    });
  } else {
    let previousThread: string | null = null;
    input.pages.forEach((page, pageIndex) => {
      if (page.kind !== 'checkpoint') return;
      if (page.threadKey !== previousThread) {
        briefRows.push({
          id: `thread:${page.threadKey}`,
          kind: 'act',
          label: page.threadTitle,
          level: 0,
          destination: pageDestination(page, pageIndex),
        });
        previousThread = page.threadKey;
      }
      briefRows.push({
        id: `page:${page.key}`,
        kind: 'page',
        label: page.label,
        level: 1,
        destination: pageDestination(page, pageIndex),
      });
    });
  }
  if (
    input.auxiliaryPage.sliceStops.length > 0 ||
    (input.auxiliaryPage.kind === 'story-residue' && input.auxiliaryPage.railItems.length > 0)
  ) {
    briefRows.push({
      id: `auxiliary:${input.auxiliaryPage.key}`,
      kind: 'auxiliary',
      label: input.auxiliaryPage.label,
      level: 0,
      destination: auxiliaryDestination(input.auxiliaryPage),
    });
  }
  briefRows.push({
    id: 'finish',
    kind: 'finish',
    label: 'Finish',
    level: 0,
    destination: { kind: 'finish' },
  });

  return {
    pageIndexByKey,
    pageIndexesBySliceKey: new Map(pageIndexesBySliceKeyMutable),
    pageIndexesByHunkKey: new Map(pageIndexesByHunkKeyMutable),
    auxiliarySliceKeys,
    auxiliaryHunkKeys,
    briefRows,
    railItemsByPageKey,
    attentionItems,
    capturedContextItems,
    itemById,
    destinationsByItemId,
    semanticPlacementsByItemId: new Map(semanticPlacementsByItemIdMutable),
    semanticPlacementById,
  };
}

function threadsVisited(ledger: ReviewLedgerV2, threadKeys: readonly string[]): boolean {
  if (threadKeys.length === 0) return false;
  const states = new Map(ledger.sections.map((entry) => [entry.threadKey, entry.state]));
  return threadKeys.every((threadKey) => {
    const state = states.get(threadKey);
    return state !== undefined && state !== 'unread';
  });
}

/**
 * The branch-level facts the finish gate reads — IDENTICAL for both lenses,
 * because finishing is a statement about the branch, not about the lens the
 * reviewer happened to read it through. Passed as one bag so that adding an
 * obligation cannot be done for one lens and forgotten for the other.
 */
export interface ReaderFinishFacts {
  targets: FloorOnlyFinishGateInput['targets'];
  currentGapRows: readonly ReviewedRow[];
  comments: readonly (CommentRecord & {
    owner?: { artifact: string; cp: number } | null;
  })[];
}

/** The one derivation. Both builders call it; neither gets to have an opinion. */
function finishGate(
  floor: Floor,
  ledger: ReviewLedgerV2,
  currentThreads: readonly CurrentThreadManifest[],
  facts: ReaderFinishFacts
): FinishGateResult {
  return evaluateFloorOnlyFinishGate({
    targets: facts.targets,
    currentThreads,
    coverage: ledger.coverage,
    currentGapRows: facts.currentGapRows,
    inspectedGapRows: ledger.unassigned.gapRows,
    currentAmbiguousHunkKeys: floor.outline.unassigned.ambiguous.hunkKeys,
    inspectedAmbiguousHunkKeys: ledger.unassigned.ambiguousHunkKeys,
    openReviewerComments: openReviewerCommentCount(facts.comments),
    openUncertaintyCitationIds: floor.citations
      .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
      .map((citation) => citation.id)
      .filter((id) => uncertaintyState(ledger, id) === UNCERTAINTY_STATE.OPEN),
  });
}

function refKey(ref: MemberRef): string {
  return `${ref.artifact}:cp${ref.cp}`;
}

/**
 * Rows owned by each checkpoint, from the targets themselves.
 *
 * `EligibleNarrativeTarget.checkpointRefs` ALREADY carries the back-link, so the
 * checkpoint index is a group-by, not a new field on the packet. Adding one
 * would mean a second source of truth for "which checkpoint owns this code" that
 * could disagree with the first.
 */
function rowsByCheckpoint(
  targets: readonly EligibleNarrativeTarget[]
): Map<string, { threadKey: string; rows: ReviewedRow[] }> {
  const byCheckpoint = new Map<string, { threadKey: string; rows: ReviewedRow[] }>();
  for (const target of targets) {
    const rows = rowsForEligibleTarget(target);
    for (const ref of target.checkpointRefs) {
      const entry = byCheckpoint.get(refKey(ref)) ?? { threadKey: target.threadKey, rows: [] };
      entry.rows.push(...rows);
      byCheckpoint.set(refKey(ref), entry);
    }
  }
  return byCheckpoint;
}

/**
 * Are all of a page's rows already covered? Uses the ledger's cumulative covered
 * set for the owning thread — the same set `effectiveThreadCoverage` reads, so a
 * page cannot read complete while its thread reads stale.
 */
function rowsCovered(
  ownedRows: ReadonlyMap<string, readonly ReviewedRow[]>,
  ledger: ReviewLedgerV2
): boolean {
  for (const [threadKey, rows] of ownedRows) {
    const covered = ledger.coverage.find((entry) => entry.threadKey === threadKey);
    if (covered === undefined) return false;
    // Content identity is a multiset: two identical changed lines still require
    // two covered rows. `matchReviewedRows` consumes matches one-to-one and also
    // preserves the intended move/re-hunk tolerance.
    if (matchReviewedRows(covered.coveredRows, rows).newRows > 0) return false;
  }
  return true;
}

function coverageView(
  pages: readonly ReaderPage[],
  ledger: ReviewLedgerV2,
  currentThreads: readonly CurrentThreadManifest[]
): CoverageView {
  const byThread = new Map<string, ReturnType<typeof effectiveThreadCoverage>>();
  for (const manifest of currentThreads) {
    byThread.set(
      manifest.threadKey,
      effectiveThreadCoverage({
        base: ledger.sections.find((entry) => entry.threadKey === manifest.threadKey),
        coverage: ledger.coverage.find((entry) => entry.threadKey === manifest.threadKey),
        current: manifest,
      })
    );
  }
  return {
    byThread,
    pagesComplete: pages.filter((page) => page.complete).length,
    pagesTotal: pages.length,
  };
}

function unassignedPage(input: {
  floor: Floor;
  currentGapRows: readonly ReviewedRow[];
  presentation: ReviewUnassignedPresentation;
}): UnassignedPage {
  const projection = projectUnassignedReaderPage({ floor: input.floor });
  return {
    kind: 'unassigned',
    key: 'unassigned',
    label: 'Unassigned',
    projection,
    sliceStops: projection.sliceStops,
    inspectionRows: input.currentGapRows,
    ambiguousHunkKeys: input.floor.outline.unassigned.ambiguous.hunkKeys,
    complete: input.presentation.complete,
  };
}

/**
 * The deterministic lens: one page per CHECKPOINT, crossing thread boundaries in
 * execution order. This is the floor route, and it is available for every branch
 * — it needs no narrative, and cannot go stale.
 */
export function buildDeterministicReader(input: {
  floor: Floor;
  eligibleTargets: readonly EligibleNarrativeTarget[];
  ledger: ReviewLedgerV2;
  currentThreads: readonly CurrentThreadManifest[];
  finishFacts: ReaderFinishFacts;
}): ReaderModel {
  const owned = rowsByCheckpoint(input.eligibleTargets);
  const pages: ReaderPage[] = [];

  for (const thread of [...input.floor.outline.threads].sort((a, b) => a.order - b.order)) {
    for (const checkpoint of [...thread.checkpoints].sort((a, b) => a.order - b.order)) {
      const member: MemberRef = {
        artifact: checkpoint.checkpoint.artifact,
        cp: checkpoint.checkpoint.cp,
      };
      const rows = owned.get(refKey(member))?.rows ?? [];
      const ownedRows: ReadonlyMap<string, readonly ReviewedRow[]> =
        rows.length === 0 ? new Map() : new Map([[thread.threadKey, rows]]);
      const hasNoRows = rows.length === 0;
      const rowCoverageComplete = hasNoRows || rowsCovered(ownedRows, input.ledger);
      const uncertaintyCitationIds = checkpoint.citationIds.filter(
        (id) =>
          input.floor.citations.find((citation) => citation.id === id)?.kind ===
          CITATION_KIND.CHECKPOINT_UNCERTAINTY
      );
      const gate = threadGate(input.ledger, {
        findingKeys: [],
        uncertaintyCitationIds,
        ownOpenComments: ownOpenCommentCountForCheckpoint(input.finishFacts.comments, member),
      });
      const blockers: ReaderPageBase['blockers'] = [];
      if (!rowCoverageComplete) blockers.push('rows');
      if (gate.blockers.some((blocker) => blocker.kind === 'uncertainty')) {
        blockers.push('uncertainties');
      }
      if (gate.blockers.some((blocker) => blocker.kind === 'comment')) blockers.push('comments');
      const complete = blockers.length === 0;
      const projection = projectCheckpointReaderPage({
        floor: input.floor,
        checkpointKey: checkpoint.checkpointKey,
      });

      pages.push({
        kind: 'checkpoint',
        key: checkpoint.checkpointKey,
        label: checkpoint.checkpoint.label ?? `Checkpoint ${checkpoint.checkpoint.cp}`,
        threadKey: thread.threadKey,
        threadTitle: thread.title,
        member,
        projection,
        sliceStops: projection.sliceStops,
        ownedRows,
        rowCount: rows.length,
        hasNoRows,
        complete,
        blockers,
        // Coverage is one component of checkpoint completion. Captured
        // uncertainties and reviewer comments gate this exact checkpoint. A
        // comment with unresolved ownership remains a branch-level Finish
        // obligation instead of blocking every page in its thread.
        markReviewedEnabled: gate.allowed,
        visitThreadKeys: [thread.threadKey],
        visited: threadsVisited(input.ledger, [thread.threadKey]),
      });
    }
  }

  const unassigned = buildUnassigned({
    floor: input.floor,
    ledger: input.ledger,
    currentGapRows: input.finishFacts.currentGapRows,
  });
  const auxiliaryPage = unassignedPage({
    floor: input.floor,
    currentGapRows: input.finishFacts.currentGapRows,
    presentation: unassigned,
  });

  return {
    lens: 'deterministic',
    story: null,
    pages,
    routeIndex: buildReaderRouteIndex({
      lens: 'deterministic',
      pages,
      auxiliaryPage,
    }),
    coverage: coverageView(pages, input.ledger, input.currentThreads),
    finish: finishGate(input.floor, input.ledger, input.currentThreads, input.finishFacts),
    unassigned,
    auxiliaryPage,
  };
}

function canonicalCheckpointRef(
  model: StoryReviewModel,
  ref: string
): { artifact: string; cp: number } {
  const parsed = /^([^:]+):cp([1-9]\d*)$/.exec(ref);
  if (parsed === null) throw new Error(`Story checkpoint reference ${ref} is invalid`);
  const artifact = model.artifactAliases[parsed[1]!];
  if (artifact === undefined) {
    throw new Error(`Story checkpoint reference ${ref} uses an unknown artifact alias`);
  }
  return { artifact, cp: Number(parsed[2]) };
}

/** Journal identities are durable; Story citation ids use prompt-local aliases. */
export function canonicalStoryCitationId(model: StoryReviewModel, id: string): string {
  const parsed = parseCitationId(id);
  if (parsed === null) throw new Error(`Story citation ${id} is invalid`);
  const artifact = model.artifactAliases[parsed.artifact];
  if (artifact === undefined) {
    throw new Error(`Story citation ${id} uses an unknown artifact alias`);
  }
  return formatCitationId({ ...parsed, artifact });
}

function sameRange(
  left: { start: number; end: number } | null,
  right: { start: number; end: number } | null
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null && right !== null && left.start === right.start && left.end === right.end)
  );
}

function targetMatchesSegment(
  target: EligibleNarrativeTarget,
  segment: StoryReviewPart['segments'][number],
  canonicalOwner: MemberRef
): boolean {
  if (
    target.anchor.file !== segment.file ||
    target.anchor.hunkKey !== segment.hunkKey ||
    !target.checkpointRefs.some(
      (ref) => ref.artifact === canonicalOwner.artifact && ref.cp === canonicalOwner.cp
    )
  ) {
    return false;
  }
  const add = target.anchor.ranges.find((range) => range.side === 'add');
  const del = target.anchor.ranges.find((range) => range.side === 'delete');
  return (
    sameRange(
      segment.add_range,
      add === undefined ? null : { start: add.startLine, end: add.endLine }
    ) &&
    sameRange(
      segment.del_range,
      del === undefined ? null : { start: del.startLine, end: del.endLine }
    )
  );
}

function rowIdentity(row: ReviewedRow): string {
  return `${row.file}\u0000${row.hunkKey ?? ''}\u0000${row.side}\u0000${row.line}\u0000${row.lineHash}`;
}

function partOwnedRows(input: {
  floor: Floor;
  model: StoryReviewModel;
  part: StoryReviewPart;
  eligibleTargets: readonly EligibleNarrativeTarget[];
  currentThreads: readonly CurrentThreadManifest[];
  /**
   * Stale-projection tolerance: a segment that fails ANY of the exact-match
   * joins below is DROPPED (counted, narrative retained) instead of throwing.
   * Only segments that survive every check contribute rows and slices — an
   * exact survivor is indistinguishable from a current one, which is what
   * makes read-on navigation safe.
   */
  tolerant?: boolean;
}): {
  ownedRows: ReadonlyMap<string, readonly ReviewedRow[]>;
  visitThreadKeys: readonly string[];
  checking: boolean;
  survivingSegments: readonly ChangedRowSegment[];
  droppedSegments: number;
} {
  const tolerant = input.tolerant === true;
  const byThread = new Map<string, ReviewedRow[]>();
  const rowsBySegment = new Map<ChangedRowSegment, { threadKey: string; rows: ReviewedRow[] }>();
  const surviving: ChangedRowSegment[] = [];
  let dropped = 0;
  const reject = (message: string): null => {
    if (tolerant) {
      dropped += 1;
      return null;
    }
    throw new Error(message);
  };
  const usedTargets = new Set<string>();
  const currentByThread = new Map(
    input.currentThreads.map((manifest) => [manifest.threadKey, manifest])
  );
  const partRefs = new Set(
    input.part.checkpointRefs.map((ref) => {
      const canonical = canonicalCheckpointRef(input.model, ref);
      return refKey(canonical);
    })
  );

  for (const segment of input.part.segments) {
    const artifact = input.model.artifactAliases[segment.owner.artifact];
    if (artifact === undefined) {
      if (
        reject(
          `Story Part ${input.part.id} segment uses unknown alias ${segment.owner.artifact}`
        ) === null
      )
        continue;
    }
    const owner: MemberRef = { artifact: artifact!, cp: segment.owner.cp };
    if (!partRefs.has(refKey(owner))) {
      if (
        reject(
          `Story Part ${input.part.id} segment owner ${refKey(owner)} is not a Part member`
        ) === null
      )
        continue;
    }
    const item = input.floor.coverage.items.find(
      (candidate) => candidate.hunkKey === segment.hunkKey
    );
    const unit = item?.units.find(
      (candidate) => candidate.kind === 'owned_slice' && candidate.slice === segment.slice
    );
    if (
      item === undefined ||
      item.file !== segment.file ||
      unit === undefined ||
      unit.kind !== 'owned_slice' ||
      unit.owner?.kind !== 'checkpoint' ||
      unit.owner.artifact !== owner.artifact ||
      unit.owner.cp !== owner.cp ||
      unit.lines !== segment.lines ||
      !sameRange(unit.add_range, segment.add_range) ||
      !sameRange(unit.del_range, segment.del_range)
    ) {
      if (
        reject(
          `Story Part ${input.part.id} segment ${segment.hunkKey}:${segment.slice} disagrees with the floor`
        ) === null
      )
        continue;
    }
    const matches = input.eligibleTargets.filter((target) =>
      targetMatchesSegment(target, segment, owner)
    );
    if (matches.length !== 1) {
      if (
        reject(
          `Story Part ${input.part.id} segment ${segment.hunkKey}:${segment.slice} matched ${matches.length} eligible targets`
        ) === null
      )
        continue;
    }
    const target = matches[0]!;
    if (usedTargets.has(target.targetKey)) {
      if (
        reject(
          `Story Part ${input.part.id} assigns eligible target ${target.targetKey} more than once`
        ) === null
      )
        continue;
    }
    usedTargets.add(target.targetKey);
    const rows = rowsForEligibleTarget(target);
    if (rows.length !== segment.lines) {
      if (
        reject(
          `Story Part ${input.part.id} segment ${segment.hunkKey}:${segment.slice} declares ${segment.lines} rows but owns ${rows.length}`
        ) === null
      )
        continue;
    }
    const current = byThread.get(target.threadKey) ?? [];
    current.push(...rows);
    byThread.set(target.threadKey, current);
    rowsBySegment.set(segment, { threadKey: target.threadKey, rows });
    surviving.push(segment);
  }

  const ownedIdentities = new Set<string>();
  for (const rows of byThread.values()) {
    for (const row of rows) {
      const identity = rowIdentity(row);
      if (ownedIdentities.has(identity)) {
        if (tolerant) continue;
        throw new Error(`Story Part ${input.part.id} owns duplicate row ${identity}`);
      }
      ownedIdentities.add(identity);
    }
  }
  // A stale Part legitimately joins fewer rows than it declared — that gap IS
  // the staleness, reported through survivor counts rather than a throw.
  if (!tolerant && ownedIdentities.size !== input.part.changedRows) {
    throw new Error(
      `Story Part ${input.part.id} declares ${input.part.changedRows} changed rows but joins ${ownedIdentities.size}`
    );
  }

  let checking = false;
  const dropThread = (threadKey: string): void => {
    byThread.delete(threadKey);
    for (const [segment, entry] of rowsBySegment) {
      if (entry.threadKey !== threadKey) continue;
      rowsBySegment.delete(segment);
      const at = surviving.indexOf(segment);
      if (at >= 0) surviving.splice(at, 1);
      dropped += 1;
    }
  };
  for (const [threadKey, rows] of [...byThread]) {
    const manifest = currentByThread.get(threadKey);
    if (manifest === undefined) {
      if (tolerant) {
        dropThread(threadKey);
        continue;
      }
      throw new Error(`Story Part ${input.part.id} references unknown thread ${threadKey}`);
    }
    if (manifest.rows === null) {
      checking = true;
      continue;
    }
    const currentRows = new Set(manifest.rows.map(rowIdentity));
    if (rows.some((row) => !currentRows.has(rowIdentity(row)))) {
      if (tolerant) {
        dropThread(threadKey);
        continue;
      }
      throw new Error(`Story Part ${input.part.id} row ownership is stale for ${threadKey}`);
    }
  }

  return {
    ownedRows: byThread,
    visitThreadKeys: [...byThread.keys()],
    checking,
    survivingSegments: surviving,
    droppedSegments: dropped,
  };
}

function partRailItems(
  model: StoryReviewModel,
  part: StoryReviewPart,
  ledger: ReviewLedgerV2
): ReaderRailItem[] {
  const items = new Map<string, ReaderRailItem>();
  for (const citationId of part.citations) {
    const citation = model.citations[citationId];
    if (citation === undefined) continue;
    const canonicalId = canonicalStoryCitationId(model, citationId);
    items.set(`citation:${canonicalId}`, {
      id: `citation:${canonicalId}`,
      kind: 'citation',
      text: citation.text,
      shortText: shortText(citation.text),
      state: 'CONTEXT',
      required: false,
      pageKey: part.id,
      file: null,
      source: citation.kind,
      citationId: canonicalId,
      context: part.title,
      placementState: 'part-context',
      targetCount: 0,
      locationCount: 0,
    });
  }
  for (const uncertainty of model.uncertainties.filter(
    (candidate) => candidate.partId === part.id
  )) {
    const canonicalId = canonicalStoryCitationId(model, uncertainty.citationId);
    items.set(`citation:${canonicalId}`, {
      id: `citation:${canonicalId}`,
      kind: 'uncertainty',
      text: uncertainty.text,
      shortText: shortText(uncertainty.text),
      state: uncertaintyState(ledger, canonicalId),
      required: true,
      pageKey: part.id,
      file: null,
      source: 'captured uncertainty',
      citationId: canonicalId,
      context: part.title,
      placementState: 'part-context',
      targetCount: 0,
      locationCount: 0,
    });
  }
  for (const entry of model.ledger.filter(
    (candidate) => candidate.attachment.kind === 'part' && candidate.attachment.partId === part.id
  )) {
    items.set(`ledger:${entry.id}`, {
      id: `ledger:${entry.id}`,
      kind: 'ledger',
      text: entry.message,
      shortText: shortText(entry.message),
      state: entry.disposition,
      required: false,
      pageKey: part.id,
      file: null,
      source: entry.kind,
    });
  }
  return [...items.values()];
}

function globalStoryItems(model: StoryReviewModel, ledger: ReviewLedgerV2): ReaderRailItem[] {
  const items: ReaderRailItem[] = [];
  for (const uncertainty of model.uncertainties.filter((candidate) => candidate.partId === null)) {
    const canonicalId = canonicalStoryCitationId(model, uncertainty.citationId);
    items.push({
      id: `citation:${canonicalId}`,
      kind: 'uncertainty',
      text: uncertainty.text,
      shortText: shortText(uncertainty.text),
      state: uncertaintyState(ledger, canonicalId),
      required: true,
      pageKey: null,
      file: null,
      source: 'captured uncertainty',
      citationId: canonicalId,
      context: 'Story',
      placementState: 'unplaced',
      targetCount: 0,
      locationCount: 0,
    });
  }
  for (const finding of model.findings) {
    items.push({
      id: `finding:${finding.id}`,
      kind: 'finding',
      text: finding.text,
      shortText: shortText(finding.text),
      state: findingState(ledger, finding.id),
      required: finding.required,
      pageKey: null,
      file: finding.file,
      source: `${finding.lane} · ${finding.severity}`,
      placementState: finding.file === null ? 'unplaced' : 'file-scope',
      targetCount: 0,
      locationCount: 0,
    });
  }
  for (const question of model.questions) {
    const state =
      ledger.prompts.find((entry) => entry.promptKey === question.id)?.state ?? PROMPT_STATE.OPEN;
    items.push({
      id: `question:${question.id}`,
      kind: 'question',
      text: question.text,
      shortText: shortText(question.text),
      state,
      required: question.required,
      pageKey: null,
      file: question.file,
      source: `${question.lane} question`,
      placementState: question.file === null ? 'unplaced' : 'file-scope',
      targetCount: 0,
      locationCount: 0,
    });
  }
  return items;
}

const ELIGIBLE_STORY_CITATION_KINDS = new Set<string>(ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS);

function rowsInSemanticRange(
  side: 'add' | 'delete',
  range: {
    start_line: number;
    end_line: number;
    line_hashes: readonly string[];
  } | null
): ReaderSemanticRow[] {
  if (range === null) return [];
  return range.line_hashes.map((lineHash, index) => ({
    side,
    line: range.start_line + index,
    lineHash,
  }));
}

function semanticTargetRows(
  target: SemanticAnchorResolvedTarget,
  catalog: SemanticAnchorChangeBlockCatalog
): ReaderSemanticRow[] {
  const hunk = catalog.hunks.find(
    (candidate) =>
      candidate.hunkKey === target.block.hunk_key &&
      candidate.blocks.some((block) => block.blockKey === target.block.block_key)
  );
  const block = hunk?.blocks.find((candidate) => candidate.blockKey === target.block.block_key);
  if (
    hunk === undefined ||
    block === undefined ||
    hunk.oldFile !== target.block.old_file ||
    hunk.newFile !== target.block.new_file ||
    hunk.displayPath !== target.block.display_file
  ) {
    throw new Error(
      `semantic anchor block ${target.block.block_key} is absent from the loaded review diff`
    );
  }
  const rowsByCoordinate = new Map(
    block.lines.map((line) => [
      `${line.side}:${line.side === 'add' ? line.newLine : line.oldLine}`,
      line.lineHash,
    ])
  );
  const verifyRange = (
    side: 'add' | 'delete',
    range: {
      start_line: number;
      end_line: number;
      line_hashes: readonly string[];
    } | null
  ): void => {
    if (range === null) return;
    if (range.line_hashes.length !== range.end_line - range.start_line + 1) {
      throw new Error(`semantic anchor ${side} range has inconsistent bounds`);
    }
    for (const [offset, lineHash] of range.line_hashes.entries()) {
      const line = range.start_line + offset;
      if (rowsByCoordinate.get(`${side}:${line}`) !== lineHash) {
        throw new Error(
          `semantic anchor ${target.block.block_key} no longer names ${side}:${line}`
        );
      }
    }
  };
  verifyRange('delete', target.block.delete);
  verifyRange('add', target.block.add);
  const source =
    target.scope === 'FOCUS' && target.focus_status === 'ACCEPTED' && target.focus !== null
      ? target.focus
      : target.block;
  verifyRange('delete', source.delete);
  verifyRange('add', source.add);
  return [
    ...rowsInSemanticRange('delete', source.delete),
    ...rowsInSemanticRange('add', source.add),
  ];
}

function sameSemanticRow(row: ReviewedRow, target: ReaderSemanticRow, hunkKey: string): boolean {
  // Semantic-anchor hashes are SHA-256 over side + raw body, while coverage
  // rows use the review-core BLAKE3 identity. `semanticTargetRows` first proves
  // the SHA-256 identity against the exact loaded diff; the durable join into
  // page ownership is therefore its hunk + side + canonical line coordinate.
  return row.hunkKey === hunkKey && row.side === target.side && row.line === target.line;
}

function semanticRowCursor(
  page: ReaderPage | ReaderAuxiliaryPage,
  hunkKey: string,
  displayTarget: ReaderSemanticDisplayTarget
): number {
  if (displayTarget.kind !== 'line') return 0;
  const rows = rowsOfProjectedHunk(page.projection, hunkKey);
  return Math.max(
    0,
    rows.findIndex((row) => row.side === displayTarget.side && row.line === displayTarget.line)
  );
}

function sliceContainsSemanticRow(
  page: ReaderPage | ReaderAuxiliaryPage,
  hunkKey: string,
  row: ReaderSemanticRow
): string | null {
  for (const group of page.projection.layout.files) {
    for (const slice of group.slices) {
      if (slice.hunkKey !== hunkKey) continue;
      if (slice.unit.kind === 'ambiguous_hunk') return slice.sliceKey;
      const range = row.side === 'add' ? slice.unit.add_range : slice.unit.del_range;
      if (range !== null && row.line >= range.start && row.line <= range.end) {
        return slice.sliceKey;
      }
    }
  }
  return page.sliceStops.find((stop) => stop.hunkKey === hunkKey)?.sliceKey ?? null;
}

function semanticDisplayTarget(
  page: ReaderPage | ReaderAuxiliaryPage,
  hunkKey: string,
  rows: readonly ReaderSemanticRow[]
): ReaderSemanticDisplayTarget | null {
  for (const row of rows) {
    const sliceKey = sliceContainsSemanticRow(page, hunkKey, row);
    if (sliceKey !== null) {
      return { kind: 'line', sliceKey, side: row.side, line: row.line };
    }
  }
  const sliceKey = page.sliceStops.find((stop) => stop.hunkKey === hunkKey)?.sliceKey;
  return sliceKey === undefined ? null : { kind: 'slice', sliceKey };
}

function pageSemanticRows(
  page: ReaderPage,
  hunkKey: string,
  targetRows: readonly ReaderSemanticRow[]
): ReaderSemanticRow[] {
  const owned = [...page.ownedRows.values()].flat();
  const matched = targetRows.filter((target) =>
    owned.some((row) => sameSemanticRow(row, target, hunkKey))
  );
  if (matched.length === 0 && page.kind === 'part' && page.ambiguousHunkKeys.includes(hunkKey)) {
    return [...targetRows];
  }
  return matched;
}

function auxiliarySemanticRows(
  page: ReaderAuxiliaryPage,
  hunkKey: string,
  targetRows: readonly ReaderSemanticRow[]
): ReaderSemanticRow[] {
  const matched = targetRows.filter((target) =>
    page.inspectionRows.some((row) => sameSemanticRow(row, target, hunkKey))
  );
  return matched.length === 0 && page.ambiguousHunkKeys.includes(hunkKey)
    ? [...targetRows]
    : matched;
}

function projectSemanticPlacements(input: {
  model: StoryReviewModel;
  anchors: SemanticAnchorModel;
  catalog: SemanticAnchorChangeBlockCatalog;
  pages: readonly ReaderPage[];
  auxiliaryPage: ReaderAuxiliaryPage;
  deterministicPages: readonly ReaderPage[];
}): ReaderSemanticPlacement[] {
  const result: ReaderSemanticPlacement[] = [];
  for (const anchorItem of input.anchors.items) {
    const canonicalCitationId = canonicalStoryCitationId(input.model, anchorItem.citation_id);
    const itemId = `citation:${canonicalCitationId}`;
    if (anchorItem.disposition !== 'ANCHORED') continue;
    let itemLocation = 0;
    for (const [targetIndex, target] of anchorItem.targets.entries()) {
      const targetRows = semanticTargetRows(target, input.catalog);
      const targetPlacements: ReaderSemanticPlacement[] = [];
      for (const [pageIndex, page] of input.pages.entries()) {
        const rows = pageSemanticRows(page, target.block.hunk_key, targetRows);
        if (rows.length === 0) continue;
        const displayTarget = semanticDisplayTarget(page, target.block.hunk_key, rows);
        if (displayTarget === null) continue;
        targetPlacements.push({
          id: '',
          itemId,
          citationId: canonicalCitationId,
          targetIndex,
          locationIndex: 0,
          target,
          displayTarget,
          rowCursor: semanticRowCursor(page, target.block.hunk_key, displayTarget),
          highlightedRows: rows,
          destination: {
            kind: 'page',
            pageIndex,
            pageKey: page.key,
            hunkKey: target.block.hunk_key,
            sliceKey: displayTarget.sliceKey,
          },
        });
      }

      const residueRows = auxiliarySemanticRows(
        input.auxiliaryPage,
        target.block.hunk_key,
        targetRows
      );
      if (residueRows.length > 0) {
        const displayTarget = semanticDisplayTarget(
          input.auxiliaryPage,
          target.block.hunk_key,
          residueRows
        );
        if (displayTarget !== null) {
          targetPlacements.push({
            id: '',
            itemId,
            citationId: canonicalCitationId,
            targetIndex,
            locationIndex: 0,
            target,
            displayTarget,
            rowCursor: semanticRowCursor(input.auxiliaryPage, target.block.hunk_key, displayTarget),
            highlightedRows: residueRows,
            destination: {
              kind: 'auxiliary',
              pageKey: input.auxiliaryPage.key,
              hunkKey: target.block.hunk_key,
              sliceKey: displayTarget.sliceKey,
            },
          });
        }
      }

      // A target visible only as foreign Story context belongs to the floor page
      // that actually owns its named rows. This is a disclosed lens switch, not
      // invented Part ownership.
      if (targetPlacements.length === 0) {
        for (const [pageIndex, page] of input.deterministicPages.entries()) {
          const rows = pageSemanticRows(page, target.block.hunk_key, targetRows);
          if (rows.length === 0) continue;
          const displayTarget = semanticDisplayTarget(page, target.block.hunk_key, rows);
          if (displayTarget === null) continue;
          targetPlacements.push({
            id: '',
            itemId,
            citationId: canonicalCitationId,
            targetIndex,
            locationIndex: 0,
            target,
            displayTarget,
            rowCursor: semanticRowCursor(page, target.block.hunk_key, displayTarget),
            highlightedRows: rows,
            destination: {
              kind: 'deterministic-page',
              pageIndex,
              pageKey: page.key,
              hunkKey: target.block.hunk_key,
              sliceKey: displayTarget.sliceKey,
            },
          });
        }
      }

      for (const placement of targetPlacements) {
        placement.locationIndex = itemLocation;
        placement.id = `${itemId}:target:${targetIndex}:location:${itemLocation}`;
        itemLocation += 1;
        result.push(placement);
      }
    }
  }
  return result;
}

function canonicalReaderItem(item: ReaderRailItem): ReaderRailItem {
  return { ...item, pageKey: null, context: undefined };
}

function projectStoryContext(input: {
  model: StoryReviewModel;
  ledger: ReviewLedgerV2;
  sourcePartPages: readonly PartPage[];
  pages: readonly ReaderPage[];
  auxiliaryPage: StoryResiduePage;
  anchors: SemanticAnchorModel | null;
  semanticCatalog: SemanticAnchorChangeBlockCatalog | null;
  deterministicPages: readonly ReaderPage[];
}): {
  pages: ReaderPage[];
  auxiliaryPage: StoryResiduePage;
  attentionItems: ReaderRailItem[];
  capturedContextItems: ReaderRailItem[];
  semanticPlacements: ReaderSemanticPlacement[];
} {
  const canonical = new Map<string, ReaderRailItem>();
  const contextsByPageAndItem = new Map<string, string>();
  const sourcePageIds = new Map<string, string[]>();
  for (const page of input.sourcePartPages) {
    const ids: string[] = [];
    for (const item of page.railItems) {
      canonical.set(item.id, canonicalReaderItem(item));
      contextsByPageAndItem.set(`${page.key}\u0000${item.id}`, item.context ?? page.label);
      ids.push(item.id);
    }
    sourcePageIds.set(page.key, ids);
  }

  const globalItems = globalStoryItems(input.model, input.ledger);
  for (const item of globalItems) canonical.set(item.id, canonicalReaderItem(item));
  const attentionIds = new Set(globalItems.map((item) => item.id));
  const capturedIds = new Set<string>();
  for (const citationId of input.model.overview?.citations ?? []) {
    const citation = input.model.citations[citationId];
    if (citation === undefined) continue;
    const canonicalId = canonicalStoryCitationId(input.model, citationId);
    const id = `citation:${canonicalId}`;
    if (!canonical.has(id)) {
      canonical.set(id, {
        id,
        kind: 'citation',
        text: citation.text,
        shortText: shortText(citation.text),
        state: 'CONTEXT',
        required: false,
        pageKey: null,
        file: null,
        source: citation.kind,
        citationId: canonicalId,
        placementState: 'unplaced',
        targetCount: 0,
        locationCount: 0,
      });
    }
    capturedIds.add(id);
  }

  if (input.anchors !== null) {
    if (input.anchors.floor_input_hash !== input.model.floor_input_hash) {
      throw new Error('semantic anchors do not belong to the loaded Story floor');
    }
    for (const anchorItem of input.anchors.items) {
      const citation = input.model.citations[anchorItem.citation_id];
      if (citation === undefined) {
        throw new Error(
          `semantic anchor citation ${anchorItem.citation_id} has no Story catalog body`
        );
      }
      if (
        citation.kind !== anchorItem.citation_kind ||
        !ELIGIBLE_STORY_CITATION_KINDS.has(citation.kind)
      ) {
        throw new Error(`semantic anchor citation ${anchorItem.citation_id} has inconsistent kind`);
      }
      const canonicalId = canonicalStoryCitationId(input.model, anchorItem.citation_id);
      const id = `citation:${canonicalId}`;
      const existing = canonical.get(id);
      canonical.set(id, {
        ...(existing ?? {
          id,
          kind: 'citation' as const,
          text: citation.text,
          shortText: shortText(citation.text),
          state: 'CONTEXT',
          required: false,
          pageKey: null,
          file: null,
          source: citation.kind,
          citationId: canonicalId,
        }),
        pageKey: null,
        context: undefined,
        disposition: anchorItem.disposition,
        placementState: anchorItem.disposition === 'ANCHORED' ? 'anchored' : 'unplaced',
        targetCount: anchorItem.targets.length,
        locationCount: 0,
      });
    }
  }

  const semanticPlacements =
    input.anchors === null
      ? []
      : projectSemanticPlacements({
          model: input.model,
          anchors: input.anchors,
          catalog:
            input.semanticCatalog ??
            (() => {
              throw new Error('semantic anchor projection requires the loaded diff catalog');
            })(),
          pages: input.pages,
          auxiliaryPage: input.auxiliaryPage,
          deterministicPages: input.deterministicPages,
        });
  const placementsByItem = new Map<string, ReaderSemanticPlacement[]>();
  for (const placement of semanticPlacements) {
    const at = placementsByItem.get(placement.itemId) ?? [];
    at.push(placement);
    placementsByItem.set(placement.itemId, at);
  }
  for (const [id, item] of canonical) {
    const placements = placementsByItem.get(id) ?? [];
    if (item.disposition !== undefined) {
      canonical.set(id, {
        ...item,
        placementState: placements.length > 0 ? 'anchored' : 'unplaced',
        locationCount: placements.length,
      });
    }
  }

  const projectedPageIds = new Map<string, Set<string>>();
  for (const placement of semanticPlacements) {
    if (placement.destination.kind !== 'page') continue;
    const at = projectedPageIds.get(placement.destination.pageKey) ?? new Set<string>();
    at.add(placement.itemId);
    projectedPageIds.set(placement.destination.pageKey, at);
  }
  const pages = input.pages.map((page): ReaderPage => {
    if (page.kind !== 'part') return page;
    const ids = new Set([
      ...(sourcePageIds.get(page.key) ?? []),
      ...(projectedPageIds.get(page.key) ?? []),
    ]);
    return {
      ...page,
      railItems: [...ids].flatMap((id) => {
        const item = canonical.get(id);
        if (item === undefined) return [];
        return [
          {
            ...item,
            pageKey: page.key,
            context:
              contextsByPageAndItem.get(`${page.key}\u0000${id}`) ?? `anchored from ${item.source}`,
          },
        ];
      }),
    };
  });

  const auxiliaryIds = new Set(input.auxiliaryPage.railItems.map((item) => item.id));
  for (const placement of semanticPlacements) {
    if (placement.destination.kind === 'auxiliary') auxiliaryIds.add(placement.itemId);
  }
  for (const item of input.auxiliaryPage.railItems)
    canonical.set(item.id, canonicalReaderItem(item));
  const auxiliaryPage: StoryResiduePage = {
    ...input.auxiliaryPage,
    railItems: [...auxiliaryIds].flatMap((id) => {
      const item = canonical.get(id);
      return item === undefined
        ? []
        : [{ ...item, pageKey: input.auxiliaryPage.key, context: 'Residue' }];
    }),
  };

  const visibleOnActualPage = new Set(
    pages.flatMap((page) => (page.kind === 'part' ? page.railItems.map((item) => item.id) : []))
  );
  for (const id of canonical.keys()) {
    const selectedByAnchors = canonical.get(id)?.disposition !== undefined;
    const wasAuthoredOnPart = input.sourcePartPages.some((page) =>
      page.railItems.some((item) => item.id === id)
    );
    const onlyDeterministicPlacement = (placementsByItem.get(id) ?? []).every(
      (placement) => placement.destination.kind === 'deterministic-page'
    );
    if (
      !attentionIds.has(id) &&
      ((selectedByAnchors && (!visibleOnActualPage.has(id) || onlyDeterministicPlacement)) ||
        (wasAuthoredOnPart && !visibleOnActualPage.has(id)))
    ) {
      capturedIds.add(id);
    }
  }

  return {
    pages,
    auxiliaryPage,
    attentionItems: [...attentionIds].flatMap((id) => {
      const item = canonical.get(id);
      return item === undefined ? [] : [item];
    }),
    capturedContextItems: [...capturedIds].flatMap((id) => {
      const item = canonical.get(id);
      return item === undefined ? [] : [item];
    }),
    semanticPlacements,
  };
}

function residuePage(input: {
  floor: Floor;
  model: StoryReviewModel;
  ledger: ReviewLedgerV2;
  currentGapRows: readonly ReviewedRow[];
  floorFallback: boolean;
}): StoryResiduePage {
  const projection = input.floorFallback
    ? projectUnassignedReaderPage({ floor: input.floor })
    : projectResidueReaderPage({
        floor: input.floor,
        contested: input.model.residue.contested,
        unattributed: input.model.residue.unattributed,
      });
  const residueHunks = new Set(
    input.model.residue.unattributed
      .filter((entry) => entry.kind === 'gap' || entry.kind === 'unowned')
      .map((entry) => entry.hunkKey)
  );
  const inspectionRows = input.floorFallback
    ? [...input.currentGapRows]
    : input.currentGapRows.filter((row) => residueHunks.has(row.hunkKey ?? ''));
  const ambiguousHunkKeys = input.floorFallback
    ? [...input.floor.outline.unassigned.ambiguous.hunkKeys]
    : [
        ...input.model.residue.contested.map((entry) => entry.hunkKey),
        ...input.model.residue.unattributed
          .filter((entry) => entry.kind === 'ambiguous_no_part')
          .map((entry) => entry.hunkKey),
      ];
  const gapComplete =
    matchReviewedRows(input.ledger.unassigned.gapRows, inspectionRows).newRows === 0;
  const inspectedAmbiguous = new Set(input.ledger.unassigned.ambiguousHunkKeys);
  const ambiguityComplete = ambiguousHunkKeys.every((key) => inspectedAmbiguous.has(key));
  const railItems = input.model.ledger
    .filter((entry) => entry.attachment.kind === 'residue')
    .map(
      (entry): ReaderRailItem => ({
        id: `ledger:${entry.id}`,
        kind: 'ledger',
        text: entry.message,
        shortText: shortText(entry.message),
        state: entry.disposition,
        required: false,
        pageKey: null,
        file: null,
        source: entry.kind,
      })
    );
  return {
    kind: 'story-residue',
    key: 'story-residue',
    label: 'Residue',
    projection,
    sliceStops: projection.sliceStops,
    inspectionRows,
    ambiguousHunkKeys,
    complete: gapComplete && ambiguityComplete,
    railItems,
  };
}

function validateStoryReaderInput(floor: Floor, model: StoryReviewModel): void {
  const aliasValues = Object.values(model.artifactAliases);
  if (new Set(aliasValues).size !== aliasValues.length) {
    throw new Error('Story artifact aliases do not resolve one-to-one');
  }
  const partsById = new Map(model.parts.map((part) => [part.id, part]));
  for (const act of model.acts) {
    const expected = model.parts.filter((part) => part.act === act.id).map((part) => part.id);
    if (
      expected.length !== act.partIds.length ||
      expected.some((partId, index) => act.partIds[index] !== partId)
    ) {
      throw new Error(`Story Act ${act.id} disagrees with causal Part order`);
    }
  }

  const checkpointExists = (member: MemberRef): boolean =>
    floor.outline.threads.some((thread) =>
      thread.checkpoints.some(
        (checkpoint) =>
          (checkpoint.checkpoint.artifact === member.artifact &&
            checkpoint.checkpoint.cp === member.cp) ||
          checkpoint.members.some(
            (candidate) => candidate.artifact === member.artifact && candidate.cp === member.cp
          )
      )
    );
  for (const part of model.parts) {
    const refs = part.checkpointRefs.map((ref) => canonicalCheckpointRef(model, ref));
    if (new Set(refs.map(refKey)).size !== refs.length) {
      throw new Error(`Story Part ${part.id} repeats a checkpoint reference`);
    }
    if (refs.some((ref) => !checkpointExists(ref))) {
      throw new Error(`Story Part ${part.id} references a checkpoint absent from the floor`);
    }
    if (part.changedRows !== part.segments.reduce((total, segment) => total + segment.lines, 0)) {
      throw new Error(`Story Part ${part.id} changedRows disagrees with its segments`);
    }
    if (
      part.ambiguousRows !== part.ambiguous.reduce((total, ambiguity) => total + ambiguity.lines, 0)
    ) {
      throw new Error(`Story Part ${part.id} ambiguousRows disagrees with its hunks`);
    }
    for (const ambiguity of part.ambiguous) {
      const item = floor.coverage.items.find(
        (candidate) => candidate.hunkKey === ambiguity.hunkKey
      );
      const unit = item?.units.find((candidate) => candidate.kind === 'ambiguous_hunk');
      if (
        item === undefined ||
        item.file !== ambiguity.file ||
        unit === undefined ||
        unit.kind !== 'ambiguous_hunk' ||
        unit.lines !== ambiguity.lines
      ) {
        throw new Error(
          `Story Part ${part.id} ambiguity ${ambiguity.hunkKey} disagrees with the floor`
        );
      }
    }
  }

  for (const uncertainty of model.uncertainties) {
    const parsed = parseCitationId(uncertainty.citationId);
    if (
      parsed === null ||
      parsed.kind !== CITATION_KIND.CHECKPOINT_UNCERTAINTY ||
      parsed.artifact !== uncertainty.artifact ||
      parsed.checkpointN !== uncertainty.cp
    ) {
      throw new Error(`Story uncertainty ${uncertainty.citationId} has inconsistent identity`);
    }
    const canonicalId = canonicalStoryCitationId(model, uncertainty.citationId);
    if (!floor.citations.some((citation) => citation.id === canonicalId)) {
      throw new Error(`Story uncertainty ${uncertainty.citationId} is absent from the floor`);
    }
    if (uncertainty.partId !== null) {
      const part = partsById.get(uncertainty.partId);
      if (part === undefined) {
        throw new Error(
          `Story uncertainty ${uncertainty.citationId} references unknown Part ${uncertainty.partId}`
        );
      }
      const owner = canonicalCheckpointRef(model, `${uncertainty.artifact}:cp${uncertainty.cp}`);
      if (
        !part.checkpointRefs
          .map((ref) => canonicalCheckpointRef(model, ref))
          .some((ref) => refKey(ref) === refKey(owner))
      ) {
        throw new Error(
          `Story uncertainty ${uncertainty.citationId} is attached outside its checkpoint Part`
        );
      }
    }
  }

  const residueKeys = new Set<string>();
  for (const entry of model.residue.contested) {
    const item = floor.coverage.items.find((candidate) => candidate.hunkKey === entry.hunkKey);
    const unit = item?.units.find((candidate) => candidate.kind === 'ambiguous_hunk');
    if (
      item === undefined ||
      item.file !== entry.file ||
      unit === undefined ||
      unit.kind !== 'ambiguous_hunk' ||
      unit.lines !== entry.lines
    ) {
      throw new Error(`Story contested residue ${entry.hunkKey} disagrees with the floor`);
    }
    residueKeys.add(`ambiguous:${entry.hunkKey}`);
  }
  for (const entry of model.residue.unattributed) {
    const key =
      entry.kind === 'ambiguous_no_part'
        ? `ambiguous:${entry.hunkKey}`
        : `slice:${entry.hunkKey}:${entry.slice ?? -1}`;
    if (residueKeys.has(key)) throw new Error(`Story residue repeats ${key}`);
    residueKeys.add(key);
    const item = floor.coverage.items.find((candidate) => candidate.hunkKey === entry.hunkKey);
    const unit =
      entry.kind === 'ambiguous_no_part'
        ? item?.units.find((candidate) => candidate.kind === 'ambiguous_hunk')
        : item?.units.find(
            (candidate) => candidate.kind === 'gap_slice' && candidate.slice === entry.slice
          );
    if (
      item === undefined ||
      item.file !== entry.file ||
      unit === undefined ||
      unit.lines !== entry.lines ||
      (entry.kind === 'ambiguous_no_part' && unit.kind !== 'ambiguous_hunk') ||
      (entry.kind !== 'ambiguous_no_part' && unit.kind !== 'gap_slice')
    ) {
      throw new Error(`Story unattributed residue ${key} disagrees with the floor`);
    }
  }
  if (
    model.residue.reviewableRows !==
    model.residue.unattributed.reduce((total, entry) => total + entry.lines, 0)
  ) {
    throw new Error('Story residue reviewableRows disagrees with unattributed rows');
  }
  const totals = {
    attributed: model.parts.reduce((total, part) => total + part.changedRows, 0),
    ambiguous: model.parts.reduce((total, part) => total + part.ambiguousRows, 0),
    contested: model.residue.contested.reduce((total, entry) => total + entry.lines, 0),
    unattributed: model.residue.unattributed.reduce((total, entry) => total + entry.lines, 0),
  };
  if (
    model.label === 'DERIVED' &&
    (totals.attributed + totals.ambiguous + totals.contested + totals.unattributed !==
      floor.coverage.summary.reviewable_rows ||
      model.metrics.attributedRows !== totals.attributed ||
      model.metrics.ambiguousRows !== totals.ambiguous ||
      model.metrics.contestedRows !== totals.contested ||
      model.metrics.unattributedRows !== totals.unattributed)
  ) {
    throw new Error('Story ownership totals disagree with the model or floor');
  }
}

/**
 * The routine Story lens: one page per authored Part in causal model order.
 * Rows are joined to the exact engine-minted eligible targets so this lens
 * records the same content-addressed coverage as the deterministic floor.
 */
export function buildStoryReader(input: {
  floor: Floor;
  model: StoryReviewModel;
  reviewDiff: string;
  semanticAnchors?: SemanticAnchorModel | null;
  eligibleTargets: readonly EligibleNarrativeTarget[];
  ledger: ReviewLedgerV2;
  currentThreads: readonly CurrentThreadManifest[];
  finishFacts: ReaderFinishFacts;
  /**
   * Best-effort projection of a STALE Story against the current floor. Every
   * code link either survives the exact-match joins (and works fully) or is
   * dropped with its narrative retained. The whole lens is NON-AUTHORITATIVE:
   * pages are never complete or coverage-markable, opening one appends no
   * VISIT, and Finish is the floor-only gate. Never set for the current Story
   * — its all-throw validation is the correctness contract.
   */
  staleProjection?: boolean;
}): ReaderModel {
  const stale = input.staleProjection === true;
  if (!stale) {
    if (input.model.floor_input_hash !== input.floor.input_hash) {
      throw new Error('Story model does not belong to the loaded floor');
    }
    validateStoryReaderInput(input.floor, input.model);
  }
  const partIds = new Set<string>();
  for (const part of input.model.parts) {
    if (partIds.has(part.id)) throw new Error(`Story contains duplicate Part ${part.id}`);
    partIds.add(part.id);
    if (part.contextOnly !== (part.segments.length === 0)) {
      throw new Error(`Story Part ${part.id} has an inconsistent contextOnly flag`);
    }
  }
  const actIds = new Set<string>();
  for (const act of input.model.acts) {
    if (actIds.has(act.id)) throw new Error(`Story contains duplicate Act ${act.id}`);
    actIds.add(act.id);
    if (
      act.partIds.some(
        (partId) =>
          !partIds.has(partId) ||
          input.model.parts.find((part) => part.id === partId)?.act !== act.id
      )
    ) {
      throw new Error(`Story Act ${act.id} has inconsistent Part membership`);
    }
  }
  if (
    input.model.parts.some(
      (part) =>
        part.act !== null &&
        (!actIds.has(part.act) ||
          !input.model.acts.find((act) => act.id === part.act)?.partIds.includes(part.id))
    )
  ) {
    throw new Error('Story Part has inconsistent Act membership');
  }

  const blockingDisclosures = blockingDisclosureCount(input.floor.disclosure);
  const inspectedAmbiguous = new Set(input.ledger.unassigned.ambiguousHunkKeys);
  const currentHunkKeys = new Set(input.floor.coverage.items.map((item) => item.hunkKey));
  let survivingMappingTotal = 0;
  let droppedMappingTotal = 0;
  const storyPages: ReaderPage[] = input.model.parts.map((part): PartPage => {
    const ownership = partOwnedRows({
      floor: input.floor,
      model: input.model,
      part,
      eligibleTargets: input.eligibleTargets,
      currentThreads: input.currentThreads,
      tolerant: stale,
    });
    const partAmbiguous = stale
      ? part.ambiguous.filter((entry) => currentHunkKeys.has(entry.hunkKey))
      : part.ambiguous;
    // Both halves of a Part's navigable code, counted together: owned segments
    // and the ambiguous hunks the ownership pass keeps with it. The aggregate
    // the Brief prints and the per-Part enum below read the SAME two numbers,
    // so the two surfaces cannot disagree about what a mapping is.
    const survivingMappings = ownership.survivingSegments.length + partAmbiguous.length;
    const droppedMappings =
      ownership.droppedSegments + (part.ambiguous.length - partAmbiguous.length);
    survivingMappingTotal += survivingMappings;
    droppedMappingTotal += droppedMappings;
    const rowCount = [...ownership.ownedRows.values()].reduce(
      (total, rows) => total + rows.length,
      0
    );
    const hasNoRows = rowCount === 0;
    const rowCoverageComplete = hasNoRows || rowsCovered(ownership.ownedRows, input.ledger);
    const uncertaintyIds = input.model.uncertainties
      .filter((uncertainty) => uncertainty.partId === part.id)
      .map((uncertainty) => canonicalStoryCitationId(input.model, uncertainty.citationId));
    const ownOpenComments = part.checkpointRefs
      .map((ref) => canonicalCheckpointRef(input.model, ref))
      .reduce(
        (total, member) =>
          total + ownOpenCommentCountForCheckpoint(input.finishFacts.comments, member),
        0
      );
    const ambiguityComplete = partAmbiguous.every((entry) => inspectedAmbiguous.has(entry.hunkKey));
    const blockers: ReaderPageBlocker[] = [];
    if (!hasNoRows && !rowCoverageComplete) blockers.push('rows');
    if (ownership.checking) blockers.push('checking');
    if (
      uncertaintyIds.some(
        (citationId) => uncertaintyState(input.ledger, citationId) === UNCERTAINTY_STATE.OPEN
      )
    ) {
      blockers.push('uncertainties');
    }
    if (ownOpenComments > 0) blockers.push('comments');
    if (blockingDisclosures > 0) blockers.push('disclosures');
    if (!ambiguityComplete) blockers.push('ambiguity');
    const projection = projectStoryPartReaderPage({
      floor: input.floor,
      segments: stale ? [...ownership.survivingSegments] : [...part.segments],
      ambiguous: partAmbiguous,
    });
    const act = input.model.acts.find((candidate) => candidate.id === part.act);
    const actIndex = act === undefined ? 0 : input.model.acts.indexOf(act);
    const partIndex =
      act === undefined
        ? 0
        : Math.max(
            0,
            act.partIds.findIndex((partId) => partId === part.id)
          );
    const nonCoverageBlocker = blockers.some(
      (blocker) => blocker !== 'rows' && blocker !== 'ambiguity'
    );
    return {
      kind: 'part',
      key: part.id,
      label: part.title,
      actKey: act?.id ?? null,
      actTitle: act?.title ?? null,
      actInterpretation: act?.interpretation ?? null,
      actIndex,
      partIndex,
      part,
      railItems: partRailItems(input.model, part, input.ledger),
      ambiguousHunkKeys: partAmbiguous.map((entry) => entry.hunkKey),
      projection,
      sliceStops: projection.sliceStops,
      ownedRows: ownership.ownedRows,
      rowCount,
      hasNoRows,
      // A stale page is NEVER authoritatively complete, coverage-markable, or
      // VISIT-witnessed: viewing an out-of-date narrative must not move the
      // current review's state.
      complete: stale ? false : blockers.length === 0,
      blockers,
      markReviewedEnabled: stale ? false : !hasNoRows && !nonCoverageBlocker,
      visitThreadKeys: stale ? [] : ownership.visitThreadKeys,
      // Thread VISIT state cannot distinguish two Parts sharing a thread.
      // Until a Part-grain witness exists, only durable row coverage counts.
      visited: stale ? false : !hasNoRows && rowCoverageComplete,
      // Parts with no code links at all are excluded: see `projectionHealth`'s
      // note — the enum has nothing to describe, and 'narrative-only' would
      // report a loss that never happened.
      ...(stale && survivingMappings + droppedMappings > 0
        ? {
            projectionHealth:
              survivingMappings > 0
                ? droppedMappings > 0
                  ? ('partial' as const)
                  : ('current' as const)
                : ('narrative-only' as const),
          }
        : {}),
    };
  });
  // CODE_ONLY and degraded-attribution models intentionally carry no reliable
  // Part ownership partition. Keep the Story's forensic/global material, but
  // route code through the deterministic checkpoint pages so every floor-owned
  // row remains visible and coverage-markable. This is a mixed Story shell, not
  // a fallback to a different lens or an invented authored Part.
  const floorFallback = input.model.label !== 'DERIVED';
  const deterministicReader =
    floorFallback || input.semanticAnchors != null
      ? buildDeterministicReader({
          floor: input.floor,
          eligibleTargets: input.eligibleTargets,
          ledger: input.ledger,
          currentThreads: input.currentThreads,
          finishFacts: input.finishFacts,
        })
      : null;
  const basePages = floorFallback ? deterministicReader!.pages : storyPages;

  const openRequiredItems =
    input.model.findings.filter(
      (finding) => finding.required && findingState(input.ledger, finding.id) === FINDING_STATE.OPEN
    ).length +
    input.model.questions.filter((question) => {
      if (!question.required) return false;
      return (
        (input.ledger.prompts.find((entry) => entry.promptKey === question.id)?.state ??
          PROMPT_STATE.OPEN) === PROMPT_STATE.OPEN
      );
    }).length;
  // A stale Story never becomes the completion basis: Finish is assigned from
  // the floor-only gate DIRECTLY, the same gate the journal transport re-checks.
  const finish = stale
    ? finishGate(input.floor, input.ledger, input.currentThreads, input.finishFacts)
    : evaluateStoryFinishGate({
        floor: finishGate(input.floor, input.ledger, input.currentThreads, input.finishFacts),
        openRequiredStoryItems: openRequiredItems,
      });
  const unassigned = buildUnassigned({
    floor: input.floor,
    ledger: input.ledger,
    currentGapRows: input.finishFacts.currentGapRows,
  });
  const baseAuxiliaryPage = residuePage({
    floor: input.floor,
    model: input.model,
    ledger: input.ledger,
    currentGapRows: input.finishFacts.currentGapRows,
    floorFallback,
  });
  const contextInput = (anchors: SemanticAnchorModel | null) => ({
    model: input.model,
    ledger: input.ledger,
    sourcePartPages: storyPages.filter((page): page is PartPage => page.kind === 'part'),
    pages: basePages,
    auxiliaryPage: baseAuxiliaryPage,
    anchors,
    semanticCatalog:
      anchors == null
        ? null
        : buildSemanticAnchorChangeBlockCatalog(input.reviewDiff, input.floor.coverage),
    deterministicPages: deterministicReader?.pages ?? [],
  });
  let anchorsUnavailable = false;
  let projectedContext;
  try {
    projectedContext = projectStoryContext(contextInput(input.semanticAnchors ?? null));
  } catch (error) {
    // Stale-only degradation: an anchor generation whose targets no longer
    // resolve against the current diff drops as a WHOLE, reported unavailable —
    // its evidence is never reinterpreted. The current Story keeps the throw.
    if (!stale || input.semanticAnchors == null) throw error;
    anchorsUnavailable = true;
    projectedContext = projectStoryContext(contextInput(null));
  }
  const pages = projectedContext.pages;
  const auxiliaryPage = projectedContext.auxiliaryPage;

  return {
    lens: 'story',
    story: input.model,
    ...(stale
      ? {
          staleProjection: true,
          staleHealth: {
            survivingMappings: survivingMappingTotal,
            totalMappings: survivingMappingTotal + droppedMappingTotal,
            anchorsUnavailable,
          },
        }
      : {}),
    pages,
    routeIndex: buildReaderRouteIndex({
      lens: 'story',
      pages,
      auxiliaryPage,
      story: input.model,
      attentionItems: projectedContext.attentionItems,
      capturedContextItems: projectedContext.capturedContextItems,
      semanticPlacements: projectedContext.semanticPlacements,
    }),
    coverage: coverageView(pages, input.ledger, input.currentThreads),
    finish,
    unassigned,
    auxiliaryPage,
  };
}

/**
 * ONE coverage preparer for BOTH lenses.
 *
 * This is what makes "toggling the lens preserves coverage" true by construction
 * rather than by test: a Part and a Checkpoint disagree about almost everything,
 * but they agree on which content-addressed ROWS they own, and rows are all the
 * ledger has ever stored. Two preparers would be two chances to disagree.
 */
export async function preparePageCoverage(input: {
  page: ReaderPage;
  floorInputHash: string;
  ledger: ReviewLedgerV2;
  currentThreads: readonly CurrentThreadManifest[];
  now?: string;
}): Promise<PrepareCoverageResult> {
  // A zero-row deterministic checkpoint has nothing to append. Its uncertainty
  // and comment obligations still affect page completion and Finish. A
  // context-only Story Part follows the same content rule: no changed rows
  // means no coverage event, regardless of its remaining non-row obligations.
  if (input.page.hasNoRows) {
    return { status: 'no_rows', event: null };
  }
  if (input.page.kind === 'checkpoint' && !input.page.markReviewedEnabled) {
    return {
      status: 'invalid',
      event: null,
      message: `mark-reviewed blocked: ${input.page.blockers.join(', ')} remain open`,
    };
  }
  if (!input.page.markReviewedEnabled) {
    return {
      status: 'invalid',
      event: null,
      message: `${input.page.kind} ${input.page.key} has open completion gates`,
    };
  }

  return prepareReviewCoverageEvent({
    floorInputHash: input.floorInputHash,
    ledgerGeneration: input.ledger.ledgerGeneration,
    priorCoverage: input.ledger.coverage,
    currentThreads: input.currentThreads,
    partRowsByThread: input.page.ownedRows,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

/**
 * The page a hunk belongs to — for ENTRY ONLY.
 *
 * Activation from Brief or Flat Files, and comment routing, all arrive holding a
 * hunkKey and no page. This resolves one, so the shell can put the reader
 * somewhere coherent. It is deliberately NOT how the pager works: a hunk owned by
 * two checkpoints has two answers and this returns the first, which is fine for
 * "put me near this code" and wrong for "move me to the next checkpoint". The
 * pager owns `readerPage` and derives the cursor; only entry goes the other way.
 */
export function pageIndexForHunk(reader: ReaderModel, hunkKey: string): number | null {
  return reader.routeIndex.pageIndexesByHunkKey.get(hunkKey)?.[0] ?? null;
}

/**
 * A page containing a non-durable slice cursor within one loaded reader.
 *
 * A deterministic floor slice can belong to multiple checkpoint pages. Entry
 * routing deliberately chooses the first, just like `pageIndexForHunk`; an
 * already-open page is retained by its durable page key instead.
 */
export function pageIndexForSlice(reader: ReaderModel, sliceKey: string): number | null {
  return reader.routeIndex.pageIndexesBySliceKey.get(sliceKey)?.[0] ?? null;
}

/** Ordered slice stops for the current page — the canonical diff cursor domain. */
export function sliceStopsOfPage(
  reader: ReaderModel | null,
  pageIndex: number
): readonly ReaderSliceStop[] {
  return reader?.pages[pageIndex]?.sliceStops ?? [];
}
