import { buildToolAdapter } from '../registry.js';
import type { ToolAdapter } from '../types.js';

/**
 * Claude Code adapter.
 *
 * Assembled data-driven via `buildToolAdapter`: the vendored
 * `@orcaops/agent-targets` registry supplies the skill dir (`.claude/skills`),
 * and the orcaops overlay supplies the command root (`.claude/commands`), the
 * instruction files (`AGENTS.md` + `CLAUDE.md`), and display metadata. This thin
 * re-export preserves the public `claudeCodeAdapter` import path.
 *
 * Skills:   `.claude/skills/${prefix}-<verb>/SKILL.md`
 * Commands: `.claude/commands/${prefix}/<verb>.md`
 */
export const claudeCodeAdapter: ToolAdapter = buildToolAdapter('claude-code')!;
