import { type HintKey, resolveConfig } from '@orcaops/storage';

import {
  archivePrompt,
  blockPrompt,
  generatedFilesPrompt,
  gitHooksPrompt,
  hintsCustomPrompt,
  hintsPrompt,
  linkPrompt,
  prefixPrompt,
  scopePrompt,
  sessionHookEntriesPrompt,
  sessionHooksPrompt,
} from './settings-prompts.js';
import { writeTerminalSafeStdout } from '../io/output.js';

/**
 * The single edit loop per orcaops setting — shared by `orcaops configure`
 * (the menu) and `orcaops init` (the interactive interview + its
 * customize-more branch), so the two surfaces cannot drift
 * behaviorally. Copy lives in
 * settings-prompts; THIS module owns the prompt call, value validation, and
 * defensive enum narrowing.
 *
 * Contract: every editor seeds from the caller-supplied current value and
 * returns the chosen value, or **null when the user cancels** (Ctrl-C/Esc).
 * What null MEANS belongs to each caller: configure keeps the draft value,
 * while init aborts its whole interview before writes. @clack is lazy-imported
 * per call so non-interactive paths (and unattended init) never load the prompt lib.
 */

type Clack = typeof import('@clack/prompts');

async function clack(): Promise<Clack> {
  return import('@clack/prompts');
}

/** Re-prompts until the prefix validates; prints why on each miss. */
export async function editPrefix(current: string): Promise<string | null> {
  const { text, isCancel } = await clack();
  for (;;) {
    const value = await text({ message: prefixPrompt.message, initialValue: current });
    if (isCancel(value)) return null;
    try {
      resolveConfig({ naming: { prefix: value } });
      return value as string;
    } catch {
      writeTerminalSafeStdout(`${prefixPrompt.invalidLine(value as string)}\n`);
    }
  }
}

export async function editScope(
  current: 'project' | 'global' | 'personal'
): Promise<'project' | 'global' | 'personal' | null> {
  const { select, isCancel } = await clack();
  const value = await select({
    message: scopePrompt.message,
    options: scopePrompt.options,
    initialValue: current,
  });
  if (isCancel(value)) return null;
  return value === 'project' || value === 'global' ? value : 'personal';
}

export async function editLink(current: 'copy' | 'symlink'): Promise<'copy' | 'symlink' | null> {
  const { select, isCancel } = await clack();
  const value = await select({
    message: linkPrompt.message,
    options: linkPrompt.options,
    initialValue: current,
  });
  if (isCancel(value)) return null;
  return value === 'symlink' ? 'symlink' : 'copy';
}

export async function editGeneratedFiles(
  current: 'commit' | 'ignore'
): Promise<'commit' | 'ignore' | null> {
  const { select, isCancel } = await clack();
  const value = await select({
    message: generatedFilesPrompt.message,
    options: generatedFilesPrompt.options,
    initialValue: current,
  });
  if (isCancel(value)) return null;
  return value === 'ignore' ? 'ignore' : 'commit';
}

export async function editHints(current: readonly HintKey[]): Promise<HintKey[] | null> {
  const { multiselect, isCancel } = await clack();
  const picked = await multiselect({
    message: hintsPrompt.message,
    options: hintsPrompt.options(),
    initialValues: [...current],
    required: false,
  });
  if (isCancel(picked)) return null;
  return picked as HintKey[];
}

/**
 * The user's free-form reminder lines: keep/remove the existing ones via a
 * multiselect, then append new ones until a blank line. Cancel at the KEEP
 * step or the add loop returns null (the caller keeps the list exactly as it
 * was). A blank line is the only way to finish and accept the edited list.
 */
export async function editHintsCustom(current: readonly string[]): Promise<string[] | null> {
  const { multiselect, text, isCancel } = await clack();
  let kept = [...current];
  if (kept.length > 0) {
    const keep = await multiselect({
      message: hintsCustomPrompt.keepMessage,
      options: kept.map((line, i) => ({ value: String(i), label: line })),
      initialValues: kept.map((_, i) => String(i)),
      required: false,
    });
    if (isCancel(keep)) return null;
    const keepSet = new Set(keep as string[]);
    kept = kept.filter((_, i) => keepSet.has(String(i)));
  }
  for (;;) {
    const line = await text({ message: hintsCustomPrompt.addMessage });
    if (isCancel(line)) return null;
    const trimmed = String(line ?? '').trim();
    if (trimmed.length === 0) return kept;
    kept.push(trimmed);
  }
}

/**
 * The session-hooks on/off+payload select. Anything that is not an explicit
 * opt-in narrows to 'off' — an unexpected select value must never end up
 * persisted as a payload enum.
 */
export async function editSessionHooksChoice(
  initial: 'static' | 'state-aware' | 'off',
  bootstrap: 'managed' | 'manual'
): Promise<'static' | 'state-aware' | 'off' | null> {
  const { select, isCancel } = await clack();
  const prompt = sessionHooksPrompt(bootstrap);
  const value = await select({
    message: prompt.message,
    options: prompt.options,
    initialValue: initial,
  });
  if (isCancel(value)) return null;
  return value === 'static' || value === 'state-aware' ? value : 'off';
}

/** Which registration carries the hook in this repo (`session_hooks.entries`). */
export async function editSessionHookEntries(
  current: 'project' | 'none'
): Promise<'project' | 'none' | null> {
  const { select, isCancel } = await clack();
  const value = await select({
    message: sessionHookEntriesPrompt.message,
    options: sessionHookEntriesPrompt.options,
    initialValue: current,
  });
  if (isCancel(value)) return null;
  return value === 'none' ? 'none' : 'project';
}

/** Narrows defensively: only an explicit 'managed' grants instruction-file writes. */
export async function editBlockChoice(
  initial: 'managed' | 'manual'
): Promise<'managed' | 'manual' | null> {
  const { select, isCancel } = await clack();
  const prompt = blockPrompt();
  const value = await select({
    message: prompt.message,
    options: prompt.options,
    initialValue: initial,
  });
  if (isCancel(value)) return null;
  return value === 'managed' ? 'managed' : 'manual';
}

export async function editArchiveEnabled(initial: boolean): Promise<boolean | null> {
  const { confirm, isCancel } = await clack();
  const value = await confirm({ message: archivePrompt.message, initialValue: initial });
  if (isCancel(value)) return null;
  return value;
}

export async function editGitHooksConfirm(initial: boolean): Promise<boolean | null> {
  const { confirm, isCancel } = await clack();
  const value = await confirm({ message: gitHooksPrompt.message, initialValue: initial });
  if (isCancel(value)) return null;
  return value;
}
