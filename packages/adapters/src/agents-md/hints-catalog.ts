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
 */
export interface CuratedHint {
  key: HintKey;
  /** Vetted one-line prose rendered into the managed block's Workflow Preferences. */
  prose: string;
}

export const CURATED_HINTS: readonly CuratedHint[] = [
  // ONE LINE: template.ts renders each hint as a single `- ${h}` bullet, so a
  // newline here would silently break the list. The ORDERING is the point —
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
 * Resolve declared hints to the lines rendered inside the managed block. Curated
 * entries render in CANONICAL catalog order (selection is order-independent);
 * freeform `custom` lines follow, verbatim, in their declared order. Blank custom
 * lines are dropped. Returns `[]` when nothing is declared (caller omits the
 * sub-section entirely).
 */
export function resolveHintLines(hints: HintsInput | undefined): string[] {
  if (!hints) return [];
  const selected = new Set(hints.keys);
  const curated = CURATED_HINTS.filter((h) => selected.has(h.key)).map((h) => h.prose);
  const custom = hints.custom.map((c) => c.trim()).filter((c) => c.length > 0);
  return [...curated, ...custom];
}
