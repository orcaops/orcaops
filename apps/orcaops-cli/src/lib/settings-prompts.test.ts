import { describe, expect, it } from 'vitest';

import { blockPrompt, hintsPrompt, sessionHooksPrompt } from './settings-prompts.js';

describe('settings prompt copy', () => {
  it('names the instruction files for the selected scope', () => {
    const personal = blockPrompt('personal');
    expect(personal.message).toContain('CLAUDE.local.md');
    expect(personal.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hint: expect.stringContaining('added to CLAUDE.local.md') }),
        expect.objectContaining({ hint: 'CLAUDE.local.md will never be edited by orcaops' }),
      ])
    );
    expect(personal.message).not.toContain('AGENTS.md');

    const project = blockPrompt('project');
    expect(project.message).toContain('AGENTS.md / CLAUDE.md');
    expect(project.options).toEqual(
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
});
