import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@orcaops/diff-render';

import {
  detectTerminalThemeModeFromBackground,
  parseOsc11BackgroundColor,
  resolveInitialThemeId,
  themeModeForBackgroundColor,
} from './themeDetection';

class FakeThemeInput extends EventEmitter {
  isRaw = false;
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
  resume(): void {}
}

describe('terminal theme detection', () => {
  it('parses OSC 11 rgb responses', () => {
    expect(parseOsc11BackgroundColor('\x1b]11;rgb:0000/1111/2222\x1b\\')).toEqual({
      red: 0,
      green: 17,
      blue: 34,
    });
    expect(parseOsc11BackgroundColor('\x1b]11;#ffffff\x07')).toEqual({
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  it('returns null for replies it cannot parse', () => {
    expect(parseOsc11BackgroundColor('')).toBeNull();
    expect(parseOsc11BackgroundColor('\x1b]11;nonsense\x07')).toBeNull();
  });

  it('classifies dark and light backgrounds', () => {
    expect(themeModeForBackgroundColor({ red: 12, green: 12, blue: 12 })).toBe('dark');
    expect(themeModeForBackgroundColor({ red: 245, green: 245, blue: 245 })).toBe('light');
  });

  it('detects terminal mode from the queried input stream and restores raw mode', async () => {
    const input = new FakeThemeInput();
    let query = '';
    const output = {
      write(chunk: string): void {
        query += chunk;
        queueMicrotask(() => input.emit('data', '\x1b]11;rgb:0000/0000/0000\x1b\\'));
      },
    };

    await expect(
      detectTerminalThemeModeFromBackground({ input, output, timeoutMs: 50 })
    ).resolves.toBe('dark');
    expect(query).toBe('\x1b]11;?\x1b\\');
    expect(input.isRaw).toBe(false);
  });

  it('resolves null (not an error) when the terminal never answers', async () => {
    const input = new FakeThemeInput();
    const output = { write(): void {} };
    await expect(
      detectTerminalThemeModeFromBackground({ input, output, timeoutMs: 10 })
    ).resolves.toBeNull();
    expect(input.listenerCount('data')).toBe(0); // probe cleaned up after itself
  });
});

describe('resolveInitialThemeId — persisted > detected > default', () => {
  it('a persisted bundled theme wins over detection', () => {
    expect(resolveInitialThemeId('ayu-dark', 'light')).toBe('ayu-dark');
  });

  it('detection picks the light/dark default when nothing is persisted', () => {
    expect(resolveInitialThemeId(null, 'light')).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(resolveInitialThemeId(null, 'dark')).toBe(DEFAULT_DARK_THEME_ID);
  });

  it('detection failure falls back to the hardcoded dark default', () => {
    expect(resolveInitialThemeId(null, null)).toBe(DEFAULT_DARK_THEME_ID);
  });

  it('a persisted id the bundle no longer carries falls through to detection', () => {
    expect(resolveInitialThemeId('retired-theme', 'light')).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(resolveInitialThemeId('retired-theme', null)).toBe(DEFAULT_DARK_THEME_ID);
  });
});
