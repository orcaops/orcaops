import { buildToolAdapter } from '../registry.js';
import type { ToolAdapter } from '../types.js';

/**
 * Codex CLI adapter (beta).
 *
 * Assembled data-driven via `buildToolAdapter`: the agent-target registry
 * supplies the skill dir (`.agents/skills` — the multi-tool standard Codex scans
 * from CWD up to repo root, NOT `.codex/skills`), and the orcaops overlay marks
 * it AGENTS.md-only with no commands (Codex deprecated custom prompts in favor of
 * skills) and omits the frontmatter `tags:` line. Thin re-export preserving the
 * public `codexAdapter` import path.
 */
export const codexAdapter: ToolAdapter = buildToolAdapter('codex')!;
