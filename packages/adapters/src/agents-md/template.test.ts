import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { renderOrcaopsAgentsMdSection } from './template.js';
import { SKILL_TEMPLATES } from '../skills/index.js';

// Golden render at the default prefix with no hints (generatedBy
// '0.0.0-fixture'); regenerate with
// `renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-fixture' })`. The render
// MUST stay byte-identical to this at the default prefix + no hints.
const DEFAULT_FIXTURE = readFileSync(
  new URL('./__fixtures__/agents-md-default.txt', import.meta.url),
  'utf8'
);

describe('renderOrcaopsAgentsMdSection — prefix + hints', () => {
  it('is byte-identical to the pre-prefix output at the default prefix + no hints', () => {
    expect(renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-fixture' })).toBe(DEFAULT_FIXTURE);
    expect(
      renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-fixture', prefix: 'orcaops', hints: [] })
    ).toBe(DEFAULT_FIXTURE);
  });

  it('threads a custom prefix into skill names + globs, leaving binary/product/markers literal', () => {
    const out = renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9', prefix: 'oo' });
    // Prefixed: skill names, the skill family, and the skill-dir globs.
    expect(out).toContain('oo-capture');
    expect(out).toContain('oo-checkpoint');
    expect(out).toContain('The `oo-*` skills own');
    expect(out).toContain('.claude/skills/oo-*');
    expect(out).toContain('.agents/skills/oo-*');
    // NOT prefixed: the orcaops CLI binary, the product name, the managed markers.
    expect(out).toContain('orcaops status --json');
    expect(out).toContain('## Orcaops');
    expect(out).toContain('This repo uses **orcaops**');
    expect(out).toContain('<!-- orcaops:start v=9.9.9 -->');
    expect(out).toContain('<!-- orcaops:end -->');
    // No default-prefix skill residue.
    expect(out).not.toContain('orcaops-capture');
    expect(out).not.toContain('.claude/skills/orcaops-*');
  });

  it('enabled-set-aware: the whole body derives from the enabled skills', () => {
    // Omitting enabledSkills and passing the default-on ungated subset are
    // byte-identical (and identical to the fixture). The no-set fallback
    // excludes capability-gated templates because it cannot verify capabilities.
    const defaultOn = SKILL_TEMPLATES.filter(
      (s) => s.defaultEnabled !== false && (s.requires ?? []).length === 0
    );
    expect(
      renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-fixture', enabledSkills: defaultOn })
    ).toBe(DEFAULT_FIXTURE);
    const everySkill = renderOrcaopsAgentsMdSection({
      generatedBy: '0.0.0-fixture',
      enabledSkills: SKILL_TEMPLATES,
    });
    expect(everySkill).not.toBe(DEFAULT_FIXTURE);
    expect(everySkill).toContain('orcaops-loose-ends');
    expect(everySkill).toContain('orcaops-parallel-dispatch');

    // Disabling digest removes EVERY digest ref: the lifecycle headline, the
    // finish-chain step, and the read-intent entry.
    const noDigest = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'digest'),
    });
    expect(noDigest).not.toContain('orcaops-digest');
    expect(noDigest).toContain('plan → checkpoint(s) → finish.');
    expect(noDigest).toContain('invoke **`orcaops-finish`**');

    const finishOnly = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id === 'finish'),
    });
    expect(finishOnly).not.toContain('The granular  skills');
    expect(finishOnly).not.toContain('orcaops-pre-pr');

    const withoutFinish = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'finish'),
    });
    expect(withoutFinish).toContain('plan → checkpoint(s) → finish.');
    expect(withoutFinish).toContain('invoke **`orcaops-finish`**');

    // Disabling plan-approval drops its whole section.
    const noPlanApproval = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'plan-approval'),
    });
    expect(noPlanApproval).not.toContain('Cloud-approved plans');
    expect(noPlanApproval).not.toContain('orcaops-plan-approval');

    // Disabling resume drops its intent entry AND the survey tail that
    // references it.
    const noResume = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'resume'),
    });
    expect(noResume).not.toContain('orcaops-resume');
    expect(noResume).not.toContain('For broader survey questions');
  });

  it('an empty enabled set still renders the required finish lifecycle', () => {
    const out = renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9', enabledSkills: [] });
    expect(out).toContain('## Orcaops');
    expect(out).toContain('**Skip orcaops for:**');
    expect(out).not.toContain('orcaops-capture');
    expect(out).not.toContain('Read intents');
    expect(out).toContain('**Capture lifecycle: finish.**');
    expect(out).toContain('invoke **`orcaops-finish`**');
    expect(out).not.toContain('Full skill bodies live under');
    expect(out).toContain('<!-- orcaops:end -->');
  });

  it('an enabled skill with a blockTriggerLine contributes its intent entry', () => {
    const standupish = {
      id: 'standup',
      name: 'Standup',
      description: 'd',
      body: 'b',
      blockTriggerLine: (prefix: string) =>
        `standup / progress report ("what did I do this week?") → \`${prefix}-standup\``,
    };
    const out = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      enabledSkills: [...SKILL_TEMPLATES, standupish],
    });
    expect(out).toContain('what did I do this week?');
    expect(out).toContain('`orcaops-standup`');
    // It rides the read-intents paragraph, before the Attribution section.
    expect(out.indexOf('orcaops-standup')).toBeLessThan(out.indexOf('**Attribution.**'));
  });

  it('renders a Workflow Preferences sub-section only when hints are present', () => {
    expect(renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9' })).not.toContain(
      '### Workflow Preferences'
    );

    const withHints = renderOrcaopsAgentsMdSection({
      generatedBy: '9.9.9',
      hints: [
        'Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.',
        'Run pnpm -r test.',
      ],
    });
    expect(withHints).toContain('### Workflow Preferences');
    expect(withHints).toContain(
      '- Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.'
    );
    expect(withHints).toContain('- Run pnpm -r test.');
    // The sub-section sits INSIDE the managed block (before the end marker).
    const subIdx = withHints.indexOf('### Workflow Preferences');
    const endIdx = withHints.indexOf('<!-- orcaops:end -->');
    expect(subIdx).toBeGreaterThan(0);
    expect(subIdx).toBeLessThan(endIdx);
  });
});
