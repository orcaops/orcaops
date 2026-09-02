import { describe, expect, it } from 'vitest';

import { getDefaultConfig, resolveConfig } from '@orcaops/storage';

import { planSkillToggle } from './toggle.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import type { SkillGates } from '../../lib/skill-set.js';

const CLOUD: SkillGates = { cloud: true };
const NO_CLOUD: SkillGates = { cloud: false };

describe('planSkillToggle', () => {
  it('rejects an unknown skill id, listing the known ids', () => {
    let caught: unknown;
    try {
      planSkillToggle(getDefaultConfig(), 'not-a-skill', true, CLOUD);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrcaopsError);
    const err = caught as OrcaopsError;
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toContain('capture');
    expect(err.message).toContain('digest');
  });

  it('disable of a default-on skill: not a no-op, previous state captured', () => {
    const plan = planSkillToggle(getDefaultConfig(), 'digest', false, CLOUD);
    expect(plan).toMatchObject({
      id: 'digest',
      enabled: false,
      previous_effective: true,
      previous_override: null,
      noop: false,
    });
  });

  it('no-op detection keys on the EFFECTIVE state, not the override', () => {
    // No override + default-on → enabling is a no-op (already effective).
    expect(planSkillToggle(getDefaultConfig(), 'digest', true, CLOUD).noop).toBe(true);

    // Explicit override false → enabling is NOT a no-op.
    const disabled = resolveConfig({ skills: { enabled: { digest: false } } });
    const plan = planSkillToggle(disabled, 'digest', true, CLOUD);
    expect(plan.noop).toBe(false);
    expect(plan.previous_effective).toBe(false);
    expect(plan.previous_override).toBe(false);
  });

  it('disabling a lifecycle-group skill warns but is allowed', () => {
    const plan = planSkillToggle(getDefaultConfig(), 'checkpoint', false, CLOUD);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/degrades the capture lifecycle/);

    // Disabling a read-group skill carries no warning.
    expect(planSkillToggle(getDefaultConfig(), 'digest', false, CLOUD).warnings).toEqual([]);

    // Nor does the authoring group: author-evaluator is discoverability, not a
    // lifecycle phase, so turning it off degrades nothing about capture.
    const authoring = planSkillToggle(getDefaultConfig(), 'author-evaluator', false, CLOUD);
    expect(authoring.warnings).toEqual([]);
    expect(authoring.previous_effective).toBe(true);
  });

  it('refuses to disable a required skill', () => {
    expect(() => planSkillToggle(getDefaultConfig(), 'finish', false, CLOUD)).toThrowError(
      /required and cannot be disabled/
    );
  });

  it('rejects a cloud skill id as UNKNOWN when there is no cloud session', () => {
    // A warning would not do: the caller persists the override regardless.
    let caught: unknown;
    try {
      planSkillToggle(getDefaultConfig(), 'plan-approval', true, NO_CLOUD);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrcaopsError);
    expect((caught as OrcaopsError).code).toBe(ErrorCodes.INVALID_INPUT);
  });

  it('does not name the cloud skills in the known-ids list without a session', () => {
    let caught: unknown;
    try {
      planSkillToggle(getDefaultConfig(), 'not-a-skill', true, NO_CLOUD);
    } catch (e) {
      caught = e;
    }
    // Substring matching would hit the ungated `adversarial-review`/`task-review`.
    const message = (caught as OrcaopsError).message;
    const listed = message
      .replace(/^.*Known skills: /, '')
      .replace(/\.$/, '')
      .split(', ');
    expect(listed).toContain('capture');
    expect(listed).not.toContain('plan-approval');
    expect(listed).not.toContain('review');
  });

  it('accepts a cloud skill id with a session', () => {
    expect(planSkillToggle(getDefaultConfig(), 'plan-approval', false, CLOUD).id).toBe(
      'plan-approval'
    );
  });
});
