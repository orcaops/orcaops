// The Brief's left-pane queue: what is unresolved, in priority order.
//
// Both lenses owe the reviewer the same thing — "here is the next thing that
// needs you" — but they know it through different machinery. The Story reader
// already projects open review work into `routeIndex.attentionItems`. The
// deterministic floor has no narrative to rank, but it has the finish gate, and
// `buildFinishObligations` already projects every durable blocker into human
// text plus a route. So the deterministic lens reads its queue off the
// obligations, which is what gives `n`/`N` something to select there.
//
// One row shape for both. Rendering, `attentionCursor` clamping, `↵`, pointer
// activation and `n`/`N` all consume this one array, so the row the reviewer
// sees highlighted and the row a gesture opens cannot diverge.

import type { FinishBlockerKind, FinishObligation } from './finishPresentation';
import type { ReaderModel, ReaderRailItem } from './readerModel';

export type BriefAttentionDestination =
  | { kind: 'story-item'; itemId: string }
  | { kind: 'obligation'; obligation: FinishObligation };

/**
 * The severity/source tone one attention row carries.
 *
 * Both the glyph and its colour flow from this single value (see `TONE_GLYPH`),
 * so a critical row and a generic one cannot drift into the same colour.
 */
export type BriefAttentionTone =
  | 'critical'
  | 'warn'
  | 'prompt'
  | 'comment'
  | 'decision'
  | 'uncertainty'
  | 'inspect'
  | 'structural';

export interface BriefAttentionRow {
  /** Durable identity, namespaced by variant. Survives a rebuild; drives restoration. */
  key: string;
  label: string;
  detail?: string;
  glyph: string;
  /** Drives the glyph's colour in the renderer; parallel to `glyph`. */
  tone: BriefAttentionTone;
  destination: BriefAttentionDestination;
}

/** One glyph per tone — the Brief and the Walk rail both mark items through here. */
const TONE_GLYPH: Readonly<Record<BriefAttentionTone, string>> = {
  critical: '‼',
  warn: '!',
  prompt: '?',
  comment: '✎',
  decision: '◆',
  uncertainty: '⚑',
  inspect: '◇',
  structural: '○',
};

/**
 * The tone of one Story rail item, from what the item IS.
 *
 * The v4 reader keeps severity on the canonical finding, not the rail row, so
 * the queue triages by kind and by whether the recorder marked the item
 * required — a required finding is a stop sign, an advisory one a caution.
 */
export function railItemTone(item: ReaderRailItem): BriefAttentionTone {
  switch (item.kind) {
    case 'finding':
      return item.required ? 'critical' : 'warn';
    case 'question':
      return 'prompt';
    case 'uncertainty':
      return 'uncertainty';
    case 'citation':
      return 'decision';
    case 'ledger':
      return 'structural';
  }
}

/** The same vocabulary, keyed by the gate blocker an obligation came from. */
const OBLIGATION_TONE: Readonly<Record<FinishBlockerKind, BriefAttentionTone>> = {
  targets: 'critical',
  checking: 'critical',
  rows: 'warn',
  gap_rows: 'inspect',
  ambiguous_hunks: 'inspect',
  comments: 'comment',
  uncertainties: 'uncertainty',
  story_items: 'decision',
};

/**
 * The queue for whichever lens is active.
 *
 * The lens comes off the reader itself — the same discriminator the reader
 * build already committed to — so the caller cannot pass one that disagrees
 * with the data.
 */
export function buildBriefAttention(input: {
  reader: ReaderModel;
  obligations: readonly FinishObligation[];
}): readonly BriefAttentionRow[] {
  if (input.reader.lens === 'deterministic') {
    return input.obligations.map((obligation) => {
      const tone = OBLIGATION_TONE[obligation.kind];
      return {
        key: `obligation:${obligation.key}`,
        label: obligation.label,
        detail: obligation.detail,
        glyph: TONE_GLYPH[tone],
        tone,
        destination: { kind: 'obligation', obligation },
      };
    });
  }
  return input.reader.routeIndex.attentionItems.map((item) => {
    const tone = railItemTone(item);
    return {
      key: `item:${item.id}`,
      label: item.shortText,
      detail: `${item.source} · ${item.required ? 'required' : 'advisory'}`,
      glyph: TONE_GLYPH[tone],
      tone,
      destination: { kind: 'story-item', itemId: item.id },
    };
  });
}

/**
 * The row a `n`/`N` gesture should SELECT (two-step: `↵` opens the selection).
 *
 * A null `key` means traversal has not started: `n` selects the first row and
 * `N` the last, rather than skipping past row 0 the way the Walk rail's
 * advance-before-route does.
 */
export function nextAttentionRow(
  rows: readonly BriefAttentionRow[],
  key: string | null,
  direction: 1 | -1
): { row: BriefAttentionRow; index: number } | null {
  if (rows.length === 0) return null;
  const current = key === null ? -1 : rows.findIndex((row) => row.key === key);
  if (current < 0) {
    const index = direction === 1 ? 0 : rows.length - 1;
    return { row: rows[index]!, index };
  }
  const index = (current + direction + rows.length) % rows.length;
  return { row: rows[index]!, index };
}

/** What `n`, `N` and `↵` respectively ask of the attention queue. */
export type BriefAttentionIntent = 'selected' | 'next' | 'previous';

/**
 * Resolve an intent against the CURRENT rows.
 *
 * Intent rather than a row index, because the two gesture dispatchers never see
 * the attention rows — neither could resolve a key, wrap it and produce an index
 * — and because an index minted at dispatch time can be stale by the time it is
 * applied. The executor holds the rows, so it resolves here.
 */
export function resolveBriefAttentionIntent(
  rows: readonly BriefAttentionRow[],
  key: string | null,
  cursor: number,
  intent: BriefAttentionIntent
): { row: BriefAttentionRow; index: number } | null {
  if (rows.length === 0) return null;
  if (intent !== 'selected') return nextAttentionRow(rows, key, intent === 'next' ? 1 : -1);
  const byKey = key === null ? -1 : rows.findIndex((row) => row.key === key);
  const index = byKey >= 0 ? byKey : Math.max(0, Math.min(cursor, rows.length - 1));
  return { row: rows[index]!, index };
}
