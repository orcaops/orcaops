# Watch probes

Standalone diagnostic scenes for the review surface. None of them is part of
the app: each mounts its own renderer, answers one question the implementation
depends on, and exits. They exist because the answers are terminal- and
OpenTUI-version-specific — the kind of thing that is cheaper to re-measure than
to re-derive from documentation.

Run them from `apps/orcaops-watch`. All of them need a real TTY.

## Run directly

| Script               | Scene                     | What it answers                                                                                                                                                                                                                |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm probe:virtual` | `probes/probeVirtual.tsx` | Does spacer-heavy `<scrollbox>` content keep total scroll height exact, do external `scrollTop` writes land, and is a windowed band re-render cheap at 5k rows? Timings go to `$PROBE_OUT` (default `/tmp/probe-virtual.txt`). |
| `pnpm probe:mouse`   | `probes/probeMouse.tsx`   | Are mouse events delivered to app components and what is on the event; do double/triple clicks arrive distinguishable; is OSC 52 clipboard write available?                                                                    |

## Driven under a pty

`pnpm test:pty` runs `scripts/review-experience-pty.sh`, which drives these two
at several widths and asserts on what they log. They take their input from the
driver, so run them through it rather than directly.

| Scene                                     | What it answers                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `probes/review/probeReviewExperience.tsx` | Does keyboard input cross the real `useKeyboard` → dispatch → `executeCommand` → rendered-state seam at real widths? |
| `probes/review/probeAppJourney.tsx`       | Does the persistent Watch → Review → Watch shell survive a real PTY round trip?                                      |

The two direct-run scenes had no entry point at all and were reachable only by
typing the file path — which is how they became invisible to every tool that
looks for dead code. `src/probeContract.test.ts` asserts that every probe scene
is reachable through a script or the pty driver, so a new one cannot be
orphaned the same way.
