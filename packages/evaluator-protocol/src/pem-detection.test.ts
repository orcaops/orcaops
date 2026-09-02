import { describe, expect, it } from 'vitest';

import { PEM_CORPUS, type PemSample } from './pem-corpus.js';
import { findSecretLocations, redactSecrets, redactSecretsInUnifiedDiff } from './secrets.js';

/**
 * What the current private-key block scan does against the corpus in
 * `./pem-corpus`, recorded as an exact table.
 *
 * The table measures; it does not judge. Every family has a row, and a family
 * that leaks or over-claims records that at its present value rather than being
 * skipped — a skipped case is invisible. Changing detector behaviour on any
 * family fails this table and forces a decision about it.
 */

interface FamilyVerdict {
  family: string;
  samples: number;
  /** Body runs that survived redaction. Each one is key material printed. */
  leakedRuns: number;
  /** Bystander runs redaction removed. Each one is content claimed wrongly. */
  overclaimedRuns: number;
}

function measure(sample: PemSample, asDiff: boolean): { leaked: number; overclaimed: number } {
  const out = asDiff ? redactSecretsInUnifiedDiff(sample.text) : redactSecrets(sample.text);
  return {
    leaked: sample.material.filter((run) => out.includes(run)).length,
    overclaimed: sample.bystanders.filter((run) => !out.includes(run)).length,
  };
}

const isDiffFamily = (family: string): boolean => family === 'clean-diff';

function verdicts(): FamilyVerdict[] {
  return PEM_CORPUS.map(({ family, samples }) => {
    let leakedRuns = 0;
    let overclaimedRuns = 0;
    for (const sample of samples) {
      const result = measure(sample, isDiffFamily(family));
      leakedRuns += result.leaked;
      overclaimedRuns += result.overclaimed;
    }
    return { family, samples: samples.length, leakedRuns, overclaimedRuns };
  });
}

describe('private-key block detection — measured against the corpus', () => {
  it('records a verdict for every family', () => {
    // No family may be silently absent: the table is the inventory.
    expect(verdicts().map((v) => v.family)).toEqual(PEM_CORPUS.map((f) => f.family));
  });

  it('matches the recorded baseline', () => {
    expect(verdicts()).toEqual([
      { family: 'decorated', samples: 28, leakedRuns: 0, overclaimedRuns: 0 },
      { family: 'header-run', samples: 3, leakedRuns: 0, overclaimedRuns: 0 },
      { family: 'first-line-narrow', samples: 4, leakedRuns: 0, overclaimedRuns: 0 },
      // Gap: a marker named in prose claims from the marker to the end of
      // whatever base64-dense content follows it. Only the definition-list
      // variant is bounded. The diff redactor scans every hunk body as one
      // joined document, so this reaches across files.
      { family: 'prose-mention', samples: 4, leakedRuns: 0, overclaimedRuns: 8 },
      { family: 'header-and-marker', samples: 3, leakedRuns: 0, overclaimedRuns: 0 },
      // Gap, in both directions at once.
      { family: 'unterminated-beside', samples: 3, leakedRuns: 2, overclaimedRuns: 3 },
      { family: 'clean-diff', samples: 3, leakedRuns: 0, overclaimedRuns: 0 },
    ]);
  });

  // A family total moving is a signal; knowing which shape moved makes it actionable.
  it('names the shapes behind each recorded gap', () => {
    const byName = new Map(
      PEM_CORPUS.flatMap(({ family, samples }) =>
        samples.map((sample) => [sample.name, measure(sample, isDiffFamily(family))] as const)
      )
    );
    const gaps = [...byName]
      .filter(([, result]) => result.leaked > 0 || result.overclaimed > 0)
      .map(([name, result]) => `${name} leaked=${result.leaked} overclaimed=${result.overclaimed}`);

    expect(gaps).toEqual([
      // A prose mention swallows the lockfile hunk behind it: 4 of its 5 rows.
      'prose-mention/npm-lockfile-integrity leaked=0 overclaimed=4',
      'prose-mention/subresource-integrity leaked=0 overclaimed=2',
      'prose-mention/commit-sha-listing leaked=0 overclaimed=2',
      // `refuse` reported over a span that stops short of its own body: half
      // the key prints under a finding claiming it was handled.
      'unterminated-beside/lockfile leaked=2 overclaimed=0',
      // The other direction from the same family: the block runs past its own
      // end and takes the certificate below it.
      'unterminated-beside/certificate leaked=0 overclaimed=3',
    ]);
  });

  it('reports refuse on a truncated span rather than declining to claim', () => {
    // Worse than a miss: the finding says the run was handled, and it was not.
    const sample = PEM_CORPUS.find((f) => f.family === 'unterminated-beside')!.samples.find(
      (s) => s.name === 'unterminated-beside/lockfile'
    )!;
    const found = findSecretLocations(sample.text);
    expect(found).toHaveLength(1);
    expect(found[0]?.tier).toBe('refuse');
    expect(found[0]?.end).toBeLessThan(sample.text.length);
    expect(measure(sample, false).leaked).toBeGreaterThan(0);
  });

  // Absolute bounds at two sizes rather than a growth ratio: a ratio measures
  // the machine under a loaded suite, a wall does not.
  it('scans a marker-dense input in bounded time', () => {
    for (const count of [4_000, 16_000]) {
      const haystack = `${'X-Key: -----BEGIN RSA PRIVATE KEY-----\n'.repeat(count)}tail\n`;
      const started = performance.now();
      findSecretLocations(haystack);
      expect(performance.now() - started, `${count} markers`).toBeLessThan(2_000);
    }
  });

  it('scans an unterminated block over a large dense tail in bounded time', () => {
    const dense = PEM_CORPUS.find((f) => f.family === 'unterminated-beside')!.samples[0]!;
    const haystack = `${dense.text}\n${'ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7\n'.repeat(20_000)}`;
    expect(haystack.length).toBeGreaterThan(800_000);
    const started = performance.now();
    findSecretLocations(haystack);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
