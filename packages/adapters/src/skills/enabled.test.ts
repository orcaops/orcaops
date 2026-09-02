import { describe, expect, expectTypeOf, it } from 'vitest';

import { resolveEnabledSkills } from './enabled.js';
import { SKILL_TEMPLATES } from './index.js';
import { SKILL_IDS, type SkillId, type SkillTemplate } from '../types.js';

const t = (id: string, extra: Partial<SkillTemplate<string>> = {}): SkillTemplate<string> => ({
  id,
  name: `Skill ${id}`,
  description: `desc ${id}`,
  body: `body ${id}`,
  ...extra,
});

describe('resolveEnabledSkills', () => {
  it('absent defaultEnabled means enabled; defaultEnabled:false means opt-in', () => {
    const out = resolveEnabledSkills({
      templates: [t('a'), t('b', { defaultEnabled: false }), t('c', { defaultEnabled: true })],
      overrides: {},
      capabilities: [],
    });
    expect(out.enabled.map((s) => s.id)).toEqual(['a', 'c']);
    expect(out.disabled).toEqual([
      { template: expect.objectContaining({ id: 'b' }), reason: 'default_disabled' },
    ]);
  });

  it('overrides beat defaults in both directions', () => {
    const out = resolveEnabledSkills({
      templates: [t('on-by-default'), t('opt-in', { defaultEnabled: false })],
      overrides: { 'on-by-default': false, 'opt-in': true },
      capabilities: [],
    });
    expect(out.enabled.map((s) => s.id)).toEqual(['opt-in']);
    expect(out.disabled).toEqual([
      { template: expect.objectContaining({ id: 'on-by-default' }), reason: 'override_disabled' },
    ]);
  });

  it('a required skill ignores a false override', () => {
    const required = t('required', { required: true });
    const out = resolveEnabledSkills({
      templates: [required],
      overrides: { required: false },
      capabilities: [],
    });
    expect(out.enabled).toEqual([required]);
    expect(out.disabled).toEqual([]);
  });

  it('an unsatisfied capability excludes regardless of override', () => {
    const gated = t('gated', { requires: ['diff-fingerprint'], defaultEnabled: true });
    const out = resolveEnabledSkills({
      templates: [gated],
      overrides: { gated: true }, // explicit enable does NOT bypass the gate
      capabilities: [],
    });
    expect(out.enabled).toEqual([]);
    expect(out.disabled).toEqual([
      {
        template: expect.objectContaining({ id: 'gated' }),
        reason: 'capability_unsatisfied',
        missing_capabilities: ['diff-fingerprint'],
      },
    ]);

    const satisfied = resolveEnabledSkills({
      templates: [gated],
      overrides: {},
      capabilities: ['diff-fingerprint'],
    });
    expect(satisfied.enabled.map((s) => s.id)).toEqual(['gated']);
  });

  it('template order is preserved (deterministic install.json)', () => {
    const out = resolveEnabledSkills({
      templates: [t('z'), t('a'), t('m', { defaultEnabled: false }), t('b')],
      overrides: { m: true },
      capabilities: [],
    });
    expect(out.enabled.map((s) => s.id)).toEqual(['z', 'a', 'm', 'b']);
  });

  it('the shipped registry resolves to the default-on subset under an empty config', () => {
    const out = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: {},
      capabilities: ['diff-fingerprint'],
    });
    expectTypeOf(out.enabled).toEqualTypeOf<SkillTemplate<SkillId>[]>();
    // Default-on minus every capability-gated template this config does not
    // grant: timetravel requires 'snapshot-checkout' — this fixture grants
    // diff-fingerprint only.
    const granted = new Set(['diff-fingerprint']);
    const defaultOn = SKILL_TEMPLATES.filter(
      (s) => s.defaultEnabled !== false && (s.requires ?? []).every((c) => granted.has(c))
    );
    expect(out.enabled.map((s) => s.id)).toEqual(defaultOn.map((s) => s.id));
    // The opt-in templates are registered but default-disabled; the
    // capability-gated ones are excluded because this fixture grants
    // diff-fingerprint only.
    expect(out.disabled.map((d) => [d.template.id, d.reason])).toEqual([
      // Registry order: plan-approval sits at index 2, ahead of the opt-ins.
      ['plan-approval', 'capability_unsatisfied'],
      ['loose-ends', 'default_disabled'],
      ['decisions', 'default_disabled'],
      ['parallel-dispatch', 'default_disabled'],
      ['estimate', 'default_disabled'],
      ['lessons', 'default_disabled'],
      ['timetravel', 'capability_unsatisfied'],
      ['blame', 'capability_unsatisfied'],
      ['review', 'capability_unsatisfied'],
    ]);
  });

  it('plan-critique is ENABLED under EMPTY capabilities — no archive gate', () => {
    // The dissolved precedent skill was `requires: ['archive']`; its
    // successor must never regain the gate — degradation is in-body.
    const out = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: {},
      capabilities: [],
    });
    expect(out.enabled.map((t) => t.id)).toContain('plan-critique');
    const template = SKILL_TEMPLATES.find((t) => t.id === 'plan-critique');
    expect(template?.requires ?? []).toEqual([]);
    expect(template?.defaultEnabled).toBe(true);
  });

  it('no template references the nonexistent delivery-coverage evaluator id', () => {
    // The real evaluator id is step-coverage; the prose bug named an evaluator
    // that never existed. Scan EVERY rendered surface.
    for (const t of SKILL_TEMPLATES) {
      const body = typeof t.body === 'function' ? t.body('orcaops') : t.body;
      expect(`${t.description}\n${body}`, t.id).not.toContain('delivery-coverage');
    }
  });

  it('the registry ships exactly 26 templates, 20 default-on, with existing opt-ins untouched', () => {
    const ids = SKILL_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(SKILL_IDS);
    expect(new Set(ids).size).toBe(26);
    expect(SKILL_TEMPLATES.filter((t) => t.defaultEnabled !== false)).toHaveLength(20);
    // task-review is ungated: the `orcaops review` engine verbs ship in every
    // install. plan-approval and review are cloud-gated, so both are absent.
    const defaultOnUngated = SKILL_TEMPLATES.filter(
      (t) => t.defaultEnabled !== false && (t.requires ?? []).length === 0
    ).map((t) => t.id);
    expect(defaultOnUngated.sort()).toEqual(
      [
        'adversarial-review',
        'author-evaluator',
        'capture',
        'checkpoint',
        'digest',
        'doctor',
        'finish',
        'plan-critique',
        'pre-pr',
        'recap',
        'resume',
        'search',
        'seed',
        'seed-discovery',
        'summary',
        'task-review',
        'why',
      ].sort()
    );
    const timetravel = SKILL_TEMPLATES.find((t) => t.id === 'timetravel');
    expect(timetravel?.defaultEnabled).toBe(true);
    expect(timetravel?.requires).toEqual(['snapshot-checkout']);
    expect(SKILL_TEMPLATES.find((t) => t.id === 'finish')?.required).toBe(true);
    // Existing opt-in templates stay registered and default-disabled.
    for (const id of ['decisions', 'loose-ends', 'estimate', 'blame']) {
      const t = SKILL_TEMPLATES.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(t?.defaultEnabled, id).toBe(false);
    }
  });

  it('the shipped registry carries the group tags', () => {
    const byId = new Map(SKILL_TEMPLATES.map((s) => [s.id, s.group]));
    for (const id of [
      'capture',
      'checkpoint',
      'plan-approval',
      'pre-pr',
      'finish',
      'summary',
    ] as const) {
      expect(byId.get(id), id).toBe('lifecycle');
    }
    for (const id of ['digest', 'why', 'resume', 'search', 'doctor'] as const) {
      expect(byId.get(id), id).toBe('read');
    }
    expect(byId.get('author-evaluator')).toBe('authoring');
  });
});
