import { describe, expect, it } from 'vitest';

import { orcaopsAdversarialReviewSkill } from './orcaops-adversarial-review.js';
import { orcaopsDigestSkill } from './orcaops-digest.js';
import { orcaopsDoctorSkill } from './orcaops-doctor.js';
import { orcaopsPlanCritiqueSkill } from './orcaops-plan-critique.js';
import { orcaopsResumeSkill } from './orcaops-resume.js';
import { orcaopsTimetravelSkill } from './orcaops-timetravel.js';
import { digestCommand } from '../commands/digest.js';
import type { SkillTemplate } from '../types.js';

const bodyText = (skill: SkillTemplate): string =>
  typeof skill.body === 'function' ? skill.body('orcaops') : skill.body;

describe('skill command accuracy', () => {
  it('uses current show and reconcile response paths', () => {
    const timetravel = bodyText(orcaopsTimetravelSkill);
    expect(timetravel).toContain('orcaops show <id> --json');
    expect(timetravel).not.toContain('orcaops show --artifact');

    const adversarial = bodyText(orcaopsAdversarialReviewSkill);
    expect(adversarial).toContain('`window.uncovered_commits`');
    expect(adversarial).toContain('`window.ambiguous_coverage_commits`');
    expect(adversarial).toContain('`pre_summary.uncovered_commits`');
  });

  it('describes digest fields and file output as implemented', () => {
    const digest = bodyText(orcaopsDigestSkill);
    const command =
      typeof digestCommand.body === 'function' ? digestCommand.body('orcaops') : digestCommand.body;
    expect(digest).toContain('`data.title.text`');
    expect(digest).toContain('when `data.title` is non-null');
    expect(digest).toContain('`data.changes`');
    expect(digest).toContain('`data.open_items`');
    expect(digest).not.toContain('the "why" section');
    expect(digest).toContain('prints only a confirmation on stdout');
    expect(command).toContain('write to file; stdout confirms the path');
    expect(command).not.toContain('in addition to stdout');
  });

  it('keeps repo-wide planning queries branch-wide and labels prior states honestly', () => {
    const critique = bodyText(orcaopsPlanCritiqueSkill);
    expect(critique).toContain('orcaops decisions --all-branches --json');
    expect(critique).toContain('orcaops loose-ends --all-branches --json');
    expect(critique).toContain('distinguish active, interrupted, abandoned, and unsummarized work');
    expect(critique).not.toContain('attempts that DIED');
    expect(critique).toContain('draft section');
  });

  it('requires repair consent and current resume state messages', () => {
    const doctor = bodyText(orcaopsDoctorSkill);
    expect(doctor).toContain('`--fix` only when the user explicitly asks for repair');

    const resume = bodyText(orcaopsResumeSkill);
    expect(resume).toContain('`repo_state` note');
    expect(resume).toContain('work may already be partly done');
    expect(resume).not.toContain('resume context may be stale');
  });
});
