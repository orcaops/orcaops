import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { defaultConfigDir } from '@orcaops/core';
import type { PackSource } from '@orcaops/evaluator-protocol';
import {
  computePackSourceFingerprint,
  type PackTrustDecision,
  resolvePackSource,
  type TrustCapability,
} from '@orcaops/evaluator-runner';

import {
  readGrantFile,
  requireGrantStoreDir,
  resolveGrantStoreDir,
  withGrantFileMutation,
} from './user-local-grant-store.js';

/**
 * User-local evaluator consent (see docs/evaluator-consent.md). Repository
 * config is not authorization: the repo declares and enables evaluators, but
 * the grant that lets capability-requiring evaluators execute lives HERE —
 * beside credentials.json, outside every repository, keyed to covered declared
 * pack-file content. Fingerprint and capability values identify a grant; they
 * are not proof of consent (both are public and computable by a hostile
 * repository), so nothing repo-controlled can mint an entry in this file.
 */

const TrustCapabilitySchema = z.union([
  z.literal('command_evaluators_present'),
  z.literal('llm_evaluators_present'),
  z.literal('file_reading_llm_evaluator_present'),
]);

const FingerprintGrantSchema = z
  .object({
    kind: z.literal('fingerprint'),
    package_id: z.string().min(1),
    source_fingerprint: z.string().min(1),
    capabilities: z.array(TrustCapabilitySchema),
    granted_at: z.string().min(1),
  })
  .strict();

const WorkspaceDevGrantSchema = z
  .object({
    kind: z.literal('workspace-dev'),
    package_id: z.string().min(1),
    /**
     * Absolute resolved pack root. A dev grant deliberately binds to the
     * PATH, not the (constantly churning) declared pack-file fingerprint — and
     * therefore never transfers to a clone of the same code at another
     * location.
     */
    resolved_path: z.string().min(1),
    capabilities: z.array(TrustCapabilitySchema),
    granted_at: z.string().min(1),
  })
  .strict();

export const EvaluatorGrantSchema = z.discriminatedUnion('kind', [
  FingerprintGrantSchema,
  WorkspaceDevGrantSchema,
]);
export type EvaluatorGrant = z.infer<typeof EvaluatorGrantSchema>;

export type EvaluatorGrantMutation =
  | { kind: 'write'; grant: EvaluatorGrant }
  | { kind: 'revoke'; packageId: string };

const GrantsFileSchema = z
  .object({
    v: z.literal(1),
    grants: z.array(EvaluatorGrantSchema),
  })
  .strict();
export type GrantsFile = z.infer<typeof GrantsFileSchema>;

export const GRANTS_FILE_NAME = 'evaluator-grants.json';

export function grantsFilePath(configDir: string = defaultConfigDir()): string {
  return path.join(configDir, GRANTS_FILE_NAME);
}

/**
 * Read the user-local grants file. Absent → empty. A malformed file is a
 * fail-closed empty read with a warning: consent must never be inferred from
 * unparseable state. The store must resolve outside the repository because a
 * repo-pointing ORCAOPS_CONFIG_HOME would let checked-in content mint consent.
 */
export function readGrants(opts: {
  repoRoot: string;
  configDir?: string;
  warn?: (msg: string) => void;
}): {
  grants: EvaluatorGrant[];
} {
  const resolution = resolveGrantStoreDir(opts);
  if (!resolution.ok) {
    opts.warn?.(
      resolution.reason === 'repository_root_invalid'
        ? `refusing to read evaluator grants: repository root ${JSON.stringify(opts.repoRoot)} ` +
            `must be an existing absolute directory.`
        : `refusing to read evaluator grants from ${JSON.stringify(resolution.requestedDir)}: the grant store ` +
            `must be an absolute location outside the repository (repository-controlled ` +
            `configuration cannot mint consent).`
    );
    return { grants: [] };
  }
  return readGrantsFromStore(resolution.dir, opts.warn);
}

function readGrantsFromStore(
  dir: string,
  warn?: (msg: string) => void
): { grants: EvaluatorGrant[] } {
  const file = grantsFilePath(dir);
  const read = readGrantFile(dir, file, GrantsFileSchema, 'repair');
  switch (read.status) {
    case 'ok':
      return { grants: read.contents.grants };
    case 'absent':
      return { grants: [] };
    case 'unsafe':
      warn?.(`${file} has unsafe ownership or permissions; treating as no grants (fail closed).`);
      return { grants: [] };
    case 'unparseable':
      warn?.(`${file} is unreadable; treating as no grants (fail closed).`);
      return { grants: [] };
    case 'invalid':
      warn?.(`${file} failed validation; treating as no grants (fail closed).`);
      return { grants: [] };
  }
}

/**
 * Record a grant, replacing any existing grant for the same package. The
 * file and its directory are created private (0700 dir, 0600 file).
 */
export async function writeGrant(
  grant: EvaluatorGrant,
  opts: { repoRoot: string; configDir?: string }
): Promise<void> {
  await withGrantMutation({ kind: 'write', grant }, opts, async () => undefined);
}

export async function withGrantMutation<Result>(
  mutation: EvaluatorGrantMutation,
  opts: { repoRoot: string; configDir?: string },
  commit: () => Promise<Result>
): Promise<{ result: Result; grantChanged: boolean }> {
  const dir = requireGrantStoreDir(opts, 'evaluator grants');
  const { planned, result } = await withGrantFileMutation(
    {
      dir,
      file: grantsFilePath(dir),
      lockName: 'evaluator-grants',
      rollbackFailureMessage: 'Evaluator mutation failed and the grant rollback also failed.',
    },
    () => {
      const current = readGrantsFromStore(dir).grants;
      const packageId = mutation.kind === 'write' ? mutation.grant.package_id : mutation.packageId;
      const remaining = current.filter((grant) => grant.package_id !== packageId);
      const next = mutation.kind === 'write' ? [...remaining, mutation.grant] : remaining;
      const grantChanged = mutation.kind === 'write' || remaining.length !== current.length;
      return {
        contents: grantChanged ? serializeGrants({ v: 1, grants: next }) : null,
        planned: { grantChanged },
      };
    },
    commit
  );
  return { result, grantChanged: planned.grantChanged };
}

/** Remove any grant for the package. Returns true when one existed. */
export async function revokeGrant(
  packageId: string,
  opts: { repoRoot: string; configDir?: string }
): Promise<boolean> {
  const { grantChanged } = await withGrantMutation(
    { kind: 'revoke', packageId },
    opts,
    async () => undefined
  );
  return grantChanged;
}

function serializeGrants(grants: GrantsFile): string {
  return `${JSON.stringify(grants, null, 2)}\n`;
}

/** Shipped-with-the-installation trust: exact package+pack+fingerprint. */
const TrustManifestSchema = z
  .object({
    v: z.literal(1),
    packs: z.array(
      z
        .object({
          package: z.string().min(1),
          pack: z.string().min(1),
          source_fingerprint: z.string().min(1),
          capabilities: z.array(TrustCapabilitySchema),
        })
        .strict()
    ),
  })
  .strict();
export type TrustManifest = z.infer<typeof TrustManifestSchema>;

export const TRUST_MANIFEST_RELATIVE = path.join('dist', 'trust-manifest.json');

/**
 * Load the installation's built-in trust manifest. Present only in a real
 * installed CLI (the dist build generates it AFTER pack install +
 * minification, so fingerprints bind to the final installed covered pack-file
 * bytes).
 * Workspace development has none — workspace packs need an explicit grant.
 * A malformed manifest is fail-closed absent.
 */
export function readTrustManifest(cliRoot: string): TrustManifest | null {
  const file = path.join(cliRoot, TRUST_MANIFEST_RELATIVE);
  if (!existsSync(file)) return null;
  try {
    const result = TrustManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function trustManifestCovers(
  manifest: TrustManifest | null,
  source: PackSource,
  fingerprint: string,
  capabilities: readonly TrustCapability[]
): boolean {
  const entry = findTrustManifestEntry(manifest, source, fingerprint);
  return (
    entry !== undefined &&
    capabilities.every((capability) => entry.capabilities.includes(capability))
  );
}

function findTrustManifestEntry(
  manifest: TrustManifest | null,
  source: PackSource,
  fingerprint: string
): TrustManifest['packs'][number] | undefined {
  if (manifest === null || source.kind !== 'bundled') return undefined;
  return manifest.packs.find(
    (entry) =>
      entry.package === source.package &&
      entry.pack === source.pack &&
      entry.source_fingerprint === fingerprint
  );
}

export interface PackTrustQuery {
  packageId: string;
  source: PackSource;
}

/**
 * Compute per-package trust decisions for dispatch, fail-closed (see
 * docs/evaluator-consent.md). Matching installation-manifest and user-local
 * fingerprint grants contribute their capability union; a workspace-dev grant
 * is the path-source fallback. `kind: bundled` in repo yaml grants nothing by
 * itself.
 */
export async function computePackTrustDecisions(opts: {
  packs: readonly PackTrustQuery[];
  repoRoot: string;
  cliRoot: string;
  configDir?: string;
  warn?: (msg: string) => void;
}): Promise<Map<string, PackTrustDecision>> {
  const decisions = new Map<string, PackTrustDecision>();
  const configDir = opts.configDir ?? defaultConfigDir();
  const grants = readGrants({
    repoRoot: opts.repoRoot,
    configDir,
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  }).grants;
  const manifest = readTrustManifest(opts.cliRoot);

  for (const pack of opts.packs) {
    decisions.set(pack.packageId, await decideOne(pack, opts, grants, manifest));
  }
  return decisions;
}

async function decideOne(
  pack: PackTrustQuery,
  opts: { repoRoot: string; cliRoot: string },
  grants: EvaluatorGrant[],
  manifest: TrustManifest | null
): Promise<PackTrustDecision> {
  const source = pack.source;
  let fingerprint: string;
  let resolvedRoot: string;
  try {
    const resolved = resolvePackSource(source, {
      repoRoot: opts.repoRoot,
      cliRoot: opts.cliRoot,
    });
    resolvedRoot = resolved.pack_root;
    fingerprint = (await computePackSourceFingerprint(resolved)).fingerprint;
  } catch (err) {
    return {
      verdict: 'refused',
      reason: `Pack "${pack.packageId}" could not be resolved for consent verification: ${(err as Error).message}`,
    };
  }

  const fingerprintGrant = grants.find(
    (g) =>
      g.kind === 'fingerprint' &&
      g.package_id === pack.packageId &&
      g.source_fingerprint === fingerprint
  );
  const manifestEntry = findTrustManifestEntry(manifest, source, fingerprint);
  if (manifestEntry !== undefined || fingerprintGrant !== undefined) {
    return {
      verdict: 'trusted',
      capabilities: [
        ...new Set([
          ...(manifestEntry?.capabilities ?? []),
          ...(fingerprintGrant?.capabilities ?? []),
        ]),
      ],
    };
  }

  // The dev tier applies ONLY to path sources (mutable workspace packs):
  // matching bundled/package sources by path would silently discard the
  // fingerprint revalidation that installed sources require.
  const devGrant =
    source.kind === 'path'
      ? grants.find(
          (g) =>
            g.kind === 'workspace-dev' &&
            g.package_id === pack.packageId &&
            g.resolved_path === resolvedRoot
        )
      : undefined;
  if (devGrant !== undefined) {
    return { verdict: 'trusted', capabilities: devGrant.capabilities };
  }

  const stale = grants.find((g) => g.package_id === pack.packageId);
  return {
    verdict: 'refused',
    reason:
      stale !== undefined
        ? `Pack "${pack.packageId}" has covered pack files that changed since it was granted ` +
          `(fingerprint mismatch); ` +
          `run \`orcaops eval trust ${pack.packageId}\` to re-inspect and re-grant.`
        : `Pack "${pack.packageId}" has no user-local grant; ` +
          `run \`orcaops eval trust ${pack.packageId}\` to inspect and grant.`,
  };
}

export type { PackTrustDecision, TrustCapability };
