import path from 'node:path';

import { getAgentOverlay } from '@orcaops/adapters';
import {
  stringifyTerminalSafeJson,
  stripTerminalControls,
} from '@orcaops/evaluator-protocol/terminal';

import { writePipeFriendlyStdout } from '../io/output.js';
import { getInvocationEnv, isCi } from '../lib/invocation-context.js';
import { readRepositoryFileOrNull } from '../lib/mutations.js';
import {
  documentHasManagedSessionHook,
  type JsonObject,
  settingsSpecs,
} from '../lib/session-hooks.js';
import { renderSessionStartGuidance } from '../lib/session-start-guidance.js';
import { readSessionStartState, resolveSessionStartLocation } from '../lib/session-start-state.js';

export type HookAgent = 'claude-code' | 'codex' | 'cursor' | 'opencode';

export interface HookSessionStartOptions {
  /** Emitting agent — selects the stdout shape (overlay `sessionHooks.payload`). */
  agent?: HookAgent;
  /**
   * Set on entries installed by the MACHINE-level registration
   * (`orcaops session-hooks install`). When the repo's own settings file also
   * carries a project entry, the project entry wins and this invocation emits
   * nothing — the agent runs both, and double guidance is worse than either.
   */
  user?: boolean;
  cwd?: string;
}

/**
 * Project-vs-user arbitration: a `--user` invocation yields when the repo's
 * project settings file contains an exact managed entry. An existing but
 * unreadable file also yields because its project hook status is unknowable;
 * silence is safer than double guidance. Deterministic, agent-agnostic, no
 * state files.
 */
async function projectEntryStatus(
  agent: HookAgent | undefined,
  repoRoot: string | null
): Promise<'present' | 'absent' | 'unreadable'> {
  if (!agent) return 'absent';
  const surface = getAgentOverlay(agent)?.sessionHooks;
  if (!surface || surface.kind !== 'settings-json') return 'absent';
  const spec = settingsSpecs().find((candidate) => candidate.agent === agent);
  if (!spec) return 'absent';
  if (!repoRoot) return 'absent';
  try {
    const raw = await readRepositoryFileOrNull(
      path.join(repoRoot, surface.path),
      repoRoot,
      surface.path
    );
    if (raw === null) return 'absent';
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable';
    return documentHasManagedSessionHook(parsed as JsonObject, spec) ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
}

/**
 * `orcaops hook session-start` — the command installed agent session hooks
 * execute. HARD CONTRACT: always exit 0 and never print an error. This runs
 * at every session start for everyone who clones a repo with hooks installed,
 * so a failure mode of "error banner in each teammate's session" is worse
 * than silence: uninitialized repos, non-git directories, unreadable configs,
 * and corrupt caches all degrade to empty stdout. (Session-start hooks are
 * non-blocking in every target agent, so even a crash would not break the
 * session — this contract is about noise, not safety.) Read-MOSTLY, not
 * strictly read-only: see readSessionStartState's contract for the
 * narrow `.orcaops/` write-backs it can perform.
 *
 * Output shapes (overlay `sessionHooks.payload`): plain text for
 * claude-code/opencode (stdout is added to context verbatim);
 * `{"additional_context": "..."}` JSON for cursor; the
 * `hookSpecificOutput.additionalContext` envelope for codex (0.146+
 * rejects plain text — live-validated). No output at all when there is
 * nothing to say, when ORCAOPS_HOOK_SUPPRESS marks an orcaops-driven
 * inner agent session, or when a `--user` invocation yields to a project
 * entry.
 */
export async function hookSessionStartAction(opts: HookSessionStartOptions = {}): Promise<void> {
  let text: string | null = null;
  try {
    // Recursion guard: when orcaops itself drives an agent (the evaluator
    // runner sets ORCAOPS_HOOK_SUPPRESS around `codex exec` / `claude -p`),
    // injecting capture guidance into that inner session is pure noise —
    // and on Codex a potential loop. Silence, exit 0.
    if (isCi(getInvocationEnv().ORCAOPS_HOOK_SUPPRESS)) return;
    const location = await resolveSessionStartLocation(opts.cwd);
    if (opts.user && (await projectEntryStatus(opts.agent, location?.root ?? null)) !== 'absent') {
      return;
    }
    text = renderSessionStartGuidance(await readSessionStartState(opts.cwd, location));
  } catch {
    text = null;
  }
  if (!text) return;
  // The guidance interpolates repo-derived strings (branch names, artifact
  // labels); neutralize control bytes BEFORE enveloping so a hostile name
  // cannot smuggle terminal sequences into the agent's context. The writes
  // are byte-exact on a pipe (the hook execution context) — the agent parses
  // stdout, so content must not be reflowed by TTY-only stripping.
  text = stripTerminalControls(text);
  if (opts.agent === 'cursor') {
    writePipeFriendlyStdout(`${stringifyTerminalSafeJson({ additional_context: text })}\n`);
    return;
  }
  if (opts.agent === 'codex') {
    // codex-cli (0.146+) REJECTS plain-text hook stdout; injection requires
    // this envelope (live-validated — see the codex overlay row).
    writePipeFriendlyStdout(
      `${stringifyTerminalSafeJson({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      })}\n`
    );
    return;
  }
  writePipeFriendlyStdout(`${text}\n`);
}
