import {
  type AgentActivitySource,
  claudeTranscriptActivity,
  type EnvLike,
  resolveAgentActivitySource,
} from '@orcaops/agent-activity';

export { claudeTranscriptActivity };

export interface AgentSessionIdentity {
  agent: string;
  session_id: string;
}

export interface AgentActivityReaderLike {
  readLastActivity(
    sessions: Iterable<AgentSessionIdentity>
  ): Promise<Map<string, Map<string, number>>>;
}

export type AgentActivitySourceResolver = (
  agent: string,
  env: EnvLike
) => AgentActivitySource | null;

export class AgentActivityReader implements AgentActivityReaderLike {
  private readonly sources = new Map<string, AgentActivitySource | null>();

  constructor(
    private readonly env: EnvLike = process.env,
    private readonly resolveSource: AgentActivitySourceResolver = resolveAgentActivitySource
  ) {}

  async readLastActivity(
    sessions: Iterable<AgentSessionIdentity>
  ): Promise<Map<string, Map<string, number>>> {
    const grouped = new Map<string, Set<string>>();
    for (const session of sessions) {
      const ids = grouped.get(session.agent) ?? new Set<string>();
      ids.add(session.session_id);
      grouped.set(session.agent, ids);
    }

    const activity = new Map<string, Map<string, number>>();
    await Promise.all(
      [...grouped].map(async ([agent, sessionIds]) => {
        try {
          const source = this.sourceFor(agent);
          if (!source) return;
          const found = await source.readLastActivity(sessionIds);
          if (found.size > 0) activity.set(agent, found);
        } catch {
          return;
        }
      })
    );
    return activity;
  }

  private sourceFor(agent: string): AgentActivitySource | null {
    if (this.sources.has(agent)) return this.sources.get(agent) ?? null;
    const source = this.resolveSource(agent, this.env);
    this.sources.set(agent, source);
    return source;
  }
}
