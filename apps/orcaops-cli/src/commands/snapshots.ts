import path from 'node:path';

import {
  diffSnapshotTrees,
  listRawSnapshotRefNames,
  listSensitiveTreePaths,
  listSnapshotRefs,
  materializeSnapshotTree,
  pruneSnapshotRefs,
} from '@orcaops/core';
import { cutTruncatedSecretTail } from '@orcaops/evaluator-protocol/secrets';
import {
  checkoutsRoot,
  type Checkpoint,
  redactSecretsInString,
  resolveCaptureExcludes,
  uuidv7,
  writeCachedirTag,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { buildContext } from '../lib/context.js';
import { readDerivedCache } from '../lib/fingerprint-cache.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { parseDigitInt } from '../lib/strict-int.js';

const PRUNE_WARNING =
  'WARNING: pruning snapshot refs makes fingerprint manifests non-re-derivable ' +
  '(unless stored at capture, or already derived into the archive cache).';

export interface SnapshotsPruneOptions {
  /** Total-wipe every ref of one artifact (all phases/statuses). */
  artifact?: string;
  /** Refs whose artifact is absent + malformed-but-valid-git refs. */
  orphans?: boolean;
  /** Every refs/orcaops/snap/* ref. Requires --apply. */
  all?: boolean;
  /** Actually delete. Default is dry-run. */
  apply?: boolean;
  /**
   * With the archive enabled, `--apply` refuses when a
   * candidate ref belongs to a closed checkpoint that has NEITHER a
   * stored manifest NOR a cached derived manifest (pruning would strand
   * it forever). Pass this to prune anyway, or run `fingerprint derive`
   * first. No-op when the archive is disabled.
   */
  allowUnderived?: boolean;
  json?: boolean;
}

type PruneMode = 'artifact' | 'orphans' | 'all';

/**
 * `orcaops snapshots prune --artifact <id> | --orphans | --all [--apply] [--json]`
 *
 * Manual cleanup of local `refs/orcaops/snap/*` refs. Dry-run by
 * default (matches `gc` UX); `--apply` to delete. Every output — both
 * modes, human and JSON — carries the non-re-derivability warning.
 *
 * All selectors operate over the RAW namespace set
 * (`listRawSnapshotRefNames`), NOT `listSnapshotRefs` — the latter
 * silently drops malformed refs, so a parsed-`artifact_id` definition
 * of `--orphans` could never remove the malformed refs that doctor's
 * `stale-snapshot-refs` recommends `prune --orphans` for.
 * `pruneSnapshotRefs` accepts any ref that is
 * namespace-prefixed + passes `git check-ref-format`, so
 * malformed-but-valid refs delete cleanly.
 *
 * This is the intentional TOTAL-wipe path (per `--artifact`/`--all`),
 * distinct from the sync layer's SELECTIVE auto-prune which preserves
 * re-derivability for skipped/abandon/in-flight refs.
 */
export async function snapshotsPruneAction(opts: SnapshotsPruneOptions = {}): Promise<void> {
  try {
    const selected: PruneMode[] = [];
    if (opts.artifact !== undefined) selected.push('artifact');
    if (opts.orphans === true) selected.push('orphans');
    if (opts.all === true) selected.push('all');
    if (selected.length !== 1) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Exactly one of --artifact <id> | --orphans | --all is required.',
        selected.length === 0 ? undefined : 'selector'
      );
    }
    const mode = selected[0];
    if (mode === 'artifact' && (opts.artifact === undefined || opts.artifact.length === 0)) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact requires an id.', 'artifact');
    }
    if (mode === 'all' && opts.apply !== true) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--all requires --apply (a full namespace wipe is never an implicit dry-run default).',
        'all'
      );
    }

    const ctx = await buildContext();
    try {
      let candidates: string[];
      if (mode === 'artifact') {
        candidates = await listRawSnapshotRefNames(ctx.repo, { artifactId: opts.artifact });
      } else if (mode === 'all') {
        candidates = await listRawSnapshotRefNames(ctx.repo);
      } else {
        // orphans = malformed (raw − parsed)
        //         ∪ parsed refs whose artifact_id is absent from the store
        //         ∪ "unmodeled" parsed refs: artifact exists + has a
        //           summary, but the ref's checkpoint n is absent from
        //           readCheckpointsRecovered (a pin-before-append crash
        //           orphan). The unmodeled predicate is IDENTICAL to
        //           doctor's `stale-snapshot-refs` 'unmodeled' class
        //           (artifact present, summary !== null, n ∉ recovered)
        //           so `prune --orphans --apply` reclaims exactly what
        //           doctor flags — no drift.
        const raw = await listRawSnapshotRefNames(ctx.repo);
        const parsed = await listSnapshotRefs(ctx.repo);
        const parsedRefs = new Set(parsed.map((e) => e.ref));
        const malformed = raw.filter((r) => !parsedRefs.has(r));
        const byArtifact = new Map<string, typeof parsed>();
        for (const e of parsed) {
          const list = byArtifact.get(e.artifact_id) ?? [];
          list.push(e);
          byArtifact.set(e.artifact_id, list);
        }
        const absent: string[] = [];
        const unmodeled: string[] = [];
        for (const [aid, entries] of byArtifact) {
          if (ctx.store.store.getArtifact(aid) === null) {
            for (const e of entries) absent.push(e.ref);
            continue;
          }
          // DELIBERATELY fail-closed (not enumeration containment): this
          // scan nominates snapshot refs for GC — treating an unreadable
          // artifact's refs as unmodeled would delete evidence for
          // checkpoints that may exist.
          const summary = await ctx.store.readSummary(aid);
          if (summary === null) continue; // in-flight — mirror doctor's gate
          const recovered = await ctx.store.readCheckpointsRecovered(aid);
          const modeledN = new Set(recovered.map((c) => c.n));
          for (const e of entries) {
            if (!modeledN.has(e.n)) unmodeled.push(e.ref);
          }
        }
        candidates = [...new Set([...malformed, ...absent, ...unmodeled])].sort();
      }

      // Pre-prune enforcement: with the archive enabled, flag
      // candidate refs whose closed checkpoint has no stored manifest and
      // no cached derived manifest — pruning those trees loses the last
      // derivation source. Dry-run discloses; --apply requires
      // --allow-underived (or a prior `fingerprint derive`).
      let underived: string[] = [];
      if (ctx.config.archive.enabled && candidates.length > 0) {
        underived = await findUnderivedRefs(
          {
            listParsedRefs: () => listSnapshotRefs(ctx.repo),
            readCheckpoint: (aid, n) => ctx.store.readCheckpoint(aid, n),
            cachedManifestExists: async (aid, n) =>
              ctx.archive !== null &&
              (await readDerivedCache(ctx.archive.projectDir, aid, n)) !== null,
          },
          candidates
        );
        if (opts.apply === true && underived.length > 0 && opts.allowUnderived !== true) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            underivedPruneRefusal(underived.length, mode === 'all' ? 'all' : 'default'),
            'allow-underived'
          );
        }
      }

      let deleted = 0;
      if (opts.apply === true && candidates.length > 0) {
        deleted = (await pruneSnapshotRefs(ctx.repo, candidates)).deleted;
      }

      if (opts.json) {
        emitOk({
          applied: opts.apply === true,
          mode,
          warning: PRUNE_WARNING,
          candidates,
          ...(ctx.config.archive.enabled ? { underived } : {}),
          deleted,
        });
        return;
      }
      writeTerminalSafeStdout(
        formatHuman(opts.apply === true, mode, candidates, deleted, underived)
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatHuman(
  applied: boolean,
  mode: PruneMode,
  candidates: string[],
  deleted: number,
  underived: string[] = []
): string {
  const lines: string[] = [];
  lines.push(
    applied
      ? `orcaops snapshots prune — applied (mode=${mode})`
      : `orcaops snapshots prune — dry-run (mode=${mode}, pass --apply to delete)`
  );
  lines.push(PRUNE_WARNING);
  lines.push('');
  lines.push(`  refs: ${candidates.length}` + (applied ? ` → deleted ${deleted}` : ''));
  for (const r of candidates) {
    lines.push(`    - ${r}${underived.includes(r) ? '  [underived]' : ''}`);
  }
  if (underived.length > 0 && !applied) {
    lines.push('');
    lines.push(
      `  ${underived.length} ref(s) are underived (no stored or cached manifest); ` +
        '`--apply` will refuse without `--allow-underived` — run ' +
        '`orcaops fingerprint derive --artifact <id> --checkpoint <n>` for each first.'
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ── snapshots checkout ─────────────────────────────────────────────────

type BoundaryPhase = 'open' | 'close' | 'abandon';

const BOUNDARY_PHASES: readonly BoundaryPhase[] = ['open', 'close', 'abandon'];

/**
 * The phase a bare `snapshots checkout` / a range endpoint defaults to,
 * per the endpoint-resolution rules below: the checkpoint's FINALIZED
 * boundary (close for closed, abandon for abandoned), and open for a
 * still-open cp (its only boundary).
 */
export function defaultPhaseForStatus(status: Checkpoint['status']): BoundaryPhase {
  return status === 'closed' ? 'close' : status === 'abandoned' ? 'abandon' : 'open';
}

type SnapshotBoundaryFields = {
  snapshot_ref: string | null;
  tree_sha: string | null;
  snapshot_commit_sha: string | null;
  snapshot_error_reason: string | null;
};

/**
 * The cp's boundary record for `phase`, or null when that phase does not
 * exist for the cp's status (close on non-closed, abandon on
 * non-abandoned, anything-but-open on an open cp resolves through the
 * status-narrowed fields). Null is the caller's `SNAPSHOT_UNAVAILABLE`.
 */
export function boundaryForPhase(
  cp: Checkpoint,
  phase: BoundaryPhase
): SnapshotBoundaryFields | null {
  if (phase === 'open') return cp.open_snapshot;
  if (phase === 'close') return cp.status === 'closed' ? cp.close_snapshot : null;
  return cp.status === 'abandoned' ? cp.abandon_snapshot : null;
}

/**
 * Shared endpoint resolution for checkout (here) and `snapshots diff`
 * validate the phase against the cp's status, then require a
 * materializable boundary. Throws typed `SNAPSHOT_UNAVAILABLE` errors —
 * the three shapes documented on the error code.
 */
export function requireBoundary(
  cp: Checkpoint,
  phase: BoundaryPhase,
  artifactId: string
): SnapshotBoundaryFields {
  const boundary = boundaryForPhase(cp, phase);
  if (boundary === null) {
    throw new OrcaopsError(
      ErrorCodes.SNAPSHOT_UNAVAILABLE,
      `Checkpoint #${cp.n} of "${artifactId}" is ${cp.status} — phase "${phase}" has no ` +
        `snapshot boundary for this status.`,
      'phase'
    );
  }
  if (boundary.snapshot_commit_sha === null || boundary.tree_sha === null) {
    const reason = boundary.snapshot_error_reason;
    throw new OrcaopsError(
      ErrorCodes.SNAPSHOT_UNAVAILABLE,
      reason !== null
        ? `Checkpoint #${cp.n} has no ${phase} snapshot: capture failed (reason: ${reason}).`
        : `Checkpoint #${cp.n} has no ${phase} snapshot: capture was deliberately skipped ` +
            `(diff_fingerprint disabled at capture time) — nothing to materialize.`,
      'phase'
    );
  }
  return boundary;
}

/**
 * The pruned-boundary message, shared by checkout and diff. Aligned with
 * derive's pruned-ref wording, PLUS the auto-prune context: pruning
 * synced cps' open/close refs is NORMAL operation,
 * not an edge case.
 */
function prunedBoundaryMessage(shaShort: string, n: number, phase: BoundaryPhase): string {
  return (
    `Snapshot commit ${shaShort} for checkpoint #${n} phase "${phase}" is unreachable. The ` +
    `refs pinning it were likely pruned (\`orcaops snapshots prune\` / \`orcaops gc\`, or the ` +
    `cloud-sync auto-prune — a synced checkpoint's open/close refs are pruned once its ` +
    `manifest lands). A pruned boundary can no longer be materialized; time-travel is ` +
    `strongest on unsynced/local work.`
  );
}

export interface SnapshotsCheckoutOptions {
  artifact: string;
  checkpoint: number;
  /** Defaults per `defaultPhaseForStatus`. */
  phase?: string;
  /** Target dir (must not exist, or be empty). Default: `<checkoutsRoot>/…`. */
  into?: string;
  json?: boolean;
}

/**
 * `orcaops snapshots checkout --artifact <id> --checkpoint <n>
 *   [--phase open|close|abandon] [--into <dir>] [--json]`
 *
 * Materialize a pinned checkpoint boundary tree into a detached scratch
 * worktree (mechanism + hygiene in `materializeSnapshotTree`).
 * NEVER touches the live worktree or index.
 *
 * Boundary source is the PHYSICAL boundary (`cp.<phase>_snapshot`).
 * When a stored manifest's fingerprint window differs (empty-fence
 * recovery pinned a baseline open tree), the output carries an
 * informational `note` — the physical state is never silently
 * substituted with the fingerprint window.
 *
 * Default location: `checkoutsRoot(env)` — cache-classified
 * (CACHEDIR.TAG at the ROOT only; a checkout itself must mirror the
 * pinned tree exactly) — under a `<artifact8>-cp<n>-<phase>-<uuid>`
 * dir. Cleanup: `git worktree remove --force <dir>` (or `rm -rf` +
 * a later `git worktree prune`).
 *
 * Materializing a snapshot writes UNTRACKED-file content that `git add -A`
 * captured — the same privacy delta the diff path discloses, but larger: a
 * whole tree rather than a two-tree delta, and into a destination outside the
 * repository where its ignore rules do not reach. Paths matching
 * `capture.exclude` are listed before the write.
 */
export async function snapshotsCheckoutAction(opts: SnapshotsCheckoutOptions): Promise<void> {
  try {
    if (typeof opts.artifact !== 'string' || opts.artifact.length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact <id> is required.', 'artifact');
    }
    if (!Number.isInteger(opts.checkpoint) || opts.checkpoint <= 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--checkpoint <n> must be a positive integer.',
        'checkpoint'
      );
    }
    if (opts.phase !== undefined && !BOUNDARY_PHASES.includes(opts.phase as BoundaryPhase)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--phase must be one of open|close|abandon (got "${opts.phase}").`,
        'phase'
      );
    }

    const ctx = await buildContext();
    try {
      if (ctx.store.store.getArtifact(opts.artifact) === null) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }
      const cp = await ctx.store.readCheckpoint(opts.artifact, opts.checkpoint);
      if (cp === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No checkpoint #${opts.checkpoint} for artifact "${opts.artifact}".`,
          'checkpoint'
        );
      }

      const phase = (opts.phase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
      const boundary = requireBoundary(cp, phase, opts.artifact);
      // requireBoundary narrows both to non-null; keep locals for clarity.
      const commitSha = boundary.snapshot_commit_sha as string;

      // Manifest-window divergence note (closed cps only). A manifest
      // integrity error is show/derive territory — the PHYSICAL boundary
      // checkout proceeds regardless.
      let note: string | undefined;
      if (cp.status === 'closed') {
        try {
          const manifest = await ctx.store.readCheckpointDiffFingerprint(
            opts.artifact,
            opts.checkpoint
          );
          if (
            manifest !== null &&
            (manifest.open_tree_sha !== cp.open_snapshot.tree_sha ||
              manifest.close_tree_sha !== cp.close_snapshot.tree_sha)
          ) {
            note =
              `stored manifest's fingerprint window (${manifest.open_tree_sha.slice(0, 12)}..` +
              `${manifest.close_tree_sha.slice(0, 12)}) differs from the physical snapshot ` +
              `boundaries (empty-fence recovery). This checkout materializes the PHYSICAL ` +
              `"${phase}" boundary tree.`;
          }
        } catch {
          // unreadable manifest — no note; integrity surfacing belongs to show/derive
        }
      }

      let dir: string;
      if (opts.into !== undefined && opts.into.length > 0) {
        dir = path.resolve(opts.into);
      } else {
        const root = checkoutsRoot(getInvocationEnv());
        await writeCachedirTag(root); // ensureDir0700 + CACHEDIR.TAG at the ROOT only
        dir = path.join(root, `${opts.artifact.slice(0, 8)}-cp${cp.n}-${phase}-${uuidv7()}`);
      }

      // Disclose before writing. `git worktree add` is atomic with no
      // interception point, and deleting after materialization is a
      // time-of-check race that would also make `git status --short` inside
      // the scratch dir report deletions the user never made — in a directory
      // the timetravel skill tells an agent to work in. So the honest control
      // is to say what is about to land, not to quietly alter it.
      //
      // Refs pinned before capture.exclude existed still carry whatever they
      // captured; this is how a user finds that out before running an install
      // in that tree.
      // A boundary with no recorded tree discloses nothing rather than
      // guessing from the commit — same fail-open posture as the probe itself.
      const sensitivePaths =
        boundary.tree_sha === null
          ? []
          : await listSensitiveTreePaths(
              ctx.repo,
              boundary.tree_sha,
              resolveCaptureExcludes(ctx.config.capture).patterns
            );

      const result = await materializeSnapshotTree(ctx.repo, commitSha, dir);
      if (!result.ok) {
        if (result.error_reason === 'commit_unreachable') {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            prunedBoundaryMessage(commitSha.slice(0, 12), cp.n, phase),
            'checkpoint'
          );
        }
        if (result.error_reason === 'target_not_empty') {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--into ${dir} exists and is not empty.`,
            'into'
          );
        }
        throw new OrcaopsError(
          ErrorCodes.SNAPSHOT_UNAVAILABLE,
          `git worktree add failed for checkpoint #${cp.n} phase "${phase}": ` +
            `${result.error_message ?? 'unknown error'}`,
          'checkpoint'
        );
      }

      const cleanup = `git worktree remove --force ${result.dir}`;
      if (opts.json) {
        emitOk({
          artifact: opts.artifact,
          checkpoint: cp.n,
          phase,
          dir: result.dir,
          snapshot_ref: boundary.snapshot_ref,
          tree_sha: boundary.tree_sha,
          snapshot_commit_sha: commitSha,
          sensitive_paths: sensitivePaths,
          sensitive_path_count: sensitivePaths.length,
          cleanup,
          ...(note !== undefined ? { note } : {}),
        });
        return;
      }
      const lines = [
        `Materialized artifact ${opts.artifact} checkpoint #${cp.n} (${phase}) into:`,
        `  ${result.dir}`,
        '',
        `  tree_sha:  ${boundary.tree_sha}`,
        `  ref:       ${boundary.snapshot_ref ?? '(none)'}`,
        ...(note !== undefined ? [`  note:      ${note}`] : []),
        ...(sensitivePaths.length > 0
          ? [
              '',
              `Sensitive paths written (${sensitivePaths.length}):`,
              ...sensitivePaths.map((p) => `  ${p}`),
              '  These match capture.exclude in the tree this checkpoint recorded.',
              '  Exclusion applies to untracked files at capture time, so a match is',
              '  here either because it is tracked — in which case it will be listed',
              '  on every checkout — or because the snapshot predates the pattern.',
              '  The destination above is outside the repository, so its .gitignore',
              '  does not cover them.',
            ]
          : []),
        '',
        `Cleanup: ${cleanup}`,
        '  (rm -rf + a later `git worktree prune` also works)',
        'Caveats: full tree even under sparse-checkout; submodules materialize as empty dirs;',
        '  LFS pointers smudge only if local LFS objects exist.',
        '',
      ];
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

// ── snapshots diff ─────────────────────────────────────────────────────

/** One side of a `snapshots diff` range: a checkpoint or the plan-time baseline. */
type DiffEndpoint = { kind: 'checkpoint'; n: number } | { kind: 'baseline' };

type ParsedDiffRange =
  | { form: 'single'; n: number }
  | { form: 'range'; from: DiffEndpoint; to: DiffEndpoint };

/**
 * Parse the positional range argument: `<n>` (one checkpoint's window) or
 * `<from>..<to>` where each side is a checkpoint number or the literal
 * `baseline` (the artifact's plan-time seed). `baseline..baseline` is
 * refused — it can only ever be empty.
 */
export function parseDiffRange(range: string): ParsedDiffRange {
  if (/^\d+$/.test(range)) {
    const n = parseDigitInt(range) ?? 0;
    if (n > 0) return { form: 'single', n };
  }
  const m = /^(baseline|\d+)\.\.(baseline|\d+)$/.exec(range);
  if (m) {
    const parse = (s: string): DiffEndpoint =>
      s === 'baseline' ? { kind: 'baseline' } : { kind: 'checkpoint', n: parseDigitInt(s) ?? 0 };
    const from = parse(m[1]);
    const to = parse(m[2]);
    if (from.kind === 'baseline' && to.kind === 'baseline') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'baseline..baseline is always empty — pick at least one checkpoint endpoint.',
        'range'
      );
    }
    if ((from.kind === 'checkpoint' && from.n <= 0) || (to.kind === 'checkpoint' && to.n <= 0)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Checkpoint endpoints must be positive integers.',
        'range'
      );
    }
    return { form: 'range', from, to };
  }
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Invalid range "${range}" — expected <n> or <from>..<to> where each side is a ` +
      `checkpoint number or "baseline".`,
    'range'
  );
}

/**
 * Trim a byte-capped buffer back to a valid UTF-8 boundary: the raw cap
 * (`runGit` slices at exactly `maxStdoutBytes`) can split a multibyte
 * character, which would decode to U+FFFD garbage in the JSON `diff`
 * field. Scans back at most 3 bytes for a lead byte and drops the
 * trailing char if its continuation bytes were cut off.
 */
export function trimToUtf8Boundary(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  // Find the last lead byte within the final 4 bytes.
  let i = buf.length - 1;
  const stop = Math.max(0, buf.length - 4);
  while (i > stop && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < expected ? buf.subarray(0, i) : buf;
}

/**
 * Bytes read beyond `max_diff_bytes` so a secret sitting ACROSS the cap is
 * whole when the redactor runs, and gets marked in place rather than cut.
 *
 * This is an optimization for the common case, not the safety property. It is
 * deliberately NOT sized to the longest possible match — PEM and
 * service-account bodies have no upper bound, so no fixed overlap could be.
 * Anything the final trim severs is handled by `cutTruncatedSecretTail`.
 */
const SECRET_STRADDLE_OVERLAP_BYTES = 4096;

/**
 * Trim the over-read, already-redacted diff back to the configured cap, then
 * drop whatever that trim severed mid-secret.
 */
export function trimRedactedToCap(text: string, cap: number, redacting: boolean): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= cap) return text;
  const out = trimToUtf8Boundary(buf.subarray(0, cap)).toString('utf8');
  return redacting ? cutTruncatedSecretTail(out) : out;
}

/**
 * Keep the pipe path byte-exact even when a text diff contains invalid UTF-8.
 * The secret corpus is ASCII, so latin1 is a one-code-unit-per-byte carrier
 * that lets the shared redactor replace matches without decoding other bytes.
 */
export function preparePipedDiff(
  raw: Buffer,
  cap: number,
  redacting: boolean
): { bytes: Buffer; trimmed: boolean } {
  const scrubbed = redacting
    ? Buffer.from(redactSecretsInString(raw.toString('latin1')), 'latin1')
    : raw;
  if (scrubbed.byteLength <= cap) return { bytes: scrubbed, trimmed: false };

  const capped = scrubbed.subarray(0, cap);
  if (!redacting) return { bytes: capped, trimmed: true };
  return {
    bytes: Buffer.from(cutTruncatedSecretTail(capped.toString('latin1')), 'latin1'),
    trimmed: true,
  };
}

export interface SnapshotsDiffOptions {
  artifact: string;
  range: string;
  fromPhase?: string;
  toPhase?: string;
  json?: boolean;
}

interface ResolvedEndpoint {
  kind: 'checkpoint' | 'baseline';
  checkpoint?: number;
  phase?: BoundaryPhase;
  /** Tree (checkpoint boundaries) or commit (baseline) — git diff peels both. */
  sha: string;
  ref: string | null;
}

/**
 * `orcaops snapshots diff --artifact <id> <n>|<from>..<to>
 *   [--from-phase X] [--to-phase Y] [--json]`
 *
 * Raw diff between two checkpoint boundaries. Endpoint
 * defaults per the endpoint-resolution rules: single `<n>` is the
 * cp's window (open → close|abandon by status; error while still open);
 * range endpoints default to each cp's finalized phase.
 *
 * Tree authority: endpoints resolve from PHYSICAL boundaries, EXCEPT the
 * single-cp open..close window of a closed cp with a stored manifest —
 * there the manifest's trees are authoritative (derive parity: a
 * recovered manifest's window IS the cp's fingerprint window), disclosed
 * via `tree_source` + a divergence note.
 *
 * Output boundary: this diff is RAW TEXT computed from live local trees
 * — fine and deliberately distinct from the hash-only fingerprint paths.
 * Snapshot trees include UNTRACKED-file content (captured via `add -A`),
 * a privacy delta vs plain `git diff` — stated here, and the text passes
 * through the standard output redaction when `digest.redact_secrets` is
 * on. Byte-capped by `diff_fingerprint.max_diff_bytes`; the capped tail
 * is trimmed to a valid UTF-8 boundary.
 */
export async function snapshotsDiffAction(opts: SnapshotsDiffOptions): Promise<void> {
  try {
    if (typeof opts.artifact !== 'string' || opts.artifact.length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact <id> is required.', 'artifact');
    }
    for (const [flag, value] of [
      ['from-phase', opts.fromPhase],
      ['to-phase', opts.toPhase],
    ] as const) {
      if (value !== undefined && !BOUNDARY_PHASES.includes(value as BoundaryPhase)) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--${flag} must be one of open|close|abandon (got "${value}").`,
          flag
        );
      }
    }
    const parsed = parseDiffRange(opts.range);

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      if (ctx.store.store.getArtifact(opts.artifact) === null) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }

      const readCp = async (n: number): Promise<Checkpoint> => {
        const cp = await ctx.store.readCheckpoint(opts.artifact, n);
        if (cp === null) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `No checkpoint #${n} for artifact "${opts.artifact}".`,
            'range'
          );
        }
        return cp;
      };

      const resolveCheckpointEndpoint = async (
        n: number,
        explicitPhase: string | undefined
      ): Promise<ResolvedEndpoint> => {
        const cp = await readCp(n);
        const phase =
          (explicitPhase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
        const boundary = requireBoundary(cp, phase, opts.artifact);
        return {
          kind: 'checkpoint',
          checkpoint: n,
          phase,
          sha: boundary.tree_sha as string,
          ref: boundary.snapshot_ref,
        };
      };

      const resolveBaselineEndpoint = async (
        explicitPhase: string | undefined,
        side: 'from' | 'to'
      ): Promise<ResolvedEndpoint> => {
        if (explicitPhase !== undefined) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--${side}-phase does not apply to the baseline endpoint.`,
            `${side}-phase`
          );
        }
        const ref = `refs/orcaops/baseline/${opts.artifact}`;
        const sha = await ctx.repo.resolveCommit(ref);
        if (sha === null) {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            `No plan-time baseline for "${opts.artifact}" — it was never pinned, or its ref ` +
              `was auto-pruned once the first checkpoint was accounted. Salvage fallback: try ` +
              `the prior checkpoint's close boundary, or \`snapshots checkout\` the abandon ` +
              `tree without a diff.`,
            'range'
          );
        }
        return { kind: 'baseline', sha, ref };
      };

      let from: ResolvedEndpoint;
      let to: ResolvedEndpoint;
      let treeSource: 'stored_manifest_trees' | 'snapshot_boundaries' = 'snapshot_boundaries';
      let note: string | undefined;

      if (parsed.form === 'single') {
        const cp = await readCp(parsed.n);
        if (cp.status === 'open') {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            `Checkpoint #${parsed.n} is still open — its window has no finalized end ` +
              `boundary yet. Close or abandon it first, or diff explicit endpoints.`,
            'range'
          );
        }
        const fromPhase = (opts.fromPhase as BoundaryPhase | undefined) ?? 'open';
        const toPhase =
          (opts.toPhase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
        const fromBoundary = requireBoundary(cp, fromPhase, opts.artifact);
        const toBoundary = requireBoundary(cp, toPhase, opts.artifact);
        from = {
          kind: 'checkpoint',
          checkpoint: parsed.n,
          phase: fromPhase,
          sha: fromBoundary.tree_sha as string,
          ref: fromBoundary.snapshot_ref,
        };
        to = {
          kind: 'checkpoint',
          checkpoint: parsed.n,
          phase: toPhase,
          sha: toBoundary.tree_sha as string,
          ref: toBoundary.snapshot_ref,
        };

        // Derive parity: for a closed cp's open..close window, a stored
        // manifest's trees are authoritative (empty-fence recovery may
        // have pinned a baseline open tree ≠ the physical boundary).
        if (cp.status === 'closed' && fromPhase === 'open' && toPhase === 'close') {
          try {
            const manifest = await ctx.store.readCheckpointDiffFingerprint(opts.artifact, parsed.n);
            if (manifest !== null) {
              treeSource = 'stored_manifest_trees';
              if (manifest.open_tree_sha !== from.sha || manifest.close_tree_sha !== to.sha) {
                note =
                  `manifest fingerprint window differs from the physical snapshot boundaries ` +
                  `(empty-fence recovery) — diffing the manifest window ` +
                  `${manifest.open_tree_sha.slice(0, 12)}..${manifest.close_tree_sha.slice(0, 12)}.`;
              }
              from.sha = manifest.open_tree_sha;
              to.sha = manifest.close_tree_sha;
            }
          } catch {
            // unreadable manifest → physical boundaries; integrity
            // surfacing belongs to show/derive
          }
        }
      } else {
        from =
          parsed.from.kind === 'baseline'
            ? await resolveBaselineEndpoint(opts.fromPhase, 'from')
            : await resolveCheckpointEndpoint(parsed.from.n, opts.fromPhase);
        to =
          parsed.to.kind === 'baseline'
            ? await resolveBaselineEndpoint(opts.toPhase, 'to')
            : await resolveCheckpointEndpoint(parsed.to.n, opts.toPhase);
      }

      const cap = ctx.config.diff_fingerprint.max_diff_bytes;
      const diff = await diffSnapshotTrees({
        repo: ctx.repo,
        openTreeSha: from.sha,
        closeTreeSha: to.sha,
        // Read a bounded overlap PAST the cap so redaction sees whole
        // secrets. Capping first and redacting after (what this did) lets a
        // secret straddling the cut be shortened below its pattern's minimum
        // length and emitted as an unmatched prefix. The overlap is a fixed
        // small constant, so the memory bound moves by a known amount.
        maxDiffBytes: cap + SECRET_STRADDLE_OVERLAP_BYTES,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.SNAPSHOT_UNAVAILABLE,
          `git diff ${from.sha.slice(0, 12)}..${to.sha.slice(0, 12)} failed — one or both ` +
            `endpoint trees are unreachable. The snapshot refs pinning them were likely ` +
            `pruned (\`orcaops snapshots prune\` / \`orcaops gc\`, or the cloud-sync ` +
            `auto-prune once a synced checkpoint's manifest landed); a pruned boundary can ` +
            `no longer be diffed. Time-travel is strongest on unsynced/local work.`,
          'range'
        );
      }

      const raw = Buffer.from(diff.diff);
      if (!opts.json && !process.stdout.isTTY) {
        const piped = preparePipedDiff(raw, cap, ctx.config.digest.redact_secrets);
        const truncated = diff.truncated || piped.trimmed;
        writePipeFriendlyStdout(piped.bytes);
        if (truncated) {
          writeTerminalSafeStderr(
            `\n[snapshots diff] truncated at diff_fingerprint.max_diff_bytes=${cap}\n`
          );
        }
        if (note !== undefined) {
          writeTerminalSafeStderr(`[snapshots diff] note: ${note}\n`);
        }
        return;
      }

      const text = (diff.truncated ? trimToUtf8Boundary(raw) : raw).toString('utf8');
      // Redact the OVER-READ text, then trim to the configured cap — in that
      // order, so a secret spanning the cap boundary is matched whole.
      const scrubbed = ctx.config.digest.redact_secrets ? redactSecretsInString(text) : text;
      const redacted = trimRedactedToCap(scrubbed, cap, ctx.config.digest.redact_secrets);
      // Both describe what is actually EMITTED, not the over-read: the reader
      // is asked for `cap + overlap` bytes purely so redaction sees whole
      // secrets, so its own truncation flag understates by that overlap.
      const byteCount = Buffer.byteLength(redacted, 'utf8');
      const truncated = diff.truncated || byteCount < Buffer.byteLength(scrubbed, 'utf8');

      if (opts.json) {
        emitOk({
          artifact: opts.artifact,
          from: { kind: from.kind, checkpoint: from.checkpoint, phase: from.phase, ref: from.ref },
          to: { kind: to.kind, checkpoint: to.checkpoint, phase: to.phase, ref: to.ref },
          from_sha: from.sha,
          to_sha: to.sha,
          tree_source: treeSource,
          truncated,
          byte_count: byteCount,
          diff: redacted,
          ...(note !== undefined ? { note } : {}),
        });
        return;
      }

      // Human mode: stdout carries ONLY the diff text (pipe-friendly);
      // metadata goes to stderr so it never corrupts a piped patch.
      writePipeFriendlyStdout(redacted);
      if (truncated) {
        writeTerminalSafeStderr(
          `\n[snapshots diff] truncated at diff_fingerprint.max_diff_bytes=${cap}\n`
        );
      }
      if (note !== undefined) {
        writeTerminalSafeStderr(`[snapshots diff] note: ${note}\n`);
      }
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/** Injected readers so the underived predicate is directly unit-testable. */
export interface UnderivedProbe {
  listParsedRefs: () => Promise<Array<{ ref: string; artifact_id: string; n: number }>>;
  readCheckpoint: (
    artifactId: string,
    n: number
  ) => Promise<{
    status: string;
    diff_fingerprint_summary?: { manifest_hash: string | null };
  } | null>;
  cachedManifestExists: (artifactId: string, n: number) => Promise<boolean>;
}

/**
 * Candidate refs whose closed checkpoint has NEITHER a stored manifest
 * (capture-time, mirrored to the archive with the event log) NOR a cached
 * derived manifest (the `fingerprint derive` cache). Malformed refs,
 * absent artifacts, and non-closed checkpoints have nothing to derive —
 * never flagged. Exported for direct unit testing.
 */
export async function findUnderivedRefs(
  probe: UnderivedProbe,
  candidates: string[]
): Promise<string[]> {
  const parsedByRef = new Map((await probe.listParsedRefs()).map((e) => [e.ref, e]));
  const derivableByCp = new Map<string, boolean>();
  const underived: string[] = [];
  for (const ref of candidates) {
    const entry = parsedByRef.get(ref);
    if (!entry) continue;
    const key = `${entry.artifact_id}:${entry.n}`;
    let derivable = derivableByCp.get(key);
    if (derivable === undefined) {
      // NO catch: this probe gates DELETION. A recovery refusal (or any
      // other failure) must abort the prune — treating an unreadable
      // checkpoint as "nothing to protect" would delete the last
      // derivation source for state that cannot be verified.
      derivable = true; // default: nothing to protect
      const cp = await probe.readCheckpoint(entry.artifact_id, entry.n);
      if (cp !== null && cp.status === 'closed') {
        derivable = (cp.diff_fingerprint_summary?.manifest_hash ?? null) !== null;
        if (!derivable) {
          derivable = await probe.cachedManifestExists(entry.artifact_id, entry.n);
        }
      }
      derivableByCp.set(key, derivable);
    }
    if (!derivable) underived.push(ref);
  }
  return underived;
}

/**
 * Refusal for `--apply` over underived refs. Flows verbatim into the
 * public JSON error envelope; exported so the remedy text stays pinned.
 * The listing pointer is mode-aware: `--all` has no dry-run (it requires
 * `--apply`), so its remedy routes through doctor instead of a re-run
 * that would itself refuse.
 */
export function underivedPruneRefusal(count: number, mode: 'default' | 'all' = 'default'): string {
  const listing =
    mode === 'all'
      ? 'Run `orcaops doctor` to list them'
      : 'Re-run without `--apply` to list them (marked [underived])';
  return (
    `${count} candidate ref(s) belong to checkpoints with no stored or ` +
    `cached manifest — pruning them makes those fingerprints permanently ` +
    `non-derivable. ${listing}, ` +
    `run \`orcaops fingerprint derive --artifact <id> --checkpoint <n>\` for each ` +
    `first, or pass \`--allow-underived\` to prune anyway.`
  );
}
