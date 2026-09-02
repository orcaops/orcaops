/** Tear the renderer down (restoring the primary screen) and exit. */
export function shutdown(renderer: { destroy: () => void } | null): void {
  try {
    renderer?.destroy();
  } catch {
    // best-effort: fall through to exit so the terminal is always restored
  }
  process.exit(0);
}
