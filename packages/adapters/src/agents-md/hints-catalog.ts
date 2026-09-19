import { type HintKey } from '@orcaops/storage';

/**
 * The curated workflow-hint catalog. The KEY literals + the
 * `workflow.hints.keys` validation live in `@orcaops/storage` (the config domain);
 * this module owns the human-readable PROSE for each key. Keeping the split this
 * way means the config schema never imports adapters (no cycle), and the prose
 * stays next to the renderer that emits it.
 *
 * Order is CANONICAL: `resolveHintLines` iterates this array (filtered by the
 * selected keys), so reordering a config's `hints.keys` never changes the rendered
 * output. Each entry is phrased so it could later be enforced as a
 * checkpoint-close check.
 *
 * Three keys are NOT rendered from here. `resolveBootstrapContent` drops
 * `capture-on-nontrivial` and `open-checkpoint-before-edits` when the lifecycle
 * phase that already states them is rendered, and drops
 * `commit-on-checkpoint-close` unconditionally — it is a legacy alias for
 * `workflow.commit_inside_window`, whose lifecycle step is the guidance's only
 * rendering (pinned with that boolean off it is redundant, and doctor's
 * `workflow-hints` check says so). The de-duplication lives in the
 * resolver, not here, because it depends on the enabled skill set and
 * `resolveHintLines` takes only `HintsInput` — every one of its eight call
 * sites would have to grow an argument it has no use for.
 */
export interface CuratedHint {
  key: HintKey;
  /** Vetted one-line prose rendered into the managed block's Workflow Preferences. */
  prose: string;
}

export const CURATED_HINTS: readonly CuratedHint[] = [
  // ONE LINE: both surfaces render each hint as a single bullet, so a newline
  // here would silently break the list (`resolveHintLines` collapses
  // whitespace in user-supplied lines for the same reason). The ORDERING is the point —
  // "commit at close" alone left the formatter and hook rewrites ambiguous, and
  // work landing after the close falls outside the attribution window.
  {
    key: 'commit-on-checkpoint-close',
    prose:
      'Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.',
  },
  {
    key: 'open-checkpoint-before-edits',
    prose: 'Open the checkpoint before changing the worktree.',
  },
  {
    key: 'capture-on-nontrivial',
    prose: 'Capture a plan for any non-trivial coding task before starting work.',
  },
  {
    key: 'subagent-parallelism',
    prose: 'Dispatch independent subagents concurrently; do not serialize them.',
  },
  { key: 'checkpoint-cadence', prose: 'Use one checkpoint per coherent unit of work.' },
];

export interface HintsInput {
  keys: readonly HintKey[];
  custom: readonly string[];
}

/**
 * Resolve declared hints to the lines rendered on both bootstrap surfaces.
 * Curated entries render in CANONICAL catalog order (selection is
 * order-independent); freeform `custom` lines follow, in their declared order.
 * Blank custom lines are dropped.
 *
 * Whitespace in a custom line is collapsed: both surfaces render one bullet
 * per hint, so an interior newline from the config would break the list.
 * Returns `[]` when nothing is declared (caller omits the sub-section
 * entirely).
 */
export function resolveHintLines(hints: HintsInput | undefined): string[] {
  if (!hints) return [];
  const selected = new Set(hints.keys);
  const curated = CURATED_HINTS.filter((h) => selected.has(h.key)).map((h) => h.prose);
  const custom = hints.custom.map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c.length > 0);
  return [...curated, ...custom];
}
