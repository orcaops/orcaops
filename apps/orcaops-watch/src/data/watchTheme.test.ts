import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '@orcaops/storage';

import {
  loadPersistedTheme,
  loadTransparentBackground,
  persistTheme,
  userWatchConfigPath,
} from './watchTheme';

let configHome: string; // the global user config dir (via ORCAOPS_CONFIG_HOME)
let priorHome: string | undefined;

beforeEach(async () => {
  configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-home-'));
  priorHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
  else process.env.ORCAOPS_CONFIG_HOME = priorHome;
  await rm(configHome, { recursive: true, force: true });
});

describe('watch.theme persistence (global user config)', () => {
  it('returns null when the user config has no theme', async () => {
    await expect(loadPersistedTheme()).resolves.toBeNull();
  });

  it('round-trips through the global user config', async () => {
    await persistTheme('ayu-dark');
    await expect(loadPersistedTheme()).resolves.toBe('ayu-dark');
    const user = JSON.parse(await readFile(userWatchConfigPath(), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(user).toEqual({ theme: 'ayu-dark' });
  });

  it('re-persist replaces the theme in place', async () => {
    await persistTheme('ayu-dark');
    await persistTheme('github-light-default');
    await expect(loadPersistedTheme()).resolves.toBe('github-light-default');
  });

  it('preserves other user-config keys (future prefs survive)', async () => {
    await atomicWriteFile(
      userWatchConfigPath(),
      `${JSON.stringify({ theme: 'ayu-dark', transparentBackground: true }, null, 2)}\n`
    );
    await persistTheme('github-light-default');
    const user = JSON.parse(await readFile(userWatchConfigPath(), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(user).toEqual({ theme: 'github-light-default', transparentBackground: true });
  });

  it('degrades to null on an unreadable user config', async () => {
    await atomicWriteFile(userWatchConfigPath(), 'not json\n');
    await expect(loadPersistedTheme()).resolves.toBeNull();
  });
});

describe('transparentBackground opt-out (global user config)', () => {
  it('defaults to false when the user config has no such key', async () => {
    await expect(loadTransparentBackground()).resolves.toBe(false);
  });

  it('reads true when the opt-out is set', async () => {
    await atomicWriteFile(
      userWatchConfigPath(),
      `${JSON.stringify({ theme: 'ayu-dark', transparentBackground: true }, null, 2)}\n`
    );
    await expect(loadTransparentBackground()).resolves.toBe(true);
  });

  it('coerces an explicit false (and any non-true) to false', async () => {
    await atomicWriteFile(
      userWatchConfigPath(),
      `${JSON.stringify({ transparentBackground: false }, null, 2)}\n`
    );
    await expect(loadTransparentBackground()).resolves.toBe(false);
  });

  it('degrades to false on an unreadable user config', async () => {
    await atomicWriteFile(userWatchConfigPath(), 'not json\n');
    await expect(loadTransparentBackground()).resolves.toBe(false);
  });

  it('survives a theme write (persistTheme preserves the opt-out key)', async () => {
    await atomicWriteFile(
      userWatchConfigPath(),
      `${JSON.stringify({ transparentBackground: true }, null, 2)}\n`
    );
    await persistTheme('github-light-default');
    await expect(loadTransparentBackground()).resolves.toBe(true);
    await expect(loadPersistedTheme()).resolves.toBe('github-light-default');
  });
});
