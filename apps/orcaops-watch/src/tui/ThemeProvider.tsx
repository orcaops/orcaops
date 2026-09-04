// The single source of truth for the app's theme, hoisted to the root so ONE
// choice governs both the cockpit shell and the review-diff surface. Two React
// contexts:
//   - CockpitThemeContext carries the active cockpit token palette (read via
//     useCockpitTheme). A surface re-provides a preview-overlaid palette over its
//     own subtree while its `t` selector is open, so chrome and diff flip live.
//   - ThemeControlsContext carries the committed diff-theme id, the derived diff
//     AppTheme, and the ops to change it (read via useThemeControls).
// Persistence + OSC-11 terminal detection live here, so the persisted read runs
// once per process rather than once per review entry.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { type AppTheme, resolveTheme, THEMES, withTransparentSurfaces } from '@orcaops/diff-render';
import type { AgentState } from '@orcaops/watch-data/ui';

import { loadPersistedTheme, loadTransparentBackground, persistTheme } from '../data/watchTheme';
import { HitProvider } from './kit/hit';
import { resolveInitialThemeId, type TerminalThemeMode } from './review/themeDetection';
import { COCKPIT_DARK, COCKPIT_LIGHT, type CockpitTheme } from './theme';

/** A selectable theme row for the `t` picker (id + label + light/dark). */
export interface ThemeRow {
  id: string;
  label: string;
  appearance: AppTheme['appearance'];
}

const AGENT_STATES: readonly AgentState[] = [
  'working',
  'quiet',
  'stalled',
  'starting',
  'wrapping',
  'ready',
  'idle',
  'done',
];

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function hex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel ?? 0))))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixHex(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  return hex(a.map((channel, index) => channel + ((b[index] ?? 0) - channel) * amount));
}

function relativeLuminance(color: string): number {
  const [r, g, b] = rgb(color)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Preserve a semantic hue when it already clears the requested floors; if not,
 * walk it toward the appearance-appropriate text endpoint. This keeps state
 * identity stable while making the selected concrete theme own readability.
 */
function ensureContrast(
  preferred: string,
  backgrounds: readonly string[],
  minimum: number,
  appearance: AppTheme['appearance']
): string {
  const endpoint = appearance === 'light' ? '#000000' : '#ffffff';
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mixHex(preferred, endpoint, step / 20);
    if (backgrounds.every((background) => contrast(candidate, background) >= minimum)) {
      return candidate;
    }
  }
  return endpoint;
}

function mapStateColors(
  colors: Readonly<Record<AgentState, string>>,
  theme: AppTheme,
  semantic: CockpitTheme
): Record<AgentState, string> {
  return Object.fromEntries(
    AGENT_STATES.map((state) => {
      const selectedBackground =
        state === 'stalled'
          ? semantic.STALLED_BG
          : state === 'ready'
            ? semantic.READY_BG
            : theme.accentMuted;
      return [
        state,
        ensureContrast(colors[state], [theme.panel, selectedBackground], 3, theme.appearance),
      ];
    })
  ) as Record<AgentState, string>;
}

/**
 * Adapt one concrete opaque diff theme into the cockpit's semantic vocabulary.
 *
 * Status colors retain light/dark semantic anchors, then gain only the luminance
 * needed on the selected theme's panel and selected-row surfaces. Neutral chrome,
 * focus, frames, and sparse accents come directly from the concrete editor theme.
 */
export function cockpitThemeFor(theme: AppTheme): CockpitTheme {
  const semantic = theme.appearance === 'light' ? COCKPIT_LIGHT : COCKPIT_DARK;
  const accentBackground = theme.accentMuted;
  const textSurfaces = [theme.panel, accentBackground] as const;
  const accent = ensureContrast(theme.accent, textSurfaces, 4.5, theme.appearance);
  return {
    ...semantic,
    COLOR: mapStateColors(semantic.COLOR, theme, semantic),
    COLOR_HI: mapStateColors(semantic.COLOR_HI, theme, semantic),
    FG: theme.text,
    DIM: theme.muted,
    DIMMER: ensureContrast(
      mixHex(theme.muted, theme.panel, 0.2),
      [theme.panel],
      3,
      theme.appearance
    ),
    FAINT: theme.border,
    BRIGHT: theme.text,
    AMBER: ensureContrast(semantic.AMBER, textSurfaces, 4.5, theme.appearance),
    BLUE: ensureContrast(semantic.BLUE, textSurfaces, 4.5, theme.appearance),
    CYAN: ensureContrast(semantic.CYAN, textSurfaces, 4.5, theme.appearance),
    LIVE: ensureContrast(semantic.LIVE, textSurfaces, 4.5, theme.appearance),
    RED: ensureContrast(semantic.RED, textSurfaces, 4.5, theme.appearance),
    ACCENT: accent,
    FOCUS_MARKER: ensureContrast(
      theme.accent,
      [theme.panel, accentBackground],
      3,
      theme.appearance
    ),
    FRAME: theme.border,
    SEL_BG: accentBackground,
    FOCUS_BG: accentBackground,
    PANEL_BG: theme.panel,
  };
}

export interface ThemeSelection {
  /** Opaque theme used to derive readable chrome and selector samples. */
  diffBaseTheme: AppTheme;
  /** Theme with the user's transparent-surface preference applied. */
  diffTheme: AppTheme;
  /** Chrome derived from diffBaseTheme, never from transparent placeholders. */
  cockpitTheme: CockpitTheme;
}

/** Pure provider-owned resolver shared by committed state and live preview. */
export function resolveThemeSelection(
  id: string,
  detectedThemeMode: TerminalThemeMode | null,
  transparentBackground: boolean
): ThemeSelection {
  const diffBaseTheme = resolveTheme(id, detectedThemeMode);
  return {
    diffBaseTheme,
    diffTheme: transparentBackground ? withTransparentSurfaces(diffBaseTheme) : diffBaseTheme,
    cockpitTheme: cockpitThemeFor(diffBaseTheme),
  };
}

const THEME_ROWS: ThemeRow[] = THEMES.map((t) => ({
  id: t.id,
  label: t.label,
  appearance: t.appearance,
}));

export interface ThemeControls {
  /** The committed theme id (persisted); NOT the live selector preview. */
  themeId: string;
  /** The committed diff theme, opaque (the selector card + preview base off this). */
  diffBaseTheme: AppTheme;
  /** The committed diff theme with the transparent-surfaces opt-out applied. */
  diffTheme: AppTheme;
  /** The committed cockpit palette derived from the concrete opaque theme. */
  cockpitTheme: CockpitTheme;
  /** The transparent-background opt-out (default false ⇒ opaque, theme bg painted). */
  transparentBackground: boolean;
  /** Commit + persist a theme id; resolves when persisted, rejects on write failure. */
  commitTheme(id: string): Promise<void>;
  /** Resolve a committed-or-preview id through the exact provider-owned adapter. */
  themeSelectionFor(id: string): ThemeSelection;
  /** The selectable theme rows (bundled themes). */
  themeRows: ThemeRow[];
}

const CockpitThemeContext = createContext<CockpitTheme>(COCKPIT_DARK);
const ThemeControlsContext = createContext<ThemeControls | null>(null);

/** The active cockpit token palette (preview-overlaid within a surface's subtree). */
export function useCockpitTheme(): CockpitTheme {
  return useContext(CockpitThemeContext);
}

/** The committed theme id + derived diff theme + change ops. */
export function useThemeControls(): ThemeControls {
  const ctx = useContext(ThemeControlsContext);
  if (ctx === null) {
    throw new Error('useThemeControls must be used within <ThemeProvider>');
  }
  return ctx;
}

export function ThemeProvider({
  detectedThemeMode,
  persistThemeEffect = persistTheme,
  children,
}: {
  detectedThemeMode: TerminalThemeMode | undefined;
  /** Mounted-app seam; production persists through the atomic user-config writer. */
  persistThemeEffect?: typeof persistTheme;
  children: ReactNode;
}) {
  // Seed synchronously with the detected default so there is no dark flash before
  // the async persisted read lands.
  const [themeId, setThemeId] = useState<string>(() =>
    resolveInitialThemeId(null, detectedThemeMode ?? null)
  );
  // The transparent-surfaces opt-out — default false (opaque). Loaded from the
  // global user config below; `transparentBackground: true` opts into terminal
  // show-through instead of the theme's real background.
  const [transparentBackground, setTransparentBackground] = useState(false);

  // Resolve the persisted choice once per process. loadPersistedTheme never
  // rejects (unreadable config ⇒ null ⇒ detection decides); stale-guarded.
  useEffect(() => {
    let stale = false;
    void loadPersistedTheme().then((persisted) => {
      if (!stale) setThemeId(resolveInitialThemeId(persisted, detectedThemeMode ?? null));
    });
    void loadTransparentBackground().then((v) => {
      if (!stale) setTransparentBackground(v);
    });
    return () => {
      stale = true;
    };
    // Theme configuration is global per-machine state. The repository root
    // must never invalidate it, so it is not a dependency.
  }, [detectedThemeMode]);

  const themeSelectionFor = useCallback(
    (id: string) => resolveThemeSelection(id, detectedThemeMode ?? null, transparentBackground),
    [detectedThemeMode, transparentBackground]
  );
  const { diffBaseTheme, diffTheme, cockpitTheme } = useMemo(
    () => themeSelectionFor(themeId),
    [themeId, themeSelectionFor]
  );

  const controls = useMemo<ThemeControls>(
    () => ({
      themeId,
      diffBaseTheme,
      diffTheme,
      cockpitTheme,
      transparentBackground,
      commitTheme: (id: string) => {
        setThemeId(id);
        return persistThemeEffect(id);
      },
      themeSelectionFor,
      themeRows: THEME_ROWS,
    }),
    [
      themeId,
      diffBaseTheme,
      diffTheme,
      cockpitTheme,
      transparentBackground,
      persistThemeEffect,
      themeSelectionFor,
    ]
  );

  return (
    <ThemeControlsContext.Provider value={controls}>
      <CockpitThemeContext.Provider value={cockpitTheme}>
        <HitProvider>{children}</HitProvider>
      </CockpitThemeContext.Provider>
    </ThemeControlsContext.Provider>
  );
}

/** The raw cockpit-palette context — for a surface to re-provide a preview overlay. */
export { CockpitThemeContext };
