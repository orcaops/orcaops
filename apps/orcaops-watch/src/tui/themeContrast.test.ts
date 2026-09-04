import { describe, expect, it } from 'vitest';

import { THEMES } from '@orcaops/diff-render';
import type { AgentState } from '@orcaops/watch-data/ui';

import { cockpitThemeFor } from './ThemeProvider';
import { COCKPIT_DARK, COCKPIT_LIGHT, type CockpitTheme } from './theme';

const STATES: readonly AgentState[] = [
  'working',
  'quiet',
  'stalled',
  'starting',
  'wrapping',
  'ready',
  'idle',
  'done',
];

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const PALETTES: Array<[string, CockpitTheme]> = [
  ['dark', COCKPIT_DARK],
  ['light', COCKPIT_LIGHT],
];

describe('shared cockpit and dialog contrast', () => {
  it.each(PALETTES)(
    '%s keeps chrome, dialogs, focus, status, and hover legible',
    (_name, theme) => {
      const normalTextPairs = [
        ['dialog title', theme.BRIGHT, theme.PANEL_BG],
        ['dialog body', theme.FG, theme.PANEL_BG],
        ['Help descriptions', theme.DIM, theme.PANEL_BG],
        ['status feedback', theme.AMBER, theme.PANEL_BG],
        ['selected modal action', theme.BRIGHT, theme.FOCUS_BG],
        ['hovered primary action', theme.FG, theme.SEL_BG],
        ['sparse accent text', theme.ACCENT, theme.PANEL_BG],
        ['actionable attention', theme.AMBER, theme.PANEL_BG],
      ] as const;
      for (const [label, foreground, background] of normalTextPairs) {
        expect(contrast(foreground, background), label).toBeGreaterThanOrEqual(4.5);
      }

      // Borders and focus indicators are non-text UI components, whose WCAG floor is 3:1.
      expect(
        contrast(theme.FOCUS_MARKER, theme.PANEL_BG),
        'focus and dialog border'
      ).toBeGreaterThanOrEqual(3);
    }
  );

  it('keeps concrete theme-derived cockpit prose readable on its panel surfaces', () => {
    for (const appTheme of THEMES) {
      const theme = cockpitThemeFor(appTheme);
      const normalTextPairs = [
        ['dialog title', theme.BRIGHT, theme.PANEL_BG],
        ['dialog body', theme.FG, theme.PANEL_BG],
        ['Help descriptions', theme.DIM, theme.PANEL_BG],
        ['selected modal action', theme.BRIGHT, theme.FOCUS_BG],
        ['hovered primary action', theme.FG, theme.SEL_BG],
        ['sparse accent text', theme.ACCENT, theme.PANEL_BG],
        ['actionable attention', theme.AMBER, theme.PANEL_BG],
        ['ready text', theme.BLUE, theme.PANEL_BG],
        ['wrapping text', theme.CYAN, theme.PANEL_BG],
        ['live text', theme.LIVE, theme.PANEL_BG],
        ['error text', theme.RED, theme.PANEL_BG],
      ] as const;
      for (const [label, foreground, background] of normalTextPairs) {
        expect(
          contrast(foreground, background),
          `${appTheme.id} · ${label}`
        ).toBeGreaterThanOrEqual(4.5);
      }

      for (const background of [theme.PANEL_BG, theme.FOCUS_BG]) {
        expect(
          contrast(theme.FOCUS_MARKER, background),
          `${appTheme.id} · focus marker`
        ).toBeGreaterThanOrEqual(3);
      }

      for (const state of STATES) {
        const selectedBackground =
          state === 'stalled'
            ? theme.STALLED_BG
            : state === 'ready'
              ? theme.READY_BG
              : theme.FOCUS_BG;
        for (const [emphasis, color] of [
          ['normal', theme.COLOR[state]],
          ['high', theme.COLOR_HI[state]],
        ] as const) {
          expect(
            contrast(color, theme.PANEL_BG),
            `${appTheme.id} · ${state} ${emphasis} · panel`
          ).toBeGreaterThanOrEqual(3);
          expect(
            contrast(color, selectedBackground),
            `${appTheme.id} · ${state} ${emphasis} · selected`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('keeps every bundled theme-selector label readable and each semantic sample visible', () => {
    for (const theme of THEMES) {
      const textPairs = [
        ['dialog text', theme.text, theme.panel],
        ['muted text and border', theme.muted, theme.panel],
        ['selected row text', theme.text, theme.accentMuted],
        ['sample label', theme.text, theme.background],
        ['sample context', theme.muted, theme.background],
      ] as const;
      for (const [label, foreground, background] of textPairs) {
        expect(contrast(foreground, background), `${theme.id} · ${label}`).toBeGreaterThanOrEqual(
          4.5
        );
      }

      const semanticMarkers = [
        ['added marker', theme.addedSignColor],
        ['removed marker', theme.removedSignColor],
        ['changed marker', theme.accent],
      ] as const;
      for (const [label, foreground] of semanticMarkers) {
        expect(
          contrast(foreground, theme.background),
          `${theme.id} · ${label}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
