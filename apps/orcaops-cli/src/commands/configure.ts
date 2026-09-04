import path from 'node:path';

import { configLocationForScope, Repo, resolveConfigSource } from '@orcaops/core';
import { type HintKey, type SupportedAgentId } from '@orcaops/storage';

import { archiveDisableAction, archiveEnableAction } from './archive.js';
import { updateAction } from './update.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { writeErrorLine, writeTerminalSafeStderr, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import {
  displayConfigPath,
  refuseTrackedPersonalTransition,
  resolvePersonalConfigForAdoption,
  trackedProjectInstallPaths,
} from '../lib/config-file.js';
import { buildContext } from '../lib/context.js';
import { hooksDirCandidates } from '../lib/git-hooks-dir.js';
import { INSTALL_MANIFEST_REL } from '../lib/install-manifest.js';
import { isCi } from '../lib/invocation-context.js';
import {
  deleteMutation,
  executeMutations,
  planGitHookMutation,
  planRemoveGitHooks,
  readRepositoryFileForOwnership,
  readRepositoryFileOrNull,
  writeMutation,
} from '../lib/mutations.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { readUserHooksRecord } from '../lib/session-hooks-user.js';
import {
  editArchiveEnabled,
  editBlockChoice,
  editGeneratedFiles,
  editGitHooksConfirm,
  editHints,
  editHintsCustom,
  editLink,
  editPrefix,
  editScope,
  editSessionHookEntries,
  editSessionHooksChoice,
} from '../lib/settings-edit.js';
import { agentsPrompt } from '../lib/settings-prompts.js';

export interface ConfigureOptions {
  cwd?: string;
}

/**
 * The user-tweakable settings snapshot the menu edits. A plain value object —
 * the menu mutates a DRAFT copy and nothing touches disk until the user
 * explicitly applies (cancel anywhere is guaranteed write-free, the same
 * abort posture as the init prompts).
 *
 * `archive` and `gitHooks` ride the menu but are NOT config-write-backed:
 * archive toggling must route through the enable/disable machinery (raw
 * `archive.enabled` writes would skip the first-enable backfill), and git
 * hooks are stamp-managed files, not config.
 */
interface SettingsDraft {
  agents: SupportedAgentId[];
  scope: 'project' | 'global' | 'personal';
  link: 'copy' | 'symlink';
  prefix: string;
  bootstrap: 'managed' | 'manual';
  sessionHooks: 'off' | 'static' | 'state-aware';
  /** Which registration carries the hook here (config `session_hooks.entries`). */
  sessionHookEntries: 'project' | 'none';
  generatedFiles: 'commit' | 'ignore';
  hintKeys: HintKey[];
  hintCustom: string[];
  archive: boolean;
  gitHooks: boolean;
}

/**
 * `orcaops configure` — an interactive menu over the existing machinery,
 * never a second write path: applying persists the changed config keys
 * (raw-minimal, like `update`'s flag persistence) and then runs the SAME
 * reconcile `update` runs, so every install surface follows the settings by
 * construction. TTY-only; scripts get pointed at the `update` flags.
 */
export async function configureAction(opts: ConfigureOptions = {}): Promise<void> {
  // stdin too: clack prompts read keystrokes — stdout alone being a TTY
  // (e.g. `echo | orcaops configure` on a terminal) cannot drive the menu.
  if (!process.stdout.isTTY || !process.stdin.isTTY || isCi(process.env.CI)) {
    writeTerminalSafeStderr(
      'Error: `orcaops configure` is interactive and needs a TTY.\n' +
        'In scripts use the flags on `orcaops update` (--scope, --link, --prefix, ' +
        '--session-hooks/--no-session-hooks, --session-hook-payload) or edit ' +
        '.orcaops/config.json directly (schema-validated on next load).\n'
    );
    throw new CliExit(1);
  }

  // Snapshot what we need, then release the store immediately — the apply
  // path delegates to update/archive actions that build their own contexts.
  const ctx = await buildContext({ cwd: opts.cwd });
  let repoRoot: string;
  let original: SettingsDraft;
  let storedPayload: 'static' | 'state-aware';
  try {
    repoRoot = ctx.repoRoot;
    // The payload preference outlives the off state on disk — keep it
    // alongside the draft so re-enabling seeds the select with it instead of
    // silently resetting a stored 'state-aware' back to 'static'.
    storedPayload = ctx.config.session_hooks.payload;
    original = {
      agents: [...ctx.config.install.agents],
      scope: ctx.config.install.scope,
      link: ctx.config.install.link,
      prefix: ctx.config.naming.prefix,
      bootstrap: ctx.config.bootstrap,
      sessionHooks: ctx.config.session_hooks.enabled ? ctx.config.session_hooks.payload : 'off',
      sessionHookEntries: ctx.config.session_hooks.entries,
      generatedFiles: ctx.config.generated_files,
      hintKeys: [...ctx.config.workflow.hints.keys],
      hintCustom: [...ctx.config.workflow.hints.custom],
      archive: ctx.config.archive.enabled,
      gitHooks: await gitHooksInstalled(repoRoot),
    };
  } finally {
    ctx.store.close();
  }
  const draft: SettingsDraft = structuredClone(original);

  const prompts = await import('@clack/prompts');
  const out = (line: string): void => writeTerminalSafeStdout(`${line}\n`);

  // Per-item pending indicators. The `*` rides the LABEL because clack only
  // renders hints on the FOCUSED row — a tweaked item must stay visibly
  // marked after the cursor moves off it. The focused hint upgrades to
  // `old → new` for changed items so the exact edit is one keystroke away.
  const mark = (label: string, changed: boolean): string => (changed ? `${label} *` : label);
  const hintFor = (changed: boolean, was: string, now: string): string =>
    changed ? `${was} → ${now}` : now;
  // Value displays stay SHORT (they carry the current value / old → new in the
  // menu hint); the plain-English explanation of each setting lives in its
  // edit sub-prompt, which is always visible when the user is choosing.
  const showAgents = (v: SettingsDraft): string => v.agents.join(', ') || 'none installed';
  const showHooks = (v: SettingsDraft): string =>
    v.sessionHooks === 'off'
      ? 'off'
      : `on (${v.sessionHooks}, ${v.sessionHookEntries === 'none' ? 'machine-level' : 'repo entries'})`;
  const showScope = (v: SettingsDraft): string => `${v.scope} / ${v.link}`;
  const showHints = (v: SettingsDraft): string =>
    `${v.hintKeys.length + v.hintCustom.length} selected`;
  const showArchive = (v: SettingsDraft): string => (v.archive ? 'on' : 'off');
  const showGitHooks = (v: SettingsDraft): string => (v.gitHooks ? 'installed' : 'not installed');

  // HYBRID menu: the frequently-revisited guidance settings stay one
  // keystroke away with visible old → new hints; the four set-once plumbing
  // items (location, prefix, generated files, git hooks) fold into a single
  // "Installation & files…" submenu whose row carries an aggregate `*` and a
  // draft-value summary, so the top level stays eight rows without hiding a
  // pending change from the pre-apply review.
  for (;;) {
    const pending = pendingChanges(original, draft);
    const changed = {
      agents: JSON.stringify(original.agents) !== JSON.stringify(draft.agents),
      sessionHooks:
        original.sessionHooks !== draft.sessionHooks ||
        original.sessionHookEntries !== draft.sessionHookEntries,
      block: original.bootstrap !== draft.bootstrap,
      prefix: original.prefix !== draft.prefix,
      scope: original.scope !== draft.scope || original.link !== draft.link,
      generated: original.generatedFiles !== draft.generatedFiles,
      hints:
        JSON.stringify(original.hintKeys) !== JSON.stringify(draft.hintKeys) ||
        JSON.stringify(original.hintCustom) !== JSON.stringify(draft.hintCustom),
      archive: original.archive !== draft.archive,
      gitHooks: original.gitHooks !== draft.gitHooks,
    };
    const installChanged = changed.scope || changed.prefix || changed.generated || changed.gitHooks;
    const showInstallGroup = (v: SettingsDraft): string =>
      `${showScope(v)} · prefix ${v.prefix} · ${v.generatedFiles}`;
    const action = await prompts.select({
      message: `Orcaops settings — pick an item to change${pending.length > 0 ? ' (* = pending)' : ''}`,
      options: [
        {
          value: 'session-hooks',
          label: mark('Session-start hooks', changed.sessionHooks),
          hint: hintFor(changed.sessionHooks, showHooks(original), showHooks(draft)),
        },
        // Personal scope owns no instruction file, so the row is not offered.
        ...(draft.scope === 'personal'
          ? []
          : [
              {
                value: 'block',
                label: mark('Instructions file section', changed.block),
                hint: hintFor(changed.block, original.bootstrap, draft.bootstrap),
              },
            ]),
        {
          value: 'hints',
          label: mark('Workflow reminders', changed.hints),
          hint: hintFor(changed.hints, showHints(original), showHints(draft)),
        },
        {
          value: 'agents',
          label: mark('Installed agents', changed.agents),
          hint: hintFor(changed.agents, showAgents(original), showAgents(draft)),
        },
        {
          value: 'archive',
          label: mark('Session-history archive', changed.archive),
          hint: hintFor(changed.archive, showArchive(original), showArchive(draft)),
        },
        {
          value: 'install',
          label: mark('Installation & files…', installChanged),
          hint: showInstallGroup(draft),
        },
        {
          value: 'apply',
          label:
            pending.length > 0
              ? `Review & apply (${pending.length} pending change${pending.length === 1 ? '' : 's'})`
              : 'Apply (no changes yet)',
        },
        { value: 'discard', label: 'Exit without changes' },
      ],
    });

    if (prompts.isCancel(action) || action === 'discard') {
      out('No changes written.');
      return;
    }

    if (action === 'apply') {
      if (pending.length === 0) {
        out('Nothing to apply yet — change a setting first.');
        continue;
      }
      // Personal + non-claude agents is allowed (skills go global); the
      // instruction-surface gap is an advisory the apply path (updateAction)
      // surfaces via the shared personalScopeWarnings helper.
      out('Pending changes:');
      for (const line of pending) out(`  ~ ${line}`);
      const go = await prompts.confirm({ message: 'Apply these changes?', initialValue: true });
      if (prompts.isCancel(go) || go !== true) continue;
      await applyDraft(repoRoot, original, draft, opts, out);
      return;
    }

    if (action === 'install') {
      // Submenu loop: edits return HERE (you usually adjust related plumbing
      // together); Back or cancel returns to the top menu with the draft
      // intact — nothing in the submenu writes anything.
      for (;;) {
        const sub = {
          scope: original.scope !== draft.scope || original.link !== draft.link,
          prefix: original.prefix !== draft.prefix,
          generated: original.generatedFiles !== draft.generatedFiles,
          gitHooks: original.gitHooks !== draft.gitHooks,
        };
        const item = await prompts.select({
          message: 'Installation & files',
          options: [
            {
              value: 'scope',
              label: mark('Install location', sub.scope),
              hint: hintFor(sub.scope, showScope(original), showScope(draft)),
            },
            {
              value: 'prefix',
              label: mark('Command name prefix', sub.prefix),
              hint: hintFor(sub.prefix, original.prefix, draft.prefix),
            },
            {
              value: 'generated',
              label: mark('Generated files in git', sub.generated),
              hint: hintFor(sub.generated, original.generatedFiles, draft.generatedFiles),
            },
            {
              value: 'git-hooks',
              label: mark('Git hooks (history refresh)', sub.gitHooks),
              hint: hintFor(sub.gitHooks, showGitHooks(original), showGitHooks(draft)),
            },
            { value: 'back', label: '← Back' },
          ],
        });
        if (prompts.isCancel(item) || item === 'back') break;
        await editItem(item as string, draft, storedPayload, prompts, out);
      }
      continue;
    }

    await editItem(action as string, draft, storedPayload, prompts, out);
  }
}

async function editItem(
  item: string,
  draft: SettingsDraft,
  storedPayload: 'static' | 'state-aware',
  prompts: typeof import('@clack/prompts'),
  out: (line: string) => void
): Promise<void> {
  switch (item) {
    case 'agents': {
      const picked = await prompts.multiselect({
        message: agentsPrompt.message,
        options: agentsPrompt.options(),
        initialValues: draft.agents,
        required: false,
      });
      if (prompts.isCancel(picked)) return;
      draft.agents = picked as SupportedAgentId[];
      return;
    }
    case 'session-hooks': {
      // Read-only machine-level registration status. Configure NEVER writes a
      // user config — that is `orcaops session-hooks install`'s consent
      // surface alone; this line only tells the user which registration
      // exists so the entries choice below makes sense.
      const record = await readUserHooksRecord();
      out(
        record
          ? `  machine-level registration: installed for ${record.entries
              .map((e) => e.agent)
              .join(', ')} (manage with \`orcaops session-hooks install|uninstall\`)`
          : '  machine-level registration: not installed ' +
              '(register once with `orcaops session-hooks install`)'
      );
      // Re-enabling resumes the stored payload preference — 'off' does not
      // erase a 'state-aware' choice recorded in config.
      const choice = await editSessionHooksChoice(
        draft.sessionHooks === 'off' ? storedPayload : draft.sessionHooks,
        draft.bootstrap
      );
      if (choice === null) return;
      let entries = draft.sessionHookEntries;
      // Personal scope registers hooks at the machine level only; there is
      // no repo-entries choice to make.
      if (choice !== 'off' && draft.scope !== 'personal') {
        const picked = await editSessionHookEntries(entries);
        if (picked === null) return;
        entries = picked;
      }
      draft.sessionHooks = choice;
      draft.sessionHookEntries = entries;
      return;
    }
    case 'block': {
      const choice = await editBlockChoice(draft.bootstrap);
      if (choice !== null) draft.bootstrap = choice;
      return;
    }
    case 'prefix': {
      const value = await editPrefix(draft.prefix);
      if (value !== null) draft.prefix = value;
      return;
    }
    case 'scope': {
      const scope = await editScope(draft.scope);
      if (scope === null) return;
      const link = await editLink(draft.link);
      if (link === null) return;
      draft.scope = scope;
      draft.link = link;
      // Personal scope stores exactly the values it supports.
      if (scope === 'personal') {
        draft.bootstrap = 'manual';
        draft.sessionHookEntries = 'none';
      }
      return;
    }
    case 'generated': {
      const choice = await editGeneratedFiles(draft.generatedFiles);
      if (choice !== null) draft.generatedFiles = choice;
      return;
    }
    case 'hints': {
      const picked = await editHints(draft.hintKeys);
      if (picked === null) return;
      draft.hintKeys = picked;
      // Custom lines: keep/remove the existing ones, then append new ones.
      // Cancel at the keep step leaves the custom list exactly as it was
      // (the curated selection above is already in the draft either way).
      const custom = await editHintsCustom(draft.hintCustom);
      if (custom !== null) draft.hintCustom = custom;
      return;
    }
    case 'archive': {
      const enabled = await editArchiveEnabled(draft.archive);
      if (enabled !== null) draft.archive = enabled;
      return;
    }
    case 'git-hooks': {
      const installed = await editGitHooksConfirm(draft.gitHooks);
      if (installed !== null) draft.gitHooks = installed;
      return;
    }
    default:
      return;
  }
}

/** Human-readable old → new lines; empty when the draft matches the original. */
function pendingChanges(o: SettingsDraft, d: SettingsDraft): string[] {
  const lines: string[] = [];
  const list = (xs: string[]): string => xs.join(', ') || 'none';
  if (JSON.stringify(o.agents) !== JSON.stringify(d.agents)) {
    lines.push(`install agents: ${list(o.agents)} → ${list(d.agents)}`);
  }
  if (o.sessionHooks !== d.sessionHooks || o.sessionHookEntries !== d.sessionHookEntries) {
    const show = (v: SettingsDraft): string =>
      v.sessionHooks === 'off'
        ? 'off'
        : `on (${v.sessionHooks}, ${v.sessionHookEntries === 'none' ? 'machine-level' : 'repo entries'})`;
    lines.push(`session hooks: ${show(o)} → ${show(d)}`);
  }
  if (o.bootstrap !== d.bootstrap) lines.push(`instruction block: ${o.bootstrap} → ${d.bootstrap}`);
  if (o.prefix !== d.prefix) lines.push(`naming prefix: ${o.prefix} → ${d.prefix}`);
  if (o.scope !== d.scope) lines.push(`install scope: ${o.scope} → ${d.scope}`);
  if (o.link !== d.link) lines.push(`global link mode: ${o.link} → ${d.link}`);
  if (o.generatedFiles !== d.generatedFiles) {
    lines.push(`generated files: ${o.generatedFiles} → ${d.generatedFiles}`);
  }
  if (JSON.stringify(o.hintKeys) !== JSON.stringify(d.hintKeys)) {
    lines.push(`workflow hints: ${list(o.hintKeys)} → ${list(d.hintKeys)}`);
  }
  if (JSON.stringify(o.hintCustom) !== JSON.stringify(d.hintCustom)) {
    lines.push(
      o.hintCustom.length === d.hintCustom.length
        ? `custom reminders: ${d.hintCustom.length} line(s) edited`
        : `custom reminders: ${o.hintCustom.length} → ${d.hintCustom.length} line(s)`
    );
  }
  if (o.archive !== d.archive) {
    lines.push(
      `archive: ${o.archive ? 'enabled' : 'disabled'} → ${d.archive ? 'enabled' : 'disabled'}`
    );
  }
  if (o.gitHooks !== d.gitHooks) {
    lines.push(
      `git hooks: ${o.gitHooks ? 'installed' : 'not installed'} → ${d.gitHooks ? 'installed' : 'not installed'}`
    );
  }
  return lines;
}

/**
 * Apply the draft: persist changed config keys into RAW config.json (a user's
 * minimal config stays minimal), run the update reconcile so every install
 * surface follows, then run the archive and git-hook intents through their
 * own machinery.
 */
async function applyDraft(
  repoRoot: string,
  original: SettingsDraft,
  draft: SettingsDraft,
  opts: ConfigureOptions,
  out: (line: string) => void
): Promise<void> {
  const configChanged =
    JSON.stringify(original.agents) !== JSON.stringify(draft.agents) ||
    original.scope !== draft.scope ||
    original.link !== draft.link ||
    original.prefix !== draft.prefix ||
    original.bootstrap !== draft.bootstrap ||
    original.sessionHooks !== draft.sessionHooks ||
    original.sessionHookEntries !== draft.sessionHookEntries ||
    original.generatedFiles !== draft.generatedFiles ||
    JSON.stringify(original.hintKeys) !== JSON.stringify(draft.hintKeys) ||
    JSON.stringify(original.hintCustom) !== JSON.stringify(draft.hintCustom);

  if (configChanged) {
    const commonDir = await new Repo(repoRoot).getCommonDirAbsolute();
    let updatedConfigPath = '';
    await withRepositoryInstallLock(commonDir, async (installLease) => {
      // Read the config in effect; write to the one the DESTINATION scope owns.
      const source = await resolveConfigSource(repoRoot);
      const destination = await configLocationForScope(repoRoot, draft.scope);
      if (destination.configPath !== source.configPath && draft.scope === 'personal') {
        const tracked = await trackedProjectInstallPaths(new Repo(repoRoot), [
          path.relative(repoRoot, source.configPath),
          INSTALL_MANIFEST_REL,
        ]);
        if (tracked.length > 0) {
          // Rendered here: configure's apply path has no envelope boundary of
          // its own, and an unrendered OrcaopsError would surface as a stack.
          writeErrorLine(refuseTrackedPersonalTransition(tracked));
          throw new CliExit(1);
        }
      }
      const raw = await readRepositoryFileOrNull(
        source.configPath,
        source.containmentRoot,
        'orcaops configuration'
      );
      if (raw === null) {
        throw new OrcaopsError(
          ErrorCodes.UNINITIALIZED,
          `${displayConfigPath(source, repoRoot)} does not exist.`
        );
      }
      const movingSource = destination.configPath !== source.configPath;
      const priorDestination = movingSource
        ? await readRepositoryFileOrNull(
            destination.configPath,
            destination.containmentRoot,
            'orcaops configuration'
          )
        : raw;
      if (movingSource && draft.scope === 'personal' && priorDestination !== null) {
        resolvePersonalConfigForAdoption(
          priorDestination,
          displayConfigPath(destination, repoRoot)
        );
      }
      const parsed = JSON.parse(priorDestination ?? raw) as Record<string, unknown>;
      // Per-key deltas ONLY (update's flag-persistence discipline): a key the
      // user never touched must not materialize in raw config.json — writing
      // today's resolved value would pin today's DEFAULT, silently detaching
      // the repo from a future default change.
      const install = { ...((parsed.install ?? {}) as Record<string, unknown>) };
      let installChanged = false;
      if (JSON.stringify(original.agents) !== JSON.stringify(draft.agents)) {
        install.agents = draft.agents;
        installChanged = true;
      }
      if (original.scope !== draft.scope) {
        install.scope = draft.scope;
        installChanged = true;
      }
      if (original.link !== draft.link) {
        install.link = draft.link;
        installChanged = true;
      }
      if (installChanged) parsed.install = install;
      if (original.prefix !== draft.prefix) {
        parsed.naming = {
          ...((parsed.naming ?? {}) as Record<string, unknown>),
          prefix: draft.prefix,
        };
      }
      if (original.bootstrap !== draft.bootstrap) parsed.bootstrap = draft.bootstrap;
      if (original.generatedFiles !== draft.generatedFiles) {
        parsed.generated_files = draft.generatedFiles;
      }
      if (
        original.sessionHooks !== draft.sessionHooks ||
        original.sessionHookEntries !== draft.sessionHookEntries
      ) {
        parsed.session_hooks = {
          ...((parsed.session_hooks ?? {}) as Record<string, unknown>),
          enabled: draft.sessionHooks !== 'off',
          // 'off' keeps the prior payload preference so a later re-enable
          // resumes it.
          ...(draft.sessionHooks !== 'off' ? { payload: draft.sessionHooks } : {}),
          ...(original.sessionHookEntries !== draft.sessionHookEntries
            ? { entries: draft.sessionHookEntries }
            : {}),
        };
      }
      if (
        JSON.stringify(original.hintKeys) !== JSON.stringify(draft.hintKeys) ||
        JSON.stringify(original.hintCustom) !== JSON.stringify(draft.hintCustom)
      ) {
        const workflow = (parsed.workflow ?? {}) as Record<string, unknown>;
        const hints = (workflow.hints ?? {}) as Record<string, unknown>;
        parsed.workflow = {
          ...workflow,
          hints: { ...hints, keys: draft.hintKeys, custom: draft.hintCustom },
        };
      }

      const desired = `${JSON.stringify(parsed, null, 2)}\n`;
      const writes = [
        writeMutation(
          repoRoot,
          path.relative(repoRoot, destination.configPath),
          desired,
          priorDestination,
          desired !== priorDestination,
          destination.containmentRoot,
          destination.configPath
        ),
      ];
      // Leaving a worktree config behind after publishing to the shared file
      // would brick every command: source selection fails closed on a
      // worktree config that claims personal.
      if (movingSource && source.kind === 'worktree') {
        writes.push(
          deleteMutation(
            repoRoot,
            path.relative(repoRoot, source.configPath),
            { kind: 'file', content: raw },
            true
          )
        );
      }
      await installLease.verify();
      await executeMutations(writes, 'apply');
      updatedConfigPath = displayConfigPath(destination, repoRoot);
    });
    out(`Updated ${updatedConfigPath}.`);
    out('');
    // The ONE shared reconcile: update re-reads the persisted config and
    // reports the file effects (installed/refreshed/pruned, session-hook
    // entries, the restart notice) itself. The config write above already
    // moved the scope, so update is told what it moved FROM — otherwise the
    // scope-exit reconcile cannot see a transition and the .gitignore block
    // is stranded.
    await updateAction({ cwd: opts.cwd, previousScope: original.scope });
  }

  if (original.archive !== draft.archive) {
    // Archive actions resolve cwd from the invocation frame (like every
    // command); routing through them keeps the first-enable backfill and
    // retain-on-disable semantics.
    if (draft.archive) await archiveEnableAction({});
    else await archiveDisableAction({});
  }

  if (original.gitHooks !== draft.gitHooks) {
    const repo = new Repo(repoRoot);
    if (draft.gitHooks) {
      const hooksDir = await repo.getHooksDir();
      if (hooksDir.source === 'core.hooksPath') {
        out(
          `! git hooks not installed — core.hooksPath points at ` +
            `${path.relative(repoRoot, hooksDir.dir) || hooksDir.dir} (hook-manager-owned); ` +
            'wire `orcaops lineage` into your post-merge/post-rewrite hooks there instead'
        );
      } else {
        for (const name of ['post-merge', 'post-rewrite'] as const) {
          const plan = await planGitHookMutation(
            repoRoot,
            hooksDir.dir,
            name,
            CLI_VERSION,
            (absPath) => readRepositoryFileForOwnership(absPath, hooksDir.dir, `Git hook ${name}`)
          );
          await executeMutations([plan.mutation], 'apply');
          out(
            plan.action === 'preserved-conflict'
              ? `! ${plan.mutation.path} left untouched (pre-existing hook without an orcaops stamp)`
              : `Git hook ${plan.action}: ${plan.mutation.path}`
          );
        }
      }
    } else {
      const gitCommonDir = await repo.getCommonDirAbsolute();
      const removal = await planRemoveGitHooks(
        repoRoot,
        await hooksDirCandidates(repo),
        (absPath) =>
          readRepositoryFileForOwnership(
            absPath,
            absPath.startsWith(gitCommonDir + path.sep) ? gitCommonDir : path.dirname(absPath),
            'Git hook'
          ),
        CLI_VERSION
      );
      await executeMutations(removal.mutations, 'apply');
      for (const rel of removal.removed) out(`Git hook removed: ${rel}`);
      for (const rel of removal.preserved) out(`! ${rel} preserved (no orcaops stamp)`);
      for (const rel of removal.unverified) {
        out(`! ${rel} left untouched (ownership could not be verified)`);
      }
    }
  }

  out('');
  out('Configuration applied.');
}

async function gitHooksInstalled(repoRoot: string): Promise<boolean> {
  // Union scan (active hooks dir + default common dir) so a hook stranded by
  // a later core.hooksPath adoption still reads as installed — the disable
  // path removes from the same union.
  let dirs: string[];
  try {
    dirs = await hooksDirCandidates(new Repo(repoRoot));
  } catch {
    dirs = [path.join(repoRoot, '.git', 'hooks')];
  }
  for (const dir of dirs) {
    for (const name of ['post-merge', 'post-rewrite'] as const) {
      let body: string | null = null;
      try {
        body = await readRepositoryFileOrNull(path.join(dir, name), dir, `Git hook ${name}`);
      } catch {
        // A redirected or refused hooks path cannot prove an install — the
        // toggle's guarded write path reports the real state.
      }
      if (body?.includes('# orcaops-hook v=')) return true;
    }
  }
  return false;
}
