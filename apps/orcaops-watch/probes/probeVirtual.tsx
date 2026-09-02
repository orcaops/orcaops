// Frame-cost probe for the Walk virtualization core.
// Standalone scene, NOT part of the app: renders a synthetic 5k-row column
// inside a <scrollbox> as spacer boxes around a small mounted band, then
// drives programmatic scrollTop writes (store first, ref second — the same
// single-writer discipline ReviewApp uses) and records ms per render pass
// (setState → post-commit effect). Timings land in $PROBE_OUT (default
// /tmp/probe-virtual.txt).
//
// What it proves: spacer-heavy scrollbox content
// keeps total scroll height exact, external scrollTop writes land, and a
// windowed band re-render is cheap at 5k rows.

import { createCliRenderer } from '@opentui/core';
import type { ScrollBoxRenderable } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { appendFileSync, writeFileSync } from 'node:fs';
import { useEffect, useRef, useState } from 'react';

const TOTAL_ROWS = Number(process.env.PROBE_ROWS ?? 5_000);
const VIEWPORT_GUESS = 40;
const OVERSCAN = 30;
const STEP = 137; // co-prime-ish stride so the band lands on fresh rows each pass
const PASSES = 24;
const OUT = process.env.PROBE_OUT ?? '/tmp/probe-virtual.txt';

function log(line: string): void {
  appendFileSync(OUT, `${line}\n`);
  process.stderr.write(`${line}\n`);
}

function Probe() {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const passStart = useRef(0);
  const samples = useRef<number[]>([]);
  const mountedAt = useRef(performance.now());

  // Post-commit latency of the pass that produced this render.
  useEffect(() => {
    if (passStart.current === 0) return;
    samples.current.push(performance.now() - passStart.current);
  }, [scrollTop]);

  useEffect(() => {
    log(`mount-to-first-commit ${(performance.now() - mountedAt.current).toFixed(2)}ms`);
    const timer = setInterval(() => {
      if (samples.current.length >= PASSES) {
        clearInterval(timer);
        const s = [...samples.current].sort((a, b) => a - b);
        const mean = s.reduce((n, x) => n + x, 0) / s.length;
        const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
        log(`samples ${samples.current.map((x) => x.toFixed(1)).join(' ')}`);
        log(
          `rows=${TOTAL_ROWS} passes=${s.length} mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
            `min=${(s[0] ?? 0).toFixed(2)}ms max=${(s[s.length - 1] ?? 0).toFixed(2)}ms`
        );
        log('probe done');
        process.exit(0);
      }
      passStart.current = performance.now();
      // Store first, ref second — one synchronous beat, as ReviewApp's
      // updScrollTop wrapper does it.
      setScrollTop((prev) => {
        const next = (prev + STEP) % (TOTAL_ROWS - VIEWPORT_GUESS);
        const box = scrollRef.current;
        if (box !== null) box.scrollTop = next;
        return next;
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  // The mounted band: rows overlapping the viewport ± overscan; everything
  // else is two spacer boxes, so the scrollbox sees the exact 5k-row height.
  const bandStart = Math.max(0, scrollTop - OVERSCAN);
  const bandEnd = Math.min(TOTAL_ROWS, scrollTop + VIEWPORT_GUESS + OVERSCAN);
  const rows = [];
  for (let i = bandStart; i < bandEnd; i++) {
    rows.push(
      <text key={i} fg="#8888aa">
        {`row ${String(i).padStart(4, '0')} ${'·'.repeat(24)} band ${bandStart}-${bandEnd}`}
      </text>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="#ffffff">probe-virtual · scrollTop={scrollTop}</text>
      <scrollbox ref={scrollRef} scrollY={true} focused={false} flexGrow={1}>
        {bandStart > 0 ? <box height={bandStart} /> : null}
        {rows}
        {bandEnd < TOTAL_ROWS ? <box height={TOTAL_ROWS - bandEnd} /> : null}
      </scrollbox>
    </box>
  );
}

async function main() {
  writeFileSync(OUT, '');
  const renderer = await createCliRenderer({
    useMouse: false,
    useAlternateScreen: true,
    exitOnCtrlC: true,
  });
  createRoot(renderer).render(<Probe />);
}

void main();
