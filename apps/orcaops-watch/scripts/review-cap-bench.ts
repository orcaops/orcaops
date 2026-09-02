// NODE-side benchmark for `review.max_diff_bytes` — what does a bigger review cap cost?
//
// The review engine runs under NODE as the watch sidecar, so this measures the
// engine where it actually lives. Final Watch rendering/interaction latency is
// measured by `scripts/review-performance.ts`, never by this Node process.
//
//   node --experimental-strip-types apps/orcaops-watch/scripts/review-cap-bench.ts
//
// It synthesizes deterministic repos whose base→head diff lands near 2 / 5 / 10 / 20 MB,
// then runs the real diff-scaling pipeline over each: git diff collection, complete-hunk
// normalization, the fingerprint parse that builds the floor's coverage, the changed-row
// substrate, and attribution. Output sizes are the real serialized artifacts.
//
// NOT measured: blame and lineage. They scale with the number of FILES and with history
// depth, not with diff bytes, and they sit behind the persistent blame cache — so they
// are orthogonal to the cap. Stating that rather than quietly folding them in.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// MEASURED (2026-07-12, Apple Silicon, Node v22.14.0, warm page cache, 40 files):
//
//   target   diff bytes   git diff  normalize  fingerprint  rows    attribute  floor.json  attribution  hunks
//    2 MB     2,147,840      28 ms      12 ms       110 ms    8 ms      108 ms     0.3 MB       2.2 MB    960
//    5 MB     5,277,530      44 ms       9 ms       163 ms    7 ms      195 ms     0.8 MB       5.4 MB   2,360
//   10 MB    10,467,470      74 ms      18 ms       335 ms   14 ms      403 ms     1.6 MB      10.7 MB   4,680
//   20 MB    21,029,650     136 ms      42 ms       689 ms   41 ms      804 ms     3.2 MB      21.5 MB   9,400
//
//   peak RSS across all four runs (/usr/bin/time -l): 665 MB
//
// Every stage is LINEAR in diff bytes — no cliff. Engine work at 20 MB totals ~1.7 s,
// paid ONCE, in the background sidecar; the fingerprint parse dominates (~33 ms/MB).
// The durable cost is footprint: `attribution.ndjson` tracks the patch at ~1:1, so a
// 20 MB cap means ~25 MB of derived artifacts per branch on top of the patch itself.
//
// The sidecar is NOT the only constraint; interpret it alongside
// `scripts/review-performance.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { attribute, parseChangedRows } from '@orcaops/review-core';
import { normalizeTruncatedReviewDiff } from '@orcaops/review-engine';

const TARGETS_MB = [2, 5, 10, 20];
/** Directory the generated patches are written to. */
export const OUT_DIR = path.join(tmpdir(), 'orcaops-review-cap-bench');

const ms = (t: bigint): number => Number(process.hrtime.bigint() - t) / 1e6;
const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`;
const num = (n: number): string => n.toLocaleString('en-US');

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 30 });
}

/**
 * A repo whose base→head diff is close to `targetBytes`, at REALISTIC HUNK DENSITY.
 *
 * Shape matters more than size here. Rewriting every line of a file yields ONE enormous
 * hunk, and both the fingerprint parse and the TUI's layout scale with the number of
 * HUNKS — so a 40-hunk 20MB diff would flatter the result into meaninglessness. A
 * representative review patch runs ~2.3KB per hunk, so each synthetic file gets
 * islands of change separated by enough untouched context that git keeps them apart
 * (unified=3 merges anything closer than ~7 lines).
 *
 * Deterministic — no RNG, no clock — so a re-run is comparable.
 */
const LINE = 72;
const CHANGED_PER_HUNK = 12; // -12/+12 ≈ 2.3KB of patch — the density this benchmark targets
const GAP = 10; // untouched lines between islands; > 2*3 context so hunks stay separate

function makeRepo(targetBytes: number): { root: string; base: string; head: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orcaops-bench-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'bench@orcaops.dev']);
  git(root, ['config', 'user.name', 'bench']);

  // Each hunk emits ~(2*CHANGED + 6 context + 1 header) lines of patch.
  const bytesPerHunk = (2 * CHANGED_PER_HUNK + 7) * LINE;
  const totalHunks = Math.max(1, Math.round(targetBytes / bytesPerHunk));
  const FILES = 40;
  const hunksPerFile = Math.max(1, Math.round(totalHunks / FILES));

  const pad = (s: string): string => s.padEnd(LINE - 1).slice(0, LINE - 1);

  const build = (f: number, mutate: boolean): string => {
    const out: string[] = [];
    for (let h = 0; h < hunksPerFile; h++) {
      for (let g = 0; g < GAP; g++) out.push(pad(`const ctx_${f}_${h}_${g} = ${g};`));
      for (let c = 0; c < CHANGED_PER_HUNK; c++) {
        out.push(
          mutate
            ? pad(`export const NEW_${f}_${h}_${c} = ${c + 1}; // rewritten`)
            : pad(`export const old_${f}_${h}_${c} = ${c};`)
        );
      }
    }
    for (let g = 0; g < GAP; g++) out.push(pad(`const tail_${f}_${g} = ${g};`));
    return `${out.join('\n')}\n`;
  };

  for (let f = 0; f < FILES; f++) writeFileSync(path.join(root, `f${f}.ts`), build(f, false));
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).toString().trim();

  for (let f = 0; f < FILES; f++) writeFileSync(path.join(root, `f${f}.ts`), build(f, true));
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'head']);
  const head = git(root, ['rev-parse', 'HEAD']).toString().trim();
  return { root, base, head };
}

await mkdir(OUT_DIR, { recursive: true });
const rows: string[][] = [];

for (const target of TARGETS_MB) {
  const { root, base, head } = makeRepo(target * 1_048_576);
  try {
    // ── git diff collection (what diffSnapshotTrees does, same flags) ───────────────
    let t = process.hrtime.bigint();
    const raw = new Uint8Array(
      git(root, ['diff', '--no-ext-diff', '--unified=3', '--find-renames', base, head])
    );
    const tDiff = ms(t);

    // ── complete-hunk normalization (only runs when the cap actually cut) ───────────
    // Feed it what the cap actually produces: a mid-hunk byte prefix. Timing
    // the untruncated diff here measured a code path production never takes.
    const capCut = raw.subarray(0, Math.floor(raw.length * 0.9));
    t = process.hrtime.bigint();
    const { bytes: patch } = normalizeTruncatedReviewDiff(capCut);
    const tNorm = ms(t);

    // ── the fingerprint parse that BUILDS the floor's coverage ──────────────────────
    const { fingerprintUnifiedDiff } = await import('@orcaops/diff-fingerprint');
    t = process.hrtime.bigint();
    const hunks = await fingerprintUnifiedDiff({
      diffBytes: raw,
      truncated: false,
      maxDiffBytes: 1 << 30,
    });
    const tFp = ms(t);

    // ── the changed-row substrate `attribute()` cross-checks against ────────────────
    t = process.hrtime.bigint();
    const parsed = parseChangedRows(raw);
    const tRows = ms(t);

    // Single-checkpoint branch: every changed row is owned by one segment. That is what
    // blame would actually produce here, so the attribution volume is realistic.
    const lineOwners = parsed.flatMap((h) =>
      h.rows.map((r) => ({ file: h.coverageFile, side: r.side, line: r.line, segment: 0 }))
    );
    const chain = {
      base,
      worktree: head,
      segments: [
        {
          index: 0,
          id: 'bench:cp1',
          kind: 'checkpoint' as const,
          openTree: base,
          closeTree: head,
          owner: { kind: 'checkpoint' as const, artifact: 'bench', cp: 1 },
        },
      ],
      excluded: [],
    };

    t = process.hrtime.bigint();
    const result = await attribute({
      chain,
      reviewDiff: raw,
      reviewDiffTruncated: false,
      reviewMaxDiffBytes: 1 << 30,
      lineOwners,
      rungInputs: [],
      overlapSegments: [],
      integrity: [],
    });
    const tAttr = ms(t);

    // ── the artifacts a bigger cap actually leaves on disk ──────────────────────────
    const ndjson = result.attribution.lines.map((l) => JSON.stringify(l)).join('\n');
    const floorish = JSON.stringify({
      coverage: result.coverage,
      attribution: { activeRung: result.attribution.activeRung },
      disclosure: result.disclosures,
    });
    writeFileSync(path.join(OUT_DIR, `${target}mb.patch`), patch);

    rows.push([
      `${target} MB`,
      num(raw.length),
      `${tDiff.toFixed(0)} ms`,
      `${tNorm.toFixed(0)} ms`,
      `${tFp.toFixed(0)} ms`,
      `${tRows.toFixed(0)} ms`,
      `${tAttr.toFixed(0)} ms`,
      mb(Buffer.byteLength(floorish)),
      mb(Buffer.byteLength(ndjson)),
      `${hunks.length} hunks`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HEAD = [
  'target',
  'diff bytes',
  'git diff',
  'normalize',
  'fingerprint',
  'rows',
  'attribute',
  'floor.json',
  'attribution',
  'hunks',
];
const w = HEAD.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(w[i])).join('  ');

console.log(`\nNODE sidecar — review.max_diff_bytes cost curve  (node ${process.version})\n`);
console.log(line(HEAD));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));
console.log(`\n  peak RSS this process: ${mb(process.memoryUsage().rss)}`);
console.log(`  patches written to   : ${OUT_DIR}`);
console.log(`\n  Excluded: blame + lineage. They scale with FILE COUNT and history depth,`);
console.log(`  not with diff bytes, and sit behind the persistent blame cache.\n`);
