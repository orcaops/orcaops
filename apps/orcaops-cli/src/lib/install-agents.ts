import { detectInstallAgents, getAgentOverlay, getAgentSkillsDirs } from '@orcaops/adapters';
import { SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

import { canonicalAgents } from './install-plan.js';
import { isCi } from './invocation-context.js';
import { agentsPrompt } from './settings-prompts.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/** The flags that select the install set. InitOptions satisfies this. */
export interface InstallAgentSelection {
  /** Repeatable `--install-agent <id>`. */
  installAgent?: string[];
  /** Comma-separated `--agents <list>` (alias for repeated --install-agent). */
  agents?: string;
  /** `--yes`: non-interactive, skip the agent-selection prompt. */
  yes?: boolean;
}

/**
 * Parse + validate the explicit install-agent flags into overlay-backed ids;
 * `null` when none were given (so the caller falls through to interactive /
 * default seeding). An explicitly EMPTY `--agents ''` returns [] — the
 * non-interactive manual mode (no install targets). Throws `INVALID_INPUT`
 * on an unsupported id.
 */
export function parseInstallAgentFlags(opts: InstallAgentSelection): SupportedAgentId[] | null {
  const given = (opts.installAgent?.length ?? 0) > 0 || opts.agents !== undefined;
  if (!given) return null;
  const raw: string[] = [...(opts.installAgent ?? [])];
  if (opts.agents !== undefined)
    raw.push(
      ...opts.agents
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );

  const supported = new Set<string>(SUPPORTED_AGENT_IDS);
  const out: SupportedAgentId[] = [];
  for (const id of raw) {
    if (!supported.has(id)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--install-agent/--agents "${id}" is not a supported install target (${SUPPORTED_AGENT_IDS.join(', ')}).`
      );
    }
    out.push(id as SupportedAgentId);
  }
  return out;
}

/**
 * The `.gitignore` globs for `generated_files: "ignore"`, DERIVED from
 * each install adapter's rendered paths — the prefixed skill dirs (skillsDir +
 * `${prefix}-` glob) and the prefixed command namespace (commandRoot + prefix) —
 * NOT hardcoded `.claude`/`.agents`, so a prefix or install-set change updates them
 * and a non-default skillsDir is covered. Deduped + sorted for a churn-free manifest.
 */
export function derivedIgnoreGlobs(
  agents: SupportedAgentId[],
  prefix: string,
  sessionHooksEnabled = false
): string[] {
  const globs = new Set<string>();
  for (const agent of agents) {
    const dirs = getAgentSkillsDirs(agent);
    if (dirs) globs.add(`${dirs.skillsDir}/${prefix}-*/`);
    const overlay = getAgentOverlay(agent);
    if (overlay?.supportsCommands && overlay.commandRoot) {
      // Mirror the command renderer's placement: nested namespaces a
      // `${prefix}/` dir; flat prefixes top-level files (Cursor CLI).
      globs.add(
        overlay.commandLayout === 'flat'
          ? `${overlay.commandRoot}/${prefix}-*.md`
          : `${overlay.commandRoot}/${prefix}/`
      );
    }
    // Mirror the session-plugin placement (generated file, so it belongs in
    // ignore mode like skills/commands). Settings files are NEVER ignored —
    // they are the team-shared surface by design.
    if (sessionHooksEnabled && overlay?.sessionHooks?.kind === 'plugin-file') {
      globs.add(`${overlay.sessionHooks.path}/${prefix}-*.js`);
    }
  }
  return [...globs].sort();
}

/**
 * Personal-scope advisory. Personal supports EVERY overlay-backed agent —
 * skills materialize via the global machinery, which the whole set declares
 * a `globalSkillsDir` for — with one structural Claude-ism left: only
 * Claude Code reads CLAUDE.local.md, so a MANAGED bootstrap block under
 * personal reaches Claude Code alone (.git/info/exclude cannot hide edits
 * to tracked files like AGENTS.md, so there is nowhere invisible to put the
 * block for other agents). Session hooks (machine-level) or team adoption
 * cover them — a warning, never a hard stop. Shared by init, update, and
 * configure so all three surfaces advise identically.
 */
export function personalScopeWarnings(
  agents: SupportedAgentId[],
  bootstrap: 'managed' | 'manual'
): string[] {
  const nonClaude = agents.filter((a) => a !== 'claude-code');
  if (nonClaude.length === 0 || bootstrap !== 'managed') return [];
  return [
    `personal scope: the CLAUDE.local.md bootstrap block only reaches Claude Code — ` +
      `${nonClaude.join(', ')} get skills but no instruction surface. Session hooks or ` +
      `team adoption (\`orcaops update --scope project\`) cover them.`,
  ];
}

/**
 * True when `init` should present the interactive checklist: a real TTY, no
 * `--yes`, and not CI. Non-interactive contexts (CI, scripts, the test harness)
 * are always false, so the install set is resolved deterministically there.
 */
export function isInteractiveInit(opts: InstallAgentSelection): boolean {
  return !!process.stdout.isTTY && !opts.yes && !isCi(process.env.CI);
}

/**
 * Resolve the install set. Explicit `--install-agent`/`--agents` win; otherwise a
 * real interactive TTY gets the checklist (default = detected); a non-interactive
 * context falls to the deterministic claude-code default (detection NEVER widens
 * a non-interactive install, so CI / scripts / tests stay machine-independent).
 */
export async function resolveInstallAgents(
  opts: InstallAgentSelection
): Promise<SupportedAgentId[] | null> {
  const explicit = parseInstallAgentFlags(opts);
  if (explicit !== null) return canonicalAgents(explicit);
  if (isInteractiveInit(opts)) {
    const detected = await detectInstallAgents();
    const selected = await promptInstallAgents(detected);
    return selected === null ? null : canonicalAgents(selected);
  }
  return ['claude-code'];
}

/**
 * The @clack/prompts multiselect — detected agents pre-checked. Lazy-imported so
 * the non-interactive path (and the whole test suite) never loads the prompt lib.
 */
async function promptInstallAgents(
  detected: SupportedAgentId[]
): Promise<SupportedAgentId[] | null> {
  const { multiselect, isCancel } = await import('@clack/prompts');
  // Shared copy (message + labels) with one init-specific touch: agents found
  // on this machine are hinted 'detected' — more useful at setup time than
  // configure's status hint.
  const options = agentsPrompt.options().map((opt) => ({
    ...opt,
    hint: detected.includes(opt.value) ? 'detected' : undefined,
  }));
  const selected = await multiselect({
    message: agentsPrompt.message,
    options,
    initialValues: detected,
    required: false,
  });
  if (isCancel(selected)) return null;
  return selected as SupportedAgentId[];
}
