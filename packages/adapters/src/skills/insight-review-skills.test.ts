import { describe, expect, it } from 'vitest';

import { orcaopsAdversarialReviewSkill } from './orcaops-adversarial-review.js';
import { orcaopsRecapSkill } from './orcaops-recap.js';

/**
 * The default-on insight/review skills. Pins the trigger phrases and skip
 * conditions (the auto-invocation contract), recap's three named formats and
 * their invariants (activity-window + exact-scope flow, unmatched_candidates
 * disclosure, consent-gated journal append), the adversarial-review
 * checklist, and prefix-resolved cross-refs.
 */

const bodyOf = (skill: { body: string | ((p: string) => string) }, prefix = 'orcaops'): string =>
  typeof skill.body === 'function' ? skill.body(prefix) : skill.body;

describe('orcaops-recap (standup / changelog / journal formats)', () => {
  it('is a default-on insight skill with complete description triggers', () => {
    expect(orcaopsRecapSkill.group).toBe('insight');
    expect(orcaopsRecapSkill.defaultEnabled).toBe(true);
    expect(orcaopsRecapSkill.description).toMatch(/what did I do yesterday \/ this week/);
    expect(orcaopsRecapSkill.description).toContain('changelog since v1.2');
    expect(orcaopsRecapSkill.description).toContain('journal today');
  });

  it('absorbs ALL merged trigger phrases verbatim in the selection description', () => {
    const d = orcaopsRecapSkill.description;
    // standup's
    expect(d).toMatch(/standup/);
    expect(d).toMatch(/what did I do yesterday \/ this week/);
    expect(d).toMatch(/progress report/);
    // changelog's
    expect(d).toContain('changelog since v1.2');
    expect(d).toContain('what shipped between these tags?');
    expect(d).toContain('draft the release notes');
    // journal's
    expect(d).toContain('journal today');
    expect(d).toContain('update my dev log');
    expect(d).toContain('append to NOTES.md what happened this week');
  });

  it('keeps the skip-fors both ways (resume / status / digest)', () => {
    expect(orcaopsRecapSkill.description).toMatch(/resume skill/);
    expect(orcaopsRecapSkill.description).toContain('orcaops status --json');
    expect(orcaopsRecapSkill.description).toMatch(/digest skill/);
    const body = bodyOf(orcaopsRecapSkill);
    expect(body).toContain('`orcaops-resume`');
    expect(body).toContain('orcaops status --json');
    expect(body).toContain('`orcaops-digest`');
  });

  it('standup format: pins the bounded ACTIVITY window + exact-scope loose-ends flow', () => {
    const body = bodyOf(orcaopsRecapSkill);
    expect(body).toContain('"what did I do yesterday?"');
    expect(body).toContain('"what did I do this week?"');
    expect(body).toContain('--all-branches --active-since <since> --active-until <until> --json');
    expect(body).toMatch(/interval-overlap/i);
    expect(body).toContain('loose-ends --artifact <id> --artifact <id2> --json');
    // Window flags must NOT be combined with --artifact (rejected).
    expect(body).toMatch(/do NOT add window flags/);
    expect(body).toContain('**Shipped**');
    expect(body).toContain('**In flight**');
    expect(body).toContain('**Loose ends**');
  });

  it('changelog format: wraps list --between and MANDATES the unmatched_candidates disclosure', () => {
    const body = bodyOf(orcaopsRecapSkill);
    expect(body).toContain('orcaops list --between <ref1>..<ref2> --json');
    expect(body).toMatch(/MANDATORY disclosure/);
    expect(body).toMatch(/possibly rebased away/);
    expect(body).toMatch(/NOT "this checkpoint's own commit"/);
    expect(body).toMatch(/user-intent\s+wording/);
  });

  it('journal format: wraps decisions/loose-ends/list and keeps the CLI read-only', () => {
    const body = bodyOf(orcaopsRecapSkill);
    expect(body).toContain('orcaops decisions --all-branches');
    expect(body).toContain('orcaops loose-ends --all-branches --json');
    expect(body).toMatch(/APPEND \(never rewrite history\)/);
    expect(body).toMatch(/The CLI never writes this file/);
  });

  it('cross-refs resolve under a custom prefix (no leaked template source)', () => {
    const body = bodyOf(orcaopsRecapSkill, 'oo');
    expect(body).toContain('`oo-resume`');
    expect(body).toContain('`oo-digest`');
    expect(body).not.toContain('${');
    expect(body).not.toContain('=>');
  });
});

describe('orcaops-adversarial-review', () => {
  it('is a default-on review skill with complete description triggers', () => {
    expect(orcaopsAdversarialReviewSkill.group).toBe('review');
    expect(orcaopsAdversarialReviewSkill.defaultEnabled).toBe(true);
    expect(orcaopsAdversarialReviewSkill.description).toMatch(/red-team this/);
  });

  it('description + body pin the trigger phrases and skip conditions', () => {
    expect(orcaopsAdversarialReviewSkill.description).toMatch(/red-team/);
    expect(orcaopsAdversarialReviewSkill.description).toMatch(/poke holes/);
    const body = bodyOf(orcaopsAdversarialReviewSkill);
    expect(body).toContain('"adversarial review"');
    expect(body).toContain('"verify the done criteria"');
    // Skips route to pre-pr (evaluator gating) and digest (summary render).
    expect(body).toContain('`orcaops-pre-pr`');
    expect(body).toContain('`orcaops-digest`');
  });

  it('body pins the 5-part checklist with per-criterion verdicts', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill);
    expect(body).toMatch(/Refute each `done_criteria` evidence entry/);
    expect(body).toContain('**CONFIRMED**');
    expect(body).toContain('**UNVERIFIED**');
    expect(body).toContain('**REFUTED**');
    expect(body).toMatch(/Attack each `uncertainty\[\]` entry/);
    expect(body).toMatch(/Audit `criterion_lineage` for goalpost moves/);
    expect(body).toMatch(/Check non-goal violations/);
    expect(body).toContain('orcaops show <artifact_id> --json');
  });

  it('claims audit sweeps BOTH surfaces: uncommitted diff AND in-window commits', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill);
    expect(body).toContain('orcaops diff --attribution --unattributed --json');
    expect(body).toContain('orcaops diff --reconcile --json');
    expect(body).toContain('uncovered_commits');
    expect(body).toContain('ambiguous_coverage_commits');
    expect(body).toMatch(/absence of attribution is NOT\s+proof of smuggling/);
    expect(body).toMatch(/UNVERIFIED, not REFUTED/);
    // The v1 blind-spot disclaimer must be GONE.
    expect(body).not.toContain('no per-line');
    // Reconcile flags a summarized artifact's post-last-close, pre-summary
    // commits as a FINDING distinct from the post-summary disclosure.
    expect(body).toContain('pre_summary.uncovered_commits');
    expect(body).toContain('post-summary list is disclosure');
  });

  it('uncertainty-led code review: starts from uncertainty, respects documented decisions', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill);
    expect(body).toContain('# Dimension 1 — claims audit');
    expect(body).toContain('# Dimension 2 — uncertainty-led code review');
    expect(body).toMatch(/Start from recorded uncertainty/);
    expect(body).toMatch(/Don't re-flag documented decisions/);
    expect(body).toMatch(/DO flag silent divergence/);
    expect(body).toMatch(/Criteria-checked/);
    expect(body).toMatch(/Depth scales with the ask/);
  });

  it('cross-refs resolve under a custom prefix', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill, 'oo');
    expect(body).toContain('`oo-pre-pr`');
    expect(body).toContain('`oo-digest`');
    expect(body).not.toContain('${');
  });
});
