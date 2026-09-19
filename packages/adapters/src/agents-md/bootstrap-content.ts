import type { HintKey } from '@orcaops/storage';

import { DEFAULT_PREFIX, skillRef } from '../refs.js';
import { SKILL_TEMPLATES } from '../skills/index.js';
import type { SkillId, SkillTemplate } from '../types.js';
import { CURATED_HINTS, type HintsInput, resolveHintLines } from './hints-catalog.js';

export interface BootstrapRoutingEntry {
  id: SkillId;
  /** The installed skill name under the active prefix, e.g. `orcaops-why`. */
  ref: string;
  /**
   * Every quoted user phrasing in `line`, comma-joined WITH its quotes and
   * collapsed to one line: `"why does X exist?", "where did this come from?"`.
   * The hook renders `- ${lead} → ${action}` and must not re-quote it.
   *
   * All of the phrases, not one per skill: a single phrase would make the hook
   * as thin a retrieval surface as skill descriptions are, which is the bug
   * this model exists to fix.
   */
  lead: string;
  /**
   * Everything after the arrow, whitespace-collapsed and unbackticked: the ref
   * alone for most entries, the ref plus its descriptive clause for the rest,
   * and the whole instruction where the wording is not "invoke this" (the
   * author-evaluator entry asks the agent to RECOMMEND the human run it).
   *
   * The hook renders `- ${lead} → ${action}`. Rendering the bare ref there
   * inverted exactly that entry, and dropped the condition from the two that
   * carry one.
   */
  action: string;
  /** The full block entry — `lead`, the arrow and ref, then any descriptive clause. */
  line: string;
}

export interface BootstrapLifecycleStep {
  phase: 'status' | 'plan' | 'checkpoint' | 'finish';
  ref?: string;
  /** Block register: pre-wrapped, continuation lines indented for a numbered list. */
  long: string;
  /** Hook register: one unwrapped sentence; the formatter owns line breaks. */
  short: string;
}

/**
 * The resolved bootstrap content model: every row both bootstrap surfaces
 * render, resolved once from one config input.
 *
 * The managed `## Orcaops` block and the SessionStart hook payload are
 * formatters over this model in two REGISTERS — the block renders `long`
 * (wrapped for a numbered markdown list), the hook renders `short` (one
 * unwrapped sentence per row). Independent prose in each formatter is how the
 * two surfaces diverged: the block carried read-intent routing and workflow
 * hints while the hook carried only the lifecycle, so a repo whose only
 * surface is the hook got no phrasing-to-skill routing at all.
 *
 * Nothing here may vary with cloud state: the block is committed, so a
 * cloud-gated ref would fork the file between a logged-in author and a
 * teammate without credentials.
 */
export interface BootstrapContent {
  prefix: string;
  /** Product framing prose. The `## Orcaops` heading belongs to the block formatter. */
  framing: string;
  lifecycle: BootstrapLifecycleStep[];
  routing: BootstrapRoutingEntry[];
  /** Appended to the routing section when `resume` is enabled; null otherwise. */
  surveyTail: string | null;
  attribution: string;
  skip: { long: string; short: string };
  /** Where the installed SKILL.md bodies live; null when no skill is enabled. */
  bodiesLocation: string | null;
  hints: string[];
}

export interface BootstrapContentInput {
  prefix: string;
  /**
   * Omitted ⇒ the DEFAULT-ON ungated subset, never the full registry: without a
   * resolved set the caller has verified neither opt-in choices nor
   * capabilities, so opt-in and `requires` templates must not leak refs.
   */
  enabledSkills: ReadonlyArray<SkillTemplate<string>> | undefined;
  hints: HintsInput | undefined;
  commitInsideWindow: boolean;
  suppressedRouting: ReadonlyArray<SkillId>;
}

/**
 * Emitted by the block formatter whenever routing is non-empty, and tested for
 * by the hook to decide whether a managed block is ACTUALLY carrying routing.
 * A marker alone does not answer that: blocks generated while the read-intent
 * section was trimmed carry a marker and no routing, and suppressing hook
 * routing for those repos is the exact failure this model fixes.
 */
export const ORCAOPS_BLOCK_ROUTING_SENTINEL = '**Read intents → skills.**';

/**
 * Hint keys the lifecycle prose already states, dropped from the rendered
 * preferences so no surface says the same thing twice. See the note beside
 * `CURATED_HINTS` for why the de-duplication lives here and not in
 * `resolveHintLines`.
 */
const HINT_KEYS_STATED_BY_PHASE: ReadonlyArray<{
  key: HintKey;
  phase: 'plan' | 'checkpoint';
  reason: string;
}> = [
  {
    key: 'capture-on-nontrivial',
    phase: 'plan',
    reason: 'the plan lifecycle step already tells the agent to capture a plan first',
  },
  {
    key: 'open-checkpoint-before-edits',
    phase: 'checkpoint',
    reason: 'the checkpoint lifecycle step already tells the agent to open before edits',
  },
];

/**
 * A legacy alias for `commit_inside_window`; the lifecycle step is its only
 * rendering, so this key renders nothing on either surface under any
 * configuration.
 */
export const ALWAYS_DROPPED_HINT_KEY: HintKey = 'commit-on-checkpoint-close';

export interface HintRenderabilityInput {
  enabledSkills: ReadonlyArray<SkillTemplate<string>> | undefined;
  commitInsideWindow: boolean;
}

function resolveEnabledSet(
  enabledSkills: ReadonlyArray<SkillTemplate<string>> | undefined
): ReadonlyArray<SkillTemplate<string>> {
  return (
    enabledSkills ??
    SKILL_TEMPLATES.filter((s) => s.defaultEnabled !== false && (s.requires ?? []).length === 0)
  );
}

function droppedHintReasons(
  phases: ReadonlySet<BootstrapLifecycleStep['phase']>,
  commitInsideWindow: boolean
): Map<HintKey, string> {
  const dropped = new Map<HintKey, string>([
    [
      ALWAYS_DROPPED_HINT_KEY,
      commitInsideWindow
        ? 'the checkpoint lifecycle step is the only rendering of the commit guidance'
        : 'workflow.commit_inside_window is off, so no surface carries commit guidance',
    ],
  ]);
  for (const { key, phase, reason } of HINT_KEYS_STATED_BY_PHASE) {
    if (phases.has(phase)) dropped.set(key, reason);
  }
  return dropped;
}

/**
 * Curated keys that render on NEITHER surface here, mapped to the reason. Runs
 * the real `resolveLifecycle`; restating that rule would leave two copies.
 */
export function nonRenderingHintKeys(input: HintRenderabilityInput): ReadonlyMap<HintKey, string> {
  const enabled = resolveEnabledSet(input.enabledSkills);
  const lifecycle = resolveLifecycle(
    (verb: SkillId) => skillRef(verb, DEFAULT_PREFIX),
    (id: string) => enabled.some((s) => s.id === id),
    input.commitInsideWindow
  );
  return droppedHintReasons(new Set(lifecycle.map((s) => s.phase)), input.commitInsideWindow);
}

export function renderableHintKeys(input: HintRenderabilityInput): HintKey[] {
  const dropped = nonRenderingHintKeys(input);
  return CURATED_HINTS.filter((h) => !dropped.has(h.key)).map((h) => h.key);
}

const QUOTED_PHRASE_RE = /"[^"]+"/g;

/**
 * Resolve every content row both bootstrap surfaces render.
 *
 * Pure: no disk reads, no cloud access, no clock. The hook calls this on every
 * session start under a 10s timeout.
 */
export function resolveBootstrapContent(input: BootstrapContentInput): BootstrapContent {
  const prefix = input.prefix || DEFAULT_PREFIX;
  const skill = (verb: SkillId): string => skillRef(verb, prefix);
  const enabled = resolveEnabledSet(input.enabledSkills);
  const on = (id: string): boolean => enabled.some((s) => s.id === id);

  const lifecycle = resolveLifecycle(skill, on, input.commitInsideWindow);
  const phases = new Set(lifecycle.map((s) => s.phase));

  const droppedHintKeys = droppedHintReasons(phases, input.commitInsideWindow);
  const hints = resolveHintLines(
    input.hints === undefined
      ? undefined
      : { ...input.hints, keys: input.hints.keys.filter((k) => !droppedHintKeys.has(k)) }
  );

  const suppressed = new Set<string>(input.suppressedRouting);
  const routing = resolveRouting(prefix, enabled, on).filter((e) => !suppressed.has(e.id));

  return {
    prefix,
    framing: `This repo uses **orcaops** to capture and evaluate AI coding sessions.
The \`${prefix}-*\` skills own the CLI surface, flags, and evaluator
semantics — invoke them on the cues below rather than driving the CLI
by hand.`,
    lifecycle,
    routing,
    surveyTail: routing.some((e) => e.id === 'resume')
      ? `For broader survey questions ("what's
the state of this branch?"), run \`orcaops status --json\` directly, not
\`${skill('resume')}\`.`
      : null,
    attribution: `Pass \`--invoked-by-agent <your-agent-id>\` on every
artifact-writing capture command with YOUR OWN agent id, so each event
records which agent produced it (multi-agent repos share one artifact
thread). Omitted, orcaops falls back to \`ORCAOPS_INVOKED_BY_AGENT\`, then
environment detection, then \`other\`.`,
    skip: {
      long: `typo fixes, cosmetic single-line edits,
formatting-only changes, trivial doc tweaks. Resume an existing artifact
instead of starting a new one when continuing prior work.`,
      short: `Skip capture for trivial changes (typos, formatting-only, one-line docs).`,
    },
    bodiesLocation:
      enabled.length > 0
        ? `Full skill bodies live under \`.claude/skills/${prefix}-*\` (Claude Code),
\`.agents/skills/${prefix}-*\` (Codex / Cursor / OpenCode / GitHub Copilot), or
\`.aider-desk/skills/${prefix}-*\` (AiderDesk).`
        : null,
    hints,
  };
}

function resolveLifecycle(
  skill: (verb: SkillId) => string,
  on: (id: string) => boolean,
  commitInsideWindow: boolean
): BootstrapLifecycleStep[] {
  const steps: BootstrapLifecycleStep[] = [
    {
      phase: 'status',
      long: `Run \`orcaops status --json\` to check whether an in-flight artifact
   already exists for the current branch.`,
      short: `Run \`orcaops status --json\` to see any in-flight capture thread on this branch.`,
    },
  ];

  if (on('capture')) {
    steps.push({
      phase: 'plan',
      ref: skill('capture'),
      long: `If none exists — or the existing artifact is unrelated to the task
   you were just asked about — invoke **\`${skill('capture')}\`** to plan.`,
      short: `Capture starts at PLAN APPROVAL, not at conversation start: brainstorm, answer questions, and draft the plan freely — nothing to capture yet. Once the plan is settled and approved, record it via the \`${skill('capture')}\` skill BEFORE writing code (the captured plan is the anchor later checks grade against).`,
    });
  }

  if (on('checkpoint')) {
    // The commit clause sits mid-parenthetical in `short` rather than at the
    // end so the default-on rendering reproduces the guidance the hook
    // hardcoded before it became config; `commit_inside_window` defaults true
    // precisely to preserve that behaviour.
    const shortClauses = [
      'open before edits',
      ...(commitInsideWindow ? ['run tests and commit inside the window'] : []),
      'close with what finished',
    ];
    steps.push({
      phase: 'checkpoint',
      ref: skill('checkpoint'),
      long:
        `For each chunk of work, invoke **\`${skill('checkpoint')}\`**: **open the
   checkpoint before you change the worktree**, then close it after with
   what actually finished. Orcaops attributes your changes by diffing the
   worktree between open and close; opening first is the only reliable way to
   get clean per-line attribution, since work done before open is outside that
   window. The skill owns command
   syntax, evaluator handling, cadence, and subagent coordination.` +
        (commitInsideWindow
          ? ` Run formatters and tests and commit
   (including hook rewrites) inside the window, before the close.`
          : ''),
      short: `Wrap each unit of work with the \`${skill('checkpoint')}\` skill (${shortClauses.join('; ')}).`,
    });
  }

  const finishers = (['pre-pr', 'summary', 'digest'] as const).filter(on).map(skill);
  steps.push({
    phase: 'finish',
    ref: skill('finish'),
    long: `Before ending the session, invoke **\`${skill('finish')}\`** to run the
   final checks, capture the summary, synchronize, and materialize the reviewer-facing digest.${
     finishers.length > 0
       ? `\n   The granular ${finishers.map((f) => `**\`${f}\`**`).join(', ')} skills remain
   available for manual inspection and recovery.`
       : ''
   }`,
    short: `Before ending a session that captured work, close the thread: ${skill('finish')}.`,
  });

  return steps;
}

function resolveRouting(
  prefix: string,
  enabled: ReadonlyArray<SkillTemplate<string>>,
  on: (id: string) => boolean
): BootstrapRoutingEntry[] {
  const skill = (verb: SkillId): string => skillRef(verb, prefix);
  const entries: BootstrapRoutingEntry[] = [];
  const push = (id: SkillId, line: string): void => {
    entries.push({
      id,
      ref: skill(id),
      lead: leadOf(line),
      action: actionOf(line, skill(id)),
      line,
    });
  };

  // The built-in read intents. Phrasing FIRST: the quoted cues are what the
  // agent matches the user against, so they must not trail a category label.
  if (on('resume')) {
    push(
      'resume',
      `"where was I?", "pick up where we left off", "continue artifact <id> here" → \`${skill('resume')}\``
    );
  }
  if (on('digest')) {
    push(
      'digest',
      `"show me the digest", "what changed?", "draft the PR description" → \`${skill('digest')}\``
    );
  }
  if (on('why')) {
    // The regression lens rides `why`'s entry.
    push(
      'why',
      `"why does X exist?", "where did this come from?", "what was the agent worried about when it wrote this?" → \`${skill('why')}\``
    );
  }
  if (on('search')) {
    push(
      'search',
      `"have we worked on X before?", "what did we decide last time?", "find earlier work about X" → \`${skill('search')}\``
    );
  }
  if (on('doctor')) {
    push(
      'doctor',
      `"is orcaops set up correctly?", "what's broken?", "diagnose orcaops" → \`${skill('doctor')}\``
    );
  }

  for (const t of enabled) {
    if (t.blockTriggerLine === undefined) continue;
    // Registry ids are parity-guarded against SKILL_IDS.
    push(
      t.id as SkillId,
      typeof t.blockTriggerLine === 'function' ? t.blockTriggerLine(prefix) : t.blockTriggerLine
    );
  }

  return entries;
}

/**
 * Whitespace is collapsed because block entries wrap across lines while the
 * hook renders one bullet per entry. Only the cues BEFORE the arrow count: a
 * clause like `but not when the user says "never mind"` states when NOT to
 * route, and hoisting it into the lead would make it a trigger. An entry with
 * no quoted phrase falls back to the text before the arrow — an empty lead
 * would drop the skill from the hook's routing surface without failing
 * anything.
 */
function leadOf(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  const arrow = separatingArrowIndex(flat);
  const cues = (arrow === -1 ? flat : flat.slice(0, arrow)).trim();
  const phrases = cues.match(QUOTED_PHRASE_RE);
  if (phrases !== null && phrases.length > 0) return phrases.join(', ');
  return cues.length > 0 ? cues : flat;
}

/**
 * Backticks are dropped because the hook payload is plain prose, not markdown.
 * An entry with no arrow falls back to its ref, which is what the hook rendered
 * for every entry before the clause was carried at all.
 */
function actionOf(line: string, ref: string): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  const arrow = separatingArrowIndex(flat);
  if (arrow === -1) return ref;
  const after = flat
    .slice(arrow + 1)
    .replaceAll('`', '')
    .trim();
  return after.length > 0 ? after : ref;
}

/**
 * Where the cues end and the action begins: the first arrow OUTSIDE a quoted
 * phrase. A user phrasing may contain one of its own ("plan → estimate"), and
 * splitting there would strand an unbalanced quote and a second arrow in the
 * hook's bullet. -1 when no arrow separates the two halves.
 */
function separatingArrowIndex(flat: string): number {
  let quoted = false;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '→' && !quoted) return i;
  }
  return -1;
}
