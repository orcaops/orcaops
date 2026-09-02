import { createInterface } from 'node:readline';

import {
  computePackSourceFingerprint,
  isTrustCapability,
  requiredTrustCapabilitiesForEngines,
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
  discoverEvaluatorsForCli,
  untrustworthyCapabilities,
} from '../../lib/evaluator-discovery.js';
import {
  readTrustManifest,
  revokeGrant,
  trustManifestCovers,
  writeGrant,
} from '../../lib/evaluator-grants.js';
import { CLI_ROOT, readEvaluatorsConfig } from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface EvalTrustOptions {
  /** Config-side pack id (`packages[].id`). */
  packId: string;
  /**
   * Grant against the resolved pack PATH instead of its declared pack-file
   * fingerprint — for workspace development where the covered bytes churn
   * constantly. Explicit and user-local; never inherited by a clone at
   * another path.
   */
  dev?: boolean;
  /** Remove the user-local grant instead of adding one. */
  revoke?: boolean;
  /** Accept without the interactive prompt (still an explicit human act). */
  yes?: boolean;
  json?: boolean;
}

/**
 * `orcaops eval trust <pack>` — inspect and grant (or revoke) the user-local
 * consent for a pack's capability-requiring evaluators. The repo yaml only
 * declares packs; THIS command is what authorizes them (see
 * docs/evaluator-consent.md).
 */
export async function evalTrustAction(opts: EvalTrustOptions): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      if (opts.revoke) {
        const removed = await revokeGrant(opts.packId, { repoRoot: ctx.repoRoot });
        const out = { ok: true as const, pack: opts.packId, revoked: removed };
        if (opts.json) {
          emitOk(out);
          return;
        }
        writeTerminalSafeStdout(
          removed
            ? `Revoked the user-local grant for "${opts.packId}".\n`
            : `No user-local grant existed for "${opts.packId}".\n`
        );
        return;
      }

      const config = await readEvaluatorsConfig(ctx.repoRoot);
      const entry = config?.packages.find((p) => p.id === opts.packId);
      if (entry === undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No pack "${opts.packId}" is registered in .orcaops/evaluators.yaml — ` +
            `run \`orcaops eval add-pack\` first.`,
          'pack'
        );
      }

      if (opts.dev && entry.source.kind !== 'path') {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--dev is for mutable path-source (workspace) packs; "${opts.packId}" resolves from ` +
            `a ${entry.source.kind} source, which stays fingerprint-bound.`,
          'dev'
        );
      }
      const resolved = resolvePackSource(entry.source, {
        repoRoot: ctx.repoRoot,
        cliRoot: CLI_ROOT,
      });
      // Classify with the effective provider the dispatch gate will see;
      // otherwise an implicit-codex evaluator's file-reading capability is
      // never offered for consent and the pack is ungrantable.
      const defaultLlmProvider = await resolveDefaultProvider(ctx.config.llm, getInvocationEnv());
      const validation = await validatePack(resolved, { defaultLlmProvider });
      if (!validation.ok) {
        throw new OrcaopsError(
          ErrorCodes.PACK_VALIDATION,
          `Pack failed validation; refusing to grant trust to a broken pack.`
        );
      }
      const discovered = await discoverEvaluatorsForCli(ctx.repoRoot);
      // Scoped to this pack: another pack's breakage cannot narrow THIS
      // pack's capability set, and refusing over it would block a grant the
      // user can do nothing about from here.
      const untrustworthy = untrustworthyCapabilities(opts.packId, discovered.errors);
      if (untrustworthy !== null) throw untrustworthy;
      const effectiveCapabilities = requiredTrustCapabilitiesForEngines(
        discovered.evaluators
          .filter((evaluator) => evaluator.enabled && evaluator.package_id === opts.packId)
          .map((evaluator) => evaluator.engine),
        defaultLlmProvider
      );
      const capabilities = [
        ...new Set([
          ...validation.warnings.map((w) => w.code).filter(isTrustCapability),
          ...effectiveCapabilities,
        ]),
      ];
      const { fingerprint } = await computePackSourceFingerprint(resolved);

      if (capabilities.length === 0) {
        const out = {
          ok: true as const,
          pack: opts.packId,
          granted: false,
          reason: 'no capability-requiring evaluators; no grant needed',
        };
        if (opts.json) {
          emitOk(out);
          return;
        }
        writeTerminalSafeStdout(
          `Pack "${opts.packId}" ships no command or LLM evaluators — nothing to grant.\n`
        );
        return;
      }

      const manifest = readTrustManifest(CLI_ROOT);
      if (trustManifestCovers(manifest, entry.source, fingerprint, capabilities)) {
        const out = {
          ok: true as const,
          pack: opts.packId,
          granted: false,
          reason: 'covered by the installation trust manifest',
        };
        if (opts.json) {
          emitOk(out);
          return;
        }
        writeTerminalSafeStdout(
          `Pack "${opts.packId}" matches this installation's built-in trust manifest — no grant needed.\n`
        );
        return;
      }

      if (!opts.yes) {
        if (opts.json) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            'Trust must be granted explicitly; re-run with --yes under --json.',
            'yes'
          );
        }
        const accepted = await promptForGrant(opts.packId, capabilities, resolved.pack_root);
        if (!accepted) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Aborted: trust not granted.', 'yes');
        }
      }

      const granted_at = new Date().toISOString();
      if (opts.dev) {
        await writeGrant(
          {
            kind: 'workspace-dev',
            package_id: opts.packId,
            resolved_path: resolved.pack_root,
            capabilities,
            granted_at,
          },
          { repoRoot: ctx.repoRoot }
        );
      } else {
        await writeGrant(
          {
            kind: 'fingerprint',
            package_id: opts.packId,
            source_fingerprint: fingerprint,
            capabilities,
            granted_at,
          },
          { repoRoot: ctx.repoRoot }
        );
      }

      const out = {
        ok: true as const,
        pack: opts.packId,
        granted: true,
        kind: opts.dev ? ('workspace-dev' as const) : ('fingerprint' as const),
        capabilities,
        ...(opts.dev ? { resolved_path: resolved.pack_root } : { source_fingerprint: fingerprint }),
      };
      if (opts.json) {
        emitOk(out);
        return;
      }
      writeTerminalSafeStdout(
        `Granted ${opts.dev ? 'a workspace-dev' : 'a fingerprint-bound'} trust grant for ` +
          `"${opts.packId}" (${capabilities.join(', ')}).\n` +
          (opts.dev
            ? `Bound to path: ${resolved.pack_root}\n`
            : `Bound to declared pack-file fingerprint: ${fingerprint}\n` +
              `A covered pack-file change invalidates it.\n`)
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    if (err instanceof OrcaopsError) {
      writeErrorLine(err);
      throw new CliExit(1);
    }
    throw err;
  }
}

async function promptForGrant(
  packId: string,
  capabilities: readonly string[],
  packRoot: string
): Promise<boolean> {
  writeTerminalSafeStderr(
    `Pack "${packId}" (${packRoot}) requires: ${capabilities.join(', ')}.\n` +
      `Evaluator packs are trusted executable code. Their processes run with your permissions; ` +
      `Orcaops does not sandbox them.\n` +
      `This grant fingerprints declared pack files only, not interpreters, imported ` +
      `dependencies, later command arguments resolved from the repository working directory, ` +
      `undeclared data, or other runtime state.\n` +
      `Inspect the pack before granting.\n`
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      writeTerminalSafeStderr('Grant trust? [y/N] ');
      rl.once('line', resolve);
      rl.once('close', () => resolve(''));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
