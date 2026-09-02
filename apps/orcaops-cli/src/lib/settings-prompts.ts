import { CURATED_HINTS, getAgentOverlay } from '@orcaops/adapters';
import { type HintKey, SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

/**
 * The single source of user-facing prompt copy for orcaops settings — shared
 * by `orcaops configure` (the menu) and `orcaops init` (the interactive
 * setup), so the two surfaces can never drift apart. The copy rules:
 * plain-noun labels; each message explains in 1–2
 * sentences what the setting does and which files it touches; option hints
 * state consequences, not mechanisms; human prose over config keys; and no
 * internal vocabulary (manifest-tracked, ref-counted, materialization,
 * lineage, curated, managed block, bootstrap).
 *
 * These objects carry MESSAGE + OPTIONS only. Behavior — initialValue
 * seeding, cancel semantics, ordering — belongs to each caller: configure's
 * cancel returns to the menu; init's cancel aborts the interview before writes.
 */

export interface SettingsPromptOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

export const agentsPrompt = {
  message:
    'Which AI coding agents do you use in this repo? orcaops installs its ' +
    'commands and skills for each one you pick (pick none to run orcaops by hand).',
  options(): SettingsPromptOption<SupportedAgentId>[] {
    return SUPPORTED_AGENT_IDS.map((id) => ({
      value: id,
      label: getAgentOverlay(id)?.name ?? id,
      hint: getAgentOverlay(id)?.status,
    }));
  },
};

export function sessionHooksPrompt(bootstrap: 'managed' | 'manual') {
  return {
    message:
      'Session-start hooks put a short orcaops reminder into your agent’s context ' +
      'at the start of every session, so it remembers to capture its work. ' +
      'What should the reminder say?',
    options: [
      {
        value: 'static',
        label: 'On — fixed reminder (recommended)',
        hint: 'the same short note every session',
      },
      {
        value: 'state-aware',
        label: 'On — state-aware (experimental)',
        hint: 'names capture work in progress; worst case: unhelpful guidance — never a broken session',
      },
      {
        value: 'off',
        label: 'Off',
        hint:
          bootstrap === 'managed'
            ? 'rely on the instructions-file section alone'
            : 'no automatic workflow guidance',
      },
    ] satisfies SettingsPromptOption<'static' | 'state-aware' | 'off'>[],
  };
}

export const sessionHookEntriesPrompt = {
  message: 'Which registration carries the hook in this repo?',
  options: [
    {
      value: 'project',
      label: 'Repo settings entries',
      hint: 'reconciled into .claude/settings.json etc. (project scope)',
    },
    {
      value: 'none',
      label: 'Machine-level only',
      hint: 'no repo settings files — relies on `orcaops session-hooks install`',
    },
  ] satisfies SettingsPromptOption<'project' | 'none'>[],
};

export function blockPrompt(scope: 'project' | 'global' | 'personal') {
  const files = scope === 'personal' ? 'CLAUDE.local.md' : 'AGENTS.md / CLAUDE.md';
  return {
    message: `Let orcaops keep a section in ${files} that teaches agents the capture workflow. Who maintains it?`,
    options: [
      {
        value: 'managed',
        label: 'orcaops keeps it up to date',
        hint: `added to ${files} now, refreshed whenever orcaops updates`,
      },
      {
        value: 'manual',
        label: `Hands off ${files}`,
        hint: `${files} will never be edited by orcaops`,
      },
    ] satisfies SettingsPromptOption<'managed' | 'manual'>[],
  };
}

export const prefixPrompt = {
  message:
    'Name prefix for the installed commands and skills — "oo" gives you ' +
    '/oo-capture instead of /orcaops-capture. Renaming is safe: old files ' +
    'are cleaned up and regenerated under the new name.',
  invalidLine: (value: string): string =>
    `  ! "${value}" must be lowercase and hyphen-safe (e.g. "orcaops", "oo", "my-team").`,
};

export const scopePrompt = {
  message: 'Where should the orcaops support files live?',
  options: [
    {
      value: 'project',
      label: 'In this repo (recommended)',
      hint: 'committed with your code, so teammates get them too',
    },
    {
      value: 'global',
      label: 'In your home directory',
      hint: 'shared across all your repos; adds nothing to this one',
    },
    {
      value: 'personal',
      label: 'Just for you (invisible — the default)',
      hint: 'nothing touches git; every agent gets skills in your home directory',
    },
  ] satisfies SettingsPromptOption<'project' | 'global' | 'personal'>[],
};

export const linkPrompt = {
  message: 'For home-directory installs: how should the files be written?',
  options: [
    {
      value: 'copy',
      label: 'Independent copies (recommended)',
      hint: 'always safe; refreshed by orcaops update',
    },
    {
      value: 'symlink',
      label: 'Symlinks',
      hint: 'stay in sync automatically; needs a stable orcaops install path',
    },
  ] satisfies SettingsPromptOption<'copy' | 'symlink'>[],
};

export const generatedFilesPrompt = {
  message: 'Should the files orcaops generates be committed to git?',
  options: [
    {
      value: 'commit',
      label: 'Commit them (recommended)',
      hint: 'teammates get everything on pull',
    },
    {
      value: 'ignore',
      label: 'Gitignore them',
      hint: 'each person generates their own copy locally',
    },
  ] satisfies SettingsPromptOption<'commit' | 'ignore'>[],
};

export const hintsPrompt = {
  message:
    'Pick extra one-line reminders to show your agent next to the workflow ' +
    '(you can add your own free-form lines next):',
  options(): SettingsPromptOption<HintKey>[] {
    return CURATED_HINTS.map((h) => ({ value: h.key, label: h.prose }));
  },
};

export const archivePrompt = {
  message:
    'Keep a backup of captured session history in your home directory? It ' +
    'survives deleting or re-cloning this checkout (turning it on backs up ' +
    'existing history; turning it off keeps what was already backed up).',
};

export const gitHooksPrompt = {
  message:
    'Install git hooks that refresh captured history after merges and rebases? ' +
    '(any git hooks you already have are never overwritten)',
};

export const customizeMorePrompt = {
  message:
    'Customize more? Command name prefix, install location, generated files ' +
    'in git, workflow reminders, session-hook registration, git hooks — all ' +
    'changeable later with `orcaops configure`.',
};

export const hintsCustomPrompt = {
  keepMessage: 'Keep which of your own reminders? Unchecked ones are removed.',
  addMessage: 'Add a reminder of your own (leave blank to finish):',
};
