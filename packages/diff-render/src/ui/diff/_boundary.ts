// Boundary severance shim — OUR code (not vendored; no MIT header).
//
// The vendored renderRows.tsx imports three symbols from source modules we do
// NOT vendor:
//   • PlannedReviewRow      (the review-plan row union, from reviewRenderPlan)
//   • CopySelectedRowRange  (a copy-selection column range, from copySelection)
//   • inlineNoteTitle       (the inline agent-note title, from AgentInlineNote)
// This shim provides the minimal, faithful surface renderRows.tsx actually
// reads (it dereferences only `annotation`, `noteIndex`, `noteCount` on an
// inline-note planned row), so the render layer compiles in isolation.
//
// This boundary is PERMANENT, not transitional. Pins ship through DiffSlice's
// slot seams (`beforeHunk` / `afterLine`) instead of vendoring the upstream
// review-render-plan splice loop — three fewer vendored files, and pins stay in
// app code where the review vocabulary lives. The inline-note planned-row path
// below is therefore never exercised by this package; it exists only to keep
// the vendored file byte-stable.

import type { DiffRow } from './pierre';
import type { AgentAnnotation } from '../../core/types';

/** Global inclusive column range of a text selection on one rendered row. */
export interface CopySelectedRowRange {
  startCol: number;
  endCol: number;
}

/** Minimal stand-in for the review-plan's VisibleAgentNote — renderRows reads only identity + annotation. */
export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
}

/** One row of the review render plan: a diff row, or an inline agent note pinned beneath a line. */
export type PlannedReviewRow =
  | {
      kind: 'diff-row';
      key: string;
      stableKey: string;
      stableAliasKeys?: string[];
      fileId: string;
      hunkIndex: number;
      row: DiffRow;
      anchorId?: string;
      noteGuideSide?: 'old' | 'new';
    }
  | {
      kind: 'inline-note';
      key: string;
      stableKey: string;
      fileId: string;
      hunkIndex: number;
      annotationId: string;
      annotation: AgentAnnotation;
      note: VisibleAgentNote;
      anchorSide?: 'old' | 'new';
      noteCount: number;
      noteIndex: number;
    };

/** Faithful minimal title for an inline agent note (the inline-note path exists only so the vendored render layer compiles). */
export function inlineNoteTitle(
  annotation: AgentAnnotation,
  noteIndex: number,
  noteCount: number
): string {
  const author = annotation.author?.trim();
  const label =
    annotation.source === 'user' ? 'Your note' : author ? `${author} note` : 'Agent note';
  return noteCount > 1 ? `${label} ${noteIndex + 1}/${noteCount}` : label;
}
