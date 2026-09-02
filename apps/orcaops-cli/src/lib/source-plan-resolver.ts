import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  firstForbiddenControlChar,
  scanByExternalIdVersion,
  type SecretFinding,
  sha256Hex,
  sourcePlanCacheDir,
  type SourcePlanPin,
  stripControlChars,
} from '@orcaops/storage';

import { assertNoSecretsOutbound } from './cloud-secret-gate.js';
import { getInvocationCwd } from './invocation-context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * `cloud:<externalId>@<version>`. externalId is non-empty with NO whitespace;
 * version is a positive integer with NO leading zero (`[1-9]\d*`). The magnitude
 * bound (the regex can't express "fits in a JS safe integer") is enforced after
 * parsing — see `resolveCloudRef`.
 */
const CLOUD_REF = /^cloud:(?<externalId>[^@\s]+)@(?<version>[1-9]\d*)$/;

/**
 * Resolve a `--source-plan <ref>` into an immutable pin.
 *
 * Two ref kinds (the resolver is the sole indirection seam — storage and the
 * conformance evaluator only ever see `{ source_ref, content, hash }`):
 *
 *  - `cloud:<externalId>@<version>` — resolved OFFLINE against the local
 *    pull-cache (populated by `orcaops plan pull`). `capture plan` has no
 *    cloud session, so the resolver scans every org-namespace for a record
 *    matching `(externalId, version)`: exactly one → pin it; more than one →
 *    hard-error (the same id exists under multiple sessions); none → loud
 *    "run `orcaops plan pull` first".
 *  - anything else — a LOCAL filesystem path, resolved relative to the
 *    invocation cwd (run-from-anywhere), read in full (never truncated), and
 *    hashed with sha256.
 *
 * The resolved `source_ref.locator` is stored DISPLAY-SAFE — repo-relative
 * for a file under the repo — because it surfaces in the digest
 * (`builder.ts`) and evaluator context (`evaluator-bridge.ts`); an absolute
 * `/home/<name>/…` must not leak. `repoRoot` anchors both the pull-cache
 * location and the repo-relative locator; thread it from `ctx.repoRoot`.
 *
 * Fails loud (`OrcaopsError`) on a missing/unreadable/empty/ambiguous ref —
 * a bad *pinned* anchor is a user error worth surfacing. An *absent*
 * `--source-plan` flag is a silent no-op handled by the caller.
 */
export interface ResolvedSourcePlan {
  pin: SourcePlanPin;
  secretWarnings: readonly SecretFinding[];
}

export async function resolveSourcePlan(
  ref: string,
  repoRoot: string,
  allow: readonly string[]
): Promise<ResolvedSourcePlan> {
  if (ref.startsWith('cloud:')) {
    return resolveCloudRef(ref, repoRoot, allow);
  }
  return resolveLocalRef(ref, repoRoot, allow);
}

async function resolveCloudRef(
  ref: string,
  repoRoot: string,
  allow: readonly string[]
): Promise<ResolvedSourcePlan> {
  const m = CLOUD_REF.exec(ref);
  const version = m ? Number(m.groups!.version) : Number.NaN;
  // The regex's `[1-9]\d*` group already guarantees version >= 1, so the only
  // remaining bound is magnitude: Number.isSafeInteger (not isInteger) rejects a
  // value past MAX_SAFE_INTEGER — `@9007199254740993` would otherwise
  // Number()-round to a neighbour and silently resolve a different (or missing)
  // cached version. (A non-match's NaN also fails isSafeInteger; `!m` catches it
  // first and reads clearer.)
  if (!m || !Number.isSafeInteger(version)) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `Invalid cloud source-plan ref "${ref}". Expected cloud:<externalId>@<version> with a positive integer version.`,
      'source-plan'
    );
  }
  const externalId = m.groups!.externalId;
  const matches = await scanByExternalIdVersion(
    sourcePlanCacheDir(repoRoot),
    externalId,
    version,
    repoRoot
  );
  if (matches.length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `No pulled plan for "${ref}". Run \`orcaops plan pull ${externalId}\` first to cache the approved version.`,
      'source-plan'
    );
  }
  if (matches.length > 1) {
    const origins = matches.map((x) => x.record.base_url).join(', ');
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `Ambiguous cloud ref "${ref}": cached under multiple sessions (${origins}). Re-run \`orcaops plan pull\` for the intended cloud, or clear the stale namespace under .orcaops/cache/source-plan.`,
      'source-plan'
    );
  }
  const rec = matches[0].record;
  // Re-verify integrity at resolve. The cache verified sha256(body) on write,
  // but a pin is a graded conformance anchor — never pin a body that no longer
  // matches its recorded hash.
  const hash = sha256Hex(rec.body);
  if (hash !== rec.content_hash) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `Cached plan for "${ref}" is corrupt (sha256 mismatch). Re-run \`orcaops plan pull\`.`,
      'source-plan'
    );
  }
  // ASSERTED, never stripped: stripping would break the content-addressed hash
  // and silently alter the reviewed plan. `plan pull` rejects a dirty body at
  // fetch, but a pre-existing cache entry must still fail loud HERE — pinned,
  // it could never pass the wire assert (sync.ts) and the artifact would be
  // permanently unpushable.
  const forbidden = firstForbiddenControlChar(rec.body);
  if (forbidden !== null) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `Cached plan for "${ref}" contains a forbidden control character ` +
        `(U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}) ` +
        `and cannot be pinned: the cloud push rejects it, and stripping would break the ` +
        `content-addressed hash. Fix the plan on the web surface, re-upload and re-approve it, ` +
        `then re-run \`orcaops plan pull\`.`,
      'source-plan'
    );
  }
  // Cloud-side defense-in-depth against a whitespace-only cached body (the
  // cache schema's `body.min(1)` admits "   "). Mirrors resolveLocalRef's blank
  // guard — a blank pin is not a gradable conformance anchor. `plan pull`
  // rejects this at fetch too, but a pre-existing cache entry must still fail loud.
  if (rec.body.trim().length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `Cached plan for "${ref}" is blank — not a gradable conformance anchor. Re-pull an approved version with content.`,
      'source-plan'
    );
  }
  const contentSecretWarnings = assertNoSecretsOutbound(
    'source-plan',
    [['content', rec.body]],
    allow,
    { approvedCloudPin: true }
  );
  // Only authored reference metadata is scanned; kind, version, and hash are structural identity.
  const metadataSecretWarnings = assertNoSecretsOutbound(
    'source-plan',
    [
      ['source_ref.locator', externalId],
      ['source_ref.base_url', rec.base_url],
      ['source_ref.org_id', rec.org_id],
    ],
    allow
  );
  return {
    pin: {
      source_ref: {
        kind: 'cloud',
        locator: externalId,
        version: String(version),
        base_url: rec.base_url,
        org_id: rec.org_id,
      },
      content: rec.body,
      hash,
      // The resolver stays pure file/cache-IO: `capture plan` merges the
      // authoring baseline for LOCAL pins; a cloud pin's authoring baseline
      // already lives cloud-side from `plan upload`.
      baseline: null,
    },
    secretWarnings: [...contentSecretWarnings, ...metadataSecretWarnings],
  };
}

async function resolveLocalRef(
  ref: string,
  repoRoot: string,
  allow: readonly string[]
): Promise<ResolvedSourcePlan> {
  // Resolution order (fatal-on-bad-pin contract: every miss is a loud
  // NO_INPUT abort BEFORE any persistent
  // state exists):
  //   1. `~` expansion.
  //   2. Relative refs resolve against the INVOCATION cwd first
  //      (run-from-anywhere: `./plan.md` from a nested subdir means
  //      "where the user typed it")…
  //   3. …then fall back to REPO-ROOT-relative on ENOENT — agents
  //      routinely pass `docs/plans/x.md` from a subdirectory.
  //   4. EISDIR gets its own message (a directory is a common slip).
  //   5. A final miss runs a bounded basename search under the repo and
  //      suggests up to 5 candidates.
  const expanded = expandTilde(ref);
  const candidates: string[] = [];
  if (path.isAbsolute(expanded)) {
    candidates.push(expanded);
  } else {
    const cwdPath = path.resolve(getInvocationCwd(), expanded);
    candidates.push(cwdPath);
    const rootPath = path.resolve(repoRoot, expanded);
    if (rootPath !== cwdPath) candidates.push(rootPath);
  }

  let content: string | null = null;
  let absPath = candidates[0];
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, 'utf8');
      absPath = candidate;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EISDIR') {
        throw new OrcaopsError(
          ErrorCodes.NO_INPUT,
          `--source-plan "${ref}" is a directory, not a file. Point the pin at the plan ` +
            `document itself (e.g. ${path.join(ref, 'plan.md')}).`,
          'source-plan'
        );
      }
      if (code !== 'ENOENT') {
        throw new OrcaopsError(
          ErrorCodes.NO_INPUT,
          `Could not read --source-plan file "${ref}": ${(err as Error).message}`,
          'source-plan'
        );
      }
      // ENOENT → try the next resolution base.
    }
  }
  if (content === null) {
    const suggestions = await suggestByBasename(repoRoot, path.basename(expanded));
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `--source-plan file not found: "${ref}" (tried cwd-relative and repo-root-relative).` +
        (suggestions.length > 0
          ? ` Files with the same name under the repo — did you mean: ${suggestions.join(', ')}?`
          : ''),
      'source-plan'
    );
  }

  // Strip forbidden control chars so a born-pinned LOCAL plan is clean BEFORE
  // it is hashed — the hash then matches the clean content everywhere (local
  // projection + the wire re-verify at sync.ts). A cloud-pulled pin is the
  // opposite case (handled in resolveCloudRef): its content_hash is the cloud's
  // approved conformance anchor, so it is asserted-not-stripped to avoid
  // breaking content-addressing or silently altering the reviewed plan.
  content = stripControlChars(content);

  // Fail loud at capture on a blank pin. SourcePlanPinSchema enforces the same
  // rule, but that only bites at rebuild safeParse — which silently NULLs the
  // pin on projection, exactly the silent blind spot this feature prevents.
  if (content.trim().length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `--source-plan file is empty: "${ref}". A blank plan is not a gradable conformance anchor.`,
      'source-plan'
    );
  }

  const locator = displaySafeLocator(absPath, repoRoot);
  const contentSecretWarnings = assertNoSecretsOutbound(
    'source-plan',
    [['content', content]],
    allow
  );
  // The content hash is derived structural identity, not authored metadata.
  const metadataSecretWarnings = assertNoSecretsOutbound(
    'source-plan',
    [['source_ref.locator', locator]],
    allow
  );
  const hash = sha256Hex(content);
  return {
    pin: {
      source_ref: { kind: 'local', locator },
      content,
      hash,
      // Null here, not resolved: the resolver stays pure file-IO. The capture
      // command freezes the authoring baseline onto local pins (see plan.ts).
      baseline: null,
    },
    secretWarnings: [...contentSecretWarnings, ...metadataSecretWarnings],
  };
}

/**
 * Repo-relative locator when the file lives under the repo, else its absolute
 * path. Resolving the stored repo-relative locator against `repoRoot` (stable
 * at capture AND push) keeps `findByPath` lineage lookups deterministic
 * regardless of the push process's cwd.
 */
function displaySafeLocator(absPath: string, repoRoot: string): string {
  const rel = path.relative(repoRoot, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return absPath;
}

/** `~` / `~/x` expand against the user's home; `~user` forms are left alone. */
function expandTilde(ref: string): string {
  if (ref === '~') return os.homedir();
  if (ref.startsWith(`~${path.sep}`) || ref.startsWith('~/')) {
    return path.join(os.homedir(), ref.slice(2));
  }
  return ref;
}

/** Directories never worth searching for a plan document. */
const SUGGESTION_EXCLUDES = new Set(['node_modules', '.git', '.orcaops']);
/** BFS directory cap — a bounded courtesy search, not an indexer. */
const SUGGESTION_DIR_CAP = 2000;
const SUGGESTION_LIMIT = 5;

/**
 * Bounded breadth-first basename search under the repo for the
 * not-found suggestion message. Best-effort by design:
 * unreadable directories are skipped, the scan stops at
 * SUGGESTION_DIR_CAP directories, and at most SUGGESTION_LIMIT
 * repo-relative candidates return (sorted for determinism).
 */
async function suggestByBasename(repoRoot: string, basename: string): Promise<string[]> {
  if (basename.length === 0) return [];
  const found: string[] = [];
  const queue: string[] = [repoRoot];
  let visited = 0;
  while (queue.length > 0 && visited < SUGGESTION_DIR_CAP && found.length < SUGGESTION_LIMIT) {
    const dir = queue.shift() as string;
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — courtesy search, skip
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SUGGESTION_EXCLUDES.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        found.push(path.relative(repoRoot, path.join(dir, entry.name)));
        if (found.length >= SUGGESTION_LIMIT) break;
      }
    }
  }
  return found.sort();
}
