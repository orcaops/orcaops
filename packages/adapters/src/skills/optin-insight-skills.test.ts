import { describe, expect, it } from 'vitest';

import { resolveEnabledSkills } from './enabled.js';
import { SKILL_TEMPLATES } from './index.js';
import { orcaopsBlameSkill } from './orcaops-blame.js';
import { orcaopsEstimateSkill } from './orcaops-estimate.js';
import { orcaopsLessonsSkill } from './orcaops-lessons.js';

/**
 * The opt-in insight skills. Pins the DEFAULT EXCLUSION
 * (registered, absent from the default enabled set — so the agents-md byte
 * fixture and every default-ON-keyed count stay untouched), the metadata,
 * each body's primary command wiring and load-bearing semantic sentences,
 * and prefix-residue-free rendering.
 */

const bodyOf = (skill: { body: string | ((p: string) => string) }, prefix = 'orcaops'): string =>
  typeof skill.body === 'function' ? skill.body(prefix) : skill.body;

const OPT_IN_INSIGHT_SKILLS = [orcaopsEstimateSkill, orcaopsLessonsSkill];
const OPT_IN_INSIGHT_IDS = ['estimate', 'lessons'];

describe('opt-in insight skills', () => {
  it('are registered (appended after parallel-dispatch) but EXCLUDED from the default set', () => {
    const ids = SKILL_TEMPLATES.map((t) => t.id);
    for (const id of OPT_IN_INSIGHT_IDS) expect(ids).toContain(id);
    // Index positions are pinned: these two occupy the two slots ahead of the
    // capability-gated tail.
    expect(ids.slice(-11, -9)).toEqual(OPT_IN_INSIGHT_IDS);
    // The registry tail, in order:
    expect(ids.slice(-9)).toEqual([
      'timetravel',
      'blame',
      'recap',
      'plan-critique',
      'task-review',
      'review',
      'seed',
      'seed-discovery',
      'author-evaluator',
    ]);
    expect(ids.indexOf('parallel-dispatch')).toBeLessThan(ids.indexOf('estimate'));

    const resolved = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: {},
      capabilities: ['diff-fingerprint'],
    });
    const enabledIds = resolved.enabled.map((t) => t.id);
    for (const id of OPT_IN_INSIGHT_IDS) expect(enabledIds).not.toContain(id);
    const disabledOptIn = resolved.disabled.filter((d) =>
      OPT_IN_INSIGHT_IDS.includes(d.template.id)
    );
    expect(disabledOptIn.map((d) => [d.template.id, d.reason])).toEqual(
      OPT_IN_INSIGHT_IDS.map((id) => [id, 'default_disabled'])
    );

    // Overrides turn each on.
    const allOn = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: Object.fromEntries(OPT_IN_INSIGHT_IDS.map((id) => [id, true])),
      capabilities: ['diff-fingerprint'],
    });
    expect(allOn.enabled.map((t) => t.id)).toEqual(expect.arrayContaining(OPT_IN_INSIGHT_IDS));
  });

  it('each: group insight, defaultEnabled false, no requires', () => {
    for (const skill of OPT_IN_INSIGHT_SKILLS) {
      expect(skill).toMatchObject({ group: 'insight', defaultEnabled: false });
      expect(skill.requires).toBeUndefined();
    }
  });

  it('estimate: wraps usage + stats + show and frames ranges, never promises', () => {
    const body = bodyOf(orcaopsEstimateSkill);
    expect(orcaopsEstimateSkill.description).toContain('similar captured work');
    expect(body).toContain('orcaops usage --artifact <id> --json');
    expect(body).toContain('orcaops show <id> --json');
    expect(body).toContain('orcaops stats --json');
    expect(body).toMatch(/RANGE anchored to those priors/);
    expect(body).toMatch(/never a promise/);
  });

  it('blame: routes WHY questions only to the current why skill', () => {
    const surfaces = `${orcaopsBlameSkill.description}\n${bodyOf(orcaopsBlameSkill)}`;
    expect(surfaces).toContain('`orcaops-why`');
    expect(surfaces).not.toContain('debug-provenance');
  });

  it('lessons: mines uncertainty→violation correlations into the growth-log format', () => {
    const body = bodyOf(orcaopsLessonsSkill);
    expect(body).toContain('orcaops stats --json');
    expect(body).toContain('orcaops show <id> --json');
    expect(body).toMatch(/Next time \[concrete situation\], I will \[concrete action\]\./);
    expect(body).toMatch(/Uncited lessons are vibes/);
    expect(body).toMatch(/Candidate evaluators/);
    expect(body).toContain('one aggregate sample, so it does not prove a');
    expect(body).not.toContain('Falling rates');
  });

  it('bodies resolve under a custom prefix (no residue, no rawrefs)', () => {
    for (const skill of OPT_IN_INSIGHT_SKILLS) {
      const body = bodyOf(skill, 'oo');
      expect(body).not.toContain('${');
      expect(body).not.toMatch(/`orcaops-[a-z]/);
    }
  });
});
