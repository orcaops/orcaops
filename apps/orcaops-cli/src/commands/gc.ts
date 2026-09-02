import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactCandidate as GcArtifactCandidate,
  type GcCandidates,
  gcCandidateSetsEqual,
  type GcGitOperation,
  type GcGitUncertainty,
  listRawBaselineRefIdentities,
  listRawReviewRefIdentities,
  listRawSnapshotRefIdentities,
  pruneBaselineRefsIfUnchanged,
  pruneReviewRefsIfUnchanged,
  pruneSnapshotRefsIfUnchanged,
  type RefIdentity,
  scanGcCandidates,
  scanPinGcCandidate,
} from '@orcaops/core';
import { reviewFloorLockKey, reviewLocksDir } from '@orcaops/review-engine';
import {
  ArtifactDeletionRecoveryError,
  ArtifactLock,
  assertResolvedWithin,
  pinIdentity,
  type ProjectionHealth,
  withNonDerivableWriteLease,
  withPinFileLock,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { ensureProjectId, readProjectId } from '../lib/project-identity.js';

export interface GcOptions {
  /** Override `config.gc.retention_days`. */
  retentionDays?: number;
  /** When true, actually delete candidates. Default is dry-run. */
  apply?: boolean;
  json?: boolean;
}

interface DeleteCounts {
  stale_pins: number;
  abandoned_summarized: number;
  /** Local snapshot refs pruned alongside a deleted artifact. */
  snapshot_refs: number;
  /** Local baseline refs pruned alongside a deleted artifact. */
  baseline_refs: number;
  /** `.orcaops/reviews/<slug>/` dirs removed (stale review dirs). */
  stale_review_dirs: number;
  /** Local review pin refs pruned alongside a removed review dir. */
  review_refs: number;
}

interface RefListing {
  refs: Map<string, RefIdentity[]>;
  count: number | null;
  uncertainty: GcGitUncertainty | null;
}

interface GcRefInventory {
  snapshot: RefListing;
  baseline: RefListing;
  review: RefListing;
}

/**
 * Raw `refs/orcaops/snap/<id>/*` names for each gc-collected artifact.
 * Uses the shared raw lister (NOT `listSnapshotRefs`) so a
 * malformed-after-id ref doesn't outlive its deleted artifact. Bounded
 * by the candidate-set size (gc is not hot-path).
 */
async function listGcSnapshotRefs(
  repo: Parameters<typeof listRawSnapshotRefIdentities>[0],
  artifactIds: string[]
): Promise<Map<string, RefIdentity[]>> {
  const out = new Map<string, RefIdentity[]>();
  for (const id of new Set(artifactIds)) {
    const refs = await listRawSnapshotRefIdentities(repo, { artifactId: id });
    if (refs.length > 0) out.set(id, refs);
  }
  return out;
}

/**
 * Raw `refs/orcaops/baseline/<id>` name for each gc-collected artifact.
 * Total-wipe on artifact deletion, same as snapshot refs — a
 * deleted artifact's plan-time baseline ref must not outlive it.
 */
async function listGcBaselineRefs(
  repo: Parameters<typeof listRawBaselineRefIdentities>[0],
  artifactIds: string[]
): Promise<Map<string, RefIdentity[]>> {
  const out = new Map<string, RefIdentity[]>();
  for (const id of new Set(artifactIds)) {
    const refs = await listRawBaselineRefIdentities(repo, { artifactId: id });
    if (refs.length > 0) out.set(id, refs);
  }
  return out;
}

/**
 * The two `refs/orcaops/review/<slug>[-base]` pins for each stale review dir,
 * keyed by slug. These pins keep only that dir's floor trees readable, so they
 * are pruned when the dir is collected. Bounded by the candidate-set size.
 */
async function listGcReviewRefs(
  repo: Parameters<typeof listRawReviewRefIdentities>[0],
  slugs: string[]
): Promise<Map<string, RefIdentity[]>> {
  const out = new Map<string, RefIdentity[]>();
  for (const slug of new Set(slugs)) {
    const refs = await listRawReviewRefIdentities(repo, { slug });
    if (refs.length > 0) out.set(slug, refs);
  }
  return out;
}

async function collectRefListing(
  operation: GcGitOperation,
  subject: string,
  list: () => Promise<Map<string, RefIdentity[]>>
): Promise<RefListing> {
  try {
    const refs = await list();
    return {
      refs,
      count: [...refs.values()].reduce((total, names) => total + names.length, 0),
      uncertainty: null,
    };
  } catch {
    return {
      refs: new Map(),
      count: null,
      uncertainty: { operation, subject },
    };
  }
}

async function collectGcRefInventory(
  repo: Parameters<typeof listRawSnapshotRefIdentities>[0],
  candidates: GcCandidates
): Promise<GcRefInventory> {
  const artifactIds = [...candidates.abandoned_summarized.map((artifact) => artifact.artifact_id)];
  const slugs = candidates.stale_review_dirs.map((dir) => dir.slug);
  return {
    snapshot: await collectRefListing(
      'snapshot_ref_enumeration',
      artifactIds.join(',') || 'no-artifact-candidates',
      () => listGcSnapshotRefs(repo, artifactIds)
    ),
    baseline: await collectRefListing(
      'baseline_ref_enumeration',
      artifactIds.join(',') || 'no-artifact-candidates',
      () => listGcBaselineRefs(repo, artifactIds)
    ),
    review: await collectRefListing(
      'review_ref_enumeration',
      slugs.join(',') || 'no-review-candidates',
      () => listGcReviewRefs(repo, slugs)
    ),
  };
}

function withRefUncertainties(candidates: GcCandidates, inventory: GcRefInventory): GcCandidates {
  const refUncertainties = [
    inventory.snapshot.uncertainty,
    inventory.baseline.uncertainty,
    inventory.review.uncertainty,
  ].filter((uncertainty): uncertainty is GcGitUncertainty => uncertainty !== null);
  return {
    ...candidates,
    git_uncertainties: [...candidates.git_uncertainties, ...refUncertainties],
  };
}

function refInventoryKey(inventory: GcRefInventory): string {
  const keyFor = (listing: RefListing): Array<[string, RefIdentity[]]> =>
    [...listing.refs.entries()]
      .map(
        ([owner, refs]) =>
          [owner, [...refs].sort((left, right) => left.ref.localeCompare(right.ref))] as [
            string,
            RefIdentity[],
          ]
      )
      .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    snapshot: keyFor(inventory.snapshot),
    baseline: keyFor(inventory.baseline),
    review: keyFor(inventory.review),
  });
}

function assertGcApplySafe(candidates: GcCandidates): void {
  if (candidates.git_uncertainties.length > 0) {
    const operations = [...new Set(candidates.git_uncertainties.map((u) => u.operation))];
    throw new OrcaopsError(
      ErrorCodes.GC_GIT_UNCERTAIN,
      `Refusing destructive garbage collection because Git state could not be proven ` +
        `(${operations.join(', ')}). Re-run without --apply to inspect the uncertainty, ` +
        `then repair Git access before retrying.`
    );
  }
  if ((candidates.storage_uncertainties?.length ?? 0) > 0) {
    const operations = [
      ...new Set((candidates.storage_uncertainties ?? []).map((u) => u.operation)),
    ];
    throw new OrcaopsError(
      ErrorCodes.GC_STORAGE_UNCERTAIN,
      `Refusing destructive garbage collection because durable artifact state could not be ` +
        `proven (${operations.join(', ')}). Re-run without --apply to inspect the ` +
        `uncertainty, then repair the hot store or archive before retrying.`
    );
  }
}

function assertGcManagedPath(target: string, repoRoot: string, label: string): string {
  try {
    return assertResolvedWithin(target, repoRoot, label, { rejectSymlinks: true });
  } catch (error) {
    throw new OrcaopsError(
      ErrorCodes.GC_STORAGE_UNCERTAIN,
      `Refusing destructive garbage collection because ${label} could not be proven safe: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertGcProjectionHealthy(health: ProjectionHealth): void {
  if (health === 'healthy') return;
  throw new OrcaopsError(
    ErrorCodes.GC_PROJECTION_UNHEALTHY,
    `Refusing destructive garbage collection because the SQLite projection is ${health}. ` +
      `Run \`orcaops doctor\`, repair or explicitly remove unreadable durable sources, ` +
      `then run \`orcaops rebuild\` before retrying.`
  );
}

function gcScanOptions(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  pinRepoId: string | null,
  retentionDays: number
): Parameters<typeof scanGcCandidates>[0] {
  return {
    store: ctx.store,
    repo: ctx.repo,
    pinRepoId,
    retentionDays,
    env: getInvocationEnv(),
    archiveEnabled: ctx.config.archive.enabled,
    archiveProjectDir: ctx.archive?.projectDir ?? null,
  };
}

/**
 * `orcaops gc` — garbage collection.
 *
 * Categories:
 *   - stale_pins: pin file points at missing/summarized artifact
 *   - unreachable_nonterminal_artifacts: report-only planned, active,
 *     or blocked artifacts whose lineage SHA is unreachable
 *   - abandoned_summarized: summarized + unreachable + outside
 *     retention window
 *   - stale_review_dirs: `.orcaops/reviews/<slug>/` whose branch is
 *     deleted/merged + outside retention window
 *
 * Dry-run by default — emits the candidate list and exits. `--apply`
 * proceeds to delete each candidate (artifact dirs + SQLite rows +
 * pin files; review dirs + their pinned refs). Nonterminal artifacts are
 * never deleted by this command. The retention window
 * applies to `abandoned_summarized` and `stale_review_dirs`; the pin
 * and stale-pin category is structural and acts immediately.
 */
export async function gcAction(opts: GcOptions = {}): Promise<void> {
  try {
    if (opts.retentionDays !== undefined && opts.retentionDays <= 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--retention-days must be a positive integer.',
        'retention-days'
      );
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const retentionDays = opts.retentionDays ?? ctx.config.gc.retention_days;
      // gc is a dry run until `--apply`, so the scan reads the identity
      // without minting one; a repo that has never had an identity has no
      // pins to sweep. Only the applying run mints, and only because it is
      // about to write the pin store.
      const pinRepoId = opts.apply
        ? (await ensureProjectId(ctx.repo)).projectId
        : await readProjectId(ctx.repo);
      let projectionHealth = ctx.store.store.projectionHealth;
      if (opts.apply) assertGcProjectionHealthy(projectionHealth);

      const scanOptions = gcScanOptions(ctx, pinRepoId, retentionDays);
      let candidates = await scanGcCandidates(scanOptions);

      let refInventory = await collectGcRefInventory(ctx.repo, candidates);
      candidates = withRefUncertainties(candidates, refInventory);
      if (opts.apply) assertGcApplySafe(candidates);

      const totalCandidates =
        candidates.stale_pins.length +
        candidates.abandoned_summarized.length +
        candidates.stale_review_dirs.length;

      let deleted: DeleteCounts = {
        stale_pins: 0,
        abandoned_summarized: 0,
        snapshot_refs: 0,
        baseline_refs: 0,
        stale_review_dirs: 0,
        review_refs: 0,
      };
      if (opts.apply && totalCandidates > 0) {
        const revalidatedRefInventory = await collectGcRefInventory(ctx.repo, candidates);
        const revalidatedCandidates = withRefUncertainties(
          await scanGcCandidates(scanOptions),
          revalidatedRefInventory
        );
        assertGcApplySafe(revalidatedCandidates);
        if (
          !gcCandidateSetsEqual(candidates, revalidatedCandidates) ||
          refInventoryKey(refInventory) !== refInventoryKey(revalidatedRefInventory)
        ) {
          throw new OrcaopsError(
            ErrorCodes.GC_CANDIDATES_CHANGED,
            'Refusing destructive garbage collection because the candidate or ref set changed ' +
              'during validation. No changes were applied; run gc again.'
          );
        }

        candidates = revalidatedCandidates;
        refInventory = revalidatedRefInventory;
        projectionHealth = ctx.store.store.projectionHealth;
        assertGcProjectionHealthy(projectionHealth);
        // There is no lock shared by external Git ref writers, pin files,
        // review directories, and SQLite. This final scan is therefore the
        // narrowest available boundary; a writer can still race after it.
        deleted = await applyGc(
          ctx,
          candidates,
          scanOptions,
          refInventory.snapshot.refs,
          refInventory.baseline.refs,
          refInventory.review.refs
        );
      }

      if (opts.json) {
        projectionHealth = ctx.store.store.projectionHealth;
        emitOk({
          applied: opts.apply === true,
          retention_days: retentionDays,
          projection_health: projectionHealth,
          candidates: {
            stale_pins: candidates.stale_pins,
            abandoned_summarized: candidates.abandoned_summarized,
            stale_review_dirs: candidates.stale_review_dirs,
            git_uncertainties: candidates.git_uncertainties,
            ...(candidates.storage_uncertainties !== undefined
              ? { storage_uncertainties: candidates.storage_uncertainties }
              : {}),
          },
          reports: {
            unreachable_nonterminal_artifacts: candidates.unreachable_nonterminal_artifacts,
          },
          would_prune_snapshot_refs: refInventory.snapshot.count,
          would_prune_baseline_refs: refInventory.baseline.count,
          would_prune_review_refs: refInventory.review.count,
          deleted,
        });
        return;
      }
      writeTerminalSafeStdout(
        formatHuman(
          opts.apply === true,
          retentionDays,
          projectionHealth,
          candidates,
          deleted,
          refInventory.snapshot.count,
          refInventory.baseline.count,
          refInventory.review.count
        )
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

async function applyGc(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  candidates: Awaited<ReturnType<typeof scanGcCandidates>>,
  scanOptions: Parameters<typeof scanGcCandidates>[0],
  snapRefs: Map<string, RefIdentity[]>,
  baselineRefs: Map<string, RefIdentity[]>,
  reviewRefs: Map<string, RefIdentity[]>
): Promise<DeleteCounts> {
  const counts: DeleteCounts = {
    stale_pins: 0,
    abandoned_summarized: 0,
    snapshot_refs: 0,
    baseline_refs: 0,
    stale_review_dirs: 0,
    review_refs: 0,
  };

  // Refs are removed after the candidate's durable state commits. Their exact
  // OIDs are CAS guards: a concurrent writer aborts the whole ref transaction
  // and keeps every changed ref, while the already-completed candidate is
  // reported as recoverable partial progress.
  const pruneRefsFor = async (artifactId: string): Promise<void> => {
    const refs = snapRefs.get(artifactId);
    if (refs && refs.length > 0) {
      counts.snapshot_refs += (await pruneSnapshotRefsIfUnchanged(ctx.repo, refs)).deleted;
    }
    const bRefs = baselineRefs.get(artifactId);
    if (bRefs && bRefs.length > 0) {
      counts.baseline_refs += (await pruneBaselineRefsIfUnchanged(ctx.repo, bRefs)).deleted;
    }
  };

  let reviewsRoot: string | null = null;
  let reviewTrashRoot: string | null = null;
  if (candidates.stale_review_dirs.length > 0) {
    reviewsRoot = assertGcManagedPath(
      path.join(ctx.repoRoot, '.orcaops', 'reviews'),
      ctx.repoRoot,
      'review state root'
    );
    reviewTrashRoot = assertGcManagedPath(
      path.join(ctx.repoRoot, '.orcaops', 'tmp', 'trash'),
      ctx.repoRoot,
      'review deletion trash root'
    );
    await mkdir(reviewTrashRoot, { recursive: true });
    reviewTrashRoot = assertGcManagedPath(
      reviewTrashRoot,
      ctx.repoRoot,
      'review deletion trash root'
    );
  }

  for (const pin of candidates.stale_pins) {
    // A stale-pin candidate can only exist when the repo has a minted identity
    // (the scanner returns none otherwise), so the narrow is for TS, not policy.
    if (scanOptions.pinRepoId === null) break;
    let removed = false;
    let counted = false;
    try {
      await withPinFileLock(
        { repoId: scanOptions.pinRepoId, key: pin.shell_key, env: scanOptions.env },
        async (pinFile) => {
          const current = await pinFile.read();
          if (current === null || pinIdentity(current) !== pin.pin_identity) {
            throw candidateChanged('stale pin', pin.artifact_id);
          }
          await ctx.store.withArtifactLock(current.artifact_id, async () => {
            const revalidateAndClear = async (): Promise<void> => {
              await withNonDerivableWriteLease(ctx.repoRoot, async () => {
                assertGcProjectionHealthy(ctx.store.store.projectionHealth);
                const revalidated = await scanPinGcCandidate(current, scanOptions);
                if (revalidated.uncertainties.length > 0) {
                  assertGcApplySafe({
                    stale_pins: [],
                    unreachable_nonterminal_artifacts: [],
                    abandoned_summarized: [],
                    stale_review_dirs: [],
                    git_uncertainties: [],
                    storage_uncertainties: revalidated.uncertainties,
                  });
                }
                if (!sameCandidate(revalidated.candidate, pin)) {
                  throw candidateChanged('stale pin', pin.artifact_id);
                }
                await pinFile.assertLease();
                removed = await pinFile.clear();
                if (!removed) throw candidateChanged('stale pin', pin.artifact_id);
              });
            };
            if (ctx.archive) {
              await ctx.archive.withArtifactLock(current.artifact_id, revalidateAndClear);
            } else {
              await revalidateAndClear();
            }
          });
        }
      );
      counts.stale_pins += 1;
      counted = true;
    } catch (err) {
      if (removed && !counted) counts.stale_pins += 1;
      throwGcProgress(err, counts, 'stale_pin', pin.artifact_id, removed);
    }
  }
  for (const a of candidates.abandoned_summarized) {
    await applyArtifactCandidate(a);
  }

  // Lock order is review-state -> raw slug. This matches journal/comment
  // publication and prevents GC from deleting a live writer's directory.
  const reviewLock = new ArtifactLock({
    locksDir: reviewLocksDir(ctx.repoRoot),
    containmentRoot: ctx.repoRoot,
    heartbeatIntervalMs: 30_000,
  });
  for (const rd of candidates.stale_review_dirs) {
    if (reviewsRoot === null || reviewTrashRoot === null) {
      throw new Error('review deletion roots were not prepared');
    }
    let removed = false;
    let counted = false;
    const detached = path.join(reviewTrashRoot, `review-${randomUUID()}`);
    try {
      await reviewLock.withLock(reviewFloorLockKey(rd.slug), async (stateLease) => {
        await reviewLock.withLock(rd.slug, async (slugLease) => {
          await withNonDerivableWriteLease(ctx.repoRoot, async () => {
            assertGcProjectionHealthy(ctx.store.store.projectionHealth);
            const current = await scanGcCandidates(scanOptions);
            assertGcApplySafe(current);
            const revalidated = current.stale_review_dirs.find((item) => item.slug === rd.slug);
            if (!sameCandidate(revalidated ?? null, rd)) {
              throw candidateChanged('stale review directory', rd.slug);
            }
            await stateLease.verify();
            await slugLease.verify();
            const resolvedDir = assertGcManagedPath(rd.dir, ctx.repoRoot, 'stale review directory');
            const resolvedDetached = assertGcManagedPath(
              detached,
              ctx.repoRoot,
              'review deletion staging path'
            );
            if (
              path.dirname(resolvedDir) !== reviewsRoot ||
              path.dirname(resolvedDetached) !== reviewTrashRoot
            ) {
              throw candidateChanged('stale review directory', rd.slug);
            }
            await rename(resolvedDir, resolvedDetached);
            removed = true;
          });
          counts.stale_review_dirs += 1;
          counted = true;
          const refs = reviewRefs.get(rd.slug);
          if (refs && refs.length > 0) {
            counts.review_refs += (await pruneReviewRefsIfUnchanged(ctx.repo, refs)).deleted;
          }
          await rm(detached, { recursive: true, force: true, maxRetries: 3 });
        });
      });
    } catch (err) {
      if (removed && !counted) counts.stale_review_dirs += 1;
      throwGcProgress(err, counts, 'stale_review_dir', rd.slug, removed);
    }
  }
  return counts;

  async function applyArtifactCandidate(candidate: GcArtifactCandidate): Promise<void> {
    let committed = false;
    let counted = false;
    try {
      await ctx.store.deleteArtifact(candidate.artifact_id, {
        beforeDelete: async () => {
          assertGcProjectionHealthy(ctx.store.store.projectionHealth);
          const current = await scanGcCandidates(scanOptions);
          assertGcApplySafe(current);
          const revalidated = current.abandoned_summarized.find(
            (item) => item.artifact_id === candidate.artifact_id
          );
          if (!sameCandidate(revalidated ?? null, candidate)) {
            throw candidateChanged('artifact', candidate.artifact_id);
          }
        },
      });
      committed = true;
      counts.abandoned_summarized += 1;
      counted = true;
      await pruneRefsFor(candidate.artifact_id);
    } catch (err) {
      if (err instanceof ArtifactDeletionRecoveryError && err.semanticCommitted) {
        committed = true;
      }
      if (committed && !counted) counts.abandoned_summarized += 1;
      throwGcProgress(err, counts, 'abandoned_summarized', candidate.artifact_id, committed);
    }
  }
}

function sameCandidate(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateChanged(kind: string, id: string): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.GC_CANDIDATES_CHANGED,
    `Refusing to delete ${kind} ${id} because it changed during per-candidate validation.`
  );
}

function throwGcProgress(
  error: unknown,
  counts: DeleteCounts,
  kind: 'stale_pin' | 'abandoned_summarized' | 'stale_review_dir',
  id: string,
  recoverableInProgress: boolean
): never {
  const completed = { ...counts };
  const priorCompletion = Object.values(completed).some((count) => count > 0);
  const gc_progress = {
    state: recoverableInProgress
      ? ('recoverable_in_progress' as const)
      : priorCompletion
        ? ('partial_completion' as const)
        : ('refused' as const),
    completed,
    failed_candidate: { kind, id },
  };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OrcaopsError) {
    throw new OrcaopsError(error.code, error.message, error.inputPath, {
      ...(error.details ?? {}),
      gc_progress,
    });
  }
  throw new OrcaopsError(
    ErrorCodes.GC_APPLY_FAILED,
    `Garbage collection stopped at ${kind} ${id}: ${message}`,
    undefined,
    { gc_progress }
  );
}

function formatHuman(
  applied: boolean,
  retentionDays: number,
  projectionHealth: ProjectionHealth,
  candidates: Awaited<ReturnType<typeof scanGcCandidates>>,
  deleted: DeleteCounts,
  wouldPruneSnapshotRefs: number | null,
  wouldPruneBaselineRefs: number | null,
  wouldPruneReviewRefs: number | null
): string {
  const lines: string[] = [];
  lines.push(
    applied
      ? `orcaops gc — applied (retention=${retentionDays}d)`
      : `orcaops gc — dry-run (retention=${retentionDays}d, pass --apply to delete)`
  );
  lines.push(`  projection_health:    ${projectionHealth}`);
  if (projectionHealth !== 'healthy') {
    lines.push('    --apply is refused until `orcaops rebuild` completes without skips.');
  }
  lines.push('');
  lines.push(
    `  stale_pins:           ${candidates.stale_pins.length}` +
      (applied ? ` → deleted ${deleted.stale_pins}` : '')
  );
  for (const p of candidates.stale_pins) {
    lines.push(`    - ${p.artifact_id} (${p.shell_key.kind}): ${p.reason}`);
  }
  lines.push(
    `  unreachable_nonterminal_artifacts: ${candidates.unreachable_nonterminal_artifacts.length} ` +
      '(report only; never deleted by gc)'
  );
  for (const a of candidates.unreachable_nonterminal_artifacts) {
    lines.push(`    - ${a.artifact_id} (${a.branch}, ${a.state}): ${truncate(a.task, 60)}`);
  }
  lines.push(
    `  abandoned_summarized: ${candidates.abandoned_summarized.length}` +
      (applied ? ` → deleted ${deleted.abandoned_summarized}` : '')
  );
  for (const a of candidates.abandoned_summarized) {
    lines.push(
      `    - ${a.artifact_id} (${a.branch}, summarized ${a.summarized_at}): ${truncate(a.task, 60)}`
    );
  }
  lines.push(
    `  stale_review_dirs:    ${candidates.stale_review_dirs.length}` +
      (applied ? ` → deleted ${deleted.stale_review_dirs}` : '')
  );
  for (const d of candidates.stale_review_dirs) {
    lines.push(`    - ${d.branch} (${d.reason}, modified ${d.last_modified})`);
  }
  lines.push(`  git_uncertainties:    ${candidates.git_uncertainties.length}`);
  for (const uncertainty of candidates.git_uncertainties) {
    lines.push(`    - ${uncertainty.operation}: ${uncertainty.subject}`);
  }
  if (candidates.git_uncertainties.length > 0) {
    lines.push('    --apply is refused until Git state can be proven.');
  }
  lines.push(
    `  storage_uncertainties:${String(candidates.storage_uncertainties?.length ?? 0).padStart(5)}`
  );
  for (const uncertainty of candidates.storage_uncertainties ?? []) {
    lines.push(`    - ${uncertainty.operation} (${uncertainty.subject}): ${uncertainty.reason}`);
  }
  if ((candidates.storage_uncertainties?.length ?? 0) > 0) {
    lines.push('    --apply is refused until durable artifact state can be proven.');
  }
  lines.push(
    formatRefCount('snapshot_refs', wouldPruneSnapshotRefs, applied, deleted.snapshot_refs)
  );
  lines.push(
    formatRefCount('baseline_refs', wouldPruneBaselineRefs, applied, deleted.baseline_refs)
  );
  lines.push(formatRefCount('review_refs', wouldPruneReviewRefs, applied, deleted.review_refs));
  lines.push('');
  return lines.join('\n');
}

function formatRefCount(
  label: string,
  count: number | null,
  applied: boolean,
  deleted: number
): string {
  const paddedLabel = `${label}:`.padEnd(24);
  if (count === null) return `  ${paddedLabel}unknown (Git state unavailable)`;
  return `  ${paddedLabel}${count}${applied ? ` → deleted ${deleted}` : ' (would prune on --apply)'}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
