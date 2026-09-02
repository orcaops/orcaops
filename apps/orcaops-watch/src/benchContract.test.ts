// BENCHMARK SOURCE CONTRACTS: these scripts are top-level-await executables,
// and importing them runs multi-MB cost curves. Source-level assertions keep
// their measurement inputs and exported metric schema stable without executing
// the benchmarks in the unit-test process.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts');
const costCurve = readFileSync(path.join(SCRIPTS, 'review-cap-bench.ts'), 'utf8');
const productionBench = readFileSync(path.join(SCRIPTS, 'review-cap-production-bench.tsx'), 'utf8');

describe('review-cap-bench contract', () => {
  it('titles the hunk-count column hunks, not parsed', () => {
    const head = costCurve.match(/const HEAD = \[[^\]]+\]/)?.[0];
    expect(head).toBeDefined();
    expect(head).toContain("'hunks'");
    expect(head).not.toContain("'parsed'");
  });

  it('times cap-cut normalization over an actually truncated input', () => {
    // The timed call must consume the strict prefix, never the complete diff.
    expect(costCurve).toMatch(
      /const capCut = raw\.subarray\(0, Math\.floor\(raw\.length \* 0\.9\)\)/
    );
    expect(costCurve).toContain('normalizeTruncatedReviewDiff(capCut)');
    expect(costCurve).not.toContain('normalizeTruncatedReviewDiff(raw)');
  });
});

describe('review-cap-production-bench contract', () => {
  it('keeps both frozen cold-layout keys on the initial layout measurement', () => {
    // The unqualified key means "cold layout of the initial layout mode."
    // That mode is split, so both keys deliberately carry one value. Pin the
    // rationale beside the fields so a future mode change cannot separate the
    // metric names from their contract.
    expect(productionBench).toContain('isolatedColdLayoutMs: rounded(layoutMs)');
    expect(productionBench).toContain('isolatedColdSplitLayoutMs: rounded(layoutMs)');
    // This source-text check validates adjacent physical lines. Establishing
    // lexical context, such as excluding a multiline template literal that
    // quotes the sequence, would require an AST parser.
    expect(productionBench).toMatch(
      /^[ \t]*\/\/ Both frozen keys report the split-layout cold measurement[^\n]*\r?\n(?:[ \t]*\/\/[^\n]*\r?\n)*[ \t]*isolatedColdLayoutMs: rounded\(layoutMs\),\r?\n[ \t]*isolatedColdSplitLayoutMs: rounded\(layoutMs\),$/m
    );
  });

  it('derives the page-hunk gate from its constants', () => {
    expect(productionBench).toContain('fixture.pageHunks === PAGE_FILES * PAGE_HUNKS_PER_FILE');
    expect(productionBench).not.toContain('=== 480');
  });
});
