import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  assertCloudSupports,
  createCloudClient,
  type OssSourcePlanBaseline,
  resolveCloudTarget,
  resolveCredentialStore,
  resolveReviewBaseline,
} from '@orcaops/core';
import {
  OssSourcePlanUploadPayload,
  type SourcePlanReviewerDiscoveryResponse,
  type SourcePlanUploadResponse,
} from '@orcaops/sdk';
import {
  assertResolvedWithin,
  canonicalizeBaseUrl,
  canonicalJson,
  firstForbiddenControlChar,
  sha256Hex,
  sourcePlanCacheDir,
} from '@orcaops/storage';

import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import { atomicWriteFile } from '../../lib/atomic-write.js';
import { CLI_VERSION } from '../../lib/cli-version.js';
import {
  assertNoSecretsOutbound,
  type AuthoredField,
  type WithSecretWarnings,
  withSecretWarnings,
  writeSecretWarnings,
} from '../../lib/cloud-secret-gate.js';
import { buildContext } from '../../lib/context.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';
import { reviewUsageStamp, stampPlanReviewUsage } from '../../lib/usage-stamp.js';

export interface PlanUploadOptions {
  title?: string;
  reviewer?: string[];
  reviewNote?: string;
  baseUrl?: string;
  json?: boolean;
}

/**
 * The cloud methods `runPlanUpload` needs — fakeable in tests. `listReviewers`
 * backs the best-effort did-you-mean assist on unresolved reviewer tags and is
 * never load-bearing for the upload itself.
 */
export interface UploadClient {
  sourcePlan: {
    create(input: OssSourcePlanUploadPayload): Promise<SourcePlanUploadResponse>;
    listReviewers(input: {
      schema_version: 1;
      repo_url: string | null;
    }): Promise<SourcePlanReviewerDiscoveryResponse>;
  };
}

export interface ReviewerSuggestion {
  tag: string;
  matches: Array<{ handle: string; name: string }>;
}

export interface PlanUploadResult {
  external_id: string;
  slug: string;
  status: string;
  unresolved: string[];
  /** Best-effort did-you-mean matches for unresolved tags (absent on any discovery failure). */
  reviewer_suggestions?: ReviewerSuggestion[];
  /** Set when the file changed since the last upload (prior draft is immutable). */
  prior_external_id?: string;
}

const UploadsIndexEntrySchema = z.object({
  fingerprint: z.string().min(1),
  external_id: z.string().min(1),
  unresolved: z.array(z.string()).default([]),
});
type UploadsIndexEntry = z.infer<typeof UploadsIndexEntrySchema>;

export interface UploadFingerprintInput {
  body: string;
  title: string;
  reviewers: string[];
  review_note: string | null;
  source_ref: string | null;
  derived_from: unknown;
}

/**
 * Content fingerprint — excludes authored_at / external_id (crash-safe). Uses
 * storage's `canonicalJson` (the same JCS rule used for event checksums and
 * idempotency equality) rather than a private copy: the input is all
 * strings/null/arrays, so the output is byte-identical to the old local
 * `canonicalize`, and reusing the one canonicalizer removes the latent
 * JCS-divergence trap on a crash-safe id.
 *
 * The authoring `baseline` is deliberately NOT part of the fingerprint: a
 * branch switch or a new commit must not mint a new draft id for unchanged
 * content — the baseline is advisory render context, not content identity.
 */
export function computeUploadFingerprint(input: UploadFingerprintInput): string {
  return sha256Hex(canonicalJson(input));
}

/**
 * Crash-safe deterministic upload id. `realpath` is in the preimage so two
 * *distinct files* with byte-identical content don't collapse into one cloud
 * draft (replay is per `(org, external_id)`); the same file+content → same id
 * (a re-run replays); an edited file → new fingerprint → new id → new draft
 * (= "prior draft immutable" for free).
 */
export function computeUploadExternalId(fileRealpath: string, fingerprint: string): string {
  return sha256Hex(`source-plan-upload:${sha256Hex(fileRealpath)}:${fingerprint}`);
}

/**
 * Org-scoped prior-draft index path (serves the immutability *message* only).
 * Keys on `canonicalizeBaseUrl(baseUrl)` — NOT the raw resolved baseUrl — so a
 * host-case / default-port / trailing-slash variant resolves the same prior
 * draft (the resolver's `assertSafeCloudUrl` only trims trailing slashes and
 * preserves case, so it cannot be relied on for namespace identity). Mirrors the
 * pull-cache `namespaceHash`, keeping every cache namespace canonicalized the
 * same way.
 */
export function uploadsIndexPath(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  fileRealpath: string
): string {
  return path.join(
    cacheDir,
    'uploads',
    `${sha256Hex(`${canonicalizeBaseUrl(baseUrl)}|${orgId}|${fileRealpath}`)}.json`
  );
}

async function readUploadsIndex(
  file: string,
  containmentRoot?: string
): Promise<UploadsIndexEntry | null> {
  const resolved =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'source-plan upload cache index', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = UploadsIndexEntrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Repo-relative provenance when under the repo, else null (no abs-path leak). */
export function displaySafeSourceRef(absPath: string, repoRoot: string): string | null {
  const rel = path.relative(repoRoot, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return null;
}

export interface RunPlanUploadArgs {
  client: UploadClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  absPath: string;
  fileRealpath: string;
  body: string;
  title: string;
  reviewers: string[];
  reviewNote: string | null;
  /**
   * Advisory authoring baseline (resolved by the action; optional so fakes
   * skip it). Its `repo_url` also rides the did-you-mean discovery call —
   * it IS `resolveWireRepoUrl`'s output, so deriving here keeps one remote
   * resolution per upload and makes a mismatched pair unrepresentable.
   */
  baseline?: OssSourcePlanBaseline | null;
  authoredAt: string;
}

/**
 * Best-effort did-you-mean matching of unresolved reviewer tags against the
 * org roster: case-insensitive substring in either direction (a typo'd tag is
 * usually a fragment of the handle/name, or a stale full handle containing
 * one). Leading '@' is stripped — `--reviewer @alice` should still match
 * alice@example.dev. Capped at 5 matches per tag; tags with no match are
 * omitted (the plain ⚠ warning already names them).
 */
export function suggestReviewers(
  unresolved: string[],
  members: Array<{ handle: string; name: string }>
): ReviewerSuggestion[] {
  const suggestions: ReviewerSuggestion[] = [];
  for (const tag of unresolved) {
    const needle = tag.replace(/^@/, '').trim().toLowerCase();
    if (needle.length === 0) continue;
    const matches = members
      .filter((m) => {
        const handle = m.handle.toLowerCase();
        const name = m.name.toLowerCase();
        return handle.includes(needle) || name.includes(needle) || needle.includes(handle);
      })
      .slice(0, 5)
      .map((m) => ({ handle: m.handle, name: m.name }));
    if (matches.length > 0) suggestions.push({ tag, matches });
  }
  return suggestions;
}

/**
 * I/O-light core: compute the deterministic id, read the prior-draft index,
 * call `sourcePlan.create`, persist the index (with `unresolved` for replay),
 * and report whether a prior (now-immutable) draft existed. Returnable so it
 * unit-tests against a fake client + a temp repoRoot.
 */
export async function runPlanUpload(
  args: RunPlanUploadArgs
): Promise<WithSecretWarnings<PlanUploadResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-upload',
    [
      ['body', args.body],
      ['title', args.title],
      ['review_note', args.reviewNote],
      // One field per tag, so a finding names the offending reviewer rather
      // than the whole list. These are author-typed and go on the wire.
      ...args.reviewers.map((tag, at): AuthoredField => [`reviewer[${at}]`, tag]),
    ],
    await loadSecretAllowlist()
  );
  // ASSERT (never strip) the wire control-char policy BEFORE anything goes on
  // the wire: content_hash is computed from these exact bytes, so an uploaded
  // dirty body would become an approved, hash-anchored plan that `plan pull`
  // must permanently reject — a trap this CLI would have minted itself.
  const forbidden = firstForbiddenControlChar(args.body);
  if (forbidden !== null) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `the plan body contains a forbidden control character ` +
        `(U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}). ` +
        `Remove the byte from the plan file and re-run the upload — an approved plan is ` +
        `hash-anchored, so a dirty body would be permanently unpullable.`,
      'plan-upload'
    );
  }
  const sourceRef = displaySafeSourceRef(args.absPath, args.repoRoot);
  const derivedFrom = null;
  // Normalize reviewers ONCE — dedup + sort — and use this array for BOTH the
  // fingerprint (hence the crash-safe external_id) and the wire payload, so a
  // reviewer reorder/dup doesn't mint a spurious new draft. Reviewers are a set.
  const reviewers = [...new Set(args.reviewers)].sort();
  const fingerprint = computeUploadFingerprint({
    body: args.body,
    title: args.title,
    reviewers,
    review_note: args.reviewNote,
    source_ref: sourceRef,
    derived_from: derivedFrom,
  });
  const externalId = computeUploadExternalId(args.fileRealpath, fingerprint);

  const indexPath = uploadsIndexPath(
    sourcePlanCacheDir(args.repoRoot),
    args.baseUrl,
    args.orgId,
    args.fileRealpath
  );
  const prior = await readUploadsIndex(indexPath, args.repoRoot);
  const priorExternalId = prior && prior.external_id !== externalId ? prior.external_id : undefined;

  // This is the ONLY user-input parse on the upload path, so a ZodError here
  // is a bad --title / reviewer / note — map it to INVALID_INPUT with a clean,
  // flattened message (not a raw Zod blob, and NOT the generic CLOUD_ERROR the
  // shared envelope applies to everything else, which is correct for the genuine
  // cloud-failure surfaces but wrong for user input).
  let payload: OssSourcePlanUploadPayload;
  try {
    payload = OssSourcePlanUploadPayload.parse({
      schema_version: 1,
      external_id: externalId,
      title: args.title,
      body: args.body,
      content_hash: sha256Hex(args.body),
      reviewers,
      review_note: args.reviewNote,
      source_ref: sourceRef,
      derived_from: derivedFrom,
      baseline: args.baseline ?? null,
      authored_at: args.authoredAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, flattenZodIssues(err), 'plan-upload');
    }
    throw err;
  }
  const res = await args.client.sourcePlan.create(payload);

  // The crash-safe id is OURS — the cloud must honor the external_id we
  // sent. Key the index, both prior-draft comparisons, and the output off the
  // LOCAL `externalId`, never `res.externalId`. Assert the echo matches so a
  // cloud that returns a foreign id fails loudly here instead of silently
  // leaking it into the prior-draft index and the derived_from lineage.
  if (res.externalId !== externalId) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `the cloud did not honor the upload id we sent (sent ${externalId}, got ${res.externalId}).`,
      'plan-upload'
    );
  }

  // Re-surface the FIRST response's reviewer warnings on a later replay: the
  // cloud replays an already-created draft with unresolved=[], so persist the
  // original and fall back to it when this run replayed the same id.
  const unresolved =
    res.unresolved.length > 0
      ? res.unresolved
      : prior && prior.external_id === externalId
        ? prior.unresolved
        : [];

  await atomicWriteFile(
    indexPath,
    `${JSON.stringify(
      { fingerprint, external_id: externalId, unresolved } satisfies UploadsIndexEntry,
      null,
      2
    )}\n`,
    args.repoRoot
  );

  // Did-you-mean assist: ONLY when something is unresolved (no wire call on the
  // happy path), and strictly best-effort: NOTHING about a failed assist may
  // fail the upload. Runs
  // AFTER the index write so the create→index crash window carries no extra
  // wire call (a lost index is replay-safe either way, but a hung discovery
  // read must not sit inside it).
  let reviewerSuggestions: ReviewerSuggestion[] | undefined;
  if (unresolved.length > 0) {
    try {
      const discovery = await args.client.sourcePlan.listReviewers({
        schema_version: 1,
        repo_url: args.baseline?.repo_url ?? null,
      });
      const suggestions = suggestReviewers(unresolved, discovery.members);
      if (suggestions.length > 0) reviewerSuggestions = suggestions;
    } catch {
      // Swallow everything (incl. missing-procedure): the assist is advisory.
    }
  }

  return withSecretWarnings(
    {
      external_id: externalId,
      slug: res.slug,
      status: res.status,
      unresolved,
      ...(reviewerSuggestions ? { reviewer_suggestions: reviewerSuggestions } : {}),
      ...(priorExternalId ? { prior_external_id: priorExternalId } : {}),
    },
    secretWarnings
  );
}

/** One-line user message from a ZodError, using Zod's own `.flatten()` grouping. */
function flattenZodIssues(err: z.ZodError): string {
  const { formErrors, fieldErrors } = err.flatten();
  // A bare ZodError (no schema generic) types fieldErrors as `{}`; the runtime
  // value is the field→messages map, so narrow it for the join.
  const byField = fieldErrors as Record<string, string[] | undefined>;
  const fieldParts = Object.entries(byField).map(
    ([field, msgs]) => `${field}: ${(msgs ?? []).join(', ')}`
  );
  return `invalid plan upload input — ${[...formErrors, ...fieldParts].join('; ')}`;
}

/**
 * Upload a local plan file as a cloud draft for web review. `--title` is
 * required. The upload id is crash-safe and deterministic, so a re-run of
 * the same file+content replays onto the same
 * draft; an edit mints a new (immutable) draft and the prior-draft id is
 * reported.
 */
export async function planUploadAction(file: string, opts: PlanUploadOptions = {}): Promise<void> {
  try {
    if (!file || file.length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a plan file path is required.', 'plan-upload');
    }
    const title = opts.title?.trim();
    if (!title) {
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        '--title is required for plan upload.',
        'plan-upload'
      );
    }

    const absPath = path.isAbsolute(file) ? file : path.resolve(getInvocationCwd(), file);
    let body: string;
    try {
      body = await readFile(absPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        code === 'ENOENT'
          ? `plan file not found: "${file}".`
          : `could not read plan file "${file}": ${(err as Error).message}`,
        'plan-upload'
      );
    }
    if (body.trim().length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, `plan file is empty: "${file}".`, 'plan-upload');
    }
    // Validate IMMEDIATELY after reading — before credential resolution — so a
    // dirty local file gets the local code-point error, never a network failure
    // first. runPlanUpload re-asserts the same policy as defense in depth for
    // programmatic callers.
    const forbidden = firstForbiddenControlChar(body);
    if (forbidden !== null) {
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        `plan file "${file}" contains a forbidden control character ` +
          `(U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}). ` +
          `Remove the byte and re-run the upload — an approved plan is hash-anchored, so a ` +
          `dirty body would be permanently unpullable.`,
        'plan-upload'
      );
    }
    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping below, so a refusal precedes anything authored reaching
    // the network rather than only preceding the mutation. runPlanUpload
    // re-asserts the same policy for programmatic callers.
    assertNoSecretsOutbound(
      'plan-upload',
      [
        ['body', body],
        ['title', title],
        ['review_note', opts.reviewNote],
        ...(opts.reviewer ?? []).map((tag, at): AuthoredField => [`reviewer[${at}]`, tag]),
      ],
      await loadSecretAllowlist()
    );
    const fileRealpath = await realpath(absPath);

    const credentialStore = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);

    const ctx = await buildContext();
    let result: WithSecretWarnings<PlanUploadResult>;
    try {
      const { client } = await createCloudClient({
        baseUrl,
        store: credentialStore,
        cliVersion: CLI_VERSION,
      });
      const ping = await client.cli.ping();
      assertCloudSupports(ping, [], 'plan upload', { cliVersion: CLI_VERSION });
      const orgId = ping.orgId;
      result = await runPlanUpload({
        client,
        repoRoot: ctx.repoRoot,
        baseUrl,
        orgId,
        absPath,
        fileRealpath,
        body,
        title,
        reviewers: opts.reviewer ?? [],
        reviewNote: opts.reviewNote ?? null,
        baseline: await resolveReviewBaseline(ctx.repo),
        authoredAt: new Date().toISOString(),
      });
    } finally {
      ctx.store.close();
    }

    await stampPlanReviewUsage(reviewUsageStamp('upload', result.external_id));

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Uploaded "${title}" → ${result.external_id} (${result.slug}, ${result.status})\n`;
    if (result.prior_external_id) {
      out += `  note: the file changed since your last upload — prior draft ${result.prior_external_id} is immutable; a new draft was created.\n`;
    }
    if (result.unresolved.length > 0) {
      // Non-empty means those tags matched NOBODY — the plan is in review with
      // no reviewer requested for them and no one notified.
      out += `  ⚠ unresolved reviewers: ${result.unresolved.join(', ')}\n`;
      for (const s of result.reviewer_suggestions ?? []) {
        out += `    did you mean (for ${s.tag}): ${s.matches.map((m) => `${m.handle} (${m.name})`).join(', ')}\n`;
      }
      out += '    full roster: orcaops plan review reviewers\n';
    }
    out += `  pull it after approval with: orcaops plan pull ${result.external_id}\n`;
    out += '  Next: orcaops plan review status   (watch for feedback)\n';
    out += `        orcaops plan review approve ${result.external_id} --wait   (when ready for approval)\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
