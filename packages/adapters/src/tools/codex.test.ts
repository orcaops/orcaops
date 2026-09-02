import { describe, expect, it } from 'vitest';

import { codexAdapter } from './codex.js';

describe('codexAdapter', () => {
  it('skills live at .agents/skills/<id>/SKILL.md (Codex per-project skill path)', () => {
    expect(codexAdapter.skills?.filePath('capture')).toBe(
      '.agents/skills/orcaops-capture/SKILL.md'
    );
  });

  it('does not expose a commands renderer (Codex deprecated custom prompts in favor of skills)', () => {
    expect(codexAdapter.commands).toBeNull();
  });

  it('skill frontmatter has name + description + generatedBy stamp', () => {
    const out = codexAdapter.skills!.format(
      {
        id: 'capture',
        name: 'Orcaops Capture',
        description: 'Capture plans and checkpoints into the artifact thread.',
        body: 'Body text here.',
      },
      { generatedBy: '0.0.0' }
    );
    expect(out).toMatch(/^---\n/);
    expect(out).toMatch(/name: "Orcaops Capture"/);
    expect(out).toMatch(/description: "Capture plans and checkpoints into the artifact thread\."/);
    expect(out).toMatch(/generatedBy: "orcaops@0\.0\.0"/);
    expect(out).toMatch(/---\n\nBody text here\./);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('escapes embedded double quotes in values', () => {
    const out = codexAdapter.skills!.format(
      {
        id: 'x',
        name: 'has "quotes" inside',
        description: 'd',
        body: 'b',
      },
      { generatedBy: '0' }
    );
    expect(out).toMatch(/name: "has \\"quotes\\" inside"/);
  });

  it('reports stable status', () => {
    expect(codexAdapter.status).toBe('stable');
  });

  it('uses .agents/skills (the multi-tool standard) rather than .codex/skills', () => {
    // Sanity check: per Codex docs, .agents/skills is the canonical
    // project-level skill location and is read by Codex from CWD up to
    // repo root. .codex/skills is NOT scanned, so picking that path
    // would silently break discovery.
    const target = codexAdapter.skills!.filePath('any-id');
    expect(target.startsWith('.agents/skills/')).toBe(true);
    expect(target.startsWith('.codex/')).toBe(false);
  });
});
