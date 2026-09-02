import { getAgentConfig } from '@orcaops/agent-targets';

import { getAgentOverlay, overlayBackedToolIds } from './overlay.js';
import { makeCommandRenderer, makeSkillRenderer } from './renderers.js';
import type { ToolAdapter, ToolId } from './types.js';

/**
 * Build a `ToolAdapter` from data. The `@orcaops/agent-targets`
 * registry supplies skill placement (`skillsDir`); the orcaops overlay supplies
 * the instruction-file + command surface and display metadata; the generic
 * renderers turn those into the concrete file layout. Adding a new agent is a
 * registry row + an overlay row — no bespoke adapter file, no hardcoded paths.
 *
 * Returns `undefined` for a tool id with no overlay, so `getToolAdapter` returns `undefined` for
 * unsupported agents.
 */
export function buildToolAdapter(id: ToolId): ToolAdapter | undefined {
  const overlay = getAgentOverlay(id);
  if (!overlay) return undefined;
  const cfg = getAgentConfig(overlay.registryAgent);
  return {
    id,
    name: overlay.name,
    status: overlay.status,
    skills: makeSkillRenderer(cfg.skillsDir, {
      includeTags: overlay.skillFrontmatterTags,
      subagentOrchestration: overlay.subagentOrchestration,
    }),
    commands:
      overlay.supportsCommands && overlay.commandRoot
        ? makeCommandRenderer(overlay.commandRoot, {
            layout: overlay.commandLayout ?? 'nested',
            frontmatter: overlay.commandFrontmatter ?? 'full',
          })
        : null,
    agentsFiles: overlay.instructionFiles,
    sessionHooks: overlay.sessionHooks ?? null,
  };
}

/**
 * The registry of supported AI tools, assembled once from the overlay in
 * declaration order. Stability labels live in the overlay and are surfaced by
 * doctor/update. Registry-detectable tools without an overlay remain excluded.
 */
export const TOOL_ADAPTERS: ReadonlyArray<ToolAdapter> = overlayBackedToolIds()
  .map((id) => buildToolAdapter(id))
  .filter((a): a is ToolAdapter => a !== undefined);

export function getToolAdapter(id: ToolId): ToolAdapter | undefined {
  return TOOL_ADAPTERS.find((a) => a.id === id);
}

/**
 * The project + global skills directories for an overlay-backed agent (from the
 * agent-target registry row). Exposes the registry's `skillsDir`/`globalSkillsDir`
 * without callers importing `@orcaops/agent-targets` directly (global scope).
 * `undefined` for an agent with no overlay.
 */
export function getAgentSkillsDirs(
  id: ToolId
): { skillsDir: string; globalSkillsDir: string | undefined } | undefined {
  const overlay = getAgentOverlay(id);
  if (!overlay) return undefined;
  const cfg = getAgentConfig(overlay.registryAgent);
  return { skillsDir: cfg.skillsDir, globalSkillsDir: cfg.globalSkillsDir };
}

export function listToolAdapters(): ReadonlyArray<ToolAdapter> {
  return TOOL_ADAPTERS;
}
