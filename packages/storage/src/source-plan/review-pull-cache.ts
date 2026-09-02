import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { canonicalizeBaseUrl } from './canonical-base-url.js';
import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { sha256Hex } from '../crypto.js';
import { assertResolvedWithin, PathContainmentError } from '../paths/containment.js';

/**
 * Local cache for cloud source-plan REVIEW pulls (`orcaops plan review pull`).
 *
 * Sibling to `pull-cache.ts`, but the SEPARATION is the load-bearing safety
 * property — not an implementation detail. `pull-cache.ts` holds the *approved*
 * body, which `capture plan --source-plan cloud:<id>@<n>` resolves into a graded
 * conformance pin (via `scanByExternalIdVersion`). This module holds the
 * *candidate / proposal* body — under review, NOT approved — which must NEVER be
 * resolvable as a capture-pin (else `pinned == graded` breaks: a body that was
 * never approved could grade a slice). The isolation is structural, not a flag:
 * the pin resolver scans only the `pull/` subtree, and every record here lives
 * under a disjoint `review-pull/` subtree the resolver never reads. This module
 * also deliberately exports NO keyed `scanBy*` lookup — there is no offline-scan
 * entry point that could bridge a review body into the PIN RESOLVER. Review
 * verbs always have a live session/org, so a namespace-scoped direct read is all
 * they ever need. (`scanReviewPullRecordsForIntegrity` below is not that bridge:
 * it enumerates records for doctor's LOCAL re-hash check only — the resolver
 * never calls it, and it resolves nothing by key.)
 *
 * On-disk layout (under `<repoRoot>/.orcaops/cache/source-plan`, gitignored):
 *
 *   review-pull/                                ← disjoint from pull/ + uploads/
 *     <sha256(canon(base_url)|org_id)>/         ← org-scoped namespace
 *       by-id/<sha256(externalId)>.json         ← THE current candidate (no @version)
 *       by-proposal/<sha256(proposalId)>.json   ← a pulled proposal
 *
 * The candidate key drops `pull/`'s `@<n>` suffix on purpose: `plan review pull
 * <ref>` carries no version (it always fetches *the* candidate), so `propose` /
 * `push` resolve the cached record by externalId alone. A versioned filename
 * would force a directory scan (the exact machinery this module refuses to
 * export) and accumulate stale versions. There is only ever one current
 * candidate per plan locally; each pull — and each `push`-published update —
 * OVERWRITES it, latest-wins. `version_number` lives inside the record for
 * display; `version_id` is the opaque CAS token echoed back to push/propose.
 */

export const REVIEW_PULL_CACHE_SCHEMA_VERSION = 1;

export const ReviewPullRecordSchema = z
  .object({
    schema_version: z.literal(REVIEW_PULL_CACHE_SCHEMA_VERSION),
    /** Which review body this holds — selects the on-disk keyspace + identity. */
    target: z.enum(['candidate', 'proposal']),
    /** The cloud `externalId` (unique per org). */
    external_id: z.string().min(1),
    /**
     * The opaque candidate-version id, echoed verbatim to push/propose as the
     * CAS base. Non-null for a candidate — it IS the CAS token. Null for a
     * proposal: `reviewPropose`'s response carries no version id to persist (a
     * follow-up `comment` targets `proposal_id` instead).
     */
    version_id: z.string().min(1).nullable(),
    /** The candidate version number (display only). Null for a proposal. */
    version_number: z.number().int().positive().nullable(),
    /** The proposal id — null unless `target==='proposal'`. */
    proposal_id: z.string().min(1).nullable(),
    /** The candidate version a proposal was based on (display). Nullable. */
    base_version_number: z.number().int().positive().nullable(),
    /** sha256 hex of `body` (re-verified on write). */
    content_hash: z.string().min(1),
    /** Full review body — never truncated. */
    body: z.string().min(1),
    /** Resolved cloud base URL the record was pulled from. */
    base_url: z.string().min(1),
    /** Authoritative org id (from `cli.ping`) the record was pulled under. */
    org_id: z.string().min(1),
    pulled_at: z.string().min(1),
  })
  .superRefine((rec, ctx) => {
    // Discriminate BOTH ways so neither arm can carry the other's shape.
    if (rec.target === 'candidate') {
      // A candidate IS its CAS token: version_id + version_number must be set,
      // and it must not masquerade as a proposal.
      if (rec.version_id === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_id'],
          message: "target 'candidate' requires a non-null version_id",
        });
      }
      if (rec.version_number === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_number'],
          message: "target 'candidate' requires a non-null version_number",
        });
      }
      if (rec.proposal_id !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposal_id'],
          message: "target 'candidate' must not carry a proposal_id",
        });
      }
    } else {
      // target 'proposal': proposal_id is the required identity, and the
      // candidate version fields MUST be null. reviewPropose's response carries
      // neither (the candidate-side asymmetry is what keeps persist-after-propose
      // implementable), and a stray version_id here would be a CAS-token trap for
      // a future reader. `base_version_number` is intentionally NOT constrained —
      // a proposal legitimately records the candidate version it was based on.
      if (rec.proposal_id === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposal_id'],
          message: "target 'proposal' requires a non-null proposal_id",
        });
      }
      if (rec.version_id !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_id'],
          message: "target 'proposal' must not carry a version_id",
        });
      }
      if (rec.version_number !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_number'],
          message: "target 'proposal' must not carry a version_number",
        });
      }
    }
  });
export type ReviewPullRecord = z.infer<typeof ReviewPullRecordSchema>;

/** All review-pull records nest here, disjoint from `pull/` and `uploads/`. */
const REVIEW_PULL_SUBTREE = 'review-pull';

function namespaceHash(baseUrl: string, orgId: string): string {
  // Same canonicalize-then-hash rule as the pull-cache namespace, so a
  // trailing-slash / scheme-case injected-origin variant keys the SAME namespace on
  // write and read (else a re-pull under a host-case variant forks the cache).
  return sha256Hex(`${canonicalizeBaseUrl(baseUrl)}|${orgId}`);
}

function reviewNamespaceDir(cacheDir: string, baseUrl: string, orgId: string): string {
  return path.join(cacheDir, REVIEW_PULL_SUBTREE, namespaceHash(baseUrl, orgId));
}

function candidatePath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  externalId: string
): string {
  // No `@<version>` suffix — there is exactly one current candidate per plan.
  return path.join(
    reviewNamespaceDir(cacheDir, baseUrl, orgId),
    'by-id',
    `${sha256Hex(externalId)}.json`
  );
}

function proposalPath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  proposalId: string
): string {
  return path.join(
    reviewNamespaceDir(cacheDir, baseUrl, orgId),
    'by-proposal',
    `${sha256Hex(proposalId)}.json`
  );
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

async function readRecord(
  file: string,
  containmentRoot?: string
): Promise<ReviewPullRecord | null> {
  const resolved = resolveCachePath(file, containmentRoot, 'plan-review cache record');
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = ReviewPullRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) a review-pull record. Verifies `sha256(body) ===
 * content_hash` before persisting (copying the pull-cache guard) so a
 * corrupted/truncated review body never lands. Single-phase write — the review
 * track has no `--out` lineage pointer (the record is the CAS token for push,
 * not a pinnable anchor). A candidate writes to the version-less `by-id` key
 * (overwriting the prior candidate for the same externalId, latest-wins); a
 * proposal writes to its own `by-proposal/<proposalId>` key.
 */
export async function writeReviewPullRecord(
  cacheDir: string,
  record: ReviewPullRecord,
  containmentRoot?: string
): Promise<{ recordPath: string }> {
  const parsed = ReviewPullRecordSchema.parse(record);
  const actual = sha256Hex(parsed.body);
  if (actual !== parsed.content_hash) {
    throw new Error(
      `review-pull-cache integrity: sha256(body)=${actual} != content_hash=${parsed.content_hash} ` +
        `for ${parsed.external_id} (${parsed.target})`
    );
  }
  let file: string;
  if (parsed.target === 'candidate') {
    file = candidatePath(cacheDir, parsed.base_url, parsed.org_id, parsed.external_id);
  } else if (parsed.proposal_id !== null) {
    file = proposalPath(cacheDir, parsed.base_url, parsed.org_id, parsed.proposal_id);
  } else {
    // Unreachable: the superRefine above guarantees a non-null proposal_id for
    // a proposal. Guard anyway so a future schema edit can't silently mis-key.
    throw new Error('review-pull-cache: proposal record missing proposal_id (schema invariant)');
  }
  await atomicWriteFile(file, `${JSON.stringify(parsed, null, 2)}\n`, containmentRoot);
  return { recordPath: file };
}

/**
 * Read THE current candidate for `externalId` (version-less direct read — the
 * org is known from the live session). Returns null if absent, corrupt, or — as
 * a keyspace cross-check — if a non-candidate record somehow occupies the slot.
 * Filesystem failures other than absence are surfaced to the caller.
 */
export async function readReviewCandidate(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  externalId: string,
  containmentRoot?: string
): Promise<ReviewPullRecord | null> {
  const rec = await readRecord(
    candidatePath(cacheDir, baseUrl, orgId, externalId),
    containmentRoot
  );
  if (rec && rec.target === 'candidate' && rec.external_id === externalId) return rec;
  return null;
}

export interface ReviewPullIntegrityScan {
  /** Every parseable record across all namespaces + keyspaces, with its path. */
  records: { record: ReviewPullRecord; recordPath: string }[];
  /** Files that exist but fail JSON/schema parse — surfaced, never thrown on. */
  corrupt: number;
}

/**
 * Enumerate every review-pull record for doctor's local `review-cache-integrity`
 * re-hash (`sha256(body) === content_hash`). Lives here because storage owns the
 * on-disk layout. NOT a pin-resolver entry point: it walks `review-pull/` only
 * (the resolver reads `pull/`), takes no lookup key, and is called by doctor
 * alone. A missing subtree is an empty scan, not an error. A non-empty
 * containment root is required so untyped callers cannot disable containment
 * or silently rebase it on the process working directory.
 */
export async function scanReviewPullRecordsForIntegrity(
  cacheDir: string,
  containmentRoot: string
): Promise<ReviewPullIntegrityScan> {
  if (typeof containmentRoot !== 'string' || containmentRoot.length === 0) {
    throw new PathContainmentError(
      'plan-review cache integrity scan requires a containment root.',
      'plan-review cache root'
    );
  }
  const root = resolveCachePath(
    path.join(cacheDir, REVIEW_PULL_SUBTREE),
    containmentRoot,
    'plan-review cache directory'
  );
  let namespaceEntries: Dirent[];
  try {
    namespaceEntries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corrupt: 0 };
    }
    throw err;
  }
  const records: ReviewPullIntegrityScan['records'] = [];
  let corrupt = 0;
  for (const entry of namespaceEntries) {
    const namespace = resolveCachePath(
      path.join(root, entry.name),
      containmentRoot,
      'plan-review cache namespace'
    );
    if (!entry.isDirectory()) continue;
    for (const keyspace of ['by-id', 'by-proposal']) {
      const dir = resolveCachePath(
        path.join(namespace, keyspace),
        containmentRoot,
        'plan-review cache keyspace'
      );
      let files: string[];
      try {
        files = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const name of files.filter((f) => f.endsWith('.json'))) {
        const recordPath = resolveCachePath(
          path.join(dir, name),
          containmentRoot,
          'plan-review cache record'
        );
        const record = await readRecord(recordPath, containmentRoot);
        if (record === null) {
          corrupt += 1;
          continue;
        }
        records.push({ record, recordPath });
      }
    }
  }
  return { records, corrupt };
}

/**
 * Read a cached proposal by `proposalId` (namespace-scoped direct read). Null if
 * absent/corrupt or the record isn't the proposal it was keyed under.
 * Filesystem failures other than absence are surfaced to the caller.
 */
export async function readReviewProposal(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  proposalId: string,
  containmentRoot?: string
): Promise<ReviewPullRecord | null> {
  const rec = await readRecord(proposalPath(cacheDir, baseUrl, orgId, proposalId), containmentRoot);
  if (rec && rec.target === 'proposal' && rec.proposal_id === proposalId) return rec;
  return null;
}
