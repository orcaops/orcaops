import { ClaudeCodeActivitySource } from './claude-code.js';
import { CodexActivitySource } from './codex/activity.js';

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface AgentActivitySource {
  readonly agent: string;
  readLastActivity(sessionIds: ReadonlySet<string>): Promise<Map<string, number>>;
}

export function resolveAgentActivitySource(
  agent: string,
  env: EnvLike = process.env
): AgentActivitySource | null {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeActivitySource(env);
    case 'codex':
      return new CodexActivitySource(env);
    default:
      return null;
  }
}
