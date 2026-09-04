import { describe, expect, it } from 'vitest';

import { resolveEnabledSkills } from './enabled.js';
import { SKILL_TEMPLATES } from './index.js';
import { orcaopsAuthorEvaluatorSkill } from './orcaops-author-evaluator.js';
import { renderOrcaopsAgentsMdSection } from '../agents-md/template.js';
import { makeSkillRenderer } from '../renderers.js';

const bodyOf = (prefix = 'orcaops'): string =>
  typeof orcaopsAuthorEvaluatorSkill.body === 'function'
    ? orcaopsAuthorEvaluatorSkill.body(prefix)
    : orcaopsAuthorEvaluatorSkill.body;

/**
 * The recommendation the managed block must carry verbatim. The whole point of
 * pairing `disableModelInvocation` with a block trigger line is that the model
 * SURFACES the skill and the human PULLS the trigger — so the wording is the
 * contract, not a phrasing preference. An edit to "invoke
 * `/orcaops-author-evaluator`" would silently restore auto-invocation on every
 * adapter that does not honor the frontmatter field.
 */
const RECOMMENDATION =
  'recommend the human run `/orcaops-author-evaluator` rather than invoking it yourself';

/** The real default-on ungated set, exactly as the renderer's fallback resolves it. */
const defaultOn = SKILL_TEMPLATES.filter(
  (s) => s.defaultEnabled !== false && (s.requires ?? []).length === 0
);

describe('author-evaluator registry metadata', () => {
  it('ships as a default-on authoring skill with model invocation disabled', () => {
    const registered = SKILL_TEMPLATES.find((t) => t.id === 'author-evaluator');
    expect(registered).toBe(orcaopsAuthorEvaluatorSkill);
    expect(registered?.group).toBe('authoring');
    expect(registered?.defaultEnabled).toBe(true);
    expect(registered?.disableModelInvocation).toBe(true);
    expect(registered?.requires ?? []).toEqual([]);
  });

  it('resolves into the default enabled set with no capability gate', () => {
    const resolved = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: {},
      capabilities: [],
    });
    expect(resolved.enabled.map((t) => t.id)).toContain('author-evaluator');
  });

  it('an explicit override disables it, recorded as an override rather than a gate', () => {
    const resolved = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: { 'author-evaluator': false },
      capabilities: [],
    });
    expect(resolved.enabled.map((t) => t.id)).not.toContain('author-evaluator');
    const off = resolved.disabled.find((d) => d.template.id === 'author-evaluator');
    expect(off?.reason).toBe('override_disabled');
  });
});

describe('the managed block recommends rather than invokes', () => {
  it('the shipped enabled set contributes the exact recommendation wording', () => {
    // Rendered against the REAL registry, not a synthetic template: generic
    // blockTriggerLine rendering is already covered in template.test.ts, and
    // what matters here is that the shipped line survives the shipped set.
    const block = renderOrcaopsAgentsMdSection({
      generatedBy: '0.0.0-fixture',
      enabledSkills: defaultOn,
    });
    expect(block).toContain(RECOMMENDATION);
    expect(block).not.toContain('invoke `/orcaops-author-evaluator`');
  });

  it('disabling the skill removes the line entirely', () => {
    const without = renderOrcaopsAgentsMdSection({
      generatedBy: '0.0.0-fixture',
      enabledSkills: defaultOn.filter((s) => s.id !== 'author-evaluator'),
    });
    expect(without).not.toContain('orcaops-author-evaluator');
    expect(without).not.toContain('authoring an evaluator');
  });

  it('the line carries no semicolon, which the intent list uses as its separator', () => {
    const line = orcaopsAuthorEvaluatorSkill.blockTriggerLine;
    const rendered = typeof line === 'function' ? line('orcaops') : (line ?? '');
    expect(rendered).not.toContain(';');
    expect(rendered).toContain(RECOMMENDATION);
  });
});

describe('evaluator test guidance', () => {
  it('distinguishes the shipped environment from the minimum launch requirement', () => {
    const body = bodyOf();
    expect(body).toContain('`env.inherit: [PATH, HOME, NODE_PATH]`');
    expect(body).toContain('`PATH` is the minimum needed to\n  launch Node');
  });

  it('does not present a revision-zero fixture as a revision comparison', () => {
    const body = bodyOf();
    expect(body).toContain('A fixture plan is revision 0');
    expect(body).toContain('exercises your null branch, not your comparison');
    expect(body).toContain('pass a non-null `prior_plan`');
  });
});

describe('the rendered skill file', () => {
  const rendered = makeSkillRenderer('.claude/skills', { includeTags: true }).format(
    orcaopsAuthorEvaluatorSkill,
    { generatedBy: '0.0.0-fixture' }
  );

  it('carries the frontmatter gate', () => {
    expect(rendered).toContain('\ndisable-model-invocation: true\n');
  });

  it('carries the stop line, which no mechanism enforces at runtime', () => {
    const flat = bodyOf().replace(/\s+/g, ' ');
    expect(flat).toContain('Do NOT grant non-`--dev` trust');
    expect(flat).toContain('Do NOT run `orcaops eval enable`');
    // The ATOMIC form. Registering first and granting after would mint a
    // durable fingerprint grant in between — the exact boundary crossing a
    // field run hit while trying to obey this very stop line.
    expect(flat).toContain('orcaops eval add-pack ./path/to/pack <pack-id> --disabled --dev --yes');
    expect(flat).not.toContain('orcaops eval trust <pack-id> --dev --yes');
  });

  it('opens with the engine routing rule, before any spec detail', () => {
    const body = bodyOf();
    const routing = body.indexOf('Route to the command engine unless the judgment');
    expect(routing).toBeGreaterThan(-1);
    expect(routing).toBeLessThan(body.indexOf('additional_context_sections'));
  });

  it('renders no default-prefix residue under a custom prefix', () => {
    expect(bodyOf('oo')).not.toContain('orcaops-doctor');
    expect(bodyOf('oo')).toContain('oo-doctor');
  });
});
