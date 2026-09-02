import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from '@orcaops/adapters';
import { getDefaultConfig, resolveConfig } from '@orcaops/storage';

import {
  currentSkillCapabilities,
  enabledSkillTemplates,
  gateWithheldSkillTemplates,
  resolveSkillSet,
  type SkillGates,
  visibleSkillTemplates,
} from './skill-set.js';

const CLOUD: SkillGates = { cloud: true };
const NO_CLOUD: SkillGates = { cloud: false };

const DEFAULT_ON = SKILL_TEMPLATES.filter((s) => s.defaultEnabled !== false);
const CLOUD_GATED = SKILL_TEMPLATES.filter((s) => (s.requires ?? []).includes('cloud'));

describe('skill-set (Config → enabled templates choke point)', () => {
  it('default config enables the default-on templates, in registry order', () => {
    const enabled = enabledSkillTemplates(getDefaultConfig(), CLOUD);
    expect(enabled.map((s) => s.id)).toEqual(DEFAULT_ON.map((s) => s.id));
  });

  it('a skills.enabled=false override removes exactly that template', () => {
    const config = resolveConfig({ skills: { enabled: { digest: false } } });
    const enabled = enabledSkillTemplates(config, CLOUD);
    expect(enabled.map((s) => s.id)).not.toContain('digest');
    expect(enabled).toHaveLength(DEFAULT_ON.length - 1);

    const resolved = resolveSkillSet(config, CLOUD);
    expect(resolved.disabled).toContainEqual({
      template: expect.objectContaining({ id: 'digest' }),
      reason: 'override_disabled',
    });
  });

  it('a false override cannot remove the required finish skill', () => {
    const config = resolveConfig({ skills: { enabled: { finish: false } } });
    const resolved = resolveSkillSet(config, CLOUD);
    expect(resolved.enabled.map((s) => s.id)).toContain('finish');
    expect(resolved.disabled.find((d) => d.template.id === 'finish')).toBeUndefined();
  });

  it('currentSkillCapabilities keys archive and fingerprint capabilities independently', () => {
    // snapshot-checkout + matcher ride the SAME kill-switch as
    // diff-fingerprint — with it off, no refs exist and no manifests match.
    expect(currentSkillCapabilities(getDefaultConfig(), NO_CLOUD)).toEqual([
      'diff-fingerprint',
      'archive',
      'snapshot-checkout',
      'matcher',
    ]);
    expect(
      currentSkillCapabilities(resolveConfig({ diff_fingerprint: { enabled: false } }), NO_CLOUD)
    ).toEqual(['archive']);
  });

  it('the cloud capability comes from the gate, not from config', () => {
    expect(currentSkillCapabilities(getDefaultConfig(), CLOUD)).toContain('cloud');
    expect(currentSkillCapabilities(getDefaultConfig(), NO_CLOUD)).not.toContain('cloud');
  });

  it('disabling diff_fingerprint resolves timetravel out as capability_unsatisfied', () => {
    const config = resolveConfig({ diff_fingerprint: { enabled: false } });
    const resolved = resolveSkillSet(config, CLOUD);
    expect(resolved.enabled.map((s) => s.id)).not.toContain('timetravel');
    const entry = resolved.disabled.find((d) => d.template.id === 'timetravel');
    expect(entry?.reason).toBe('capability_unsatisfied');
  });

  describe('the cloud gate', () => {
    it('resolves the cloud skills out when there is no session', () => {
      const enabled = enabledSkillTemplates(getDefaultConfig(), NO_CLOUD);
      const ids = enabled.map((s) => s.id);
      expect(CLOUD_GATED.length).toBeGreaterThan(0);
      for (const t of CLOUD_GATED) expect(ids).not.toContain(t.id);
      expect(enabled).toHaveLength(DEFAULT_ON.length - CLOUD_GATED.length);
    });

    it('leaves NO trace of them in disabled[] — unlike every other capability', () => {
      const resolved = resolveSkillSet(getDefaultConfig(), NO_CLOUD);
      for (const t of CLOUD_GATED) {
        expect(resolved.disabled.find((d) => d.template.id === t.id)).toBeUndefined();
      }
    });

    it('enables them when the gate is on, so the filter keys on state not id', () => {
      const resolved = resolveSkillSet(getDefaultConfig(), CLOUD);
      for (const t of CLOUD_GATED) {
        expect(resolved.enabled.map((s) => s.id)).toContain(t.id);
      }
    });
  });

  describe('gateWithheldSkillTemplates', () => {
    it('is empty with a cloud session — the gate withholds nothing', () => {
      expect(gateWithheldSkillTemplates(getDefaultConfig(), CLOUD)).toEqual([]);
    });

    it('is exactly the cloud-gated templates without one', () => {
      expect(gateWithheldSkillTemplates(getDefaultConfig(), NO_CLOUD).map((s) => s.id)).toEqual(
        CLOUD_GATED.map((s) => s.id)
      );
    });

    it('omits a cloud skill the user disabled, so the prune can still remove it', () => {
      // Keyed on the enabled-set DIFFERENCE, not the cloud-gated id list: an
      // explicit disable is a user removal, not something the gate withholds.
      const config = resolveConfig({ skills: { enabled: { review: false } } });
      const withheld = gateWithheldSkillTemplates(config, NO_CLOUD).map((s) => s.id);
      expect(withheld).not.toContain('review');
      expect(withheld).toContain('plan-approval');
    });
  });

  describe('visibleSkillTemplates', () => {
    it('is the whole registry with a cloud session', () => {
      expect(visibleSkillTemplates(CLOUD).map((s) => s.id)).toEqual(
        SKILL_TEMPLATES.map((s) => s.id)
      );
    });

    it('omits the cloud-gated templates without one', () => {
      const ids = visibleSkillTemplates(NO_CLOUD).map((s) => s.id);
      for (const t of CLOUD_GATED) expect(ids).not.toContain(t.id);
      expect(ids).toHaveLength(SKILL_TEMPLATES.length - CLOUD_GATED.length);
    });
  });
});
