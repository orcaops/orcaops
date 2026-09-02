// The review theme's persistence seam. A theme choice is a PERSONAL, per-machine
// preference — not team state — so it lives in the GLOBAL user config
// (`${XDG_CONFIG_HOME:-~/.config}/orcaops/watch.json`, honoring
// `ORCAOPS_CONFIG_HOME`), never the git-tracked project `.orcaops/config.json`.
// Write is an atomic read-modify-write of the user file (its parent dir is
// created as needed) that preserves any other user keys. Renderer-free (the
// src/data rule); every failure degrades to null / a caller notice, never a crash.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultConfigDir } from '@orcaops/core';
import { atomicWriteFile } from '@orcaops/storage';

/** The global user watch-prefs file — one per user/machine, never inside a repo. */
export function userWatchConfigPath(): string {
  return path.join(defaultConfigDir(), 'watch.json');
}

/** Parse the user watch config into an object, or `{}` on any miss/error. */
async function readUserWatchConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(userWatchConfigPath(), 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // absent / unreadable / invalid JSON — treat as empty; detection decides
  }
  return {};
}

/**
 * The persisted theme id, or null (⇒ terminal detection decides the default).
 */
export async function loadPersistedTheme(): Promise<string | null> {
  const fromUser = (await readUserWatchConfig()).theme;
  if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
  return null;
}

/**
 * The persisted transparent-background opt-out — default false ⇒ OPAQUE, so the
 * theme paints its own background and a light theme is not read through a dark
 * terminal. Set `transparentBackground: true` in the user config to let the
 * terminal show through instead. Reads the same user config file as the theme; never rejects.
 */
export async function loadTransparentBackground(): Promise<boolean> {
  return (await readUserWatchConfig()).transparentBackground === true;
}

/**
 * Persist a committed theme id into the global user config (atomic RMW, other
 * user keys preserved). Rejects only on an unwritable filesystem; the caller
 * keeps the session override and surfaces the reason.
 */
export async function persistTheme(themeId: string): Promise<void> {
  const obj = await readUserWatchConfig();
  obj.theme = themeId;
  await atomicWriteFile(userWatchConfigPath(), `${JSON.stringify(obj, null, 2)}\n`);
}
