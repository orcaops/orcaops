import { describe, expect, it } from 'vitest';

import { matchesAnyGlob } from '@orcaops/evaluator-protocol';

/**
 * Perf budget for the compiled-glob cache. `matchesAnyGlob` must stay
 * under the budget across a 1000-evaluator × 50-pattern workload,
 * since the doctor's `checkFingerprintZeroMatch` re-computes
 * fingerprints for every configured evaluator on every invocation.
 *
 * We measure the second pass — after the per-pattern-list compiled
 * matcher cache is warm — since first-pass cost is dominated by
 * picomatch compilation which is irreducible.
 */
describe('matchesAnyGlob perf budget', () => {
  const N_EVALUATORS = 1000;
  const N_PATTERNS_PER_EVALUATOR = 50;
  // ~20x the quiet-machine measurement, so a CPU-starved worker under a
  // fully parallel run does not flake. A real cache regression recompiles
  // picomatch per call (~50k compilations, 60s+), an order of magnitude
  // past this budget either way, so the slack costs no detection power.
  const BUDGET_MS = 10_000;
  const TEST_TIMEOUT_MS = 30_000;

  it(
    `runs ${N_EVALUATORS} evaluators × ${N_PATTERNS_PER_EVALUATOR} patterns under ${BUDGET_MS}ms (cache-warm)`,
    { timeout: TEST_TIMEOUT_MS },
    () => {
      // Build N evaluator pattern lists. Each list has 50 patterns;
      // adjacent evaluators share most patterns (typical of real
      // first-party packs that all watch the same source tree) so the
      // compiled-matcher cache earns its keep.
      const lists: string[][] = [];
      for (let i = 0; i < N_EVALUATORS; i++) {
        const list: string[] = [];
        for (let j = 0; j < N_PATTERNS_PER_EVALUATOR; j++) {
          // 80% shared patterns, 20% per-evaluator-specific.
          if (j < 40) list.push(`src/**/*.${j % 5 === 0 ? 'ts' : 'js'}`);
          else list.push(`evaluator-${i}/check-${j}.*.yaml`);
        }
        lists.push(list);
      }
      const filePaths = [
        'src/middleware/rateLimiter.ts',
        'src/app.ts',
        'evaluator-0/check-42.eval.yaml',
        'README.md',
      ];

      // Warm the cache.
      for (const list of lists) {
        for (const fp of filePaths) {
          matchesAnyGlob(fp, list);
        }
      }

      // Measured pass.
      const start = performance.now();
      for (const list of lists) {
        for (const fp of filePaths) {
          matchesAnyGlob(fp, list);
        }
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(BUDGET_MS);
    }
  );
});
