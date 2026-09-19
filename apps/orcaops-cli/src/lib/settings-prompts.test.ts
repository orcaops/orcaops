import { describe, expect, it } from 'vitest';

import {
  ALWAYS_DROPPED_HINT_KEY,
  renderableHintKeys,
  resolveBootstrapContent,
} from '@orcaops/adapters';
import type { HintKey } from '@orcaops/storage';

import { blockPrompt, hintsPrompt, sessionHooksPrompt } from './settings-prompts.js';

describe('settings prompt copy', () => {
  it('names the repository instruction files — personal scope has none to offer', () => {
    const prompt = blockPrompt();
    expect(prompt.message).toContain('AGENTS.md / CLAUDE.md');
    expect(prompt.message).not.toContain('CLAUDE.local.md');
    expect(prompt.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hint: expect.stringContaining('added to AGENTS.md / CLAUDE.md'),
        }),
        expect.objectContaining({
          hint: 'AGENTS.md / CLAUDE.md will never be edited by orcaops',
        }),
      ])
    );
  });

  it('describes the consequence of turning session hooks off', () => {
    const withoutInstructions = sessionHooksPrompt('manual');
    expect(withoutInstructions.message).not.toContain('instructions file');
    expect(withoutInstructions.options.find(({ value }) => value === 'off')?.hint).toBe(
      'no automatic workflow guidance'
    );

    const withInstructions = sessionHooksPrompt('managed');
    expect(withInstructions.options.find(({ value }) => value === 'off')?.hint).toBe(
      'rely on the instructions-file section alone'
    );
    expect(withInstructions.options.find(({ value }) => value === 'state-aware')?.hint).toContain(
      'worst case: unhelpful guidance — never a broken session'
    );
  });

  it('sends users through the custom-reminder editor', () => {
    expect(hintsPrompt.message).toContain('add your own free-form lines next');
    expect(hintsPrompt.message).not.toContain('config.json');
  });

  it('offers no reminder the default skill set already states', () => {
    // A bare set renders neither hint-stating phase, masking this entirely.
    const renderability = { enabledSkills: undefined, commitInsideWindow: true };
    const rendered = (key: HintKey): string[] =>
      resolveBootstrapContent({
        prefix: 'orcaops',
        enabledSkills: renderability.enabledSkills,
        hints: { keys: [key], custom: [] },
        commitInsideWindow: renderability.commitInsideWindow,
        suppressedRouting: [],
      }).hints;

    const offered = hintsPrompt.options(renderability).map((o) => o.value);
    expect(offered).toEqual(renderableHintKeys(renderability));
    for (const key of offered) expect(rendered(key), key).toHaveLength(1);
    for (const key of [
      ALWAYS_DROPPED_HINT_KEY,
      'capture-on-nontrivial',
      'open-checkpoint-before-edits',
    ] as HintKey[]) {
      expect(offered, key).not.toContain(key);
      expect(rendered(key), key).toEqual([]);
    }
  });

  it('keeps a reminder the config already pins, saying what renders it instead', () => {
    const renderability = { enabledSkills: undefined, commitInsideWindow: true };
    const offered = hintsPrompt.options(renderability, ['capture-on-nontrivial']);

    const pinned = offered.find((o) => o.value === 'capture-on-nontrivial');
    expect(pinned?.hint).toContain('plan lifecycle step');
    expect(offered.map((o) => o.value)).toEqual([
      'capture-on-nontrivial',
      ...renderableHintKeys(renderability),
    ]);
  });
});
