import picomatch from 'picomatch';

/**
 * Normalize a filesystem path to POSIX separators so the same
 * glob patterns match on Windows and Unix. picomatch's matcher
 * treats `\` as a literal character, not a separator — without
 * this normalization, a Windows-style path like
 * `src\foo\bar.py` would never match a `src/**\/*.py` pattern.
 *
 * Idempotent on already-POSIX paths.
 */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Syntactical validation of a glob pattern. Returns true iff
 * `picomatch.makeRe` can compile the pattern without throwing.
 * Used by `EvaluatorSchema` to reject malformed `filters.paths[]`
 * and `fingerprint.include[]` entries at parse time.
 *
 * Empty strings are rejected — they would match every path under
 * picomatch and that is never the intended semantics.
 */
export function isValidGlobSyntax(pattern: string): boolean {
  if (typeof pattern !== 'string') return false;
  if (pattern.length === 0) return false;
  try {
    picomatch.makeRe(toPosixPath(pattern));
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff `filePath` matches at least one of `patterns`. Empty
 * pattern array returns false (callers wanting "no filter" semantics
 * should treat an empty pattern array as "no gating," not "match all").
 *
 * Both `filePath` and pattern matchers are POSIX-normalized so the
 * same call works on Windows agents writing backslash paths.
 *
 * Used by:
 *   - the runner for `filters.paths` (skip the evaluator if no
 *     changed file matches)
 *   - the runner for `fingerprint.include` (resolve the additional
 *     fingerprint inputs to include in the soft-block fingerprint)
 *
 * Compiled picomatch matchers are cached internally keyed on the
 * normalized pattern list. The cache is per-process, never
 * invalidated (patterns are content-addressed) and bounded by a
 * simple max-size to keep memory predictable.
 */
const MAX_MATCHER_CACHE_ENTRIES = 1024;
const matcherCache = new Map<string, Array<(s: string) => boolean>>();

function getCompiledMatchers(patterns: readonly string[]): Array<(s: string) => boolean> {
  // Canonicalize the cache key on the pattern list itself — order
  // matters for the OR-traversal below, so we don't sort here.
  // Identical pattern lists produced by different callers hit the
  // same cached compile.
  const key = JSON.stringify(patterns);
  const cached = matcherCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = patterns.map((p) => picomatch(p, { dot: true }));
  if (matcherCache.size >= MAX_MATCHER_CACHE_ENTRIES) {
    // Simple FIFO eviction: drop the oldest entry. picomatch
    // recompiles cheaply on the next miss; the cap exists to bound
    // memory under adversarial pattern churn (not normal usage).
    const oldest = matcherCache.keys().next().value;
    if (oldest !== undefined) matcherCache.delete(oldest);
  }
  matcherCache.set(key, compiled);
  return compiled;
}

export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const target = toPosixPath(filePath);
  const matchers = getCompiledMatchers(patterns.map(toPosixPath));
  for (const matcher of matchers) {
    if (matcher(target)) return true;
  }
  return false;
}

/**
 * True when a glob can select something below `directoryPath`.
 *
 * Fingerprint expansion uses this before following a directory symlink. It
 * avoids resolving unrelated workspace symlinks while ensuring a symlink on
 * the static path to a declared input cannot make that input disappear.
 */
export function globMayMatchDescendant(
  directoryPath: string,
  patterns: readonly string[]
): boolean {
  const directory = toPosixPath(directoryPath).replace(/\/+$/, '');
  return patterns.some((pattern) => {
    const { base, maxDepth } = picomatch.scan(toPosixPath(pattern), {
      parts: true,
      tokens: true,
    });
    const normalizedBase = base.replace(/\/+$/, '');
    const prefixCanReachDirectory =
      normalizedBase.length === 0 ||
      normalizedBase === directory ||
      normalizedBase.startsWith(directory + '/') ||
      directory.startsWith(normalizedBase + '/');
    if (!prefixCanReachDirectory) return false;
    const directoryDepth = directory.length === 0 ? 0 : directory.split('/').length;
    return maxDepth === undefined || maxDepth > directoryDepth;
  });
}

/**
 * True when a glob specifically selects traversal through `directoryPath`.
 *
 * A prefix-free glob such as `**\/*.mjs` may match below every directory, but
 * it does not specifically declare an incidental workspace symlink as pack
 * input. Finite brace and extglob alternatives do name their alternatives
 * (`{runtime,vendor}` and `@(runtime|vendor)`), as do character classes and
 * named directory segments after a wildcard. Fingerprinting uses this
 * distinction to skip broad external dependency directories while still
 * refusing a symlink selected by an equivalent glob spelling.
 */
export function globRequiresDirectoryTraversal(
  directoryPath: string,
  patterns: readonly string[]
): boolean {
  const directory = toPosixPath(directoryPath).replace(/\/+$/, '');
  const directoryParts = directory.split('/').filter(Boolean);
  return patterns.some((pattern) => {
    const expanded = expandFiniteAlternatives(toPosixPath(pattern));
    // Complex or excessive alternatives are unusual pack declarations. Fail
    // closed instead of misclassifying a selected external symlink as incidental.
    if (expanded === null) return true;
    return expanded.some((candidate) => {
      const { base } = picomatch.scan(candidate, { parts: true, tokens: true });
      const normalizedBase = base.replace(/\/+$/, '');
      if (normalizedBase === directory || normalizedBase.startsWith(directory + '/')) {
        return true;
      }
      return candidateRequiresTraversal(candidate, directoryParts);
    });
  });
}

const MAX_FINITE_ALTERNATIVES = 64;
const FINITE_GROUP = /\{([^{}]*,[^{}]*)\}|@\(([^()]*)\)/;
const SIMPLE_NEGATED_SEGMENT = /^!\([a-z0-9._-]+(?:\|[a-z0-9._-]+)*\)$/i;

function isGlobSegment(segment: string): boolean {
  return /[*?[\]{}()]|^!/.test(segment);
}

function isBroadTraversalSegment(segment: string): boolean {
  return segment === '*' || segment === '**' || SIMPLE_NEGATED_SEGMENT.test(segment);
}

function candidateRequiresTraversal(candidate: string, directoryParts: readonly string[]): boolean {
  const parts = candidate.split('/');
  const selectors = parts.slice(0, -1);
  const finalSelector = parts.at(-1) ?? '';
  const seen = new Set<string>();

  const visit = (
    selectorIndex: number,
    directoryIndex: number,
    wildcardSeen: boolean,
    specificSelectionSeen: boolean
  ): boolean => {
    const key = `${selectorIndex}:${directoryIndex}:${wildcardSeen ? 1 : 0}:${specificSelectionSeen ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);

    if (directoryIndex === directoryParts.length) {
      if (specificSelectionSeen) return true;
      if (selectors.slice(selectorIndex).some((selector) => !isBroadTraversalSegment(selector))) {
        return true;
      }
      // A literal or narrow final descendant after a bounded wildcard names
      // content below the symlink. Leading-star file selectors stay broad so
      // ordinary recursive declarations such as **/*.mjs can skip incidental
      // workspace dependency links.
      return wildcardSeen && !finalSelector.startsWith('*') && finalSelector !== '';
    }
    if (selectorIndex === selectors.length) return false;

    const selector = selectors[selectorIndex]!;
    if (selector === '**') {
      return (
        visit(selectorIndex + 1, directoryIndex, true, specificSelectionSeen) ||
        visit(selectorIndex, directoryIndex + 1, true, specificSelectionSeen)
      );
    }

    const part = directoryParts[directoryIndex]!;
    if (!picomatch.isMatch(part, selector, { dot: true })) return false;
    const globSegment = isGlobSegment(selector);
    const specific =
      specificSelectionSeen ||
      (globSegment && !isBroadTraversalSegment(selector)) ||
      (wildcardSeen && !isBroadTraversalSegment(selector));
    return visit(selectorIndex + 1, directoryIndex + 1, wildcardSeen || globSegment, specific);
  };

  return visit(0, 0, false, false);
}

function expandFiniteAlternatives(pattern: string): string[] | null {
  // Positive quantified extglobs need optional/repetition semantics this
  // static classifier does not model. Treat them as complex so callers refuse
  // external traversal instead of approximating their named prefixes.
  if (/[+*?]\(/.test(pattern)) return null;
  const pending = [pattern];
  const expanded: string[] = [];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    const match = FINITE_GROUP.exec(candidate);
    if (match === null || match.index === undefined) {
      if (candidate.includes('@(')) return null;
      expanded.push(candidate);
      continue;
    }
    const content = match[1] ?? match[2] ?? '';
    if (/[()[\]{}]/.test(content)) return null;
    const alternatives = content.split(match[1] !== undefined ? ',' : '|');
    if (pending.length + expanded.length + alternatives.length > MAX_FINITE_ALTERNATIVES) {
      return null;
    }
    for (const alternative of alternatives) {
      pending.push(
        candidate.slice(0, match.index) +
          alternative +
          candidate.slice(match.index + match[0].length)
      );
    }
  }
  return expanded;
}
