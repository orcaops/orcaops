import type { Stats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { defaultConfigDir, FileStore } from '@orcaops/core';
import type { PackSource } from '@orcaops/evaluator-protocol';
import {
  computePackSourceFingerprint,
  type PackTrustDecision,
  resolvePackSource,
  type TrustCapability,
} from '@orcaops/evaluator-runner';
import { resolveCanonicalPath } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

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
  const requestedDir = opts.configDir ?? defaultConfigDir();
  const resolvedRepo = resolveRepositoryRoot(opts.repoRoot);
  if (resolvedRepo === null) {
    opts.warn?.(
      `refusing to read evaluator grants: repository root ${JSON.stringify(opts.repoRoot)} ` +
        `must be an existing absolute directory.`
    );
    return { grants: [] };
  }
  const dir = resolveGrantStoreOutsideRepository(requestedDir, resolvedRepo);
  if (dir === null) {
    opts.warn?.(
      `refusing to read evaluator grants from ${JSON.stringify(requestedDir)}: the grant store ` +
        `must be an absolute location outside the repository (repository-controlled ` +
        `configuration cannot mint consent).`
    );
    return { grants: [] };
  }
  return readGrantsFromStore(dir, opts.warn);
}

function readGrantsFromStore(
  dir: string,
  warn?: (msg: string) => void
): { grants: EvaluatorGrant[] } {
  const file = grantsFilePath(dir);
  try {
    repairGrantState(dir, file);
  } catch {
    warn?.(`${file} has unsafe ownership or permissions; treating as no grants (fail closed).`);
    return { grants: [] };
  }
  if (!existsSync(file)) return { grants: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    warn?.(`${file} is unreadable; treating as no grants (fail closed).`);
    return { grants: [] };
  }
  const result = GrantsFileSchema.safeParse(parsed);
  if (!result.success) {
    warn?.(`${file} failed validation; treating as no grants (fail closed).`);
    return { grants: [] };
  }
  return { grants: result.data.grants };
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
  const requestedDir = opts.configDir ?? defaultConfigDir();
  const resolvedRepo = assertRepositoryRoot(opts.repoRoot);
  const dir = assertGrantStoreOutsideRepository(requestedDir, resolvedRepo);
  const lock = new FileStore({ dir });
  return lock.withRefreshLock('evaluator-grants', async () => {
    const file = grantsFilePath(dir);
    ensureGrantDirPrivate(dir);
    repairGrantState(dir, file);
    const snapshot = existsSync(file) ? readFileSync(file) : null;
    const current = readGrantsFromStore(dir).grants;
    const packageId = mutation.kind === 'write' ? mutation.grant.package_id : mutation.packageId;
    const remaining = current.filter((grant) => grant.package_id !== packageId);
    const next = mutation.kind === 'write' ? [...remaining, mutation.grant] : remaining;
    const grantChanged = mutation.kind === 'write' || remaining.length !== current.length;

    try {
      if (grantChanged) writeGrantsDurable(dir, file, { v: 1, grants: next });
      return { result: await commit(), grantChanged };
    } catch (error) {
      try {
        restoreGrantSnapshot(dir, file, snapshot);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Evaluator mutation failed and the grant rollback also failed.'
        );
      }
      throw error;
    }
  });
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

function currentUid(): number | null {
  return process.platform !== 'win32' && typeof process.getuid === 'function'
    ? process.getuid()
    : null;
}

function assertOwnedByCurrentUser(observed: Stats, target: string): void {
  const uid = currentUid();
  if (uid !== null && observed.uid !== uid) {
    throw new Error(`${target} is owned by uid ${observed.uid}, not the current uid ${uid}.`);
  }
}

function ensureGrantDirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const observed = statSync(dir);
  assertOwnedByCurrentUser(observed, dir);
  if ((observed.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const repaired = statSync(dir);
  assertOwnedByCurrentUser(repaired, dir);
  if ((repaired.mode & 0o077) !== 0) {
    throw new Error(`${dir} could not be tightened to mode 700.`);
  }
}

function repairGrantState(dir: string, file: string): void {
  let directory;
  try {
    directory = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!directory.isDirectory()) throw new Error(`${dir} is not a directory.`);
  assertOwnedByCurrentUser(directory, dir);
  if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
  const repairedDirectory = statSync(dir);
  if (!repairedDirectory.isDirectory()) throw new Error(`${dir} is not a directory.`);
  assertOwnedByCurrentUser(repairedDirectory, dir);
  if (process.platform !== 'win32' && (repairedDirectory.mode & 0o077) !== 0) {
    throw new Error(`${dir} could not be tightened to mode 700.`);
  }

  let grantFile;
  try {
    grantFile = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!grantFile.isFile()) throw new Error(`${file} is not a regular file.`);
  assertOwnedByCurrentUser(grantFile, file);
  if (process.platform !== 'win32' && (grantFile.mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    const repaired = lstatSync(file);
    if (!repaired.isFile()) throw new Error(`${file} is not a regular file.`);
    assertOwnedByCurrentUser(repaired, file);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`${file} could not be tightened to mode 600.`);
    }
  }
}

function writeGrantsDurable(dir: string, file: string, grants: GrantsFile): void {
  writeGrantBytesDurable(dir, file, `${JSON.stringify(grants, null, 2)}\n`);
}

function writeGrantBytesDurable(dir: string, file: string, contents: string | Uint8Array): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    const staged = statSync(tmp);
    assertOwnedByCurrentUser(staged, tmp);
    if (process.platform !== 'win32' && (staged.mode & 0o777) !== 0o600) {
      throw new Error(`${tmp} could not be restricted to mode 600.`);
    }
    renameSync(tmp, file);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename consumed it, or creation failed before the temp existed.
    }
    throw error;
  }
  repairGrantState(dir, file);
}

function restoreGrantSnapshot(dir: string, file: string, snapshot: Buffer | null): void {
  if (snapshot !== null) {
    writeGrantBytesDurable(dir, file, snapshot);
    return;
  }
  try {
    unlinkSync(file);
    fsyncDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    closeSync(fd);
  }
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

function resolveRepositoryRoot(repoRoot: string): string | null {
  if (!path.isAbsolute(repoRoot)) return null;
  try {
    const resolvedRepo = realpathSync(repoRoot);
    return statSync(resolvedRepo).isDirectory() ? resolvedRepo : null;
  } catch {
    return null;
  }
}

function assertRepositoryRoot(repoRoot: string): string {
  const resolved = resolveRepositoryRoot(repoRoot);
  if (resolved !== null) return resolved;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `cannot validate evaluator grants: repository root ${JSON.stringify(repoRoot)} ` +
      `must be an existing absolute directory`
  );
}

function resolveGrantStoreOutsideRepository(
  configDir: string,
  resolvedRepo: string
): string | null {
  if (!path.isAbsolute(configDir)) return null;
  try {
    const resolvedDir = resolveCanonicalPath(configDir, 'grant store');
    const relative = path.relative(resolvedRepo, resolvedDir);
    const inside =
      relative === '' ||
      (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep));
    return inside ? null : resolvedDir;
  } catch {
    return null;
  }
}

function assertGrantStoreOutsideRepository(configDir: string, resolvedRepo: string): string {
  const resolved = resolveGrantStoreOutsideRepository(configDir, resolvedRepo);
  if (resolved !== null) return resolved;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `refusing to mutate evaluator grants at ${JSON.stringify(configDir)}: the grant store ` +
      `must be an absolute location outside the repository`
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
