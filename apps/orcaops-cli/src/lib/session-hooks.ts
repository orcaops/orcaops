import path from 'node:path';

import { getAgentOverlay } from '@orcaops/adapters';
import { SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

import {
  deleteMutation,
  type PlannedMutation,
  readRepositoryRegularFileOrNull,
  writeMutation,
} from './mutations.js';

/**
 * Session-start hooks — the top rung of the bootstrap preference ladder
 * (session hooks > instruction block > manual).
 *
 * Capability is DERIVED from the adapters overlay (`sessionHooks` rows),
 * never a second hardcoded list: the overlay is the single source of truth
 * for which agents have a hook surface, so init's recommendation, this
 * planner, and doctor can never disagree about the target set.
 *
 * OWNERSHIP MODEL (deliberate, mirrors git hooks — not the manifest): the
 * settings files (`.claude/settings.json`, `.cursor/hooks.json` — codex is
 * machine-config-only, no project settings file) are CO-OWNED with the user,
 * so they are never manifest entries (the manifest's delete guard hashes
 * whole files — any unrelated user edit would strand the entry forever).
 * Instead, orcaops's entries are self-identifying: only the canonical
 * command is ours to reconcile; everything else in the file is
 * preserved verbatim. Entries are VERSION-FREE (no stamp): the
 * command re-renders guidance fresh each session, so team-shared settings
 * files never churn on a CLI release.
 *
 * Unlike git hooks (a known wart: only `init --with-hooks` touches them),
 * this planner is called from inside `planInstallMutations`, so `init`,
 * `update`, and `doctor --fix` all reconcile hook entries and `--dry-run`
 * previews them.
 */

/** Stable command fragment used to find possible session-hook entries. */
export const SESSION_HOOK_COMMAND = 'orcaops hook session-start';

export interface CanonicalSessionHookCommandOptions {
  user?: boolean;
}

export function canonicalSessionHookCommand(
  agent: SupportedAgentId,
  opts: CanonicalSessionHookCommandOptions = {}
): string {
  const invocation = `${SESSION_HOOK_COMMAND} --agent ${agent}${opts.user ? ' --user' : ''}`;
  return `sh -c 'command -v orcaops >/dev/null 2>&1 && ${invocation} || true'`;
}

export type SessionHookAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'removed'
  | 'preserved-invalid-json'
  | 'skipped-scope'
  // entries:'none' — the repo deliberately carries no settings entries (the
  // machine-level registration covers it). A steady state, never a warning.
  | 'skipped-entries';

export interface SessionHookFilePlan {
  agent: SupportedAgentId;
  /** Repo-relative settings file path. */
  path: string;
  /**
   * File-level outcome. `created`/`updated`/`removed` mean the running agent
   * session will not see the change until restarted (restart_required).
   */
  action: SessionHookAction;
}

export interface PlanSessionHookSettingsInput {
  repoRoot: string;
  /** Canonical install set (planInstallMutations' `installedAgents`). */
  agents: SupportedAgentId[];
  /** `config.session_hooks.enabled`. */
  enabled: boolean;
  scope: 'project' | 'global' | 'personal';
  /** `config.session_hooks.entries` — 'none' suppresses repo entries. */
  entries?: 'project' | 'none';
}

export interface PlanSessionHookSettingsResult {
  plans: SessionHookFilePlan[];
  mutations: PlannedMutation[];
  warnings: string[];
}

/**
 * The subset of an install set whose overlay declares a session-hook surface.
 */
export function sessionHookCapableAgents(agents: SupportedAgentId[]): SupportedAgentId[] {
  return agents.filter((id) => getAgentOverlay(id)?.sessionHooks !== undefined);
}

export type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function desiredCommand(spec: SettingsSpec): string {
  if (spec.schema === 'flat') return spec.desired.command as string;
  const hooks = spec.desired.hooks as JsonObject[];
  return hooks[0].command as string;
}

function isOrcaopsHook(v: unknown, spec: SettingsSpec): boolean {
  if (!isObject(v) || typeof v.command !== 'string') return false;
  return v.command === desiredCommand(spec);
}

function stripManagedHookEntries(entries: unknown[], spec: SettingsSpec): unknown[] {
  if (spec.schema === 'flat') return entries.filter((entry) => !isOrcaopsHook(entry, spec));

  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const foreign = entry.hooks.filter((hook) => !isOrcaopsHook(hook, spec));
    if (foreign.length === entry.hooks.length) kept.push(entry);
    else if (foreign.length > 0) kept.push({ ...entry, hooks: foreign });
  }
  return kept;
}

function hookEntriesInExpectedRegion(root: JsonObject, spec: SettingsSpec): unknown[] {
  if (!isObject(root.hooks)) return [];
  const entries = root.hooks[spec.eventKey];
  if (!Array.isArray(entries)) return [];
  if (spec.schema === 'flat') return entries;
  return entries.flatMap((entry) =>
    isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : []
  );
}

export function documentHasManagedSessionHook(root: JsonObject, spec: SettingsSpec): boolean {
  return hookEntriesInExpectedRegion(root, spec).some((entry) => isOrcaopsHook(entry, spec));
}

export function documentHasCustomizedSessionHook(root: JsonObject, spec: SettingsSpec): boolean {
  return hookEntriesInExpectedRegion(root, spec).some(
    (entry) =>
      isObject(entry) &&
      typeof entry.command === 'string' &&
      entry.command.includes(SESSION_HOOK_COMMAND) &&
      !isOrcaopsHook(entry, spec)
  );
}

/**
 * Per-agent settings-file schema. The overlay declares WHERE (path, matcher,
 * payload); the concrete JSON shape each agent parses lives here, next to the
 * merge logic that has to understand it:
 *  - `grouped` (Claude Code, Codex): `hooks.<Event>` is an array of GROUPS —
 *    `{ matcher?, hooks: [hookObj, …] }`.
 *  - `flat` (Cursor): `hooks.<event>` is an array of hook objects directly,
 *    plus a root `version: 1`.
 */
export interface SettingsSpec {
  agent: SupportedAgentId;
  path: string;
  schema: 'grouped' | 'flat';
  eventKey: string;
  /** Canonical orcaops group (`grouped`) or hook entry (`flat`). */
  desired: JsonObject;
  /** Fresh-file skeleton (root keys beyond `hooks`). */
  seed: JsonObject;
}

export function settingsSpecs(): SettingsSpec[] {
  const specs: SettingsSpec[] = [];
  for (const id of SUPPORTED_AGENT_IDS) {
    const sh = getAgentOverlay(id)?.sessionHooks;
    if (!sh || sh.kind !== 'settings-json') continue;
    const command = canonicalSessionHookCommand(id);
    if (id === 'cursor') {
      specs.push({
        agent: id,
        path: sh.path,
        schema: 'flat',
        // Cursor's event keys are lowerCamelCase and entries carry no matcher.
        eventKey: 'sessionStart',
        desired: { type: 'command', command, timeout: 10 },
        seed: { version: 1 },
      });
      continue;
    }
    specs.push({
      agent: id,
      path: sh.path,
      schema: 'grouped',
      eventKey: 'SessionStart',
      desired: {
        ...(sh.matcher ? { matcher: sh.matcher } : {}),
        hooks: [
          {
            type: 'command',
            command,
            // Claude Code shows a spinner while a hook runs; keep the budget
            // tight. Codex's JSON hook shape has no documented timeout key.
            ...(id === 'claude-code' ? { timeout: 10 } : {}),
          },
        ],
      },
      seed: {},
    });
  }
  return specs;
}

/**
 * Reconcile orcaops's entry within one parsed settings document (mutates
 * `root`). `desired === null` strips. Foreign structure is preserved verbatim:
 * in a `grouped` schema, a group whose inner hooks are ALL ours is replaced
 * wholesale; a MIXED group (a user appended their own hook into ours) only has
 * the orcaops inner entries removed — user hooks are never deleted.
 * An entry already identical to `desired` is kept IN PLACE (position is user
 * data too: a user group appended after ours must not push ours to the end on
 * every reconcile); the canonical entry is appended only when no in-place
 * match survived. Extra ours entries beyond the first match are dropped.
 * Returns 'invalid' when the existing `hooks` region has an unexpected shape
 * (caller preserves the file untouched).
 */
export function reconcileDocument(
  root: JsonObject,
  spec: SettingsSpec,
  desired: JsonObject | null
): 'ok' | 'invalid' {
  const hooksVal = root.hooks;
  if (hooksVal !== undefined && !isObject(hooksVal)) return 'invalid';
  const hooks: JsonObject = isObject(hooksVal) ? hooksVal : {};
  const eventVal = hooks[spec.eventKey];
  if (eventVal !== undefined && !Array.isArray(eventVal)) return 'invalid';
  const entries: unknown[] = Array.isArray(eventVal) ? eventVal : [];

  const desiredJson = desired === null ? null : JSON.stringify(desired);
  let matched = false;
  const kept: unknown[] = [];
  for (const entry of entries) {
    const keepInPlace = (ours: unknown): boolean => {
      if (matched || desiredJson === null || JSON.stringify(ours) !== desiredJson) return false;
      matched = true;
      kept.push(ours);
      return true;
    };
    if (spec.schema === 'flat') {
      if (!isOrcaopsHook(entry, spec)) kept.push(entry);
      else keepInPlace(entry);
      continue;
    }
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry); // foreign shape — preserve verbatim
      continue;
    }
    const foreign = entry.hooks.filter((h) => !isOrcaopsHook(h, spec));
    if (foreign.length === entry.hooks.length) kept.push(entry);
    else if (foreign.length > 0) kept.push({ ...entry, hooks: foreign });
    else keepInPlace(entry);
    // unmatched all-ours → dropped; the canonical group is appended below
  }
  if (desired && !matched) kept.push(desired);

  if (kept.length > 0) hooks[spec.eventKey] = kept;
  else delete hooks[spec.eventKey];

  for (const [eventKey, eventEntries] of Object.entries(hooks)) {
    if (eventKey === spec.eventKey || !Array.isArray(eventEntries)) continue;
    const foreign = stripManagedHookEntries(eventEntries, spec);
    // Only a key WE emptied may be deleted. A strip that changed nothing means
    // the key holds no entry of ours — including a user-authored empty array,
    // which is theirs to keep. Compare content, not length: a mixed group is
    // rewritten in place at the same length.
    if (JSON.stringify(foreign) === JSON.stringify(eventEntries)) continue;
    if (foreign.length > 0) hooks[eventKey] = foreign;
    else delete hooks[eventKey];
  }

  if (Object.keys(hooks).length === 0) delete root.hooks;
  else root.hooks = hooks;
  return 'ok';
}

/**
 * After a strip, is the document nothing but its own PRISTINE skeleton?
 * Values must deep-equal the seed's, not just share key names — a
 * user-modified seed value (e.g. cursor's `{"version": 2}`) is user data, so
 * the file is stripped in place rather than deleted.
 */
export function isSemanticallyEmpty(root: JsonObject, spec: SettingsSpec): boolean {
  return Object.keys(root).every(
    (k) => k in spec.seed && JSON.stringify(root[k]) === JSON.stringify(spec.seed[k])
  );
}

export function serializeSettings(root: JsonObject): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Plan the settings-file hook entries for every settings-json-capable agent.
 * The single rule that handles enable, disable, AND install-set narrowing
 * uniformly: an agent's entry is desired iff session hooks are enabled AND
 * the agent is in the install set AND the scope is `project`; every known
 * settings path is scanned regardless, so lingering entries from a removed
 * agent — or from a project→global/personal scope switch — self-clean on the
 * next init/update/doctor --fix.
 *
 * INSTALL is project-scope only in v1: under `global`/`personal`, an agent whose
 * entry would otherwise be desired reports `skipped-scope` when there is
 * nothing to reconcile. STRIP is deliberately scope-agnostic — leaving an
 * entry behind because the scope changed would make doctor's lingering-entry
 * warning unfixable. (Stripping under `personal` edits a tracked file, which
 * matches the scope-switch precedent: update already prunes tracked install
 * trees on the way into personal, and git surfaces the deletion to commit.)
 */
export async function planSessionHookSettings(
  input: PlanSessionHookSettingsInput
): Promise<PlanSessionHookSettingsResult> {
  const plans: SessionHookFilePlan[] = [];
  const mutations: PlannedMutation[] = [];
  const warnings: string[] = [];
  const installAllowed = input.scope === 'project';

  const planSpec = async (spec: SettingsSpec, desired: boolean): Promise<void> => {
    const abs = path.join(input.repoRoot, spec.path);
    const raw = await readRepositoryRegularFileOrNull(abs, input.repoRoot, spec.path);

    if (raw === null) {
      if (!desired) return; // nothing to create, nothing to strip
      const root: JsonObject = structuredClone(spec.seed);
      reconcileDocument(root, spec, spec.desired);
      mutations.push(writeMutation(input.repoRoot, spec.path, serializeSettings(root), null, true));
      plans.push({ agent: spec.agent, path: spec.path, action: 'created' });
      return;
    }

    // An unparseable/odd-shaped file is only a FINDING when orcaops has (or
    // wants) an entry in it — a user's broken settings file in a repo with
    // hooks disabled is not ours to nag about.
    const relevant = desired || raw.includes(SESSION_HOOK_COMMAND);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      if (!relevant) return;
      plans.push({ agent: spec.agent, path: spec.path, action: 'preserved-invalid-json' });
      warnings.push(
        `${spec.path} is not a valid JSON object — left untouched; ` +
          `reconcile the "${canonicalSessionHookCommand(spec.agent)}" entry manually`
      );
      return;
    }

    const root = structuredClone(parsed);
    if (reconcileDocument(root, spec, desired ? spec.desired : null) === 'invalid') {
      if (!relevant) return;
      plans.push({ agent: spec.agent, path: spec.path, action: 'preserved-invalid-json' });
      warnings.push(
        `${spec.path} has an unexpected "hooks" shape — left untouched; ` +
          `reconcile the "${canonicalSessionHookCommand(spec.agent)}" entry manually`
      );
      return;
    }

    // Structural compare (not byte compare): a semantically-current file with
    // the user's own formatting is left byte-untouched — no churn.
    if (JSON.stringify(parsed) === JSON.stringify(root)) {
      if (desired) plans.push({ agent: spec.agent, path: spec.path, action: 'unchanged' });
      return;
    }

    if (!desired && isSemanticallyEmpty(root, spec)) {
      // Stripping left only the skeleton (e.g. `{}`, or cursor's bare
      // `{"version": 1}`) — remove the file rather than leave husks around.
      mutations.push(
        deleteMutation(input.repoRoot, spec.path, { kind: 'file', content: raw }, true)
      );
      plans.push({ agent: spec.agent, path: spec.path, action: 'removed' });
      return;
    }

    mutations.push(writeMutation(input.repoRoot, spec.path, serializeSettings(root), raw, true));
    plans.push({
      agent: spec.agent,
      path: spec.path,
      action: desired ? 'updated' : 'removed',
    });
  };

  const entriesWanted = (input.entries ?? 'project') === 'project';
  let skippedScope = false;
  for (const spec of settingsSpecs()) {
    const inSet = input.enabled && input.agents.includes(spec.agent);
    const before = plans.length;
    await planSpec(spec, installAllowed && inSet && entriesWanted);
    if (plans.length !== before) continue;
    // A would-be install held back by entries:'none' is a deliberate steady
    // state (machine-level registration covers the repo) — reported without
    // a warning. Blocked only by scope: reported AND warned (the strip /
    // invalid outcomes above are strictly more informative and take
    // precedence over either).
    if (inSet && installAllowed && !entriesWanted) {
      plans.push({ agent: spec.agent, path: spec.path, action: 'skipped-entries' });
    } else if (inSet && !installAllowed) {
      plans.push({ agent: spec.agent, path: spec.path, action: 'skipped-scope' });
      skippedScope = true;
    }
  }
  if (skippedScope) {
    warnings.push(
      `settings-file hook entries are project-scope only — under scope "${input.scope}" ` +
        'use the machine-level registration instead (`orcaops session-hooks install`)'
    );
  }

  return { plans, mutations, warnings };
}

export const SESSION_HOOK_RESTART_NOTICE =
  'Changed agents may require a restart; Cursor reloads automatically.';

/** Keep the JSON restart_required signal uniform across all changed agents. */
export function sessionHooksRestartRequired(plans: ReadonlyArray<{ action: string }>): boolean {
  return plans.some(
    (p) => p.action === 'created' || p.action === 'updated' || p.action === 'removed'
  );
}
