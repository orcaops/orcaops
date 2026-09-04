import { describe, expect, it } from 'vitest';

import { SUPPORTED_AGENT_IDS } from '@orcaops/storage';

import { getAgentOverlay, overlayBackedToolIds } from './overlay.js';
import { getAgentSkillsDirs, getToolAdapter } from './registry.js';
import { SKILL_TEMPLATES } from './skills/index.js';
import type { ToolId } from './types.js';

describe('agent overlay', () => {
  it('the overlay-backed ids match storage SUPPORTED_AGENT_IDS exactly', () => {
    // Parity guard (mirrors the curated-hints catalog guard): `config.install.agents`
    // is `z.enum(SUPPORTED_AGENT_IDS)` in storage, but the install SURFACE
    // (instructionFiles/commands/skill placement) lives in this overlay. Adding an
    // overlay row without adding the id to SUPPORTED_AGENT_IDS (or vice-versa) would
    // let `init`/`update` accept an id with no overlay (or seed an id init can't
    // install). Keeping both lists in lockstep is the forcing function.
    expect([...overlayBackedToolIds()].sort()).toEqual([...SUPPORTED_AGENT_IDS].sort());
  });

  it('is declared in SUPPORTED_AGENT_IDS order (drives the canonical install-set sort)', () => {
    expect(overlayBackedToolIds()).toEqual([...SUPPORTED_AGENT_IDS]);
  });

  it('every supported id resolves to an overlay', () => {
    for (const id of SUPPORTED_AGENT_IDS) {
      expect(getAgentOverlay(id)).toBeDefined();
    }
  });

  it('sessionHooks capability is declared for exactly the v1 hook targets', () => {
    // The overlay is the single source of truth for the bootstrap ladder's top
    // rung: init's recommendation, the settings planner, and the
    // `hook session-start` output formatter all derive from these rows. A row
    // added or dropped here silently changes what init installs — pin the set.
    const withHooks = overlayBackedToolIds().filter(
      (id) => getAgentOverlay(id)!.sessionHooks !== undefined
    );
    expect(withHooks).toEqual(['claude-code', 'codex', 'cursor', 'opencode']);
    for (const id of withHooks) {
      const sh = getAgentOverlay(id)!.sessionHooks!;
      // Cursor parses hook stdout as {additional_context}; codex (0.146+)
      // requires the hookSpecificOutput envelope; OpenCode is the only
      // plugin-file target (no declarative hook config); codex is
      // machine-config-only — capable, but no project hook file surface.
      expect(sh.payload).toBe(
        id === 'cursor' ? 'cursor-json' : id === 'codex' ? 'codex-json' : 'text'
      );
      expect(sh.kind).toBe(
        id === 'opencode' ? 'plugin-file' : id === 'codex' ? 'machine-config' : 'settings-json'
      );
      expect(getToolAdapter(id)!.sessionHooks).toEqual(sh);
    }
  });

  it('gives codex a user-level hooks.json surface and no project settings file', () => {
    const sh = getAgentOverlay('codex')!.sessionHooks!;
    expect(sh).toEqual({
      kind: 'machine-config',
      path: 'config.toml',
      payload: 'codex-json',
      matcher: 'startup|resume',
      userFile: 'hooks.json',
    });
    // The project settings planner selects on `settings-json`, so a
    // `machine-config` row carrying a userFile yields a user-level spec only.
    expect(sh.kind).not.toBe('settings-json');
  });

  it('declares a user-level hook file for exactly the machine-registerable agents', () => {
    const withUserFile = overlayBackedToolIds().filter(
      (id) => getAgentOverlay(id)!.sessionHooks?.userFile !== undefined
    );
    expect(withUserFile).toEqual(['claude-code', 'codex']);
  });

  it('uses parallel seed orchestration only on the independently rendered Claude tree', () => {
    expect(getAgentOverlay('claude-code')!.subagentOrchestration).toBe('parallel');
    for (const id of overlayBackedToolIds().filter((id) => id !== 'claude-code')) {
      expect(getAgentOverlay(id)!.subagentOrchestration, id).toBe('none');
    }
  });

  it('agents sharing a skillsDir render byte-identical skill files', () => {
    // The install planner dedupes generated files by path FIRST-WINS with no
    // conflict detection (install-plan.ts), so every overlay-backed agent
    // sharing a skillsDir (codex/cursor/opencode all use the universal
    // `.agents/skills`) MUST render byte-identical skills — otherwise the
    // surviving bytes would depend on install-set order. Practically this pins
    // `skillFrontmatterTags` (the only per-agent render variable) equal within
    // a shared dir.
    const byDir = new Map<string, ToolId[]>();
    for (const id of overlayBackedToolIds()) {
      const dir = getAgentSkillsDirs(id)!.skillsDir;
      byDir.set(dir, [...(byDir.get(dir) ?? []), id]);
    }
    const shared = [...byDir.values()].filter((ids) => ids.length > 1);
    // Guard the guard: the universal dir IS shared today.
    expect(shared.length).toBeGreaterThan(0);
    for (const ids of shared) {
      const [first, ...rest] = ids.map((id) => getToolAdapter(id)!);
      for (const skill of SKILL_TEMPLATES) {
        const path = first.skills!.filePath(skill.id);
        const bytes = first.skills!.format(skill, { generatedBy: 'X' });
        for (const other of rest) {
          expect(other.skills!.filePath(skill.id)).toBe(path);
          expect(other.skills!.format(skill, { generatedBy: 'X' })).toBe(bytes);
        }
      }
    }
  });
});
