import { statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin, PathContainmentError } from '@orcaops/evaluator-protocol';

import { EvaluatorDiscoveryError } from './errors.js';
import { type LoadedPackage, loadPackage } from './package.js';
import type { ResolvedPackSource } from './resolver.js';
import { type LoadedSpec, loadSpecs } from './spec.js';
import { createParamsValidator } from './validator.js';
import { requiredTrustCapabilities, type TrustCapability } from '../trust-capability.js';

/**
 * Result of validating a pack at install / refresh time. `ok` is true
 * iff `errors.length === 0`. Warnings never fail validation — they
 * surface trust signals the caller should display before mutating
 * the user's `.orcaops/evaluators.yaml`.
 *
 * Reused by:
 *   - `orcaops eval add-pack` (block install on errors; surface
 *     warnings as a trust-boundary confirmation prompt)
 *   - `orcaops eval update-pack` (block refresh on errors; warn if
 *     warning set changed since last resolve)
 *   - `orcaops doctor` (surface errors as install drift, warnings as
 *     informational)
 */
export interface PackValidationResult {
  ok: boolean;
  package_id: string;
  package_root: string;
  errors: PackValidationError[];
  warnings: PackValidationWarning[];
  /** Successfully-loaded specs (informational; caller may render counts). */
  specs: LoadedSpec[];
}

export interface PackValidationError {
  /** Stable code; tests + structured output assert on this. */
  code:
    | 'manifest_load'
    | 'spec_load'
    | 'command_missing_executable'
    | 'command_missing_companion_file'
    | 'prompt_file_missing'
    | 'params_schema_invalid'
    | 'path_escapes_pack';
  message: string;
  /** Pack-relative path the error is about. Always set when known. */
  source_path?: string;
  /** Spec id when the error is per-spec. */
  evaluator_id?: string;
}

export interface PackValidationWarning {
  /**
   * All three warnings are trust-boundary signals and gate the fingerprint
   * grant. Every LLM evaluator transmits capture context and consumes the
   * user's authenticated provider access; the file-reading class is an
   * additional capability for evaluators that can inspect the worktree.
   * `file_reading_llm_evaluator_present` covers command-filtered LLM
   * evaluators that can read files into a prompt sent to an external API.
   */
  code:
    | 'command_evaluators_present'
    | 'llm_evaluators_present'
    | 'file_reading_llm_evaluator_present';
  message: string;
  /** Refs that participate in this warning, ordered for deterministic output. */
  refs: string[];
}

export interface ValidatePackOptions {
  /**
   * Allow callers to short-circuit the companion-file existence
   * check (e.g., doctor wants to surface missing files; add-pack
   * wants to block on them). Default: check.
   */
  skipCommandFileChecks?: boolean;
  /**
   * The tool an evaluator reaches when it declares no `provider` (from
   * `LLMClient.defaultProvider`). Threaded through so the capability
   * classification here matches the DISPATCH gate exactly: a class dispatch
   * refuses but validation never warns about would be ungrantable — no
   * prompt, no grant, no manifest entry, permanent refusal.
   */
  defaultLlmProvider?: 'claude' | 'codex' | null;
}

/**
 * Validate a resolved pack end-to-end. Loads the manifest, loads
 * every spec, and runs a battery of file-system / schema checks
 * against the resolved pack root. Never throws — pack-load failure
 * is reported as a structured error.
 */
export async function validatePack(
  resolved: ResolvedPackSource,
  opts: ValidatePackOptions = {}
): Promise<PackValidationResult> {
  const errors: PackValidationError[] = [];
  const warnings: PackValidationWarning[] = [];

  let pkg: LoadedPackage;
  try {
    pkg = await loadPackage(resolved.pack_root);
  } catch (err) {
    return {
      ok: false,
      package_id: derivePackId(resolved),
      package_root: resolved.pack_root,
      errors: [
        {
          code: 'manifest_load',
          message: err instanceof Error ? err.message : String(err),
          source_path:
            err instanceof EvaluatorDiscoveryError ? err.source_path : resolved.pack_root,
        },
      ],
      warnings: [],
      specs: [],
    };
  }

  const specs: LoadedSpec[] = [];
  await loadSpecs(pkg, {
    onError: (err) => {
      // Preserve the specific code (e.g., `path_escapes_pack`) that
      // spec.ts attaches to EvaluatorDiscoveryError. Without this the
      // structural escape-path / params-shape rejections collapse into
      // the generic `spec_load` bucket and downstream code (doctor,
      // structured CLI output) can't distinguish them.
      const errCode = (err as EvaluatorDiscoveryError).code;
      errors.push({
        code: errCode === 'path_escapes_pack' ? 'path_escapes_pack' : 'spec_load',
        message: err.message,
        source_path: err.source_path,
        ...(err.field_path !== undefined ? { evaluator_id: err.field_path } : {}),
      });
    },
  }).then((loaded) => specs.push(...loaded));

  const refsByCapability: Record<TrustCapability, string[]> = {
    command_evaluators_present: [],
    llm_evaluators_present: [],
    file_reading_llm_evaluator_present: [],
  };
  // Instantiate the Ajv validator once and reuse across
  // specs. createParamsValidator caches compiled schemas by identity,
  // so each spec only pays the compile cost on its first call.
  const validateParams = createParamsValidator();

  for (const loaded of specs) {
    const spec = loaded.spec;
    const ref = `${pkg.manifest.id}/${spec.id}`;
    // If the spec declares a params_schema, validate its own params
    // defaults against it. This catches pack-author bugs at install
    // time (the defaults don't pass the schema they ship with) rather
    // than at first run.
    if (spec.params_schema !== undefined) {
      try {
        validateParams(spec.params, spec.params_schema);
      } catch (err) {
        errors.push({
          code: 'params_schema_invalid',
          message: `default params fail spec's own params_schema: ${(err as Error).message}`,
          source_path: loaded.spec_path,
          evaluator_id: ref,
        });
      }
    }
    for (const capability of requiredTrustCapabilities(spec.engine, opts.defaultLlmProvider)) {
      refsByCapability[capability].push(ref);
    }
    if (spec.engine.kind === 'command') {
      if (!opts.skipCommandFileChecks) {
        await checkCommandFiles(spec, ref, pkg.package_root, loaded.spec_path, errors);
      }
    } else if (spec.engine.kind === 'llm') {
      const promptRel = spec.engine.prompt_file;
      const promptTarget = path.resolve(pkg.package_root, promptRel);
      let promptAbs: string;
      try {
        promptAbs = assertResolvedWithin(promptTarget, pkg.package_root, 'engine.prompt_file');
      } catch (err) {
        if (!(err instanceof PathContainmentError)) throw err;
        errors.push({
          code: 'path_escapes_pack',
          message: err.message,
          source_path: loaded.spec_path,
          evaluator_id: ref,
        });
        continue;
      }
      {
        const promptExists = await pathExists(promptAbs);
        if (!promptExists) {
          errors.push({
            code: 'prompt_file_missing',
            message: `engine.prompt_file ${promptRel} not found relative to ${pkg.package_root}`,
            source_path: loaded.spec_path,
            evaluator_id: ref,
          });
        }
      }
    }
  }

  const commandRefs = refsByCapability.command_evaluators_present;
  if (commandRefs.length > 0) {
    warnings.push({
      code: 'command_evaluators_present',
      message:
        `${commandRefs.length} command-engine evaluator(s) are trusted executable code and ` +
        `will run with the invoking user's permissions under the declared env policy. Orcaops ` +
        `does not sandbox them. Confirm you trust this pack before enabling them.`,
      refs: commandRefs,
    });
  }
  const llmRefs = refsByCapability.llm_evaluators_present;
  if (llmRefs.length > 0) {
    warnings.push({
      code: 'llm_evaluators_present',
      message:
        `${llmRefs.length} llm-engine evaluator(s) will send captured context through your ` +
        `authenticated Claude / Codex CLI and consume LLM credits. Confirm you trust this ` +
        `pack source before enabling them.`,
      refs: llmRefs,
    });
  }
  const fileReadingLlmRefs = refsByCapability.file_reading_llm_evaluator_present;
  if (fileReadingLlmRefs.length > 0) {
    warnings.push({
      code: 'file_reading_llm_evaluator_present',
      message:
        `${fileReadingLlmRefs.length} llm-engine evaluator(s) can READ files and send their ` +
        `contents to the LLM API to grade delivery. Provider tool controls vary; they are not ` +
        `an Orcaops OS sandbox or workspace-confinement boundary. The provider process runs ` +
        `with the invoking user's permissions. Confirm you trust this pack before enabling them.`,
      refs: fileReadingLlmRefs,
    });
  }

  return {
    ok: errors.length === 0,
    package_id: pkg.manifest.id,
    package_root: pkg.package_root,
    errors,
    warnings,
    specs,
  };
}

/**
 * Explicit allowlist of absolute paths to recognized system
 * interpreters. Any other absolute path outside the pack root is a
 * `path_escapes_pack` error — pack authors needing a non-standard
 * interpreter use `env <name>` indirection (the indirection target
 * resolves at exec time, not trust time, which is the correct
 * boundary).
 */
const SYSTEM_INTERPRETER_ALLOWLIST: ReadonlySet<string> = new Set([
  '/usr/bin/env',
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/bash',
  '/usr/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/python',
  '/usr/bin/python3',
  '/usr/local/bin/python',
  '/usr/local/bin/python3',
]);

interface ResolvedCommandArg {
  /** `pack_file` is the only class whose bytes belong to the pack fingerprint. */
  kind: 'bare' | 'repo_relative' | 'pack_file' | 'non_file' | 'system_interpreter' | 'escape';
  abs?: string;
}

function classifyPackPath(abs: string, packRoot: string, index: number): ResolvedCommandArg {
  let contained: string;
  try {
    contained = assertResolvedWithin(abs, packRoot, `engine.command[${index}]`);
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    return { kind: 'escape', abs };
  }
  try {
    if (!statSync(contained).isFile()) return { kind: 'non_file', abs: contained };
  } catch {
    // Preserve the pack-file classification for a missing explicit path so
    // validation reports the missing companion or executable.
  }
  return { kind: 'pack_file', abs: contained };
}

function hasPathSeparator(arg: string): boolean {
  return arg.includes('/') || (path.sep === '\\' && arg.includes('\\'));
}

/**
 * Classify a single `engine.command[]` element. Explicit relative and absolute
 * paths use resolved containment. An unprefixed command[0] containing a path
 * separator is cwd-relative rather than PATH-resolved; under package cwd it is
 * a pack file. A later bare token is also a pack file when it currently
 * resolves to one, covering `node runtime/check.mjs` without mistaking `node`
 * for a file.
 */
export function classifyCommandArg(
  arg: string,
  packRoot: string,
  index: number,
  cwd: 'package' | 'repo'
): ResolvedCommandArg {
  if (arg.startsWith('./') || arg.startsWith('../')) {
    // resolveEvaluator rewrites command[0] against the pack. Later arguments
    // stay verbatim, so repo-cwd arguments resolve from the repository and
    // are deliberately outside the pack-source fingerprint.
    if (index > 0 && cwd === 'repo') return { kind: 'repo_relative' };
    const abs = path.resolve(packRoot, arg);
    return classifyPackPath(abs, packRoot, index);
  }
  if (path.isAbsolute(arg)) {
    if (SYSTEM_INTERPRETER_ALLOWLIST.has(arg)) {
      return { kind: 'system_interpreter' };
    }
    return classifyPackPath(arg, packRoot, index);
  }
  if (hasPathSeparator(arg)) {
    if (cwd === 'repo') return { kind: 'repo_relative' };
    if (index === 0) return classifyPackPath(path.resolve(packRoot, arg), packRoot, index);
  }
  if (index > 0 && cwd === 'package') {
    const abs = path.resolve(packRoot, arg);
    try {
      if (statSync(abs).isFile()) return classifyPackPath(abs, packRoot, index);
    } catch {
      // A missing bare token remains a literal argument. If it becomes a
      // file, the next fresh trust check classifies and fingerprints it.
    }
  }
  return { kind: 'bare' };
}

/**
 * Walk every element of `engine.command[]` (including `command[0]`)
 * and surface `path_escapes_pack` for any element resolving outside
 * the pack root, plus existence checks for pack-internal elements.
 */
async function checkCommandFiles(
  spec:
    | { engine: Extract<{ kind: 'command'; command: string[] }, { kind: 'command' }> }
    | {
        engine: { kind: string };
        id?: string;
      },
  ref: string,
  packRoot: string,
  specPath: string,
  errors: PackValidationError[]
): Promise<void> {
  const engine = (
    spec as {
      engine: { kind: string; command?: string[]; cwd?: 'package' | 'repo' };
    }
  ).engine;
  if (engine.kind !== 'command' || !Array.isArray(engine.command) || engine.command.length === 0) {
    return;
  }
  for (let i = 0; i < engine.command.length; i++) {
    const arg = engine.command[i];
    if (typeof arg !== 'string') continue;
    const classified = classifyCommandArg(
      arg,
      packRoot,
      i,
      engine.cwd === 'repo' ? 'repo' : 'package'
    );
    if (
      classified.kind === 'bare' ||
      classified.kind === 'repo_relative' ||
      classified.kind === 'system_interpreter'
    ) {
      continue;
    }
    if (classified.kind === 'escape') {
      errors.push({
        code: 'path_escapes_pack',
        message: `engine.command[${i}] (${arg}) resolves outside the pack root (${packRoot})`,
        source_path: specPath,
        evaluator_id: ref,
      });
      continue;
    }
    if (classified.kind === 'non_file') {
      if (i === 0) {
        errors.push({
          code: 'command_missing_executable',
          message: `engine.command[0] (${arg}) is not a regular file`,
          source_path: specPath,
          evaluator_id: ref,
        });
      }
      continue;
    }
    let contained: string | undefined;
    try {
      contained =
        classified.abs === undefined
          ? undefined
          : assertResolvedWithin(classified.abs, packRoot, `engine.command[${i}]`);
    } catch (err) {
      if (!(err instanceof PathContainmentError)) throw err;
      errors.push({
        code: 'path_escapes_pack',
        message: err.message,
        source_path: specPath,
        evaluator_id: ref,
      });
      continue;
    }
    if (contained && !(await pathExists(contained))) {
      const code = i === 0 ? 'command_missing_executable' : 'command_missing_companion_file';
      errors.push({
        code,
        message:
          i === 0
            ? `engine.command[0] (${arg}) not found at ${contained}`
            : `engine.command argument (${arg}) not found at ${contained}`,
        source_path: specPath,
        evaluator_id: ref,
      });
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort package_id derivation when the manifest didn't load.
 * Resolver-source descriptors with a `pack` field expose the id
 * inline; path-sourced packs fall back to the basename of the
 * resolved root.
 */
function derivePackId(resolved: ResolvedPackSource): string {
  const src = resolved.source;
  if (src.kind === 'bundled' || src.kind === 'package') {
    return src.pack;
  }
  return path.basename(resolved.pack_root);
}
