import { describe, expect, it } from 'vitest';

import { resolveEnabledSkills } from './enabled.js';
import { SKILL_TEMPLATES } from './index.js';
import { orcaopsDecisionsSkill } from './orcaops-decisions.js';
import { orcaopsLooseEndsSkill } from './orcaops-loose-ends.js';
import { orcaopsParallelDispatchSkill } from './orcaops-parallel-dispatch.js';

/**
 * The opt-in skills. Pins the DEFAULT EXCLUSION (present
 * in the registry, absent from the default enabled set), groups, trigger
 * phrases, the decisions FTS fallback, and the parallel-dispatch
 * protocol.
 */

const bodyOf = (skill: { body: string | ((p: string) => string) }, prefix = 'orcaops'): string =>
  typeof skill.body === 'function' ? skill.body(prefix) : skill.body;

const OPT_IN_IDS = ['loose-ends', 'decisions', 'parallel-dispatch'];

describe('opt-in orchestration + insight skills', () => {
  it('are registered but EXCLUDED from the default enabled set', () => {
    const ids = SKILL_TEMPLATES.map((t) => t.id);
    for (const id of OPT_IN_IDS) expect(ids).toContain(id);

    const resolved = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: {},
      capabilities: ['diff-fingerprint'],
    });
    const enabledIds = resolved.enabled.map((t) => t.id);
    for (const id of OPT_IN_IDS) expect(enabledIds).not.toContain(id);
    // Filtered to these three — the other opt-ins share the disabled list and
    // are pinned in optin-insight-skills.test.ts.
    expect(
      resolved.disabled
        .filter((d) => OPT_IN_IDS.includes(d.template.id))
        .map((d) => [d.template.id, d.reason])
    ).toEqual(OPT_IN_IDS.map((id) => [id, 'default_disabled']));

    // Overrides turn each on (alongside the default-on set).
    const allOn = resolveEnabledSkills({
      templates: SKILL_TEMPLATES,
      overrides: Object.fromEntries(OPT_IN_IDS.map((id) => [id, true])),
      capabilities: ['diff-fingerprint'],
    });
    const allOnIds = allOn.enabled.map((t) => t.id);
    for (const id of OPT_IN_IDS) expect(allOnIds).toContain(id);
  });

  it('carry the pinned groups and defaultEnabled: false', () => {
    expect(orcaopsLooseEndsSkill).toMatchObject({ group: 'insight', defaultEnabled: false });
    expect(orcaopsDecisionsSkill).toMatchObject({ group: 'insight', defaultEnabled: false });
    expect(orcaopsParallelDispatchSkill).toMatchObject({
      group: 'orchestration',
      defaultEnabled: false,
    });
  });

  it('loose-ends: wraps the loose-ends command and pins the window semantics', () => {
    expect(orcaopsLooseEndsSkill.description).toMatch(/unfinished captured work/);
    const body = bodyOf(orcaopsLooseEndsSkill);
    expect(body).toContain('orcaops loose-ends --json');
    expect(body).toContain('--artifact <id> --json');
    expect(body).toMatch(/SELECT\s+ARTIFACTS ONLY/);
    expect(body).toMatch(/Never combine window flags\s+with `--artifact`/);
    expect(body).toContain('`orcaops-resume`');
  });

  it('decisions: wraps the decisions command with the search FTS fallback', () => {
    expect(orcaopsDecisionsSkill.description).toMatch(/recorded decisions/);
    const body = bodyOf(orcaopsDecisionsSkill);
    expect(body).toContain('orcaops decisions --json');
    expect(body).toMatch(/FTS fallback/);
    expect(body).toContain('orcaops search "<topic>" --json');
    expect(body).toMatch(/plan decisions carry their\s+revision's `captured_at`/);
    expect(body).toMatch(/ADR/);
  });

  it('parallel-dispatch: pins the concurrent dispatch protocol', () => {
    expect(orcaopsParallelDispatchSkill.description).toMatch(/parallel/i);
    expect(orcaopsParallelDispatchSkill.description).toContain(
      'split a captured plan across subagents'
    );
    const body = bodyOf(orcaopsParallelDispatchSkill);
    expect(body).toContain('orcaops step brief <step_id> --json');
    expect(body).toMatch(/`checkpoint open` declaring exactly its own `step_id` BEFORE touching/);
    expect(body).toContain('`OPEN_CP_OVERLAP`');
    expect(body).toMatch(/never retry with force/);
    expect(body).toMatch(/PARENT revises the plan to split/);
    expect(body).toMatch(/dropped_in_latest_revision: true.*\s+.*NEVER dispatch/);
    expect(body).toContain('`verification` record for a command run fresh at close');
    expect(body).toContain('`orcaops-finish`');
    expect(body).toMatch(/ABANDON/);
  });

  it('parallel-dispatch: subagents run fully concurrently — NO mutex/serialization prose', () => {
    const body = bodyOf(orcaopsParallelDispatchSkill);
    const surfaces = `${orcaopsParallelDispatchSkill.description}\n${body}`;
    // Negative pin: mutex/serialization vocabulary must not return.
    expect(surfaces).not.toMatch(/mutex/i);
    expect(surfaces).not.toMatch(/collision lock/i);
    expect(surfaces).not.toMatch(/serializ/i);
    // Positive pin: the close-time self-report is the attribution claim.
    expect(body).toMatch(/ACCURATE and COMPLETE `files_changed`/);
    expect(body).toMatch(/it is the\s+attribution claim/);
    expect(body).toMatch(/FULLY CONCURRENTLY/);
  });

  it('bodies resolve under a custom prefix', () => {
    for (const skill of [
      orcaopsLooseEndsSkill,
      orcaopsDecisionsSkill,
      orcaopsParallelDispatchSkill,
    ]) {
      const body = bodyOf(skill, 'oo');
      expect(body).not.toContain('${');
      expect(body).not.toContain('orcaops-resume'); // no default-prefix residue
    }
    expect(bodyOf(orcaopsParallelDispatchSkill, 'oo')).toContain('`oo-checkpoint`');
  });
});
