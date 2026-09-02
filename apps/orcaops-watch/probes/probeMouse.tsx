// Mouse + OSC 52 capability probe for the Walk review surface.
// Standalone scene, NOT part of the app: renders labeled hit-boxes (some nested
// inside a focused={false} scrollbox, mirroring DiffSlice's real geometry) with
// every per-renderable mouse handler wired to a logger, then answers three
// questions the implementation depends on:
//
//   1. Are mouse events delivered to app components, and what's on the event?
//      Each handler logs `type x y btn shift/alt/ctrl drag` so the pty drive can
//      assert clicks/drags land on the right box (incl. inside the scrollbox).
//   2. Do double/triple clicks arrive distinguishable? The MouseEvent type has
//      no click-count field (confirmed against @opentui/core@0.1.89 d.ts); this
//      logs inter-down timestamps so the drive can show the app must
//      time-window rapid clicks itself.
//   3. Is OSC 52 clipboard write available? Logs isOsc52Supported() + the
//      boolean return of renderer.copyToClipboardOSC52(), and ALSO writes an
//      escape sequence directly to stdout with a known base64 sentinel so the
//      pty capture can be grepped for it (the direct-write fallback path).
//
// Run it directly against a pty; output lands in $PROBE_OUT (default
// /tmp/probe-mouse.txt). Self-exits after ~7s.

import { createCliRenderer } from '@opentui/core';
import type { CliRenderer, MouseEvent } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { useRenderer } from '@opentui/react';
import { appendFileSync, writeFileSync } from 'node:fs';
import { useEffect } from 'react';

const OUT = process.env.PROBE_OUT ?? '/tmp/probe-mouse.txt';
// A sentinel whose base64 the pty capture is grepped for, proving a direct
// stdout OSC 52 write reaches the terminal even if the native path is ungated.
const OSC52_SENTINEL = 'OSC52PROBE';

function log(line: string): void {
  appendFileSync(OUT, `${line}\n`);
}

let lastDownMs = 0;
function logMouse(where: string, e: MouseEvent): void {
  const now = performance.now();
  const gap = e.type === 'down' ? (lastDownMs === 0 ? 0 : now - lastDownMs) : 0;
  if (e.type === 'down') lastDownMs = now;
  const mods = `${e.modifiers.shift ? 'S' : '-'}${e.modifiers.alt ? 'A' : '-'}${e.modifiers.ctrl ? 'C' : '-'}`;
  log(
    `mouse where=${where} type=${e.type} x=${e.x} y=${e.y} btn=${e.button} mods=${mods} ` +
      `drag=${e.isDragging === true ? 1 : 0} gapMs=${gap.toFixed(1)}` +
      (e.scroll !== undefined ? ` scroll=${e.scroll.direction}:${e.scroll.delta}` : '')
  );
}

/** One labeled hit-box wired to every per-renderable mouse handler. */
function HitBox({ where, bg }: { where: string; bg: string }) {
  return (
    <box
      height={1}
      backgroundColor={bg}
      onMouseDown={(e: MouseEvent) => {
        e.stopPropagation();
        logMouse(where, e);
      }}
      onMouseUp={(e: MouseEvent) => logMouse(where, e)}
      onMouseDrag={(e: MouseEvent) => logMouse(where, e)}
      onMouseDragEnd={(e: MouseEvent) => logMouse(where, e)}
    >
      <text fg="#ffffff">{`hit:${where}`}</text>
    </box>
  );
}

function osc52DirectPayload(text: string): string {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${base64}\x07`;
}

function Probe() {
  const renderer = useRenderer() as CliRenderer;

  useEffect(() => {
    log('probe start');
    // Question 3: probe OSC 52 once the renderer has settled its capabilities.
    const t = setTimeout(() => {
      let supported: boolean | 'threw' = 'threw';
      let nativeReturn: boolean | 'threw' = 'threw';
      try {
        supported = renderer.isOsc52Supported();
      } catch {
        supported = 'threw';
      }
      try {
        nativeReturn = renderer.copyToClipboardOSC52(`native-${OSC52_SENTINEL}`);
      } catch {
        nativeReturn = 'threw';
      }
      log(`osc52 isSupported=${String(supported)} nativeCopyReturn=${String(nativeReturn)}`);
      // Direct escape write — the fallback path. The base64 of the sentinel is
      // grepped for in the pty capture to prove the bytes reach the terminal.
      try {
        process.stdout.write(osc52DirectPayload(OSC52_SENTINEL));
        log(
          `osc52 directWrite=ok sentinelBase64=${Buffer.from(OSC52_SENTINEL).toString('base64')}`
        );
      } catch {
        log('osc52 directWrite=threw');
      }
    }, 1_500);

    // Self-exit so the pty drive is bounded.
    const done = setTimeout(() => {
      log('probe done');
      process.exit(0);
    }, 6_000);
    return () => {
      clearTimeout(t);
      clearTimeout(done);
    };
  }, [renderer]);

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="#ffffff">probe-mouse</text>
      {/* Top-level rows (rows 2-3): baseline click delivery. */}
      <HitBox where="top-a" bg="#332244" />
      <HitBox where="top-b" bg="#223344" />
      {/* Nested rows inside a focused={false} scrollbox (rows 5+), mirroring
          the real DiffSlice geometry — proves clicks land inside the scrollbox. */}
      <scrollbox scrollY={true} focused={false} flexGrow={1}>
        <box flexDirection="column" onMouseScroll={(e: MouseEvent) => logMouse('scroll-wrap', e)}>
          <HitBox where="in-a" bg="#204020" />
          <HitBox where="in-b" bg="#402020" />
          <HitBox where="in-c" bg="#404020" />
        </box>
      </scrollbox>
    </box>
  );
}

async function main() {
  writeFileSync(OUT, '');
  const renderer = await createCliRenderer({
    useMouse: true, // matches main.tsx
    useAlternateScreen: true,
    exitOnCtrlC: true,
  });
  createRoot(renderer).render(<Probe />);
}

void main();
