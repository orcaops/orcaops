import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { canonicalizeBaseUrl } from './canonical-base-url.js';
import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { sha256Hex } from '../crypto.js';
import { fsyncDir, mkdirDurable, writeDurable } from '../fs/durable.js';
import { assertResolvedWithin } from '../paths/containment.js';

/**
 * Local pull-cache for cloud source plans (`orcaops plan pull`).
 *
 * Lives in `@orcaops/storage` — NOT the CLI app — because three callers
 * across the package boundary touch it: the CLI resolver reads it offline
 * at `capture plan`, the CLI `plan pull` writes it, and `@orcaops/core`'s
 * push reads it for Branch-B `derived_from`. Core cannot import the CLI app.
 *
 * On-disk layout (under `<repoRoot>/.orcaops/cache/source-plan`, gitignored):
 *
 *   pull/                                    ← all pull records live here
 *     <sha256(canon(base_url)|org_id)>/      ← org-scoped namespace
 *       by-id/<sha256(externalId)>@<n>.json  ← the full pull record
 *       by-path/<sha256(realpath)>.json      ← lineage pointer (only when --out)
 *   uploads/...                              ← `plan upload`'s index (upload.ts)
 *
 * Cloud uniqueness is `(org, externalId)`, so EVERY key is org-scoped by a
 * `sha256(canonicalizeBaseUrl(base_url)|org_id)` namespace — canonicalized so a
 * trailing-slash / scheme-case injected-origin variants don't fork the namespace
 * (write/read/scan/`findByPath` all agree). The offline resolver scans
 * namespaces (it has no session → no known org); the push's `findByPath` is
 * namespace-scoped (it knows the org from `cli.ping`). Records sit under a
 * `pull/` subtree disjoint from the sibling `uploads/` index so the scan never
 * mistakes an upload namespace for a pull namespace.
 */

export const PULL_CACHE_SCHEMA_VERSION = 1;

export const PullCacheRecordSchema = z.object({
  schema_version: z.literal(PULL_CACHE_SCHEMA_VERSION),
  /** The cloud `externalId` (unique per org). */
  external_id: z.string().min(1),
  slug: z.string().min(1),
  /** The approved version pulled. */
  version_number: z.number().int().positive(),
  title: z.string().min(1),
  /** Full plan body — never truncated (the conformance anchor). */
  body: z.string().min(1),
  /** sha256 hex of `body` (re-verified on write). */
  content_hash: z.string().min(1),
  /**
   * The cloud's stored provenance ref for the approved version (e.g. the
   * original uploader path), preserved verbatim. `string | null` — this is
   * the cloud `approvedVersion.sourceRef`, distinct from the pin's
   * `SourceRef` object the resolver builds.
   */
  source_ref: z.string().nullable(),
  /** Resolved cloud base URL the pin was pulled from. */
  base_url: z.string().min(1),
  /** Authoritative org id (from `cli.ping`) the pin was pulled under. */
  org_id: z.string().min(1),
  pulled_at: z.string().min(1),
});
export type PullCacheRecord = z.infer<typeof PullCacheRecordSchema>;

const PathPointerSchema = z.object({
  external_id: z.string().min(1),
  version_number: z.number().int().positive(),
});
export type PullCachePathHit = z.infer<typeof PathPointerSchema>;

export interface PullCacheMatch {
  record: PullCacheRecord;
  /** The namespace hash the record was found under (diagnostics / ambiguity). */
  namespace: string;
}

export function pullCacheTemporaryPath(recordPath: string): string {
  return `${recordPath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
}

/**
 * The canonical on-disk root for all pull-cache state:
 * `<repoRoot>/.orcaops/cache/source-plan`.
 *
 * `repoRoot` must already exist. The returned path is realpath-canonicalized,
 * and an existing symlink component is refused.
 */
export function sourcePlanCacheDir(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'cache', 'source-plan'),
    repoRoot,
    'source-plan cache directory',
    { rejectSymlinks: true }
  );
}

/** All pull records nest under this subtree, disjoint from `uploads/`. */
const PULL_SUBTREE = 'pull';

function namespaceHash(baseUrl: string, orgId: string): string {
  // canonicalize base_url so a trailing-slash / scheme-case override keys the
  // SAME namespace on write, read, scan, and findByPath (else lineage forks).
  return sha256Hex(`${canonicalizeBaseUrl(baseUrl)}|${orgId}`);
}

/** `<cacheDir>/pull/<namespaceHash>` — the org-scoped namespace dir. */
function pullNamespaceDir(cacheDir: string, baseUrl: string, orgId: string): string {
  return path.join(cacheDir, PULL_SUBTREE, namespaceHash(baseUrl, orgId));
}

function recordFileName(externalId: string, version: number): string {
  return `${sha256Hex(externalId)}@${version}.json`;
}

function recordPath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  externalId: string,
  version: number
): string {
  return path.join(
    pullNamespaceDir(cacheDir, baseUrl, orgId),
    'by-id',
    recordFileName(externalId, version)
  );
}

function pathPointerPath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  realPath: string
): string {
  return path.join(
    pullNamespaceDir(cacheDir, baseUrl, orgId),
    'by-path',
    `${sha256Hex(realPath)}.json`
  );
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

function resolveCachePath(
  target: string,
  containmentRoot: string | undefined,
  label: string
): string {
  return containmentRoot === undefined
    ? target
    : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
}

async function safeReaddir(dir: string, containmentRoot?: string): Promise<string[]> {
  const resolved = resolveCachePath(dir, containmentRoot, 'source-plan cache directory');
  try {
    return await readdir(resolved);
  } catch {
    return [];
  }
}

async function readRecord(file: string, containmentRoot?: string): Promise<PullCacheRecord | null> {
  const resolved = resolveCachePath(file, containmentRoot, 'source-plan cache record');
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = PullCacheRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the **by-id** pull-cache record — the resolve-critical
 * artifact. Verifies `sha256(body) === content_hash` before persisting so a
 * corrupted/truncated pull never lands.
 *
 * This writes ONLY the by-id record. The by-path lineage pointer is a separate
 * call (`writePullCachePathPointer`) made AFTER the `--out` file exists, so the
 * durable record always lands first: a `plan pull --out` whose file write fails
 * (or whose file is later moved) still leaves a usable `cloud:<id>@<n>` pin,
 * losing only the best-effort `derived_from` breadcrumb. The record itself
 * deliberately carries no "materialized to <path>" field — that would be a claim
 * the record cannot honor before the `--out` write succeeds; the by-path pointer
 * is the only materialization record, and it is written only once the file exists.
 */
export async function writePullCacheRecord(
  cacheDir: string,
  record: PullCacheRecord,
  containmentRoot?: string
): Promise<{ recordPath: string }> {
  const parsed = PullCacheRecordSchema.parse(record);
  const actual = sha256Hex(parsed.body);
  if (actual !== parsed.content_hash) {
    throw new Error(
      `pull-cache integrity: sha256(body)=${actual} != content_hash=${parsed.content_hash} ` +
        `for ${parsed.external_id}@${parsed.version_number}`
    );
  }
  let rPath = resolveCachePath(
    recordPath(cacheDir, parsed.base_url, parsed.org_id, parsed.external_id, parsed.version_number),
    containmentRoot,
    'source-plan cache record'
  );
  // Durable rather than merely atomic: this record is the only offline source
  // for a later `cloud:<id>@<version>` pin, and nothing can rebuild it — the
  // pull happens BEFORE any capture event exists, so there is no log to
  // replay. A successful `plan pull` that vanished on power loss would strand
  // the pin it just advertised. The record's BYTES are fsynced; its directory
  // entry is best-effort (see fsyncDir), so on a filesystem that refuses
  // directory sync a crash can still lose a freshly created record.
  await mkdirDurable(path.dirname(rPath), 0o700, undefined, containmentRoot);
  let tmp = resolveCachePath(
    pullCacheTemporaryPath(rPath),
    containmentRoot,
    'source-plan cache temporary file'
  );
  await writeDurable(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 0o600, containmentRoot);
  tmp = resolveCachePath(tmp, containmentRoot, 'source-plan cache temporary file');
  rPath = resolveCachePath(rPath, containmentRoot, 'source-plan cache record');
  await rename(tmp, rPath);
  await fsyncDir(path.dirname(rPath), containmentRoot);
  return { recordPath: rPath };
}

export interface WritePullCachePathPointerArgs {
  baseUrl: string;
  orgId: string;
  /** The `--out` file path; realpath'd here so a symlink keys identically to `findByPath`. */
  realPath: string;
  externalId: string;
  versionNumber: number;
}

/**
 * Write the by-path lineage pointer keyed by the `--out` file's realpath, so the
 * push's `findByPath` can trace a local `--source-plan` back to this pull. Call
 * this AFTER the `--out` file exists (the writer split — see
 * `writePullCacheRecord`). If the file vanished between the `--out` write and
 * here, the pointer is skipped and `null` is returned (`derived_from` degrades
 * to null — a lost breadcrumb, never a wrong id, never a broken pin).
 */
export async function writePullCachePathPointer(
  cacheDir: string,
  args: WritePullCachePathPointerArgs,
  containmentRoot?: string
): Promise<{ pathPointerPath: string } | null> {
  const real = await safeRealpath(args.realPath);
  if (!real) return null;
  const pPath = pathPointerPath(cacheDir, args.baseUrl, args.orgId, real);
  const pointer: PullCachePathHit = {
    external_id: args.externalId,
    version_number: args.versionNumber,
  };
  await atomicWriteFile(pPath, `${JSON.stringify(pointer, null, 2)}\n`, containmentRoot);
  return { pathPointerPath: pPath };
}

/** Namespace-scoped direct read (the org is known). Null if absent/corrupt. */
export async function readPullCacheRecord(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  externalId: string,
  version: number,
  containmentRoot?: string
): Promise<PullCacheRecord | null> {
  return readRecord(recordPath(cacheDir, baseUrl, orgId, externalId, version), containmentRoot);
}

/**
 * Scan EVERY org-namespace under the `pull/` subtree for records matching
 * `(externalId, version)`. The resolver is offline at `capture plan` (no
 * session → no known org), so it surfaces all matches and the caller decides
 * exactly-one / ambiguous / miss. Reads only the one deterministically-named
 * candidate per namespace. Scoped to `pull/` so the sibling `uploads/` index
 * (a different keying scheme) is never mistaken for a pull namespace.
 */
export async function scanByExternalIdVersion(
  cacheDir: string,
  externalId: string,
  version: number,
  containmentRoot?: string
): Promise<PullCacheMatch[]> {
  const target = recordFileName(externalId, version);
  const pullDir = path.join(cacheDir, PULL_SUBTREE);
  const matches: PullCacheMatch[] = [];
  for (const ns of await safeReaddir(pullDir, containmentRoot)) {
    const rec = await readRecord(path.join(pullDir, ns, 'by-id', target), containmentRoot);
    if (rec && rec.external_id === externalId && rec.version_number === version) {
      matches.push({ record: rec, namespace: ns });
    }
  }
  return matches;
}

/**
 * Trace a local file back to a prior `plan pull --out`, scoped to the push
 * org namespace (Branch-B `derived_from`). `realpath` is wrapped so a
 * moved/deleted file degrades to null — the frozen pin stays valid and the
 * push continues without a lineage breadcrumb.
 */
export async function findByPath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  filePath: string,
  containmentRoot?: string
): Promise<PullCachePathHit | null> {
  const real = await safeRealpath(filePath);
  if (!real) return null;
  let raw: string;
  const pointer = resolveCachePath(
    pathPointerPath(cacheDir, baseUrl, orgId, real),
    containmentRoot,
    'source-plan cache path pointer'
  );
  try {
    raw = await readFile(pointer, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = PathPointerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
