// The shared visual vocabulary (semantic state colors, glyphs, foreground
// tiers), plus the brand accent the cockpit adds.
// The individual token constants below are the DARK values. The cockpit reads
// them through `useCockpitTheme()` (see ThemeProvider) as the COCKPIT_DARK /
// COCKPIT_LIGHT objects, which swap by the active theme's appearance — so a
// theme change repaints the whole cockpit. GLYPH / STATE_LABEL are
// appearance-invariant and stay plain module constants.
import {
  AMBER,
  BLUE,
  BRIGHT,
  COLOR,
  COLOR_HI,
  CYAN,
  DIM,
  DIMMER,
  FAINT,
  FG,
  FRAME,
  GLYPH,
  LIVE,
  READY_BG,
  SEL_BG,
  SPACE,
  STALLED_BG,
  STATE_LABEL,
  UI_GLYPH,
} from './coreTheme';
import type { AgentState } from '../core/types.js';

export {
  AMBER,
  BLUE,
  BRIGHT,
  COLOR,
  COLOR_HI,
  CYAN,
  DIM,
  DIMMER,
  FAINT,
  FG,
  FRAME,
  GLYPH,
  LIVE,
  READY_BG,
  SEL_BG,
  SPACE,
  STALLED_BG,
  STATE_LABEL,
  UI_GLYPH,
};

/** Diff-delete red for line-count bars (the shared palette stops at amber). */
export const RED = '#ef5350';

/** Sparse theme accent — deliberately outside the semantic state palette. */
export const ACCENT = '#a69bd4';
export const PANEL_BG = '#0d141b';

/**
 * The cockpit's semantic token palette as one object, in a dark and a light
 * variant. Every shell component reads the active variant via `useCockpitTheme()`
 * instead of importing the individual constants, so one theme choice repaints the
 * whole cockpit. GLYPH / STATE_LABEL are appearance-invariant and are NOT part of
 * this object.
 */
export interface CockpitTheme {
  COLOR: Record<AgentState, string>;
  COLOR_HI: Record<AgentState, string>;
  FG: string;
  DIM: string;
  DIMMER: string;
  FAINT: string;
  BRIGHT: string;
  AMBER: string;
  BLUE: string;
  CYAN: string;
  LIVE: string;
  RED: string;
  ACCENT: string;
  FOCUS_MARKER: string;
  FRAME: string;
  SEL_BG: string;
  FOCUS_BG: string;
  STALLED_BG: string;
  READY_BG: string;
  PANEL_BG: string;
}

/** The dark semantic anchors, assembled into the provider's fallback palette. */
export const COCKPIT_DARK: CockpitTheme = {
  COLOR,
  COLOR_HI,
  FG,
  DIM,
  DIMMER,
  FAINT,
  BRIGHT,
  AMBER,
  BLUE,
  CYAN,
  LIVE,
  RED,
  ACCENT,
  FOCUS_MARKER: ACCENT,
  FRAME,
  SEL_BG,
  FOCUS_BG: SEL_BG,
  STALLED_BG,
  READY_BG,
  PANEL_BG,
};

/**
 * The light palette — GitHub-light-anchored so it harmonizes with the light diff
 * background. The 9 state hues are restrained siblings of the dark ones: they
 * stay legible on a light ground and keep their meaning (green=working,
 * amber=stalled, blue=ready, …), rather than merely being inverted.
 */
export const COCKPIT_LIGHT: CockpitTheme = {
  COLOR: {
    working: '#37764a',
    quiet: '#526f60',
    stalled: '#806120',
    starting: '#3d7958',
    wrapping: '#32717a',
    ready: '#386f9f',
    idle: '#697178',
    done: '#526d5c',
  },
  COLOR_HI: {
    working: '#458b5b',
    quiet: '#648171',
    stalled: '#99762c',
    starting: '#4b8e69',
    wrapping: '#41858e',
    ready: '#4a82b2',
    idle: '#7d858c',
    done: '#63806d',
  },
  FG: '#2e3338',
  DIM: '#57606a',
  DIMMER: '#8a929c',
  FAINT: '#d0d4d9',
  BRIGHT: '#1f2328',
  AMBER: '#9a6700',
  BLUE: '#0969da',
  CYAN: '#0a7d8c',
  LIVE: '#1a7f37',
  RED: '#cf222e',
  ACCENT: '#6f4ca8',
  FOCUS_MARKER: '#6f4ca8',
  FRAME: '#d0d7de',
  SEL_BG: '#e8eef4',
  FOCUS_BG: '#e8eef4',
  STALLED_BG: '#fbf1d8',
  READY_BG: '#ddf4ff',
  PANEL_BG: '#f6f6f6',
};
