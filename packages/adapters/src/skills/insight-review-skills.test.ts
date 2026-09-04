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
  it('is a default-on insight skill with distinct format cues', () => {
    expect(orcaopsRecapSkill.group).toBe('insight');
    expect(orcaopsRecapSkill.defaultEnabled).toBe(true);
    expect(orcaopsRecapSkill.description).toContain('time window or git range');
  });

  it('names each recap format in the selection description', () => {
    const d = orcaopsRecapSkill.description;
    expect(d).toMatch(/standup/);
    expect(d).toMatch(/changelog/);
    expect(d).toMatch(/journal/);
  });

  it('keeps detailed routing in the body', () => {
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
    expect(body).toContain("Compute the user's requested local calendar window first");
    expect(body).toContain('convert its\n   start and end to explicit UTC instants');
    expect(body).not.toContain('Compute the window as **UTC dates**');
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
  it('is a default-on review skill with a red-team cue', () => {
    expect(orcaopsAdversarialReviewSkill.group).toBe('review');
    expect(orcaopsAdversarialReviewSkill.defaultEnabled).toBe(true);
    expect(orcaopsAdversarialReviewSkill.description).toMatch(/red-team/i);
  });

  it('body pins the trigger phrases and skip conditions', () => {
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
    expect(body).toMatch(/Investigate possible non-goal violations/);
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

  it('requires evidence before calling a non-goal violation and offers valid remediation', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill);
    expect(body).toContain('Touching a\n   related file is a reason to inspect the actual change');
    expect(body).toContain('Never claim a\ncompleted step again');
    expect(body).toContain('summarized artifact, capture remediation in a follow-up artifact');
    expect(body).not.toContain('REFUTED criterion → reopen the work');
  });

  it('cross-refs resolve under a custom prefix', () => {
    const body = bodyOf(orcaopsAdversarialReviewSkill, 'oo');
    expect(body).toContain('`oo-pre-pr`');
    expect(body).toContain('`oo-digest`');
    expect(body).not.toContain('${');
  });
});
