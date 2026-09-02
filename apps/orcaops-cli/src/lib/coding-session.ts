import { type AgentUsageSource, type EnvLike, resolveAgentUsageSource } from '@orcaops/llm';

/**
 * Resolve the coding agent's active session id from the environment.
 *
 * Claude Code only: `CLAUDE_CODE_SESSION_ID`, present in every Bash tool
 * call. Returns `null` when unset/blank (headless or non-Claude-Code runs).
 * Kept as the claude-specific helper; agent-aware resolution lives in
 * {@link resolveAgentSession}.
 *
 * NOTE: this is `CLAUDE_CODE_SESSION_ID`, not `CLAUDE_SESSION_ID`, which is
 * the variable the pin shell-key resolver reads. They are distinct.
 */
export function resolveCodingSessionId(env: EnvLike): string | null {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/**
 * Agents checked for DIRECT env evidence, in precedence order. The vars that
 * are known to be injected lead (Claude Code injects
 * `CLAUDE_CODE_SESSION_ID`, Copilot CLI ≥ 1.0.29 injects
 * `COPILOT_AGENT_SESSION_ID`, and Codex injects `CODEX_THREAD_ID`). Future,
 * wrapper, or user-set channels still resolve only when explicitly present.
 */
const ENV_EVIDENCE_AGENTS = ['claude-code', 'github-copilot', 'codex', 'opencode'] as const;

export interface ResolvedAgentSession {
  agent: string;
  sessionId: string;
  source: AgentUsageSource;
  via: 'env' | 'invoking-agent-discovery';
}

/**
 * Resolve which coding agent is driving this process and its active session.
 *
 * Precedence:
 *  1. **Direct env evidence** — an agent's own session-id env var proves it
 *     is literally the parent of this invocation, so it beats the discovery
 *     hint (a Codex invocation can still run inside a Claude-owned shell).
 *  2. **Invoking-agent discovery hint** — the runtime-resolved invoking agent,
 *     via the source's filesystem/DB discovery (cwd match + recency guard), for
 *     agents that export no session env var (Codex, OpenCode).
 *
 * Returns `null` when neither channel resolves — headless runs, agents with
 * no usage source (cursor/aider/other), or no fresh matching session — which
 * keeps usage stamping a clean silent no-op.
 */
export async function resolveAgentSession(opts: {
  env: EnvLike;
  cwd: string;
  invokingAgent?: string;
  /** ISO "now" anchor for the discovery recency window (typically the stamp's asOf). */
  now?: string;
}): Promise<ResolvedAgentSession | null> {
  for (const agent of ENV_EVIDENCE_AGENTS) {
    const source = resolveAgentUsageSource(agent, opts.env);
    if (source === null) continue;
    const sessionId = source.resolveActiveSessionId(opts.env);
    if (sessionId !== null) {
      if (source.canonicalizeSessionId === undefined) {
        return { agent, sessionId, source, via: 'env' };
      }
      let canonical: string | null;
      try {
        canonical = await source.canonicalizeSessionId(sessionId, opts.env);
      } catch {
        return null;
      }
      if (canonical === null) return null;
      return { agent, sessionId: canonical, source, via: 'env' };
    }
  }

  const invokingAgent = opts.invokingAgent?.trim();
  if (!invokingAgent) return null;
  const source = resolveAgentUsageSource(invokingAgent, opts.env);
  if (source === null || source.discoverActiveSessionId === undefined) return null;
  const discovered = await source.discoverActiveSessionId({
    cwd: opts.cwd,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (discovered === null) return null;
  return {
    agent: invokingAgent,
    sessionId: discovered,
    source,
    via: 'invoking-agent-discovery',
  };
}
