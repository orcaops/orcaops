import { CITATION_KIND, type FinishBlocker, type Floor } from '@orcaops/review-core';

import { capturedTrailForCheckpoint } from './capturedTrail';
import type { ReaderModel } from './readerModel';

export type FinishObligationRoute =
  | { kind: 'reader-page'; pageIndex: number; contextItemIndex?: number }
  | { kind: 'unassigned' }
  | { kind: 'comments' }
  | { kind: 'recovery'; message: string };

/** The gate blocker an obligation was projected from. */
export type FinishBlockerKind = FinishBlocker['kind'];

export interface FinishObligation {
  /**
   * DURABLE identity — derived from the domain thing the obligation is about,
   * never from its position in the list.
   *
   * A positional key looks stable until an earlier blocker clears: every later
   * key shifts, a DIFFERENT obligation answers to the key a surface recorded,
   * and restoring by key silently lands on the wrong row while believing it
   * matched. Threads and citations already have durable ids, and the remaining
   * blockers are singletons per review, so every obligation can name itself.
   */
  key: string;
  /**
   * Retained so surfaces can mark an obligation by what it IS rather than by
   * parsing its key. The Brief's attention queue reads it for the row glyph.
   */
  kind: FinishBlockerKind;
  label: string;
  detail: string;
  route: FinishObligationRoute;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() || 'Captured question';
}

function pageForThread(reader: ReaderModel, threadKey: string): number | null {
  const candidates = reader.pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.kind === 'checkpoint' && page.threadKey === threadKey);
  return candidates.find(({ page }) => !page.complete)?.index ?? candidates[0]?.index ?? null;
}

function threadTitle(floor: Floor, threadKey: string): string {
  return (
    floor.outline.threads.find((thread) => thread.threadKey === threadKey)?.title ?? 'Review work'
  );
}

function uncertaintyObligation(input: {
  floor: Floor;
  reader: ReaderModel;
  citationId: string;
}): FinishObligation {
  const pageIndex = input.reader.pages.findIndex(
    (page) =>
      page.kind === 'checkpoint' &&
      input.floor.outline.threads.some((thread) =>
        thread.checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointKey === page.key &&
            checkpoint.citationIds.includes(input.citationId)
        )
      )
  );
  const page = pageIndex < 0 ? undefined : input.reader.pages[pageIndex];
  const citation = input.floor.citations.find((candidate) => candidate.id === input.citationId);
  if (page?.kind !== 'checkpoint') {
    return {
      key: `uncertainty:${input.citationId}`,
      kind: 'uncertainties',
      label: `Answer · ${firstLine(citation?.text ?? '')}`,
      detail: 'Captured question ownership is unavailable.',
      route: {
        kind: 'recovery',
        message: 'Refresh the review floor to recover this captured question’s checkpoint.',
      },
    };
  }
  const questions = capturedTrailForCheckpoint(input.floor, page.member).records.filter(
    (record) => record.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY
  );
  const contextItemIndex = Math.max(
    0,
    questions.findIndex((question) => question.id === input.citationId)
  );
  return {
    key: `uncertainty:${input.citationId}`,
    kind: 'uncertainties',
    label: `Answer · ${firstLine(citation?.text ?? '')}`,
    detail: `${page.label} · captured question`,
    route: { kind: 'reader-page', pageIndex, contextItemIndex },
  };
}

function projectBlocker(
  floor: Floor,
  reader: ReaderModel,
  blocker: FinishBlocker
): FinishObligation[] {
  switch (blocker.kind) {
    case 'targets':
      return [
        {
          key: 'targets',
          kind: 'targets',
          label: 'Refresh review obligations',
          detail: 'Current review targets could not be derived.',
          route: {
            kind: 'recovery',
            message: 'Refresh the review; if this persists, rebuild the review targets.',
          },
        },
      ];
    case 'checking':
      return [
        {
          key: `checking:${blocker.threadKey}`,
          kind: 'checking',
          label: `Refresh · ${threadTitle(floor, blocker.threadKey)}`,
          detail: 'Current changed rows are still being derived.',
          route: { kind: 'recovery', message: 'Refresh once current changed rows are available.' },
        },
      ];
    case 'rows': {
      const pageIndex = pageForThread(reader, blocker.threadKey);
      return [
        {
          key: `rows:${blocker.threadKey}`,
          kind: 'rows',
          label: `Read · ${threadTitle(floor, blocker.threadKey)}`,
          detail: `${blocker.newRows} changed row(s) remain`,
          route:
            pageIndex === null
              ? {
                  kind: 'recovery',
                  message: 'Refresh the review floor to recover this thread’s checkpoint pages.',
                }
              : { kind: 'reader-page', pageIndex },
        },
      ];
    }
    case 'gap_rows':
      return [
        {
          key: 'gap',
          kind: 'gap_rows',
          label: 'Inspect · Unassigned changes',
          detail: `${blocker.newRows} unexplained row(s) remain`,
          route: { kind: 'unassigned' },
        },
      ];
    case 'ambiguous_hunks':
      return [
        {
          key: 'ambiguous',
          kind: 'ambiguous_hunks',
          label: 'Inspect · Ambiguous ownership',
          detail: `${blocker.hunkKeys.length} hunk(s) remain`,
          route: { kind: 'unassigned' },
        },
      ];
    case 'comments':
      return [
        {
          key: 'comments',
          kind: 'comments',
          label: 'Resolve reviewer comments',
          detail: `${blocker.open} open comment(s) remain`,
          route: { kind: 'comments' },
        },
      ];
    case 'uncertainties':
      return blocker.citationIds.map((citationId) =>
        uncertaintyObligation({ floor, reader, citationId })
      );
    case 'story_items': {
      const pageIndex = reader.pages.findIndex((page) => !page.complete);
      return [
        {
          key: 'story',
          kind: 'story_items',
          label: 'Resolve Story review items',
          detail: `${blocker.open} item(s) remain`,
          route:
            pageIndex < 0
              ? { kind: 'recovery', message: 'Return to the Brief and refresh the composed Story.' }
              : { kind: 'reader-page', pageIndex },
        },
      ];
    }
  }
}

/** Watch-owned human/action projection; core retains durable IDs and gate semantics. */
export function buildFinishObligations(input: {
  floor: Floor;
  reader: ReaderModel;
}): FinishObligation[] {
  return input.reader.finish.blockers.flatMap((blocker) =>
    projectBlocker(input.floor, input.reader, blocker)
  );
}
