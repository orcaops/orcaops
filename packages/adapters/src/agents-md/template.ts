import { DEFAULT_PREFIX } from '../refs.js';
import type { SkillId, SkillTemplate } from '../types.js';
import {
  type BootstrapLifecycleStep,
  ORCAOPS_BLOCK_ROUTING_SENTINEL,
  resolveBootstrapContent,
} from './bootstrap-content.js';
import type { HintsInput } from './hints-catalog.js';

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
 * Every content row comes from `resolveBootstrapContent`, which the SessionStart
 * hook renders too; this module is the BLOCK formatter over that model. It owns
 * the markers, the bold section labels, the numbered list, and the hints
 * sub-section, and renders the model's `long` register. Prose that lives here
 * rather than in the model is prose the hook must not emit.
 *
 * Enabled-set-aware: the ENTIRE body is assembled from the enabled
 * skill set — every section is keyed by the skill id(s) it references, so no
 * skill ref is ever emitted unconditionally. Disabling a skill and running
 * `orcaops update` regenerates the block without the dead ref; a newly-enabled
 * skill contributes its trigger line immediately.
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
   * Declared workflow preferences, rendered as a `### Workflow Preferences`
   * sub-section INSIDE the managed block. Empty/omitted → no sub-section
   * (byte-identical to the no-hints output).
   *
   * The raw `workflow.hints`, never pre-resolved lines: the resolver drops the
   * keys the lifecycle already states, and it needs the keys to do that.
   */
  hints?: HintsInput;
  /**
   * The enabled skill set. Lifecycle steps render per enabled member,
   * read-intent entries render per enabled read skill, and any enabled skill
   * with a `blockTriggerLine` contributes its own intent entry. Omitted ⇒
   * the default-on ungated subset, which is how a caller that resolved no set
   * declares it verified neither opt-in choices nor capabilities.
   *
   * The block is committed, so nothing here may vary with cloud state; the
   * cloud-gated skills contribute no section.
   */
  enabledSkills?: ReadonlyArray<SkillTemplate<string>>;
  /** `workflow.commit_inside_window`; adds the commit clause to the checkpoint step. */
  commitInsideWindow?: boolean;
  /** `workflow.routing.suppress`; drops those skills' read-intent entries. */
  suppressedRouting?: ReadonlyArray<SkillId>;
}

/**
 * `status` has no paired skill, so it is a precondition rather than a capture
 * phase and never appears in the lifecycle headline.
 */
const LIFECYCLE_PHASE_LABELS: Record<BootstrapLifecycleStep['phase'], string | null> = {
  status: null,
  plan: 'plan',
  checkpoint: 'checkpoint(s)',
  finish: 'finish',
};

/**
 * Render the full managed section, including markers. Stitch this into
 * an existing AGENTS.md / CLAUDE.md via `injectOrcaopsSection`.
 */
export function renderOrcaopsAgentsMdSection(opts: AgentsMdSectionOptions): string {
  const content = resolveBootstrapContent({
    prefix: opts.prefix ?? DEFAULT_PREFIX,
    enabledSkills: opts.enabledSkills,
    hints: opts.hints,
    commitInsideWindow: opts.commitInsideWindow ?? true,
    suppressedRouting: opts.suppressedRouting ?? [],
  });
  const hints = content.hints;

  const sections: string[] = [];

  sections.push(`## Orcaops\n\n${content.framing}`);

  const phaseNames = content.lifecycle
    .map((s) => LIFECYCLE_PHASE_LABELS[s.phase])
    .filter((p): p is string => p !== null);
  if (phaseNames.length > 0) {
    const steps = content.lifecycle.map((s, i) => `${i + 1}. ${s.long}`).join('\n');
    sections.push(`**Capture lifecycle: ${phaseNames.join(' → ')}.**
Each phase has a paired skill; skipping a phase degrades the next. At
the start of any non-trivial coding task:

${steps}`);
  }

  if (content.routing.length > 0) {
    const entries = content.routing.map((e) => e.line).join('; ');
    const tail = content.surveyTail === null ? '' : ` ${content.surveyTail}`;
    sections.push(`${ORCAOPS_BLOCK_ROUTING_SENTINEL} Match user phrasing: ${entries}.${tail}`);
  }

  sections.push(`**Attribution.** ${content.attribution}`);

  sections.push(`**Skip orcaops for:** ${content.skip.long}`);

  if (content.bodiesLocation !== null) {
    sections.push(content.bodiesLocation);
  }

  const body = `<!-- orcaops:start v=${opts.generatedBy} -->\n${sections.join('\n\n')}`;

  const hintsBlock =
    hints.length > 0
      ? `\n\n### Workflow Preferences\n\n${hints.map((h) => `- ${h}`).join('\n')}\n`
      : '';

  return `${body}${hintsBlock}\n${ORCAOPS_AGENTS_MD_MARKER_END}\n`;
}
