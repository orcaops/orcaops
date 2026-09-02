import { describe, expect, it } from 'vitest';

import { renderOrcaopsAgentsMdSection } from './agents-md/template.js';
import { CLOUD_PIN_SCHEME, CLOUD_SURFACE_COMMANDS } from './cloud-surface.js';
import { COMMAND_TEMPLATES } from './commands/index.js';
import { SKILL_TEMPLATES } from './skills/index.js';
import type { SkillTemplate } from './types.js';

/**
 * Skill files and the managed block are committed, so content that varies with
 * cloud state churns in git between a logged-in author and a teammate without
 * credentials — and steers a public install toward a product it cannot reach.
 */

/**
 * Derived from the shared surface rather than hand-written prose, so it cannot
 * fall behind `program.ts`, and so anchoring each verb to `orcaops <verb>` keeps
 * the ungated local review engine's own verbs (`review routine-start`,
 * `review comments`, …) from colliding with the cloud collaboration ones.
 *
 * The cloud-gated skill IDS are included too: a bare cross-reference like
 * `**orcaops-plan-approval**` names no command, but it routes a
 * credential-less agent to a skill that is never installed.
 */
const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const CLOUD_REFERENCE = new RegExp(
  [
    `orcaops (?:${CLOUD_SURFACE_COMMANDS.map(esc).join('|')})\\b`,
    ...SKILL_TEMPLATES.filter((t) => (t.requires ?? []).includes('cloud')).map(
      (t) => `\\borcaops-${esc(t.id)}\\b`
    ),
    esc(CLOUD_PIN_SCHEME),
  ].join('|'),
  'i'
);

const isCloudGated = (t: SkillTemplate): boolean => (t.requires ?? []).includes('cloud');

const renderBody = (t: SkillTemplate): string =>
  typeof t.body === 'function' ? t.body('orcaops') : t.body;

describe('cloud content is confined to cloud-gated files', () => {
  const ungated = SKILL_TEMPLATES.filter((t) => !isCloudGated(t));

  it('flags a bare cross-reference to a cloud-gated skill', () => {
    // The literal string that shipped in the ungated capture skill while the
    // guard passed: no command, no colon, so the old verb-only pattern missed
    // it — and it routed a credential-less agent to a skill never installed.
    expect('(see the **orcaops-plan-approval** skill)').toMatch(CLOUD_REFERENCE);
  });

  it('flags the cloud verbs and the cloud pin scheme', () => {
    for (const sample of [
      'run `orcaops resync --force`',
      'with `orcaops plan pull`',
      'run `orcaops login`',
      '`cloud:<externalId>@<version>`',
      'the **orcaops-review** skill',
    ]) {
      expect(sample, `should be flagged: ${sample}`).toMatch(CLOUD_REFERENCE);
    }
  });

  it('does not flag the ungated local review engine or ordinary prose', () => {
    // Anchoring on `orcaops <verb>` is what keeps these clear — a bare
    // `review status` pattern would fail the guard on correct code.
    for (const sample of [
      'orcaops review routine-start',
      'orcaops review comment reply',
      'orcaops review comments',
      'branch on `cloud_sync.status`',
      'run `orcaops rebuild`',
      'the orcaops-task-review skill',
    ]) {
      expect(sample, `should NOT be flagged: ${sample}`).not.toMatch(CLOUD_REFERENCE);
    }
  });

  it('covers every cloud-gated skill id, so ungating one cannot weaken it', () => {
    for (const t of SKILL_TEMPLATES.filter(isCloudGated)) {
      expect(`the **orcaops-${t.id}** skill`).toMatch(CLOUD_REFERENCE);
    }
  });

  it('has both gated and ungated templates to compare', () => {
    // Without this, dropping `requires: ['cloud']` makes everything below vacuous.
    expect(SKILL_TEMPLATES.filter(isCloudGated).length).toBeGreaterThan(0);
    expect(ungated.length).toBeGreaterThan(10);
  });

  it.each(ungated.map((t) => [t.id, t] as const))(
    'ungated skill "%s" body carries no cloud steering',
    (_id, template) => {
      // No allowlist: the one former exception was a `cloud:` paragraph in the
      // ungated capture skill, whose content already lives in plan-approval.
      // Deleting it lets this guard be absolute.
      const body = renderBody(template);
      expect(body).not.toMatch(CLOUD_REFERENCE);
    }
  );

  it.each(ungated.map((t) => [t.id, t] as const))(
    'ungated skill "%s" description carries no cloud steering',
    (_id, template) => {
      // Descriptions drive skill selection, so a reference here routes a
      // credential-less user to a skill that is not installed.
      expect(template.description).not.toMatch(CLOUD_REFERENCE);
    }
  );

  it('no cloud-gated template declares a blockTriggerLine', () => {
    // A trigger line reaches the committed block only on machines with a
    // session, forking it between teammates.
    for (const t of SKILL_TEMPLATES.filter(isCloudGated)) {
      expect(t.blockTriggerLine, `"${t.id}" must not contribute a block entry`).toBeUndefined();
    }
  });

  it('slash commands carry no cloud steering', () => {
    // CommandTemplate has no `requires`, so every command ships to every install.
    for (const c of COMMAND_TEMPLATES) {
      const body = typeof c.body === 'function' ? c.body('orcaops') : c.body;
      expect(body, `command "${c.id}" references the cloud`).not.toMatch(CLOUD_REFERENCE);
    }
  });

  it('the default managed block render carries no cloud steering', () => {
    expect(renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-guard' })).not.toMatch(
      CLOUD_REFERENCE
    );
  });

  it('the managed block is byte-identical with and without the cloud skills', () => {
    const withoutCloud = SKILL_TEMPLATES.filter((t) => !isCloudGated(t));
    expect(
      renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-guard', enabledSkills: SKILL_TEMPLATES })
    ).toBe(
      renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0-guard', enabledSkills: withoutCloud })
    );
  });
});
