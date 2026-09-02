// Terminal light/dark detection for the review surface's theme default.
// Adapted from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path
// src/core/themeDetection.ts (MIT — full text: packages/diff-render/LICENSE).
// Adaptations: local TerminalThemeMode type (hunk keeps it in core/types), and
// resolveInitialThemeId — our precedence rule (persisted > detected > default)
// over the bundled diff-render themes.
//
// The probe writes an OSC 11 query and parses the reply off the given input
// stream. It MUST run before OpenTUI owns stdin (main.tsx, pre-render):
// probing after would feed the reply bytes to the key parser too, and
// sequences like `]11;rgb:…` contain letters that dispatch review verbs.
// Defensive throughout — timeout or parse failure resolves null, never throws.

import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, THEMES } from '@orcaops/diff-render';

export type TerminalThemeMode = 'light' | 'dark';

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

interface ThemeProbeInput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
}

interface ThemeProbeOutput {
  write(chunk: string): unknown;
}

export interface DetectTerminalThemeOptions {
  input: ThemeProbeInput;
  output: ThemeProbeOutput;
  timeoutMs?: number;
}

const OSC_11_BACKGROUND_QUERY = '\x1b]11;?\x1b\\';

/** Convert xterm-style OSC 11 color channels into 8-bit RGB. */
function parseHexChannel(channel: string): number | null {
  const value = Number.parseInt(channel, 16);
  if (Number.isNaN(value)) {
    return null;
  }

  const max = 16 ** channel.length - 1;
  return Math.round((value / max) * 255);
}

/** Parse common OSC 11 background-color responses into RGB. */
export function parseOsc11BackgroundColor(sequence: string): RgbColor | null {
  // The escape/bell bytes ARE the protocol here (OSC intro + terminators), so
  // eslint's no-control-regex guard is a false positive on both patterns.
  const rgbMatch =
    // eslint-disable-next-line no-control-regex
    /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x07|\x1b\\)/i.exec(sequence);
  if (rgbMatch) {
    const red = parseHexChannel(rgbMatch[1]!);
    const green = parseHexChannel(rgbMatch[2]!);
    const blue = parseHexChannel(rgbMatch[3]!);
    return red === null || green === null || blue === null ? null : { red, green, blue };
  }

  // eslint-disable-next-line no-control-regex
  const hexMatch = /\x1b\]11;#([0-9a-f]{6})(?:\x07|\x1b\\)/i.exec(sequence);
  if (!hexMatch) {
    return null;
  }

  const [, hex] = hexMatch;
  return {
    red: Number.parseInt(hex!.slice(0, 2), 16),
    green: Number.parseInt(hex!.slice(2, 4), 16),
    blue: Number.parseInt(hex!.slice(4, 6), 16),
  };
}

/** Classify a background color using relative luminance. */
export function themeModeForBackgroundColor({ red, green, blue }: RgbColor): TerminalThemeMode {
  const linear = [red, green, blue].map((component) => {
    const normalized = component / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.5 ? 'light' : 'dark';
}

/**
 * Probe the terminal background via OSC 11 on the given input/output streams.
 * Resolves null when the terminal never answers (timeoutMs) — callers fall
 * back to the hardcoded default, never crash.
 */
export async function detectTerminalThemeModeFromBackground({
  input,
  output,
  timeoutMs = 150,
}: DetectTerminalThemeOptions): Promise<TerminalThemeMode | null> {
  const wasRaw = input.isRaw;
  let settled = false;
  let buffer = '';

  return await new Promise<TerminalThemeMode | null>((resolve) => {
    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      if (wasRaw !== undefined) {
        input.setRawMode?.(wasRaw);
      }
    };

    const finish = (mode: TerminalThemeMode | null): void => {
      cleanup();
      resolve(mode);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const color = parseOsc11BackgroundColor(buffer);
      if (color) {
        finish(themeModeForBackgroundColor(color));
      }
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onData);
    output.write(OSC_11_BACKGROUND_QUERY);
  });
}

/**
 * The review theme precedence rule: a persisted user theme naming a bundled
 * theme wins; otherwise the detected terminal mode picks the light/dark
 * default; otherwise the hardcoded dark default. A persisted id the bundle no
 * longer carries falls THROUGH to detection (stale config must not pin the
 * fallback-dark resolveTheme would silently give it).
 */
export function resolveInitialThemeId(
  persisted: string | null,
  detected: TerminalThemeMode | null
): string {
  if (persisted !== null && THEMES.some((theme) => theme.id === persisted)) {
    return persisted;
  }
  return detected === 'light' ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
}
