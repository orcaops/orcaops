import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertResolvedWithin,
  globMayMatchDescendant,
  globRequiresDirectoryTraversal,
  matchesAnyGlob,
  PathContainmentError,
  type ResolvedEvaluator,
  toPosixPath,
} from '@orcaops/evaluator-protocol';

/**
 * Soft-block idempotency fingerprint. The
 * fingerprint is a sha256 over the sorted concatenation of:
 *
 *   - the evaluator ref
 *   - sha256 of the spec file's content
 *   - sha256 of every file matched by `fingerprint.include` globs
 *     (resolved against the pack root)
 *   - canonical JSON of the resolved `params`
 *   - canonical JSON of the resolved `severity`
 *
 * Replays of a `soft_blocked` checkpoint-open record return the
 * cached envelope ONLY when the recomputed fingerprint matches.
 * Any change to the spec, its referenced fingerprint inputs, the
 * params overrides, or the severity invalidates the cache.
 */

export interface FingerprintResult {
  /** sha256 hex string. */
  fingerprint: string;
  /**
   * Absolute paths to every file that contributed content to the
   * fingerprint, in sorted order. Includes the spec path + every
   * matched fingerprint_include file.
   */
  inputs: string[];
  /**
   * `fingerprint_include` patterns that matched zero files. This is
   * a warning condition (doctor surfaces these), not an error — the
   * patterns contribute an empty content slice to the fingerprint.
   */
  empty_patterns: string[];
}

/**
 * Compute the soft-block fingerprint for a single evaluator. Reads
 * the spec file + every matched fingerprint_include file from disk.
 */
export async function computeEvaluatorFingerprint(
  evaluator: ResolvedEvaluator
): Promise<FingerprintResult> {
  const inputs: string[] = [];
  const inputContents = new Map<string, string>();

  // Spec content (always included).
  const specPath = assertResolvedWithin(
    evaluator.spec_path,
    evaluator.package_root,
    'evaluator spec'
  );
  const specContent = await readFile(specPath);
  inputs.push(evaluator.spec_path);
  inputContents.set(evaluator.spec_path, sha256(specContent));

  // fingerprint_include glob expansion against the pack root.
  const { matched, empty_patterns } = await expandFingerprintIncludes(
    evaluator.package_root,
    evaluator.fingerprint_include
  );
  for (const filePath of matched) {
    const contained = assertResolvedWithin(
      filePath,
      evaluator.package_root,
      'fingerprint.include input'
    );
    if (inputContents.has(filePath)) continue;
    const content = await readFile(contained);
    inputs.push(filePath);
    inputContents.set(filePath, sha256(content));
  }
  inputs.sort();

  const lines: string[] = [];
  lines.push(`ref=${evaluator.ref}`);
  lines.push(`spec=${inputContents.get(evaluator.spec_path) ?? ''}`);
  for (const filePath of inputs) {
    if (filePath === evaluator.spec_path) continue;
    lines.push(
      `file:${path.relative(evaluator.package_root, filePath)}=${inputContents.get(filePath) ?? ''}`
    );
  }
  lines.push(`params=${canonicalJson(evaluator.params)}`);
  lines.push(`severity=${canonicalJson(evaluator.severity)}`);
  lines.sort();

  const fingerprint = sha256(lines.join('\n'));
  return { fingerprint, inputs, empty_patterns };
}

/**
 * Combine per-evaluator fingerprints into a single soft-block
 * replay key. Used by the checkpoint-open gate's idempotency layer
 * — the gate caches a `soft_blocked` envelope
 * keyed by the COMBINED fingerprint of every checkpoint-open
 * evaluator, so a single spec/param change invalidates the entire
 * cached envelope.
 *
 * Sorted `<ref>=<fp>` joins so the same evaluator set in any
 * iteration order produces the same combined hash.
 */
export async function combineEvaluatorFingerprints(
  evaluators: readonly ResolvedEvaluator[]
): Promise<string> {
  const parts: string[] = [];
  for (const ev of evaluators) {
    const { fingerprint } = await computeEvaluatorFingerprint(ev);
    parts.push(`${ev.ref}=${fingerprint}`);
  }
  parts.sort();
  return sha256(parts.join(';'));
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * sha256 hex of a UTF-8 string. Exported for `pack-fingerprint.ts` to
 * reuse — keeps the same digest input encoding across the
 * evaluator-replay key and the trust-source fingerprint.
 */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

const MAX_EXPAND_CACHE_ENTRIES = 1024;
const expandIncludesCache = new Map<string, { matched: string[]; empty_patterns: string[] }>();

/** Drop the per-process expand-includes cache for embedding callers. */
export function clearExpandFingerprintIncludesCache(): void {
  expandIncludesCache.clear();
}

/**
 * Walk a pack root and return every file that matches at least one of
 * the supplied patterns. Exported for `pack-fingerprint.ts` to reuse
 * the same glob expansion (and per-process cache) as the evaluator-
 * level fingerprint.
 */
export async function expandFingerprintIncludes(
  packRoot: string,
  patterns: readonly string[],
  options: { fresh?: boolean } = {}
): Promise<{ matched: string[]; empty_patterns: string[] }> {
  if (patterns.length === 0) return { matched: [], empty_patterns: [] };

  const normalized = patterns.map(normalizePattern);
  const cacheKey = `${packRoot}\u0000${[...normalized].sort().join('')}`;
  if (!options.fresh) {
    const cached = expandIncludesCache.get(cacheKey);
    if (cached !== undefined) {
      return { matched: [...cached.matched], empty_patterns: [...cached.empty_patterns] };
    }
  }
  const matchedByPattern = new Map<string, Set<string>>();
  for (const p of normalized) matchedByPattern.set(p, new Set());

  const visit = async (
    dir: string,
    relPrefix: string,
    ancestors: ReadonlySet<string>
  ): Promise<void> => {
    let entries: {
      name: string;
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosixPath(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        await visit(abs, rel, new Set([...ancestors, await realpath(abs)]));
        continue;
      }
      if (entry.isSymbolicLink()) {
        const matches = normalized.filter((pattern) => matchesAnyGlob(rel, [pattern]));
        const mayMatchBelow = globMayMatchDescendant(rel, normalized);
        if (matches.length === 0 && !mayMatchBelow) continue;

        let resolved: string;
        try {
          resolved = assertResolvedWithin(abs, packRoot, 'fingerprint.include input');
        } catch (err) {
          if (
            err instanceof PathContainmentError &&
            matches.length === 0 &&
            mayMatchBelow &&
            !globRequiresDirectoryTraversal(rel, normalized)
          ) {
            continue;
          }
          throw err;
        }
        const target = await stat(resolved);
        if (target.isDirectory()) {
          if (!mayMatchBelow) continue;
          if (ancestors.has(resolved)) {
            throw new Error(`fingerprint.include directory symlink cycle at ${abs}`);
          }
          await visit(resolved, rel, new Set([...ancestors, resolved]));
          continue;
        }
        if (!target.isFile()) continue;
        for (const pattern of matches) matchedByPattern.get(pattern)?.add(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      for (const pattern of normalized) {
        if (matchesAnyGlob(rel, [pattern])) matchedByPattern.get(pattern)?.add(abs);
      }
    }
  };
  const canonicalRoot = assertResolvedWithin(packRoot, packRoot, 'pack root', {
    allowRoot: true,
  });
  await visit(packRoot, '', new Set([canonicalRoot]));

  const matched = new Set<string>();
  const empty_patterns: string[] = [];
  for (const [pattern, files] of matchedByPattern) {
    if (files.size === 0) {
      empty_patterns.push(pattern);
      continue;
    }
    for (const f of files) matched.add(f);
  }
  const result = { matched: [...matched].sort(), empty_patterns };
  if (expandIncludesCache.size >= MAX_EXPAND_CACHE_ENTRIES) {
    const oldest = expandIncludesCache.keys().next().value;
    if (oldest !== undefined) expandIncludesCache.delete(oldest);
  }
  expandIncludesCache.set(cacheKey, result);
  return { matched: [...result.matched], empty_patterns: [...result.empty_patterns] };
}

function normalizePattern(pattern: string): string {
  const normalized = toPosixPath(pattern);
  if (normalized.startsWith('./')) return normalized.slice(2);
  if (normalized.startsWith('/')) return normalized.slice(1);
  return normalized;
}

/**
 * Canonical JSON serialization with sorted object keys. Unlike storage's
 * serializer, unsupported and undefined values become null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return 'null';
}
