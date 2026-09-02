import {
  ArtifactLockTimeoutError,
  type ArtifactState,
  EventLogAppendRefusedError,
  type Pin,
  RecoveryRefusedError,
  resolveShellKey,
  type ShellKey,
  withPinFileLock,
} from '@orcaops/storage';

import type { CliContext } from './context.js';
import { getInvocationEnv } from './invocation-context.js';
import { ensureProjectId, readProjectId } from './project-identity.js';

/**
 * Pin orchestration helpers shared between explicit checkout,
 * capture-plan auto-pin, and capture-summary auto-clear.
 *
 * Two responsibilities live here, not in the storage primitives:
 *   1. Resolve the (repoId, shellKey) pair from the runtime context.
 *   2. Emit `pin_displaced` on the **previously-pinned** artifact when
 *      a pin is overwritten while that artifact is still active or
 *      blocked. The summarized-overwrite case is silent (no event).
 */

export interface ResolvedPinTargets {
  repoId: string;
  shellKey: ShellKey;
}

export async function resolvePinTargets(ctx: CliContext): Promise<ResolvedPinTargets> {
  // Mint-on-first-use: any invocation that needs the identity may create it
  // (ensureProjectId's contract), and pins are keyed by it verbatim.
  const { projectId } = await ensureProjectId(ctx.repo);
  return {
    repoId: projectId,
    shellKey: resolveShellKey({ env: getInvocationEnv() }),
  };
}

export interface ReadPinTargets {
  /** Null when this repo has no minted identity — nothing can be pinned yet. */
  repoId: string | null;
  shellKey: ShellKey;
}

/**
 * The non-minting form, for verbs that only REPORT pin state. Minting takes a
 * cross-worktree lock and writes `git config --local`, so doing it from a read
 * verb turns a survey command into a writer that can fail on a read-only
 * checkout or under config-lock contention. No identity simply means no pin.
 */
export async function resolvePinTargetsForRead(ctx: CliContext): Promise<ReadPinTargets> {
  return {
    repoId: await readProjectId(ctx.repo),
    shellKey: resolveShellKey({ env: getInvocationEnv() }),
  };
}

export type PriorArtifactFailureKind =
  | 'unreadable'
  | 'append_refused'
  | 'lock_timeout'
  | 'read_errno';

export interface ReplacePinResult {
  pin: Pin;
  /** When non-null, a pin_displaced event was emitted on this artifact. */
  displacedArtifactId: string | null;
  /** Path to the on-disk pin file for diagnostics. */
  pinFile: string;
  /** Set when `containPriorArtifactFailure` swallowed a prior-artifact
   *  failure: the displacement event was skipped, the new pin was still
   *  written, and the caller owes the operator a disclosure. */
  priorArtifactFailure?: {
    artifactId: string;
    kind: PriorArtifactFailureKind;
    message: string;
  };
}

export interface ReplacePinOptions {
  ctx: CliContext;
  artifactId: string;
  branch: string;
  pinnedAt: string;
  pinnedVia: 'auto-on-capture-plan' | 'explicit-checkout';
  targets: ResolvedPinTargets;
  /** Capture-plan only: the pin runs AFTER the plan is durably written, so
   *  a failure caused solely by the previously-pinned artifact (corruption
   *  refusal, permission-class read error, its lock held) must not fail the
   *  capture. Contains exactly those shapes around the prior-artifact
   *  phase; the new pin's own write stays loud. Checkout/resume leave this
   *  off — they write nothing durable first, so their loud refusal is
   *  correct. Path-guard refusals (symlink/traversal) are NEVER contained. */
  containPriorArtifactFailure?: boolean;
}

export function classifyPriorArtifactFailure(
  err: unknown,
  phase: 'read' | 'write'
): PriorArtifactFailureKind | null {
  if (err instanceof RecoveryRefusedError) return 'unreadable';
  if (err instanceof EventLogAppendRefusedError) {
    return err.shape === 'unreadable' ? 'read_errno' : 'append_refused';
  }
  if (err instanceof ArtifactLockTimeoutError) return 'lock_timeout';
  // Raw errno failures (EACCES/EPERM/EIO…) are permission-class
  // unreadability — but ONLY in the read phase. In the write phase the
  // displacement line may already be on disk (an fsync/close failure),
  // so a swallowed errno would falsely disclose "no displacement
  // written"; the append preflight's own read failures arrive typed
  // (shape 'unreadable') above. Path-guard refusals throw plain Errors
  // without errno and deliberately fall through in both phases —
  // silencing a traversal guard would convert a security refusal into
  // a warning.
  if (
    phase === 'read' &&
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).errno === 'number'
  ) {
    return 'read_errno';
  }
  return null;
}

/**
 * Write a pin for the current shell-key, replacing whatever pin was
 * there before. If the prior pin pointed at an `active` or `blocked`
 * artifact, emit a `pin_displaced` event on that prior artifact.
 *
 * Caller must have validated `targets.shellKey.kind !== 'none'`.
 */
export async function replacePin(opts: ReplacePinOptions): Promise<ReplacePinResult> {
  const { ctx, artifactId, branch, pinnedAt, pinnedVia, targets } = opts;
  if (targets.shellKey.kind === 'none') {
    // Defense in depth — the public CLI surface rejects this earlier
    // with NO_SHELL_KEY.
    throw new Error('replacePin requires a resolvable shell-key (kind !== "none").');
  }

  return withPinFileLock(
    { repoId: targets.repoId, key: targets.shellKey, env: getInvocationEnv() },
    async (pinFileHandle) => {
      const previous = await pinFileHandle.read();
      let displacedArtifactId: string | null = null;
      let priorArtifactFailure: ReplacePinResult['priorArtifactFailure'];
      if (previous && previous.artifact_id !== artifactId) {
        const contain = (err: unknown, phase: 'read' | 'write'): void => {
          const kind =
            opts.containPriorArtifactFailure === true
              ? classifyPriorArtifactFailure(err, phase)
              : null;
          if (kind === null) throw err;
          priorArtifactFailure = {
            artifactId: previous.artifact_id,
            kind,
            message: err instanceof Error ? err.message : String(err),
          };
        };
        let priorState: ArtifactState | null = null;
        try {
          priorState = await loadArtifactState(ctx, previous.artifact_id);
        } catch (err) {
          contain(err, 'read');
        }
        if (priorState === 'active' || priorState === 'blocked') {
          try {
            await ctx.store.writePinDisplaced(previous.artifact_id, {
              displaced_by_artifact_id: artifactId,
              shell_key: targets.shellKey,
              reason: pinnedVia,
            });
            displacedArtifactId = previous.artifact_id;
          } catch (err) {
            contain(err, 'write');
          }
        }
      }

      const pin: Pin = {
        schema_version: 1,
        artifact_id: artifactId,
        branch,
        shell_key: targets.shellKey,
        pinned_at: pinnedAt,
        pinned_via: pinnedVia,
      };
      const pinFile = await pinFileHandle.write(pin);
      return {
        pin,
        displacedArtifactId,
        pinFile,
        ...(priorArtifactFailure !== undefined ? { priorArtifactFailure } : {}),
      };
    }
  );
}

/**
 * Clear the pin for the current shell-key. No-op when the pin doesn't
 * exist, when the shell-key is `none`, or when an `expectArtifactId`
 * is supplied and doesn't match the current pin. The last condition
 * keeps capture-summary's auto-clear from accidentally wiping a
 * different artifact's pin.
 */
export async function clearPinForCurrentShell(opts: {
  targets: ResolvedPinTargets;
  expectArtifactId?: string;
}): Promise<{ cleared: boolean; pin: Pin | null }> {
  const { targets, expectArtifactId } = opts;
  if (targets.shellKey.kind === 'none') return { cleared: false, pin: null };

  return withPinFileLock(
    { repoId: targets.repoId, key: targets.shellKey, env: getInvocationEnv() },
    async (pinFile) => {
      const existing = await pinFile.read();
      if (!existing) return { cleared: false, pin: null };
      if (expectArtifactId !== undefined && existing.artifact_id !== expectArtifactId) {
        return { cleared: false, pin: existing };
      }
      return { cleared: await pinFile.clear(), pin: existing };
    }
  );
}

async function loadArtifactState(
  ctx: CliContext,
  artifactId: string
): Promise<ArtifactState | null> {
  const artifact = await ctx.store.readArtifact(artifactId);
  return artifact?.state ?? null;
}
