import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  configFromSource,
  Repo,
  resolveConfigSource,
  type ResolvedConfigSource,
} from '@orcaops/core';
import { ProjectIdentityError, readProjectId } from '@orcaops/project-scope';
import {
  type ArchiveMirror,
  ArtifactDeletionRecoveryError,
  ArtifactLockLeaseLostError,
  ArtifactStore,
  cacheDbPath,
  type Config,
  ConfigValidationError,
  openEmptyArtifactStore,
  prepareArtifactStoreForRead,
  probeHotState,
  type RebuildResult,
  SchemaAheadError,
  Store,
  UnsupportedSchemaVersionError,
} from '@orcaops/storage';

import { buildArchiveContext } from './archive-context.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationInvokedByAgent,
} from './invocation-context.js';
import { type InvokingAgentResolution, resolveInvokingAgent } from './invoking-agent.js';
import { resolveOrcaopsRoot } from './resolve-root.js';
import { resolveSkillGates, type SkillGates } from './skill-set.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { writeTerminalSafeStderr } from '../io/output.js';

export interface CliContext {
  repoRoot: string;
  config: Config;
  repo: Repo;
  store: ArtifactStore;
  /**
   * Archive mirror when `archive.enabled` resolved successfully; null when
   * disabled or when archive wiring failed (fail-open — the command runs
   * without archiving). Threaded into every write surface (ArtifactStore
   * here, UsageLedger via usage-stamp).
   */
  archive: ArchiveMirror | null;
  /**
   * The runtime-resolved invoking agent for THIS invocation
   * (flag > ORCAOPS_INVOKED_BY_AGENT > ambient markers > 'other').
   * Resolved once here so every stamp site within one command agrees.
   */
  invokingAgent: InvokingAgentResolution;
  /** True when this open completed a required destructive cache rebuild. */
  healedProjection: boolean;
  /** The rebuild's replay counts when healedProjection is true; null otherwise. */
  healResult: RebuildResult | null;
  /**
   * Resolved once per invocation, like `invokingAgent`: a command that asked
   * twice could plan an install against one answer and write the manifest
   * against the other.
   */
  gates: SkillGates;
}

export interface ContextOptions {
  cwd?: string;
  /** When true (default), require `.orcaops/` to exist; init bypasses with false. */
  requireInit?: boolean;
  /**
   * Already-resolved root supplied programmatically (highest precedence
   * in `resolveOrcaopsRoot`, skipping discovery). The `--root` flag itself
   * arrives via ALS, not here.
   */
  root?: string;
  /** Allow only the explicit rebuild command to replace a non-current cache. */
  destructiveRebuild?: boolean;
  /**
   * Read verbs pass false so archive wiring never mints the repo identity —
   * a survey command must not become a writer. Event-writing verbs keep the
   * default mint-on-first-use so their events mirror from the first capture.
   */
  mintArchiveIdentity?: boolean;
}

/**
 * Build the runtime context every command (except `init`) needs:
 * resolved repo root, validated git repo, loaded config, opened ArtifactStore.
 *
 * Caller MUST call `ctx.store.close()` when done (use try/finally).
 */
export async function buildContext(opts: ContextOptions = {}): Promise<CliContext> {
  const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
  // Anchor to the git worktree root (or an explicit --root / ORCAOPS_ROOT
  // override) so a command works from any subdirectory. Throws NOT_A_REPO
  // when cwd is not in a git work tree and no override is set.
  const repoRoot = await resolveOrcaopsRoot({ cwd, root: opts.root });
  const repo = new Repo(repoRoot);

  try {
    await repo.getCurrentBranch();
  } catch {
    try {
      await access(path.join(repoRoot, '.orcaops'));
      await readProjectId(repo);
    } catch (error) {
      if (error instanceof ProjectIdentityError) {
        throw new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message);
      }
    }
    throw new OrcaopsError(
      ErrorCodes.NOT_A_REPO,
      `${repoRoot} is not a git repository (or has no commits yet).`
    );
  }

  // Initialization is a property of the CONFIG, not of `<worktree>/.orcaops`:
  // a personal install lives in the git common dir, so requiring a local
  // directory would report every linked worktree uninitialized, and a
  // leftover data directory would report an uninstalled one as ready.
  let source: ResolvedConfigSource;
  let config: Config;
  try {
    source = await resolveConfigSource(repoRoot);
    config = configFromSource(source);
  } catch (err) {
    // Storage's `ConfigValidationError` carries the offending dotted
    // path. Remap to the public `INVALID_CONFIG` envelope at the CLI
    // boundary — storage doesn't depend on the CLI's error registry.
    if (err instanceof ConfigValidationError) {
      throw new OrcaopsError(ErrorCodes.INVALID_CONFIG, err.message, err.path);
    }
    throw err;
  }
  if (opts.requireInit !== false && source.kind === 'none') {
    throw new OrcaopsError(
      ErrorCodes.UNINITIALIZED,
      `${repoRoot} is not initialized for orcaops. Run \`orcaops init\` first ` +
        `(resolved root: ${repoRoot}; override the root with --root or ORCAOPS_ROOT).`
    );
  }
  // Archive wiring: fail-open — a null mirror simply means this
  // invocation does not archive. The disabled path costs nothing.
  const archive =
    (await buildArchiveContext(repoRoot, config, repo, { mintIdentity: opts.mintArchiveIdentity }))
      ?.mirror ?? null;
  let store: ArtifactStore;
  let destructiveStore: Store | null = null;
  // A read verb on a governed worktree that holds no data yet must not
  // materialize the cache or the locks dir; it reads an in-memory projection.
  // Write verbs (mint-on-first-use) open normally and create what they store.
  const emptyReadOnly =
    opts.mintArchiveIdentity === false &&
    opts.destructiveRebuild !== true &&
    probeHotState(repoRoot, config).empty;
  try {
    if (emptyReadOnly) {
      store = openEmptyArtifactStore(repoRoot, config);
    } else {
      if (opts.destructiveRebuild === true) {
        destructiveStore = new Store(cacheDbPath(repoRoot, config), {
          containmentRoot: repoRoot,
          rebuildExistingProjection: true,
        });
      }
      store = new ArtifactStore({
        repoRoot,
        config,
        archive,
        store: destructiveStore ?? undefined,
      });
    }
  } catch (err) {
    destructiveStore?.close();
    // Storage's `SchemaAheadError` fires when the on-disk SQLite cache
    // is at a higher version than this CLI knows. Remap to the public
    // `SCHEMA_AHEAD` envelope at the CLI boundary; storage doesn't
    // depend on the CLI's error registry.
    if (err instanceof SchemaAheadError) {
      throw new OrcaopsError(ErrorCodes.SCHEMA_AHEAD, err.message);
    }
    if (err instanceof UnsupportedSchemaVersionError) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, err.message);
    }
    throw err;
  }
  const preparation = emptyReadOnly
    ? null
    : await prepareArtifactStoreForRead({
        store,
        onPlanIdempotencyConflicts: (conflicts) => {
          writeTerminalSafeStderr(
            `warning: ${conflicts.length} plan idempotency key(s) appear in ` +
              `multiple artifacts' event logs (filesystem-level corruption); ` +
              `the first artifact holds each key — run \`orcaops doctor\`.\n`
          );
        },
      });
  if (preparation?.reconciliation?.restored.length) {
    writeTerminalSafeStderr(
      `warning: restored ${preparation.reconciliation.restored.length} interrupted artifact ` +
        `deletion(s) from protected staging; rebuilding the SQLite projection.\n`
    );
  }
  if (preparation?.issue?.kind === 'deletion_reconciliation_failed') {
    store.close();
    const error = preparation.issue.cause;
    if (error instanceof ArtifactDeletionRecoveryError) {
      throw new OrcaopsError(ErrorCodes.RECOVERY_REQUIRED, error.message);
    }
    throw error;
  }

  // A failed rebuild must not wedge every command: preparation leaves durable
  // health pending and the command can disclose the incomplete projection.
  if (preparation?.issue?.kind === 'projection_rebuild_failed') {
    const error = preparation.issue.cause;
    if (error instanceof ArtifactLockLeaseLostError) {
      const pendingRebuild = store.store.projectionHealth === 'rebuild_pending';
      writeTerminalSafeStderr(
        pendingRebuild
          ? `warning: the cache rebuild lost its lock lease (a ` +
              `concurrent rebuild may have interleaved) and aborted before ` +
              `finalizing; the next command will retry the rebuild.\n`
          : `warning: the cache rebuild finished but lost its lock lease (a ` +
              `concurrent rebuild may have interleaved); run \`orcaops ` +
              `rebuild\` if data looks incomplete.\n`
      );
    } else {
      writeTerminalSafeStderr(
        `warning: the SQLite cache could not be rebuilt from the event logs ` +
          `(${preparation.issue.message}); commands may see incomplete data until ` +
          `\`orcaops rebuild\` succeeds. Run \`orcaops doctor\` to diagnose.\n`
      );
    }
  }
  const healResult: RebuildResult | null = preparation?.rebuild ?? null;
  const healedProjection = healResult !== null;
  if (healResult && healResult.skipped_artifacts > 0) {
    writeTerminalSafeStderr(
      `warning: ${healResult.skipped_artifacts} artifact(s) had malformed ` +
        `durable sources and were skipped during the cache rebuild; destructive ` +
        `garbage collection is disabled — run \`orcaops doctor\`.\n`
    );
  }
  if (!healedProjection && store.store.projectionHealth === 'degraded') {
    const skipped = store.store.projectionSkippedArtifacts;
    writeTerminalSafeStderr(
      `warning: the SQLite projection is degraded` +
        (skipped === null ? '' : ` (${skipped} skipped artifact(s))`) +
        `; cache-backed results may be incomplete and destructive garbage collection ` +
        `is disabled — run \`orcaops doctor\`.\n`
    );
  }
  // The flag arrives via the ALS invocation frame (preAction hook); only
  // capture subcommands register it, so non-capture commands resolve from
  // env/ambient harmlessly. Throws INVALID_INPUT on an invalid flag value.
  const invokingAgent = resolveInvokingAgent({ flag: getInvocationInvokedByAgent() });
  const gates = resolveSkillGates(getInvocationEnv());
  return {
    repoRoot,
    config,
    repo,
    store,
    archive,
    invokingAgent,
    gates,
    healedProjection,
    healResult,
  };
}
