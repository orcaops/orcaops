import type { AgentState } from '../core/types.js';

/**
 * The orcaops watch semantic palette, kept at low chrome saturation.
 * Colours are truecolor; OpenTUI down-samples on terminals
 * without 24-bit support. Theme-specific contrast adjustment happens in the
 * concrete AppTheme adapter; these anchors preserve state identity.
 */

/** Semantic state colours (state, not decoration). */
export const COLOR: Record<AgentState, string> = {
  working: '#58b47c',
  quiet: '#71927f',
  stalled: '#c89b50',
  starting: '#5fbd92',
  wrapping: '#5bb3bb',
  ready: '#6999c8',
  idle: '#667173',
  done: '#688671',
};

/** A brighter endpoint per state — the "glow" on the live sparkline bar. */
export const COLOR_HI: Record<AgentState, string> = {
  working: '#76c995',
  quiet: '#8aa693',
  stalled: '#dcb66f',
  starting: '#7bd0a8',
  wrapping: '#79c9cf',
  ready: '#85aed7',
  idle: '#7f898b',
  done: '#809c88',
};

/**
 * Semantic symbols that must have the same width in the renderer and terminal.
 * Keep these printable ASCII: ambiguous Unicode width leaves retained cells
 * behind when a terminal and OpenTUI disagree about continuation columns.
 */
export const SYMBOL = {
  warning: '!',
} as const;

/**
 * UI chrome glyphs whose meanings should not drift between screens. Every
 * value is one terminal column in the renderer's supported width model.
 * Semantic agent-state glyphs remain in GLYPH below.
 */
export const UI_GLYPH = {
  paneFocused: '▸',
  paneBlurred: '▌',
  rowSelected: '▸',
  viewport: '▌',
  cursor: '•',
  attention: '▲',
  inactive: '·',
  section: '▸',
  disclosureExpanded: '▴',
  disclosureCollapsed: '▾',
} as const;

/** Layout spacing for chrome that is not governed by measured-row geometry. */
export const SPACE = {
  xs: 1,
  sm: 2,
  md: 3,
} as const;

export const GLYPH: Record<AgentState, string> = {
  working: '●',
  quiet: '○',
  stalled: SYMBOL.warning,
  starting: '◔',
  wrapping: '◌',
  ready: '◆',
  idle: '·',
  done: '✓',
};

export const STATE_LABEL: Record<AgentState, string> = {
  working: 'working',
  quiet: 'quiet',
  stalled: 'stalled',
  starting: 'starting',
  wrapping: 'wrapping',
  ready: 'ready',
  idle: 'idle',
  done: 'done',
};

/** Foreground tiers (primary → faint). */
export const FG = '#cdd7d2';
export const DIM = '#7e8c88';
export const DIMMER = '#4a565a';
export const FAINT = '#2c363c';
export const BRIGHT = '#eef3f0';

/** Attention accents — the two states that pull the human in. */
export const AMBER = '#f2b13c';
export const BLUE = '#5aa6ff';
export const CYAN = '#45d4de';

/** A live green for the pulsing "now" dot. */
export const LIVE = '#46d17f';

/** Frame + horizontal rules. */
export const FRAME = '#2a3644';

/**
 * Row background tints — solid approximations of alpha washes over the
 * near-black terminal ground, kept subtle so foreground text stays legible.
 */
export const SEL_BG = '#1d2a37';
export const STALLED_BG = '#20190f';
export const READY_BG = '#111b28';
