import { getToolAdapter, listToolAdapters, type ToolId } from '@orcaops/adapters';
import type { Config } from '@orcaops/storage';

/**
 * The instruction files orcaops manages for this install. Personal scope
 * manages none; every other scope unions the install set's adapter agentsFiles.
 *
 * `agent` narrows the answer to the files THAT agent loads, which is the only
 * correct scope for a caller acting on one agent's behalf: codex reads
 * AGENTS.md and never CLAUDE.md, so a block in CLAUDE.md covers a claude-code
 * session and leaves a codex session with nothing. A known agent narrows even
 * when it is outside the install set — cursor reads no CLAUDE.md whether or not
 * orcaops installed anything for it, and answering with the union would credit
 * it with a block it never loads. The union is only for a caller that could not
 * determine an agent at all.
 *
 * Its own leaf module because `orcaops hook session-start` needs it under the
 * agents' 10s hook timeout: `install-drift.ts`, where it used to live, pulls in
 * the install manifest, git info/exclude, the personal manifest, session-hook
 * planning and skill-set resolution, none of which the hook has any use for.
 */
export function resolveManagedInstructionFiles(config: Config, agent?: ToolId): string[] {
  if (config.install.scope === 'personal') return [];
  const adapter = agent === undefined ? undefined : getToolAdapter(agent);
  if (adapter !== undefined) return [...new Set(adapter.agentsFiles ?? [])];
  return [...new Set(config.install.agents.flatMap((id) => getToolAdapter(id)?.agentsFiles ?? []))];
}

/**
 * Every instruction-file name any adapter loads, whatever this install selected.
 */
export function knownInstructionFiles(): string[] {
  return [...new Set(listToolAdapters().flatMap((adapter) => adapter.agentsFiles ?? []))];
}
