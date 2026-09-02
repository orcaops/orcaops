import { describe, expect, expectTypeOf, it } from 'vitest';

import { getAgentConfig } from '@orcaops/agent-targets';

import { COMMAND_TEMPLATES } from './commands/index.js';
import { commandRef, skillRef } from './refs.js';
import { buildToolAdapter, getToolAdapter, listToolAdapters } from './registry.js';
import { makeCommandRenderer, makeSkillRenderer } from './renderers.js';
import { SKILL_TEMPLATES } from './skills/index.js';
import type { SkillId, ToolId } from './types.js';

describe('data-driven adapter registry', () => {
  it('renders every skill and command path slash-only, for every adapter', () => {
    // Manifest paths are slash-only by contract, so a platform separator never
    // matches a recorded path and breaks substring checks like init's
    // skill/command split.
    for (const adapter of listToolAdapters()) {
      for (const skill of SKILL_TEMPLATES) {
        for (const prefix of ['orcaops', 'oo']) {
          expect(
            adapter.skills?.filePath(skill.id, prefix) ?? '',
            `${adapter.id} skill ${skill.id}`
          ).not.toContain('\\');
        }
      }
      for (const command of COMMAND_TEMPLATES) {
        expect(
          adapter.commands?.filePath(command.id, 'orcaops') ?? '',
          `${adapter.id} command ${command.id}`
        ).not.toContain('\\');
      }
    }
  });

  it('builds claude-code from the vendored registry skillsDir + the overlay (no hardcoded paths)', () => {
    const a = getToolAdapter('claude-code')!;
    expect(a.skills!.filePath('capture')).toBe('.claude/skills/orcaops-capture/SKILL.md');
    expect(a.commands!.filePath('status')).toBe('.claude/commands/orcaops/status.md');
    expect(a.agentsFiles).toEqual(['AGENTS.md', 'CLAUDE.md']);
    // The skill dir is sourced from the vendored registry, not a constant baked
    // into the adapter file.
    expect(getAgentConfig('claude-code').skillsDir).toBe('.claude/skills');
  });

  it('builds codex AGENTS.md-only with no commands and no frontmatter tags', () => {
    const a = getToolAdapter('codex')!;
    expect(a.commands).toBeNull();
    expect(a.agentsFiles).toEqual(['AGENTS.md']);
    expect(a.skills!.filePath('capture')).toBe('.agents/skills/orcaops-capture/SKILL.md');
    const out = a.skills!.format(
      { id: 'capture', name: 'X', description: 'd', tags: ['orcaops'], body: 'b' },
      { generatedBy: '0' }
    );
    expect(out).not.toContain('tags:');
  });

  it('lists exactly the overlay-backed install targets', () => {
    expect(listToolAdapters().map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'opencode',
      'aider-desk',
      'github-copilot',
      'antigravity-cli',
    ]);
  });

  it('returns undefined for registry-detectable but non-overlay agents', () => {
    // Every ToolId is overlay-backed; the defensive branch still guards a
    // registry-only id arriving through a cast (e.g. config from a newer CLI).
    expect(getToolAdapter('gemini-cli' as ToolId)).toBeUndefined();
    expect(buildToolAdapter('gemini-cli' as ToolId)).toBeUndefined();
  });

  it('builds cursor with flat body-only commands and shared universal skills', () => {
    const a = getToolAdapter('cursor')!;
    expect(a.skills!.filePath('capture')).toBe('.agents/skills/orcaops-capture/SKILL.md');
    // Flat layout: the Cursor CLI reads only top-level .md files.
    expect(a.commands!.filePath('status')).toBe('.cursor/commands/orcaops-status.md');
    const cmd = a.commands!.format(
      { id: 'status', description: 'd', body: 'b' },
      { generatedBy: '1.2.3' }
    );
    // Body-only (no frontmatter) with the stamp as an HTML comment that still
    // matches the drift/staleness regex.
    expect(cmd).not.toContain('---');
    expect(cmd).toMatch(/generatedBy:\s*"orcaops@1\.2\.3"/);
    expect(a.agentsFiles).toEqual(['AGENTS.md']);
  });

  it('builds github-copilot skills-only, like codex, on the universal dir', () => {
    const a = getToolAdapter('github-copilot')!;
    expect(a.commands).toBeNull();
    expect(a.agentsFiles).toEqual(['AGENTS.md']);
    expect(a.skills!.filePath('capture')).toBe('.agents/skills/orcaops-capture/SKILL.md');
    const out = a.skills!.format(
      { id: 'capture', name: 'X', description: 'd', tags: ['orcaops'], body: 'b' },
      { generatedBy: '0' }
    );
    expect(out).not.toContain('tags:');
  });

  it('builds antigravity-cli as a skills-only universal-dir target', () => {
    const a = getToolAdapter('antigravity-cli')!;
    expect(a.status).toBe('beta');
    expect(a.commands).toBeNull();
    expect(a.agentsFiles).toEqual(['AGENTS.md']);
    expect(a.skills!.filePath('capture')).toBe('.agents/skills/orcaops-capture/SKILL.md');
    const out = a.skills!.format(
      { id: 'capture', name: 'X', description: 'd', tags: ['orcaops'], body: 'b' },
      { generatedBy: '0' }
    );
    expect(out).not.toContain('tags:');
  });

  it('builds opencode + aider-desk with nested minimal-frontmatter commands', () => {
    const oc = getToolAdapter('opencode')!;
    expect(oc.skills!.filePath('capture')).toBe('.agents/skills/orcaops-capture/SKILL.md');
    expect(oc.commands!.filePath('status')).toBe('.opencode/commands/orcaops/status.md');

    const ad = getToolAdapter('aider-desk')!;
    expect(ad.skills!.filePath('capture')).toBe('.aider-desk/skills/orcaops-capture/SKILL.md');
    expect(ad.commands!.filePath('status')).toBe('.aider-desk/commands/orcaops/status.md');
    const cmd = ad.commands!.format(
      { id: 'status', description: 'd "x"', body: 'b' },
      { generatedBy: '1.2.3' }
    );
    // Minimal frontmatter: exactly the description key AiderDesk requires, plus
    // the stamp comment in the body.
    expect(cmd).toContain('description: "d \\"x\\""');
    expect(cmd).not.toContain('name:');
    expect(cmd).not.toContain('metadata:');
    expect(cmd).toMatch(/generatedBy:\s*"orcaops@1\.2\.3"/);
  });
});

describe('naming-prefix mechanism (render-time)', () => {
  it('threads a custom prefix through skill + command paths and the derived command name', () => {
    const skills = makeSkillRenderer('.claude/skills', { includeTags: true });
    const commands = makeCommandRenderer('.claude/commands', {
      layout: 'nested',
      frontmatter: 'full',
    });
    expect(skills.filePath('capture', 'oo')).toBe('.claude/skills/oo-capture/SKILL.md');
    expect(commands.filePath('status', 'oo')).toBe('.claude/commands/oo/status.md');
    const cmd = commands.format(
      { id: 'status', description: 'd', body: 'b' },
      { generatedBy: '1', prefix: 'oo' }
    );
    expect(cmd).toContain('name: "oo:status"');
  });

  it('default prefix reproduces orcaops naming; refs accept an override', () => {
    expect(skillRef('digest')).toBe('orcaops-digest');
    expect(commandRef('show')).toBe('orcaops:show');
    expect(skillRef('digest', 'oo')).toBe('oo-digest');
    expect(commandRef('show', 'oo')).toBe('oo:show');
    expectTypeOf<'debug-provenance'>().not.toExtend<SkillId>();
  });
});
