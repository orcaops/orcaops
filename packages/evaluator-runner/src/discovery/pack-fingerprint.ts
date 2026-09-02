import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin, toPosixPath } from '@orcaops/evaluator-protocol';

import { expandFingerprintIncludes, sha256 } from '../fingerprint.js';
import { loadPackage } from './package.js';
import type { ResolvedPackSource } from './resolver.js';
import { loadSpecs } from './spec.js';
import { classifyCommandArg } from './validate-pack.js';

/**
 * `computePackSourceFingerprint` — sha256 over the declared pack files listed
 * below. This is not a fingerprint of the complete executable closure. Backs
 * the consent `source_fingerprint` and the doctor-side trust check.
 *
 * Distinct from `computeEvaluatorFingerprint` in two important ways:
 *
 * 1. Excludes resolved `params`, `severity`, and `enabled` overrides.
 *    A user tweaking `params.threshold` in their evaluators.yaml must
 *    not revoke command trust — that field changes WHAT runs, not
 *    HOW it runs.
 * 2. Scoped to the pack, not to a single evaluator: a single
 *    fingerprint covers every spec the pack ships.
 *
 * Inputs (deterministic, sorted):
 *   - `package.yaml` (manifest)
 *   - every `<id>.eval.yaml` discovered by `loadSpecs`
 *   - for command-engine specs: every pack-internal element of
 *     `engine.command[]` (per `classifyCommandArg`)
 *   - for llm-engine specs: `engine.prompt_file`
 *   - for any spec with `description_file`: that file
 *   - every file expanded from each spec's `fingerprint.include`
 *     patterns
 *
 * Excluded inputs: the bare executable token in `command[0]`, later bare
 * tokens that do not name an existing pack file, repo-cwd relative
 * arguments, absolute system interpreters on the validate-pack allowlist,
 * and non-source repo state.
 * Every included input is independently resolved within `pack_root`.
 *
 * Serialization: `<kind>:<pack-relative-posix-path>=<sha256>` per
 * input, sorted, joined with `\n`, sha256-d. The kind discriminator
 * keeps `runtime/foo.mjs` and `evaluators/foo.mjs` distinct even if
 * they ever shared content.
 */
export interface PackSourceFingerprintResult {
  /** sha256 hex string. */
  fingerprint: string;
  /** Absolute paths to every file that contributed, sorted for debugging. */
  inputs: string[];
  /** fingerprint.include patterns that matched zero files. */
  empty_patterns: string[];
}

type LineKind =
  | 'manifest'
  | 'spec'
  | 'command_file'
  | 'prompt_file'
  | 'description_file'
  | 'include';

interface InputEntry {
  kind: LineKind;
  abs: string;
}

export async function computePackSourceFingerprint(
  resolved: ResolvedPackSource
): Promise<PackSourceFingerprintResult> {
  const pkg = await loadPackage(resolved.pack_root);
  const specs = await loadSpecs(pkg);

  const entries: InputEntry[] = [];
  const seen = new Set<string>();
  const pushOnce = (kind: LineKind, abs: string): void => {
    const contained = assertResolvedWithin(abs, pkg.package_root, `${kind} fingerprint input`);
    const key = `${kind}\u0000${contained}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, abs: contained });
  };

  pushOnce('manifest', pkg.manifest_path);

  const emptyPatternsSet = new Set<string>();
  for (const loaded of specs) {
    pushOnce('spec', loaded.spec_path);
    const spec = loaded.spec;
    if (spec.description_file !== undefined) {
      pushOnce('description_file', path.resolve(pkg.package_root, spec.description_file));
    }
    if (spec.engine.kind === 'command') {
      for (const [index, arg] of spec.engine.command.entries()) {
        if (typeof arg !== 'string') continue;
        const classified = classifyCommandArg(arg, pkg.package_root, index, spec.engine.cwd);
        if (classified.kind === 'pack_file' && classified.abs !== undefined) {
          pushOnce('command_file', classified.abs);
        }
        // 'bare' / 'repo_relative' / 'non_file' / 'system_interpreter' / 'escape'
        // do not contribute.
        // Consent-granting callers reject 'escape' through validatePack;
        // no external path is read or incorporated here.
      }
    } else if (spec.engine.kind === 'llm') {
      pushOnce('prompt_file', path.resolve(pkg.package_root, spec.engine.prompt_file));
    }
    if (spec.fingerprint?.include !== undefined) {
      const { matched, empty_patterns } = await expandFingerprintIncludes(
        pkg.package_root,
        spec.fingerprint.include,
        { fresh: true }
      );
      for (const abs of matched) pushOnce('include', abs);
      for (const p of empty_patterns) emptyPatternsSet.add(p);
    }
  }

  const lines: string[] = [];
  const inputs: string[] = [];
  for (const entry of entries) {
    let content: Uint8Array;
    try {
      content = await readFile(entry.abs);
    } catch (err) {
      // Pack-fingerprint sits downstream of validatePack; missing
      // files indicate a bypass or filesystem race. Surface the error
      // rather than substituting empty bytes (which would silently
      // equalize fingerprints across broken packs).
      throw new Error(
        `computePackSourceFingerprint: cannot read ${entry.kind} at ${entry.abs}: ${
          (err as Error).message
        }`
      );
    }
    const rel = toPosixPath(path.relative(pkg.package_root, entry.abs));
    lines.push(`${entry.kind}:${rel}=${sha256(content)}`);
    inputs.push(entry.abs);
  }
  lines.sort();
  inputs.sort();

  return {
    fingerprint: sha256(lines.join('\n')),
    inputs,
    empty_patterns: [...emptyPatternsSet].sort(),
  };
}
