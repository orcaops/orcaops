import { CAPTURE_AGENT_IDS, type CaptureAgentId } from '@orcaops/storage';

import { getInvocationEnv } from './invocation-context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Runtime invoking-agent resolution — which coding agent actually ran
 * this CLI invocation. Replaces the static `config.agent` capture
 * identity: attribution is resolved per invocation, so multi-agent
 * repos (Claude Code + Codex + …) stamp each artifact event with the
 * agent that produced it, not a repo-wide setting.
 *
 * Four tiers, first hit wins:
 *
 *   1. `--invoked-by-agent <id>` flag — generated skills instruct the
 *      executing agent to self-declare. Explicit beats implicit: a
 *      nested agent (codex launched from a Claude Code shell) inherits
 *      the parent's env markers, but its skill-driven flag names the
 *      actual invoker. An invalid value is a loud INVALID_INPUT.
 *   2. `ORCAOPS_INVOKED_BY_AGENT` env var — for wrappers/CI that set
 *      identity process-wide. Best-effort trust: an invalid value
 *      falls through rather than failing the capture.
 *   3. Ambient env markers (table below) — automatic detection where
 *      the agent's shell exposes one. If markers for MORE THAN ONE
 *      distinct agent are present the tier is ambiguous (nested-agent
 *      env inheritance) and is skipped entirely.
 *   4. `'other'` — the deterministic fallback (member of the capture
 *      enum). Never an interactive prompt: capture commands are
 *      agent-driven and must behave identically in TTY and CI.
 */

export type InvokingAgentSource = 'flag' | 'env' | 'ambient' | 'fallback';

export interface InvokingAgentResolution {
  agent: CaptureAgentId;
  source: InvokingAgentSource;
  /**
   * Distinct agents whose ambient markers were ALL present when the
   * ambient tier was consulted and found ambiguous (≥2 candidates —
   * the nested-agent case). Recorded for the fallback notice /
   * debugging; absent when the ambient tier was decisive or unused.
   */
  ambient_conflict?: CaptureAgentId[];
}

/** Env var consulted at tier 2. */
export const ORCAOPS_INVOKED_BY_AGENT_ENV = 'ORCAOPS_INVOKED_BY_AGENT';

/**
 * Ambient detection table — best-effort, data-driven, append-friendly.
 * Reliability notes (researched July 2026):
 *  - claude-code: `CLAUDECODE=1` + `CLAUDE_CODE_SESSION_ID` are
 *    documented and set in every Bash tool call. Reliable.
 *  - cursor: `CURSOR_AGENT=1` is intended (known gaps in some CLI
 *    versions); `CURSOR_TRACE_ID` appears in IDE terminals. Best-effort.
 *  - codex: released versions inject `CODEX_THREAD_ID`; wrappers and newer
 *    builds may inject `CODEX_SESSION_ID`. `CODEX_SANDBOX*` is a fallback.
 *  - opencode / aider / github-copilot: no automatic marker exists
 *    today (opencode: sst/opencode#1775; copilot: COPILOT_AGENT is
 *    user-set only) — those agents rely on tiers 1–2.
 */
const AMBIENT_MARKERS: ReadonlyArray<{
  agent: CaptureAgentId;
  present: (env: NodeJS.ProcessEnv) => boolean;
}> = [
  {
    agent: 'claude-code',
    present: (env) => isSet(env.CLAUDECODE) || isSet(env.CLAUDE_CODE_SESSION_ID),
  },
  { agent: 'cursor', present: (env) => isSet(env.CURSOR_AGENT) || isSet(env.CURSOR_TRACE_ID) },
  {
    agent: 'codex',
    present: (env) =>
      isSet(env.CODEX_THREAD_ID) ||
      isSet(env.CODEX_SESSION_ID) ||
      Object.keys(env).some((k) => k.startsWith('CODEX_SANDBOX') && isSet(env[k])),
  },
];

/** Every env var name the ambient tier consults — exported so the test
 *  setup can scrub them for hermeticity (a dev running vitest INSIDE an
 *  agent shell must not leak markers into every CLI test). The codex
 *  entry is a prefix: scrub any key starting with it. */
export const AMBIENT_MARKER_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
] as const;
export const AMBIENT_MARKER_ENV_PREFIXES = ['CODEX_SANDBOX'] as const;

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCaptureAgentId(value: string): value is CaptureAgentId {
  return (CAPTURE_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Resolve the invoking agent for this CLI invocation. `env` defaults to
 * the ALS-aware invocation env so in-process test agents observe their
 * own frame, not the developer's shell.
 */
export function resolveInvokingAgent(
  opts: { flag?: string; env?: NodeJS.ProcessEnv } = {}
): InvokingAgentResolution {
  const env = opts.env ?? getInvocationEnv();

  // Tier 1 — explicit flag. Invalid values fail loudly: the flag is
  // written by generated skills / humans and a typo must not silently
  // demote attribution to a lower tier.
  if (opts.flag !== undefined) {
    const flag = opts.flag.trim();
    if (!isCaptureAgentId(flag)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Invalid --invoked-by-agent value "${opts.flag}". Expected one of: ` +
          `${CAPTURE_AGENT_IDS.join(', ')}.`,
        'invoked_by_agent'
      );
    }
    return { agent: flag, source: 'flag' };
  }

  // Tier 2 — env var. Best-effort: invalid/blank falls through.
  const fromEnv = env[ORCAOPS_INVOKED_BY_AGENT_ENV];
  if (isSet(fromEnv)) {
    const candidate = fromEnv!.trim();
    if (isCaptureAgentId(candidate)) {
      return { agent: candidate, source: 'env' };
    }
  }

  // Tier 3 — ambient markers, decisive only when exactly ONE distinct
  // agent matches. Nested agents inherit the parent's markers, so ≥2
  // matches means the environment cannot be trusted to name the invoker.
  const candidates = AMBIENT_MARKERS.filter((m) => m.present(env)).map((m) => m.agent);
  if (candidates.length === 1) {
    return { agent: candidates[0], source: 'ambient' };
  }

  // Tier 4 — deterministic fallback.
  return {
    agent: 'other',
    source: 'fallback',
    ...(candidates.length > 1 ? { ambient_conflict: candidates } : {}),
  };
}
