import { describe, expect, it } from 'vitest';

import { claudeCodeAdapter } from './claude-code.js';
import { CLOUD_SYNC_STEERING } from '../skills/cloud-sync-steering.js';
import { SKILL_TEMPLATES } from '../skills/index.js';

describe('claudeCodeAdapter', () => {
  it('skills live at .claude/skills/<id>/SKILL.md', () => {
    expect(claudeCodeAdapter.skills?.filePath('capture')).toBe(
      '.claude/skills/orcaops-capture/SKILL.md'
    );
  });

  it('commands live at .claude/commands/orcaops/<id>.md', () => {
    expect(claudeCodeAdapter.commands?.filePath('status')).toBe(
      '.claude/commands/orcaops/status.md'
    );
  });

  it('skill frontmatter includes generatedBy stamp', () => {
    const out = claudeCodeAdapter.skills!.format(
      {
        id: 'capture',
        name: 'Orcaops Capture',
        description: 'Capture plans and checkpoints into the artifact thread',
        body: 'Body text here.',
      },
      { generatedBy: '0.0.0' }
    );
    expect(out).toMatch(/^---\n/);
    expect(out).toMatch(/name: "Orcaops Capture"/);
    expect(out).toMatch(/description: "Capture plans and checkpoints into the artifact thread"/);
    expect(out).toMatch(/generatedBy: "orcaops@0\.0\.0"/);
    expect(out).toMatch(/---\n\nBody text here\./);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('command frontmatter includes generatedBy + tags when provided', () => {
    const out = claudeCodeAdapter.commands!.format(
      {
        id: 'status',
        description: 'Show artifact thread status',
        tags: ['orcaops', 'read-only'],
        body: 'Run `orcaops status --json`.',
      },
      { generatedBy: '0.1.2' }
    );
    // name is derived from the bare id at render time: `${prefix}:${id}`.
    expect(out).toMatch(/name: "orcaops:status"/);
    expect(out).toMatch(/tags: \["orcaops", "read-only"\]/);
    expect(out).toMatch(/orcaops@0\.1\.2/);
    expect(out).toMatch(/Run `orcaops status --json`\./);
  });

  it('escapes double quotes in values', () => {
    const out = claudeCodeAdapter.skills!.format(
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

  it('reports stable status for v1', () => {
    expect(claudeCodeAdapter.status).toBe('stable');
  });
});

describe('skill bodies render without function-source leakage', () => {
  // A `(prefix) => string` body interpolated into a template literal coerces to
  // its source text and corrupts the generated SKILL.md.
  const assertCleanRender = (id: string): string => {
    const skill = SKILL_TEMPLATES.find((s) => s.id === id);
    expect(skill, `SKILL_TEMPLATES is missing "${id}"`).toBeDefined();
    const out = claudeCodeAdapter.skills!.format(skill!, {
      generatedBy: '0.0.0',
      prefix: 'orcaops',
    });
    expect(out).not.toContain('(prefix) =>');
    expect(out).not.toContain('${skillRef');
    expect(out).not.toContain('${commandRef');
    return out;
  };

  // The cross-reference assertion proves the body function was called.
  for (const id of ['capture', 'checkpoint', 'pre-pr'] as const) {
    it(`${id} renders clean threaded markdown`, () => {
      const out = assertCleanRender(id);
      expect(out).toMatch(/orcaops-(capture|checkpoint|pre-pr|summary|digest|why)\b/);
    });
  }

  // String bodies: the steering wrap must not disturb them.
  for (const id of ['plan-approval', 'review'] as const) {
    it(`${id} renders clean markdown carrying the cloud-sync steering`, () => {
      expect(assertCleanRender(id)).toContain(CLOUD_SYNC_STEERING.trim());
    });
  }
});
