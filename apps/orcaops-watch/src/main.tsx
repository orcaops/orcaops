import { createCliRenderer, resolveRenderLib } from '@opentui/core';
import { createRoot } from '@opentui/react';

import type { CliOptions } from './cli';
import { pollSnapshot } from './data/snapshot';
import { App } from './tui/App';
import { ThemeProvider } from './tui/ThemeProvider';
import { shutdown } from './tui/lifecycle';
import {
  detectTerminalThemeModeFromBackground,
  type TerminalThemeMode,
} from './tui/review/themeDetection';

/** The application proper; `entry.ts` parses argv and gates the terminal. */
export async function main(opts: CliOptions): Promise<void> {
  // Headless boot check (no TTY needed). Resolving the render library binds
  // the embedded native code's symbols, so a broken embed fails here rather
  // than at the first render.
  if (opts.selfcheck) {
    resolveRenderLib();
    process.stdout.write('watch selfcheck ok\n');
    process.exit(0);
  }

  // Headless data-bridge check: poll one snapshot through the same path the UI
  // uses and print its totals, so the bridge can be verified without a TTY.
  // Return rather than process.exit() — exit() can truncate a draining stdout.
  if (opts.probe) {
    const snapshot = await pollSnapshot({ root: opts.root });
    const threads = snapshot.projects.reduce((total, project) => total + project.threads.length, 0);
    process.stdout.write(`${JSON.stringify({ threads, ...snapshot.totals })}\n`);
    return;
  }

  // Probe the terminal's light/dark background BEFORE OpenTUI owns stdin: the
  // OSC 11 reply would otherwise reach the key parser too, and its `]11;rgb:…`
  // letters dispatch review verbs. Defensive: a mute terminal times out to
  // undefined and the review theme falls back to its hardcoded default.
  let detectedThemeMode: TerminalThemeMode | undefined;
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    try {
      detectedThemeMode =
        (await detectTerminalThemeModeFromBackground({
          input: process.stdin,
          output: process.stdout,
        })) ?? undefined;
    } catch {
      detectedThemeMode = undefined;
    }
  }

  const renderer = await createCliRenderer({
    useMouse: true,
    useAlternateScreen: true,
    exitOnCtrlC: false,
  });
  createRoot(renderer).render(
    <ThemeProvider detectedThemeMode={detectedThemeMode}>
      <App options={{ root: opts.root, intervalMs: opts.intervalMs, detectedThemeMode }} />
    </ThemeProvider>
  );

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => shutdown(renderer));
  }
}
