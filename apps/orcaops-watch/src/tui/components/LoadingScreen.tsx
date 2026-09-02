// The transient full-screen loading state (cockpit "connecting…", review
// "Loading review…"). A braille spinner animates on its own frame ticker while
// the component is mounted — it unmounts the moment real data lands, so the
// interval is naturally scoped to the wait. Centered on both axes so the screen
// reads as a deliberate interstitial rather than stray top-left text; the
// caller passes the surface `background` plus `accent`/`fg` from the active
// theme so the paint follows light/dark like every other surface.

import { useEffect, useLayoutEffect, useState } from 'react';

/** Classic braille dots — 10 frames leave headroom under the 100 ms heartbeat gate. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

export interface LoadingScreenProps {
  width: number;
  height: number;
  /** The wait message, e.g. `connecting…`. */
  message: string;
  /** Surface background (from the diff/review AppTheme, appearance-aware). */
  background: string;
  /** Spinner glyph colour — an "alive" accent (e.g. LIVE green). */
  accent: string;
  /** Message colour — a readable dim tier. */
  fg: string;
  /** Performance instrumentation fired from each committed spinner frame. */
  onFrameCommitted?: (frame: (typeof SPINNER_FRAMES)[number]) => void;
}

export function LoadingScreen({
  width,
  height,
  message,
  background,
  accent,
  fg,
  onFrameCommitted,
}: LoadingScreenProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    onFrameCommitted?.(SPINNER_FRAMES[frame]);
  }, [frame, onFrameCommitted]);

  return (
    <box
      width={width}
      height={height}
      backgroundColor={background}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={accent}>{SPINNER_FRAMES[frame]}</text>
      <box height={1} flexShrink={0} />
      <text fg={fg}>{message}</text>
    </box>
  );
}
