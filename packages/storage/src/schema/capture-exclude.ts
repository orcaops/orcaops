import { isValidGlobSyntax, matchesAnyGlob } from '@orcaops/evaluator-protocol';

import { DEFAULT_CAPTURE_EXCLUDE } from './config.js';

/** The `capture` block, as the resolver needs it. */
export interface CaptureExcludeConfig {
  readonly exclude: readonly string[];
  readonly exclude_builtins: boolean;
}

export interface ResolvedCaptureExcludes {
  /** Every pattern in effect, built-ins first. */
  readonly patterns: readonly string[];
  /** Repo-declared patterns that are not valid globs, dropped from the set. */
  readonly invalid: readonly string[];
}

/**
 * Combine the built-in exclude set with repo-declared additions.
 *
 * Additions never narrow the built-ins — only `exclude_builtins: false` does,
 * and that is a deliberate opt-out rather than a side effect of declaring a
 * pattern. Invalid globs are dropped and returned rather than thrown on:
 * snapshot capture is fail-open by contract, and a typo in a config should not
 * be able to stop a checkpoint closing.
 */
export function resolveCaptureExcludes(capture: CaptureExcludeConfig): ResolvedCaptureExcludes {
  const invalid = capture.exclude.filter((pattern) => !isValidGlobSyntax(pattern));
  const declared = capture.exclude.filter((pattern) => isValidGlobSyntax(pattern));
  return {
    patterns: capture.exclude_builtins ? [...DEFAULT_CAPTURE_EXCLUDE, ...declared] : declared,
    invalid,
  };
}

/**
 * Select the paths an exclude set covers.
 *
 * Callers pass the output of `git ls-files --others --exclude-standard`, which
 * is definitionally not gitignored. That matters downstream: an exclude
 * pathspec naming a gitignored path makes `git add` fail outright, so the
 * concrete set staying non-ignored is what lets it be applied at add time.
 */
export function selectExcludedPaths(
  paths: readonly string[],
  patterns: readonly string[]
): string[] {
  if (patterns.length === 0) return [];
  return paths.filter((path) => matchesAnyGlob(path, patterns)).sort();
}
