import { describe, expect, it } from 'vitest';

import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';
import { orcaopsDigestSkill } from './orcaops-digest.js';
import { orcaopsPrePrSkill } from './orcaops-pre-pr.js';
import type { SkillTemplate } from '../types.js';

/**
 * Skill/command bodies thread the active naming prefix into their
 * cross-references, so a non-default prefix renders e.g. `oo-summary` and
 * `oo:show` in the body prose (not just in paths/dir-names/the managed block).
 * At the default prefix `skillRef(id, 'orcaops') === skillRef(id)`, so the
 * rendered body is unchanged.
 */
const render = (s: SkillTemplate, prefix: string): string =>
  typeof s.body === 'function' ? s.body(prefix) : s.body;

describe('body prefix threading', () => {
  it('a ref-bearing skill body renders cross-refs under a non-default prefix', () => {
    expect(typeof orcaopsDigestSkill.body).toBe('function');
    const oo = render(orcaopsDigestSkill, 'oo');
    expect(oo).toContain('oo-why'); // skillRef('why', 'oo')
    expect(oo).toContain('oo:show'); // commandRef('show', 'oo')
    expect(oo).toContain('oo-finish'); // skillRef('finish', 'oo')
    expect(oo).not.toMatch(/orcaops-(why|finish)\b/);
    expect(oo).not.toContain('orcaops:show');
  });

  it('the default prefix renders the unprefixed refs unchanged', () => {
    const def = render(orcaopsDigestSkill, 'orcaops');
    expect(def).toContain('orcaops-why');
    expect(def).toContain('orcaops:show');
    expect(def).toContain('orcaops-finish');
  });

  it('pre-pr body threads the prefix into its sibling skill refs', () => {
    const oo = render(orcaopsPrePrSkill, 'oo');
    expect(oo).toContain('oo-finish');
    expect(oo).toContain('oo-summary');
    expect(oo).not.toMatch(/orcaops-(finish|summary)\b/);
  });
});

describe('verified-close guidance in the checkpoint skill', () => {
  it('the checkpoint body carries the Verified close section and verification field row', () => {
    const body = render(orcaopsCheckpointSkill, 'orcaops');
    expect(body).toContain('## Verified close');
    expect(body).toMatch(/`verification\[\]`/);
    expect(body).toMatch(/exit_code/);
    // The honesty rule is the load-bearing sentence: failing commands are
    // cited, never omitted.
    expect(body).toMatch(/FAILING\s+command is honest evidence/);
    expect(body).toContain('store rejects completion claims with no cited evidence');
    expect(body).toContain('resolution.policy_exception.enabled: true');
    expect(body).not.toContain('acknowledge_policy_exception');
    expect(body).not.toContain('checkpoint open --declared_step_ids');
  });

  it('keeps close-time explanation outside the shell block', () => {
    const body = render(orcaopsCheckpointSkill, 'orcaops');
    expect(body).toMatch(/output_digest: "9 tests passed"\nEOF\n```\n\n\(`/);
    expect(body).not.toMatch(/\nEOF\n\n\(`/);
    expect(body).toContain('done_criteria:');
    expect(body).toContain('verification:');
  });
});
