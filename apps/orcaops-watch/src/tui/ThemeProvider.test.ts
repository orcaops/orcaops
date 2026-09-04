import { describe, expect, it } from 'vitest';

import { THEMES } from '@orcaops/diff-render';
import type { AgentState } from '@orcaops/watch-data/ui';

import { cockpitThemeFor, resolveThemeSelection } from './ThemeProvider';
import { SPACE, SYMBOL, UI_GLYPH } from './coreTheme';
import { COCKPIT_DARK, COCKPIT_LIGHT } from './theme';

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

describe('cockpitThemeFor', () => {
  it('maps every concrete theme through its own opaque neutral and accent fields', () => {
    for (const theme of THEMES) {
      const cockpit = cockpitThemeFor(theme);
      expect(cockpit.FG, theme.id).toBe(theme.text);
      expect(cockpit.DIM, theme.id).toBe(theme.muted);
      expect(cockpit.BRIGHT, theme.id).toBe(theme.text);
      expect(cockpit.FRAME, theme.id).toBe(theme.border);
      expect(cockpit.SEL_BG, theme.id).toBe(theme.accentMuted);
      expect(cockpit.FOCUS_BG, theme.id).toBe(theme.accentMuted);
      expect(cockpit.ACCENT, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(cockpit.FOCUS_MARKER, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(cockpit.PANEL_BG, theme.id).toBe(theme.panel);
    }
  });

  it('does not collapse distinct same-appearance themes onto one cockpit palette', () => {
    const first = THEMES[0]!;
    const second = THEMES.find(
      (theme) => theme.appearance === first.appearance && theme.panel !== first.panel
    );
    expect(second).toBeDefined();
    expect(cockpitThemeFor(second!).PANEL_BG).not.toBe(cockpitThemeFor(first).PANEL_BG);
  });

  it('keeps all appearance-anchored semantic states distinct after theme contrast adjustment', () => {
    for (const theme of THEMES) {
      const cockpit = cockpitThemeFor(theme);
      const semantic = theme.appearance === 'light' ? COCKPIT_LIGHT : COCKPIT_DARK;
      expect(Object.keys(cockpit.COLOR).sort()).toEqual(Object.keys(semantic.COLOR).sort());
      expect(Object.keys(cockpit.COLOR_HI).sort()).toEqual(Object.keys(semantic.COLOR_HI).sort());
      expect(new Set(Object.values(cockpit.COLOR)).size, `${theme.id} · normal states`).toBe(
        STATES.length
      );
      expect(new Set(Object.values(cockpit.COLOR_HI)).size, `${theme.id} · high states`).toBe(
        STATES.length
      );
    }
  });
});

describe('resolveThemeSelection', () => {
  it('uses the same concrete adapter for committed and preview ids', () => {
    const first = THEMES[0]!;
    const preview = THEMES.find((theme) => theme.id !== first.id && theme.panel !== first.panel)!;
    const committedSelection = resolveThemeSelection(first.id, null, false);
    const previewSelection = resolveThemeSelection(preview.id, null, false);

    expect(committedSelection.diffBaseTheme.id).toBe(first.id);
    expect(committedSelection.cockpitTheme.PANEL_BG).toBe(first.panel);
    expect(previewSelection.diffBaseTheme.id).toBe(preview.id);
    expect(previewSelection.cockpitTheme.PANEL_BG).toBe(preview.panel);
  });

  it('derives chrome from the opaque base before applying transparent surfaces', () => {
    const theme = THEMES[0]!;
    const selection = resolveThemeSelection(theme.id, null, true);

    expect(selection.diffTheme.background).toBe('transparent');
    expect(selection.diffTheme.panel).toBe('transparent');
    expect(selection.cockpitTheme.PANEL_BG).toBe(theme.panel);
    expect(selection.cockpitTheme.PANEL_BG).not.toBe('transparent');
  });
});

describe('cockpit palettes', () => {
  it('both variants carry all 9 semantic state colors', () => {
    for (const s of STATES) {
      expect(COCKPIT_LIGHT.COLOR[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(COCKPIT_DARK.COLOR[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(COCKPIT_LIGHT.COLOR_HI[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(COCKPIT_DARK.COLOR_HI[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('the light variant re-tunes every state hue (never an identity of the dark one)', () => {
    for (const s of STATES) {
      expect(COCKPIT_LIGHT.COLOR[s]).not.toBe(COCKPIT_DARK.COLOR[s]);
    }
  });

  it('exposes the same token shape for both variants', () => {
    expect(Object.keys(COCKPIT_LIGHT).sort()).toEqual(Object.keys(COCKPIT_DARK).sort());
  });
});

describe('terminal-safe semantic symbols', () => {
  it('uses one printable ASCII column for warnings', () => {
    expect(SYMBOL.warning).toMatch(/^[!-~]$/);
  });

  it('defines each UI chrome glyph once as one renderer-width code point', () => {
    for (const glyph of Object.values(UI_GLYPH)) {
      expect([...glyph]).toHaveLength(1);
    }
  });

  it('keeps the shared spacing scale small and strictly increasing', () => {
    expect(Object.values(SPACE)).toEqual([1, 2, 3]);
  });
});
