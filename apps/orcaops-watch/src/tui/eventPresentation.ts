// CANONICAL EVENT-PRESENTATION MAPPING. Live Events, the detail model, and the
// Detail pane all derive labels and color families from this record. It is
// exhaustive over EventTypeSchema at compile time, so a new event type fails
// the build here until its presentation is defined.

import type { EventType } from '@orcaops/storage';

/**
 * Color lane for an event type. The three semantic families carry a
 * canonical theme token (EVENT_FAMILY_THEME); 'other' deliberately defers
 * to each surface's own dim hierarchy.
 */
export type EventFamily = 'checkpoint' | 'plan' | 'summary' | 'other';

export interface EventPresentation {
  /** Past-tense human copy (e.g. `summarised`, `evaluator run recorded`). */
  label: string;
  family: EventFamily;
}

export const EVENT_PRESENTATION = {
  plan_captured: { label: 'plan captured', family: 'plan' },
  plan_revised: { label: 'plan revised', family: 'plan' },
  checkpoint_opened: { label: 'checkpoint opened', family: 'checkpoint' },
  checkpoint_closed: { label: 'checkpoint closed', family: 'checkpoint' },
  checkpoint_abandoned: { label: 'checkpoint abandoned', family: 'checkpoint' },
  evaluator_run_recorded: { label: 'evaluator run recorded', family: 'other' },
  evaluator_disposition_recorded: { label: 'evaluator disposition recorded', family: 'other' },
  pre_pr_checked: { label: 'pre-pr checked', family: 'summary' },
  block_acknowledged: { label: 'block acknowledged', family: 'other' },
  block_dismissed: { label: 'block dismissed', family: 'other' },
  summary_captured: { label: 'summarised', family: 'summary' },
  branch_lineage_updated: { label: 'branch lineage updated', family: 'other' },
  pin_displaced: { label: 'pin displaced', family: 'other' },
} as const satisfies Record<EventType, EventPresentation>;

/**
 * Canonical theme token per semantic family. Summary and pre-PR events use
 * CYAN, distinct from the checkpoint and plan families.
 */
export const EVENT_FAMILY_THEME = {
  checkpoint: 'LIVE',
  plan: 'ACCENT',
  summary: 'CYAN',
} as const satisfies Record<Exclude<EventFamily, 'other'>, 'LIVE' | 'ACCENT' | 'CYAN'>;

function presentationFor(type: string): EventPresentation | undefined {
  return (EVENT_PRESENTATION as Record<string, EventPresentation>)[type];
}

/**
 * Human copy for an event type. Every in-repo producer goes through
 * appendEvent, whose input is compile-time typed to EventType, and the
 * validated read path (readEventLog) enforces the strict record schema —
 * but the ticker's tail reader is deliberately permissive, so a torn,
 * hand-edited, or foreign log line can surface any string here. The
 * fallback is that guard: it degrades to underscores-to-spaces.
 */
export function eventLabel(type: string): string {
  return presentationFor(type)?.label ?? type.replace(/_/g, ' ');
}

/** Color family for an event type; unknown strings fall to 'other'. */
export function eventFamily(type: string): EventFamily {
  return presentationFor(type)?.family ?? 'other';
}
