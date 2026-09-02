import { describe, expect, it } from 'vitest';

import { CLOUD_PIN_SCHEME, CLOUD_SURFACE_COMMANDS } from '../cloud-surface.js';
import { SKILL_TEMPLATES } from './index.js';
import { SYNC_SIGNAL_STEERING } from './sync-signal-steering.js';
import { claudeCodeAdapter } from '../tools/claude-code.js';

/** The skills whose commands actually emit `cloud_sync`. */
const EMITTERS = ['capture', 'checkpoint', 'pre-pr', 'summary'];

const render = (id: string): string => {
  const skill = SKILL_TEMPLATES.find((s) => s.id === id);
  expect(skill, `SKILL_TEMPLATES is missing "${id}"`).toBeDefined();
  return claudeCodeAdapter.skills!.format(skill!, { generatedBy: '0.0.5' });
};

describe('SYNC_SIGNAL_STEERING', () => {
  it('instructs the agent to STOP on a paused sync and quote the envelope', () => {
    // The only instruction telling an agent to halt; without it a revoked
    // session captures on in silence.
    expect(SYNC_SIGNAL_STEERING).toContain('STOP');
    expect(SYNC_SIGNAL_STEERING).toContain('cloud_sync.message');
    expect(SYNC_SIGNAL_STEERING).toContain('cloud_sync.action');
    expect(SYNC_SIGNAL_STEERING).toContain('`"paused"`');
  });

  it('does not claim a replay skips the upload', () => {
    // A replay skips the eager push, but the same command's drain re-attempts
    // once the backoff elapses — the advice is right, the mechanism claim was not.
    expect(SYNC_SIGNAL_STEERING).not.toMatch(/does not resend/i);
  });

  it('names no cloud command and no cloud pin scheme', () => {
    // Ships in committed files on a public install, so it must describe the
    // field without naming the product behind it.
    for (const command of CLOUD_SURFACE_COMMANDS) {
      expect(SYNC_SIGNAL_STEERING, `names "orcaops ${command}"`).not.toContain(
        `orcaops ${command}`
      );
    }
    expect(SYNC_SIGNAL_STEERING).not.toContain(CLOUD_PIN_SCHEME);
  });

  it.each(EMITTERS)('is rendered into the ungated "%s" skill', (id) => {
    expect(render(id)).toContain('Capture sync signal');
  });

  it.each(EMITTERS)('does not give "%s" the cloud-gated remediation', (id) => {
    expect(render(id)).not.toContain('Cloud sync signal — do not ignore');
  });

  it('is not appended to a read-side skill that never emits cloud_sync', () => {
    expect(render('digest')).not.toContain('Capture sync signal');
  });
});
