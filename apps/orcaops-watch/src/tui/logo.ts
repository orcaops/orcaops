// The orcaops mark, pre-rendered from the brand assets as monochrome braille
// (the silhouette rule "opaque + dark = ink" turns the white eye and the
// transparent field into blank cells, so it reads as a single-color mark on the
// dark cockpit). Baked as constants so the UI needs no image decoding at
// runtime. Four variants let the top bar stay legible as the terminal narrows:
// three wordmark lockups (the gap between icon and wordmark pulled in) and a
// compact icon (the medium orca + the wordmark's trailing "ps", stitched — the
// "ps" reused at the wordmark's own scale so it stays legible).

/** Full horizontal lockup — orcaops-logo-h.png at a 112px source → 54×6 cells. */
export const LOGO_FULL: readonly string[] = [
  '  ⣀⣠⣤⣤⣶⣾⣿⣷⣶⣤⡀',
  ' ⠉⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆',
  '  ⢰⣿⠋⠁⠈⣿⣿⣿⣿⣿⣿⣿⠆   ⣠⠤⠢⢤⡀ ⣤⠤ ⣠⠴⠦⢤ ⢀⠤⠶⢤⣠ ⢀⡤⠔⠤⣄ ⢠⡠⠔⠦⣄ ⢠⠴⠦⡄',
  '  ⢸⣿⣶⣶⣿⠿⣿⣿⠿⠿⠛⠁   ⢰⡇   ⡇ ⡇ ⢰⡃    ⡏   ⢹ ⣾   ⢸ ⢸   ⢸⡆⠘⠢⢤⡀',
  '   ⠻⣿⣿⡇           ⠳⢤⣤⠴⠁ ⠇  ⠳⢤⣤⠔ ⠙⢦⣤⠴⠻ ⠘⠦⣤⡤⠎ ⢸⠢⣤⡤⠞ ⠰⢤⡤⠟',
  '    ⠈⠛⠿⡀                                    ⢸',
];

/** Narrower lockup — 96px source → 46×5 cells. */
export const LOGO_MEDIUM: readonly string[] = [
  ' ⣀⣤⣤⣤⣶⣿⣿⣷⣦⣄',
  ' ⠈⢹⣿⠿⠿⣿⣿⣿⣿⣿⣷',
  '  ⣿⣇⣀⣠⣿⣿⣿⣿⣿⠟⠁  ⡞⠉⠉⢳ ⡿⠉⢠⠎⠉⠙⠂⡴⠋⠉⠱⡇⢠⠋⠉⠙⡆⢸⡟⠉⠉⢦ ⣏⠉⠃',
  '  ⠸⣿⣿⡟⠉⠉⠉⠉     ⢧⣀⣀⡼ ⡇ ⠘⢄⣀⣠⠄⠳⣀⣀⡰⡇⠸⣄⣀⣠⠇⢸⣦⣀⣀⠜ ⣄⣉⡷',
  '   ⠈⠻⠿⡀                              ⢸',
];

/** Compact lockup — 88px source → 43×5 cells (wordmark near its legible floor). */
export const LOGO_COMPACT: readonly string[] = [
  '⢀⣀⣤⣤⣴⣶⣿⣷⣶⣄',
  '  ⣹⡿⠿⢿⣿⣿⣿⣿⣷     ⣀   ⢀  ⣀   ⣀    ⣀    ⣀   ⣀',
  '  ⣿⣤⣤⣾⣿⣿⣿⡿⠟⠁  ⢰⠋ ⠙⡄⢸⠁⢰⠋ ⠙⢠⠋⠁⠉⡇⢰⠋ ⠙⡆⢸⠉⠈⠱⡄⢮⣈⠁',
  '  ⠹⣿⣿⡁        ⠘⠦⣠⠴⠁⠼ ⠘⠦⣠⠴⠈⠣⣄⠤⠇⠘⠦⣀⠴⠃⢸⠤⣠⠜⠁⠤⣠⠝',
  '   ⠈⠙⠃                             ⠸',
];

/** Compact icon — the medium lockup's orca + the wordmark's trailing "ps" → 23×5. */
export const LOGO_ICON: readonly string[] = [
  ' ⣀⣤⣤⣤⣶⣿⣿⣷⣦⣄',
  ' ⠈⢹⣿⠿⠿⣿⣿⣿⣿⣿⣷',
  '  ⣿⣇⣀⣠⣿⣿⣿⣿⣿⠟⠁ ⢸⡟⠉⠉⢦ ⣏⠉⠃',
  '  ⠸⣿⣿⡟⠉⠉⠉⠉    ⢸⣦⣀⣀⠜ ⣄⣉⡷',
  '   ⠈⠻⠿⡀       ⢸',
];

/**
 * Pick the widest logo variant that fits the column budget (the rail width the
 * logo sits above): full wordmark lockup when there's room, then a narrower and
 * a compact lockup, and finally the bare orca icon when space is tight.
 */
export function pickLogo(cols: number): readonly string[] {
  // Thresholds sit ~3 cols above each variant's raw width (54/46/43) so a bigger
  // lockup only appears once it has a little breathing room, not the instant it fits.
  if (cols >= 57) return LOGO_FULL;
  if (cols >= 49) return LOGO_MEDIUM;
  if (cols >= 46) return LOGO_COMPACT;
  return LOGO_ICON;
}
