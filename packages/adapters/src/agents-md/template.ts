import { DEFAULT_PREFIX, skillRef } from '../refs.js';
import { SKILL_TEMPLATES } from '../skills/index.js';
import type { SkillId, SkillTemplate } from '../types.js';

/**
 * The managed `## Orcaops` section that gets injected into AGENTS.md /
 * CLAUDE.md (between markers). One source of truth — same body for every
 * adapter that ships this surface.
 *
 * This file is the **bootstrap** for skill auto-invocation: skills load
 * but don't auto-trigger reliably from a cold session. CLAUDE.md / AGENTS.md
 * IS auto-loaded, so a few lines of "here's when to invoke each skill"
 * here close that gap.
 *
 * Enabled-set-aware: the ENTIRE body is assembled from the enabled
 * skill set — every section is a builder keyed by the skill id(s) it
 * references, so no skill ref is ever emitted unconditionally. Disabling a
 * skill and running `orcaops update` regenerates the block without the dead
 * ref; a newly-enabled skill contributes its trigger line immediately.
 *
 * The marker stamp plus exact managed-region identity make staleness detectable
 * by `orcaops doctor` and let `orcaops update` regenerate cleanly.
 */

export const ORCAOPS_AGENTS_MD_MARKER_START_RE = /<!-- orcaops:start v=([^\s]+) -->/;
export const ORCAOPS_AGENTS_MD_MARKER_END = '<!-- orcaops:end -->';

export interface AgentsMdSectionOptions {
  /** orcaops version stamped into the start marker for staleness detection. */
  generatedBy: string;
  /**
   * Skill naming prefix. Threads into the skill names referenced in the
   * block so they match what `init`/`update` install (`${prefix}-capture`, …). The
   * `orcaops` CLI binary, the product name, and the `orcaops:start/end` markers are
   * NOT prefixed. Default `orcaops` → byte-identical to the pre-prefix output.
   */
  prefix?: string;
  /**
   * Resolved workflow-preference lines, rendered as a
   * `### Workflow Preferences` sub-section INSIDE the managed block. Empty/omitted
   * → no sub-section (byte-identical to the no-hints output).
   */
  hints?: string[];
  /**
   * The enabled skill set. Lifecycle steps render per enabled member,
   * read-intent entries render per enabled read skill, and any enabled skill
   * with a `blockTriggerLine` contributes its own intent entry. Omitted ⇒
   * every shipped template.
   *
   * The block is committed, so nothing here may vary with cloud state; the
   * cloud-gated skills contribute no section.
   */
  enabledSkills?: ReadonlyArray<SkillTemplate<string>>;
}

/**
 * Render the full managed section, including markers. Stitch this into
 * an existing AGENTS.md / CLAUDE.md via `injectOrcaopsSection`.
 */
export function renderOrcaopsAgentsMdSection(opts: AgentsMdSectionOptions): string {
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const skill = (verb: SkillId): string => skillRef(verb, prefix);
  const hints = opts.hints ?? [];
  // Omitted ⇒ the DEFAULT-ON subset (not the full registry — opt-in
  // templates must not leak refs into a caller that didn't resolve a set).
  // Capability-gated templates (`requires` non-empty, e.g.
  // timetravel) are excluded too: without a resolved set the
  // renderer cannot verify capabilities, so it must not assume them —
  // this also keeps the default render byte-stable by construction.
  const enabled =
    opts.enabledSkills ??
    SKILL_TEMPLATES.filter((s) => s.defaultEnabled !== false && (s.requires ?? []).length === 0);
  const on = (id: string): boolean => enabled.some((s) => s.id === id);

  const sections: string[] = [];

  // Product framing — references the prefix glob, never a specific skill.
  sections.push(`## Orcaops

This repo uses **orcaops** to capture and evaluate AI coding sessions.
The \`${prefix}-*\` skills own the CLI surface, flags, and evaluator
semantics — invoke them on the cues below rather than driving the CLI
by hand.`);

  // ── Capture-lifecycle walkthrough (per enabled lifecycle member) ──────────
  const phaseNames = [
    on('capture') ? 'plan' : null,
    on('checkpoint') ? 'checkpoint(s)' : null,
    'finish',
  ].filter((p): p is string => p !== null);
  if (phaseNames.length > 0) {
    const steps: string[] = [];
    steps.push(`Run \`orcaops status --json\` to check whether an in-flight artifact
   already exists for the current branch.`);
    if (on('capture')) {
      steps.push(`If none exists — or the existing artifact is unrelated to the task
   you were just asked about — invoke **\`${skill('capture')}\`** to plan.`);
    }
    if (on('checkpoint')) {
      steps.push(`For each chunk of work, invoke **\`${skill('checkpoint')}\`**: **open the
   checkpoint before you change the worktree**, then close it after with
   what actually finished. Orcaops attributes your changes by diffing the
   worktree between open and close; opening first is the only reliable way to
   get clean per-line attribution, since work done before open is outside that
   window. The skill owns command
   syntax, evaluator handling, cadence, and subagent coordination.`);
    }
    const finishers = (['pre-pr', 'summary', 'digest'] as const).filter(on);
    steps.push(`Before ending the session, invoke **\`${skill('finish')}\`** to run the
   final checks, capture the summary, synchronize, and materialize the reviewer-facing digest.${
     finishers.length > 0
       ? `\n   The granular ${finishers.map((f) => `**\`${skill(f)}\`**`).join(', ')} skills remain
   available for manual inspection and recovery.`
       : ''
   }`);
    sections.push(`**Capture lifecycle: ${phaseNames.join(' → ')}.**
Each phase has a paired skill; skipping a phase degrades the next. At
the start of any non-trivial coding task:

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }

  // ── Read intents (per enabled read skill) + blockTriggerLine entries ─────
  const intentEntries: string[] = [];
  if (on('resume')) {
    intentEntries.push(`continuation
("pick up where we left off") → \`${skill('resume')}\``);
  }
  if (on('digest')) {
    intentEntries.push(`PR summary ("show me
the digest", "what changed?") → \`${skill('digest')}\``);
  }
  if (on('why')) {
    // The regression-lens trigger rides `why`'s intent entry.
    intentEntries.push(`provenance ("why does
X exist?", "what was the agent worried about when it wrote this?") → \`${skill('why')}\``);
  }
  if (on('search')) {
    intentEntries.push(`cross-branch search ("have we worked on X
before?") → \`${skill('search')}\``);
  }
  if (on('doctor')) {
    intentEntries.push(`install health ("is orcaops set up
correctly?") → \`${skill('doctor')}\``);
  }
  // Enabled skills that ship their own one-line trigger entry (insight /
  // review skills) append to the same intent list.
  for (const t of enabled) {
    if (t.blockTriggerLine === undefined) continue;
    intentEntries.push(
      typeof t.blockTriggerLine === 'function' ? t.blockTriggerLine(prefix) : t.blockTriggerLine
    );
  }
  if (intentEntries.length > 0) {
    const surveyTail = on('resume')
      ? ` For broader survey questions ("what's
the state of this branch?"), run \`orcaops status --json\` directly, not
\`${skill('resume')}\`.`
      : '';
    sections.push(
      `**Read intents → skills.** Match user phrasing: ${intentEntries.join('; ')}.${surveyTail}`
    );
  }

  // ── Attribution (always emitted; independent of plan-approval) ────────────
  sections.push(`**Attribution.** Pass \`--invoked-by-agent <your-agent-id>\` on every
artifact-writing capture command with YOUR OWN agent id, so each event
records which agent produced it (multi-agent repos share one artifact
thread). Omitted, orcaops falls back to \`ORCAOPS_INVOKED_BY_AGENT\`, then
environment detection, then \`other\`.`);

  // Skip guidance — no skill refs.
  sections.push(`**Skip orcaops for:** typo fixes, cosmetic single-line edits,
formatting-only changes, trivial doc tweaks. Resume an existing artifact
instead of starting a new one when continuing prior work.`);

  if (enabled.length > 0) {
    sections.push(`Full skill bodies live under \`.claude/skills/${prefix}-*\` (Claude Code),
\`.agents/skills/${prefix}-*\` (Codex / Cursor / OpenCode / GitHub Copilot), or
\`.aider-desk/skills/${prefix}-*\` (AiderDesk).`);
  }

  const body = `<!-- orcaops:start v=${opts.generatedBy} -->\n${sections.join('\n\n')}`;

  const hintsBlock =
    hints.length > 0
      ? `\n\n### Workflow Preferences\n\n${hints.map((h) => `- ${h}`).join('\n')}\n`
      : '';

  return `${body}${hintsBlock}\n${ORCAOPS_AGENTS_MD_MARKER_END}\n`;
}
