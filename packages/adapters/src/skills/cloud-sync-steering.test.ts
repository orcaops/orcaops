import { describe, expect, it } from 'vitest';

import { CLOUD_SYNC_REASONS } from '@orcaops/storage';

import { CLOUD_SYNC_STEERING } from './cloud-sync-steering.js';
import { SKILL_TEMPLATES } from './index.js';
import { claudeCodeAdapter } from '../tools/claude-code.js';

/**
 * Content golden for the agent-facing `cloud_sync` steering. doctor only checks
 * the generatedBy VERSION STAMP, not the body — so a steering edit shipped
 * without a CLI version bump would leave the committed SKILL.md goldens stale and
 * undetected. This pins the body: it fails if a status or reason is dropped, so
 * the steering and the honest 3-status contract can't silently drift apart.
 */
describe('CLOUD_SYNC_STEERING content', () => {
  it('documents all three statuses', () => {
    expect(CLOUD_SYNC_STEERING).toContain('`"ok"`');
    expect(CLOUD_SYNC_STEERING).toContain('`"paused"`');
    expect(CLOUD_SYNC_STEERING).toContain('`"skipped"`');
  });

  it('documents every reason with its remediation', () => {
    // Derived from the runtime vocabulary, not a hand-kept copy: the previous
    // hardcoded list had already fallen behind by two reasons
    // (`upgrade_required`, `no_cloud_configured`), which is exactly the drift
    // this golden exists to catch.
    for (const reason of CLOUD_SYNC_REASONS) {
      expect(CLOUD_SYNC_STEERING, `reason "${reason}" is undocumented`).toContain(reason);
    }
    // actionable (paused) reasons name their fix
    expect(CLOUD_SYNC_STEERING).toContain('orcaops resync');
    expect(CLOUD_SYNC_STEERING).toContain('orcaops resync --force');
    expect(CLOUD_SYNC_STEERING).not.toContain('ORCAOPS_BASE_URL');
    expect(CLOUD_SYNC_STEERING).not.toContain('--base-url');
    // the non-retryable content fault steers to scrub+rebuild, NOT resync
    expect(CLOUD_SYNC_STEERING).toContain('orcaops rebuild');
    expect(CLOUD_SYNC_STEERING).toContain('NOT retryable');
    // benign (skipped) reasons are framed as no-action
    expect(CLOUD_SYNC_STEERING).toContain('No action needed');
  });

  it('is appended to the CLOUD-GATED skills (rendered output carries it)', () => {
    const planApproval = SKILL_TEMPLATES.find((s) => s.id === 'plan-approval');
    expect(planApproval).toBeDefined();
    const rendered = claudeCodeAdapter.skills!.format(planApproval!, { generatedBy: '0.0.5' });
    expect(rendered).toContain('Cloud sync signal — do not ignore');
    expect(rendered).toContain('`"skipped"`');
  });

  it('also ships to the review skill', () => {
    const review = SKILL_TEMPLATES.find((s) => s.id === 'review');
    expect(review).toBeDefined();
    expect(claudeCodeAdapter.skills!.format(review!, { generatedBy: '0.0.5' })).toContain(
      'Cloud sync signal — do not ignore'
    );
  });

  it('is NOT appended to the ungated lifecycle skills', () => {
    // Their SKILL.md files are committed, so this text — which names cloud
    // commands — would fork them between teammates and advertise the product to
    // an install that cannot reach it. They carry SYNC_SIGNAL_STEERING instead.
    for (const id of ['capture', 'checkpoint', 'pre-pr', 'summary']) {
      const skill = SKILL_TEMPLATES.find((s) => s.id === id);
      expect(skill, `SKILL_TEMPLATES is missing "${id}"`).toBeDefined();
      const rendered = claudeCodeAdapter.skills!.format(skill!, { generatedBy: '0.0.5' });
      expect(rendered, `"${id}" must not carry the cloud-sync steering`).not.toContain(
        'Cloud sync signal — do not ignore'
      );
    }
  });
});
