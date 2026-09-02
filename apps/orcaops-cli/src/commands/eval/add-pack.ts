import { createInterface } from 'node:readline';

import type {
  EvaluatorConfigPackageEntry,
  EvaluatorOverride,
  PackSource,
} from '@orcaops/evaluator-protocol';
import {
  computePackSourceFingerprint,
  isTrustCapability,
  type PackValidationResult,
  type ResolvedPackSource,
  resolvePackSource,
  validatePack,
} from '@orcaops/evaluator-runner';
import { resolveDefaultProvider } from '@orcaops/llm';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import {
  type EvaluatorGrantMutation,
  readTrustManifest,
  trustManifestCovers,
} from '../../lib/evaluator-grants.js';
import {
  CLI_ROOT,
  emptyEvaluatorsConfig,
  EVALUATOR_CONFIG_FILE,
  evaluatorsConfigPath,
  readEvaluatorsConfig,
  validateEvaluatorsConfig,
  writeEvaluatorState,
} from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

const FIRST_PARTY_PACKAGE = '@orcaops/evaluator-pack';

/**
 * The exact re-add invocation for a registered pack source. A bare pack id
 * (`orcaops eval add-pack core`) parses as a THIRD-PARTY source and
 * INVALID_INPUTs, so every remediation hint must carry the full source form.
 */
export function regrantCommandFor(source: PackSource | undefined, packId: string): string {
  if (source !== undefined && (source.kind === 'bundled' || source.kind === 'package')) {
    return `orcaops eval add-pack ${source.package} ${source.pack} --force --yes`;
  }
  if (source !== undefined && source.kind === 'path') {
    return `orcaops eval add-pack ${source.path} --force --yes`;
  }
  return `orcaops eval add-pack <source> ${packId} --force --yes`;
}

export type AddPackProfile = 'deterministic' | 'all';

export interface AddPackOptions {
  /** Positional: package name or path. */
  source: string;
  /** Optional positional: pack id within the package. */
  packId?: string;
  profile?: string;
  /** Register the pack but enable nothing. */
  disabled?: boolean;
  /** Skip trust-boundary confirmation. */
  yes?: boolean;
  /**
   * Bind the grant to the resolved workspace path instead of the declared
   * pack-file fingerprint — the author-iterating case, where editing a spec or
   * prompt would invalidate a fingerprint grant on every save.
   *
   * Exists so registration and dev-bound trust are ONE act. `eval trust --dev`
   * cannot run first (it requires the pack already registered), so without this
   * a non-interactive agent had to take a fingerprint grant via `--yes` and
   * replace it afterwards — momentarily holding exactly the durable trust the
   * authoring skill's stop line forbids.
   *
   * Deliberately does NOT imply `--yes`: a dev grant trusts whatever that path
   * later becomes, so it is more permissive than a fingerprint grant and must
   * not skip consent.
   */
  dev?: boolean;
  /** Overwrite an existing packages[] entry instead of erroring. */
  force?: boolean;
  json?: boolean;
}

interface AddPackResult {
  ok: true;
  config_path: string;
  pack: {
    id: string;
    source: PackSource;
    pack_root: string;
    description: string;
  };
  evaluators_enabled: string[];
  evaluators_disabled: string[];
  warnings: Array<{ code: string; message: string; refs: string[] }>;
  config_created: boolean;
  /**
   * How consent was established for capability-requiring evaluators:
   * a user-local grant, the installation's built-in manifest, or not
   * needed (no command / file-reading LLM evaluators in the pack).
   */
  trust: 'user-local-grant' | 'user-local-dev-grant' | 'builtin-manifest' | 'not-required';
}

export async function evalAddPackAction(opts: AddPackOptions): Promise<void> {
  try {
    const result = await runAddPack(opts);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanResult(result));
  } catch (err) {
    if (opts.json) emitError(err);
    if (err instanceof OrcaopsError) {
      writeErrorLine(err);
      throw new CliExit(1);
    }
    throw err;
  }
}

/**
 * Resolve + validate + register a pack. Exported for direct test use
 * (see apps/orcaops-cli/tests/support/test-helpers.ts:TEST_PACK_ABS_PATH); the
 * public CLI surface is `evalAddPackAction` which delegates here and
 * formats the output.
 */
export async function runAddPack(opts: AddPackOptions): Promise<AddPackResult> {
  const profile = parseAddPackProfile(opts.profile);

  const ctx = await buildContext();
  try {
    const source = parseSourceArg(opts.source, opts.packId);
    // Before resolution, validation, and every mutation: a dev grant binds to a
    // path, so a non-path source has nothing to bind to. Rejecting here rather
    // than later is what keeps the failure free of side effects — silently
    // falling back to a fingerprint grant would hand back the durable trust the
    // flag exists to avoid. Mirrors the same guard in `eval trust --dev`.
    if (opts.dev && source.kind !== 'path') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--dev is for mutable path-source (workspace) packs; this source is ` +
          `kind: ${source.kind}, which stays fingerprint-bound. Re-run without --dev.`,
        'dev'
      );
    }
    let resolved: ResolvedPackSource;
    try {
      resolved = await resolvePackSource(source, {
        repoRoot: ctx.repoRoot,
        cliRoot: CLI_ROOT,
      });
    } catch (err) {
      throw new OrcaopsError(
        ErrorCodes.PACK_RESOLUTION,
        err instanceof Error ? err.message : String(err)
      );
    }

    // Classify with the effective provider the dispatch gate will see;
    // otherwise an implicit-codex evaluator's file-reading capability is
    // never prompted for, granted, or recorded.
    const validation = await validatePack(resolved, {
      defaultLlmProvider: await resolveDefaultProvider(ctx.config.llm, getInvocationEnv()),
    });
    if (!validation.ok) {
      throw new OrcaopsError(
        ErrorCodes.PACK_VALIDATION,
        `Pack failed validation:\n${formatErrors(validation)}`
      );
    }

    const configId = derivePackId(source, validation);
    const existing = await readEvaluatorsConfig(ctx.repoRoot);
    const config = existing ?? emptyEvaluatorsConfig();
    const configCreated = existing === null;
    const configPath = evaluatorsConfigPath(ctx.repoRoot);

    const existingIdx = config.packages.findIndex((pack) => pack.id === configId);
    if (existingIdx !== -1 && !opts.force) {
      throw new OrcaopsError(
        ErrorCodes.PACK_ALREADY_INSTALLED,
        `Pack id "${configId}" is already registered in ${configPath}. ` +
          `Use --force to overwrite or \`orcaops eval update-pack ${configId}\` to refresh.`
      );
    }

    const nextConfig = {
      ...config,
      runtime: { ...config.runtime },
      packages: config.packages.map((pack) => ({ ...pack, source: { ...pack.source } })),
      evaluators: { ...config.evaluators },
    };
    const packEntry: EvaluatorConfigPackageEntry = { id: configId, source };
    if (existingIdx === -1) nextConfig.packages.push(packEntry);
    else nextConfig.packages[existingIdx] = packEntry;

    const enabledRefs: string[] = [];
    const disabledRefs: string[] = [];
    const overrides: Record<string, EvaluatorOverride> = nextConfig.evaluators;
    const discoveredRefs = new Set(
      validation.specs.map((loaded) => `${configId}/${loaded.spec.id}`)
    );

    if (opts.force) {
      const prefix = `${configId}/`;
      for (const ref of Object.keys(overrides)) {
        if (ref.startsWith(prefix) && !discoveredRefs.has(ref)) delete overrides[ref];
      }
    }

    for (const loaded of validation.specs) {
      const ref = `${configId}/${loaded.spec.id}`;
      const enable = seedEnableDecision(loaded.spec, profile, opts.disabled);
      const prior = overrides[ref];
      if (prior !== undefined && !opts.force) {
        if (prior.enabled) enabledRefs.push(ref);
        else disabledRefs.push(ref);
        continue;
      }
      overrides[ref] = { enabled: enable };
      if (enable) enabledRefs.push(ref);
      else disabledRefs.push(ref);
    }
    const validatedConfig = validateEvaluatorsConfig(nextConfig);

    // Every command and LLM warning is a consent capability. Plain LLM
    // evaluators still transmit capture context and use the user's
    // authenticated provider; file-reading evaluators require the additional
    // worktree capability.
    const securityWarnings = validation.warnings.filter((warning) =>
      isTrustCapability(warning.code)
    );
    const securityWarningCodes = securityWarnings
      .map((warning) => warning.code)
      .filter(isTrustCapability);
    let grantWritten = false;
    let grantCoveredByManifest = false;
    let grantMutation: EvaluatorGrantMutation = { kind: 'revoke', packageId: configId };
    if (securityWarnings.length > 0) {
      // Installation-manifest short-circuit: a bundled pack whose final
      // installed bytes match the manifest shipped WITH this CLI is built-in
      // trusted — no prompt, no user-local grant needed. Repo-declared
      // `kind: bundled` grants nothing by itself; the fingerprint match does.
      const { fingerprint } = await computePackSourceFingerprint(resolved);
      const manifest = readTrustManifest(CLI_ROOT);
      if (trustManifestCovers(manifest, source, fingerprint, securityWarningCodes)) {
        grantCoveredByManifest = true;
      } else {
        // Consent must present EVERY capability class it will grant — a
        // mixed command + file-reading-LLM pack shows both warnings before
        // acceptance, not just the command one.
        const combinedWarning = securityWarnings.map((w) => w.message).join('\n');
        const totalRefs = new Set(securityWarnings.flatMap((w) => w.refs)).size;
        if (opts.json && !opts.yes) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Pack ships ${totalRefs} evaluator(s) that reach capture data ` +
              `(${securityWarningCodes.join(', ')}). Trust must be granted explicitly; ` +
              `re-run with --yes to accept under --json, or run \`orcaops eval trust <pack>\` ` +
              `interactively.`,
            'yes'
          );
        }
        const accepted = opts.yes
          ? true
          : await promptForTrust(combinedWarning, totalRefs, securityWarningCodes);
        if (!accepted) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Aborted: trust not granted.', 'yes');
        }
        // The grant is USER-LOCAL (never written into the repository).
        // Fingerprint-bound to the covered declared pack files by default, so
        // changes to excluded runtime state do not invalidate it; `--dev` binds
        // to the resolved path instead, which is the author-iterating case.
        // See docs/evaluator-consent.md.
        grantMutation = {
          kind: 'write',
          grant: opts.dev
            ? {
                kind: 'workspace-dev',
                package_id: configId,
                resolved_path: resolved.pack_root,
                capabilities: securityWarningCodes,
                granted_at: new Date().toISOString(),
              }
            : {
                kind: 'fingerprint',
                package_id: configId,
                source_fingerprint: fingerprint,
                capabilities: securityWarningCodes,
                granted_at: new Date().toISOString(),
              },
        };
        grantWritten = true;
      }
    }

    await writeEvaluatorState(ctx.repoRoot, validatedConfig, grantMutation);

    return {
      ok: true,
      config_path: EVALUATOR_CONFIG_FILE,
      pack: {
        id: configId,
        source,
        pack_root: resolved.pack_root,
        description: validation.specs.length > 0 ? loadedPackDescription(validation) : '',
      },
      evaluators_enabled: enabledRefs.sort(),
      evaluators_disabled: disabledRefs.sort(),
      warnings: validation.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        refs: w.refs,
      })),
      config_created: configCreated,
      trust: grantWritten
        ? opts.dev
          ? 'user-local-dev-grant'
          : 'user-local-grant'
        : grantCoveredByManifest
          ? 'builtin-manifest'
          : 'not-required',
    };
  } finally {
    ctx.store.close();
  }
}

/**
 * Map the positional CLI args to a PackSource. The first-party
 * `@orcaops/evaluator-pack` resolves as `kind: bundled` because the
 * CLI ships this dependency itself; any other npm-specifier-shaped
 * source goes through `kind: package` (third-party). A `./`-prefixed
 * source becomes `kind: path`.
 */
function parseSourceArg(srcArg: string, packArg: string | undefined): PackSource {
  if (srcArg.startsWith('./') || srcArg.startsWith('../') || srcArg.startsWith('/')) {
    return { kind: 'path', path: srcArg };
  }
  if (srcArg === FIRST_PARTY_PACKAGE) {
    if (!packArg) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `${FIRST_PARTY_PACKAGE} requires a pack id (e.g., \`orcaops eval add-pack ${FIRST_PARTY_PACKAGE} core\`)`
      );
    }
    return { kind: 'bundled', package: FIRST_PARTY_PACKAGE, pack: packArg };
  }
  // npm package specifier + pack-id positional → kind: package
  if (!packArg) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Third-party package source "${srcArg}" requires a pack id ` +
        `(e.g., \`orcaops eval add-pack ${srcArg} <pack-id>\`)`
    );
  }
  return { kind: 'package', package: srcArg, pack: packArg };
}

function derivePackId(source: PackSource, validation: PackValidationResult): string {
  if (source.kind === 'bundled' || source.kind === 'package') return source.pack;
  return validation.package_id;
}

function parseAddPackProfile(value: string | undefined): AddPackProfile {
  const profile = value ?? 'deterministic';
  if (profile === 'deterministic' || profile === 'all') return profile;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Unsupported add-pack profile "${profile}"; expected deterministic or all.`,
    'profile'
  );
}

function shouldEnableForProfile(engineKind: string, profile: AddPackProfile): boolean {
  switch (profile) {
    case 'deterministic':
      return engineKind === 'command';
    case 'all':
      return true;
  }
}

/**
 * The enable decision for a NEWLY SEEDED evaluator ref — shared by add-pack
 * (initial registration) and update-pack (a pack that gained evaluators after
 * registration) so the two commands can never disagree. `default_enabled:
 * false` always wins (turning such an evaluator on is its own explicit act);
 * otherwise the profile decides.
 */
export function seedEnableDecision(
  spec: { engine: { kind: string }; default_enabled?: boolean },
  profile: AddPackProfile,
  forceDisabled?: boolean
): boolean {
  if (forceDisabled || spec.default_enabled === false) return false;
  return shouldEnableForProfile(spec.engine.kind, profile);
}

function formatErrors(validation: PackValidationResult): string {
  return validation.errors
    .map((e) => `  - [${e.code}] ${e.message}${e.evaluator_id ? ` (${e.evaluator_id})` : ''}`)
    .join('\n');
}

function loadedPackDescription(validation: PackValidationResult): string {
  return `${validation.specs.length} evaluator(s) in pack "${validation.package_id}"`;
}

function formatHumanResult(r: AddPackResult): string {
  const lines: string[] = [];
  lines.push(
    r.config_created
      ? `Created ${r.config_path} and registered pack "${r.pack.id}".`
      : `Registered pack "${r.pack.id}" in ${r.config_path}.`
  );
  lines.push(`  source: ${r.pack.source.kind}`);
  lines.push(`  pack_root: ${r.pack.pack_root}`);
  lines.push(`  trust: ${r.trust}`);
  lines.push('');
  if (r.warnings.length > 0) {
    lines.push('Trust-boundary warnings:');
    for (const w of r.warnings) {
      lines.push(`  - ${w.message}`);
    }
    lines.push('');
  }
  lines.push(`Enabled ${r.evaluators_enabled.length} evaluator(s):`);
  for (const ref of r.evaluators_enabled) lines.push(`  + ${ref}`);
  if (r.evaluators_disabled.length > 0) {
    lines.push('');
    lines.push(`Left ${r.evaluators_disabled.length} evaluator(s) disabled:`);
    for (const ref of r.evaluators_disabled) lines.push(`  · ${ref}`);
  }
  lines.push('');
  lines.push('Next: run `orcaops eval list` to see the active set, or');
  lines.push('     `orcaops eval enable <ref>` to flip a disabled evaluator on.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Interactive y/N trust prompt on stderr. Returns true iff the user
 * answers `y` / `yes` (case-insensitive). Anything else — including
 * empty input (Enter) or EOF — returns false. Bypassed when --yes is
 * passed; reachable only when --json is NOT set (the runAddPack
 * caller rejects JSON-without-yes upstream).
 */
async function promptForTrust(
  warningMessage: string,
  refCount: number,
  capabilities: readonly string[]
): Promise<boolean> {
  // Name every capability class the grant will carry — a mixed pack that
  // showed only the command wording understated what consent authorized.
  writeTerminalSafeStderr(
    `\n${warningMessage}\n` +
      `Pack contains ${refCount} evaluator(s) requiring: ${capabilities.join(', ')}. ` +
      `Evaluator packs are trusted executable code whose processes run with your permissions; ` +
      `Orcaops does not sandbox them. The grant fingerprints declared pack files only, not ` +
      `interpreters, imported dependencies, later command arguments resolved from the ` +
      `repository working directory, undeclared data, or other runtime state. Allow? [y/N] `
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('line', (line) => resolve(line));
      rl.once('close', () => resolve(''));
    });
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}
