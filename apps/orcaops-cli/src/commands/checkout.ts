import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';
import { clearPinForCurrentShell, replacePin, resolvePinTargets } from '../lib/pin-helpers.js';

export interface CheckoutOptions {
  /** Artifact id to pin. Mutually exclusive with `--clear`. */
  artifactId?: string;
  /** When true, clear the pin for the current shell instead of writing one. */
  clear?: boolean;
  json?: boolean;
}

/**
 * `orcaops checkout <artifact-id>` — explicit pin for the current shell.
 * `orcaops checkout --clear` — clear the pin for the current shell.
 *
 * Pin storage is per-(repo, shell-key); see
 * `packages/storage/src/pins/`. When the explicit checkout displaces
 * a pin still pointing at an `active` or `blocked` artifact, a
 * `pin_displaced` event is emitted on that prior artifact so doctor
 * can later prompt "was A abandoned?".
 *
 * Headless / CI shells without any of the recognized session env vars
 * resolve to `kind: 'none'`. There is no pin to write; we surface
 * `NO_SHELL_KEY` so the caller can decide whether to skip pinning
 * (`resume --no-pin` covers that case).
 */
export async function checkoutAction(opts: CheckoutOptions): Promise<void> {
  try {
    if (opts.clear && opts.artifactId !== undefined) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '`orcaops checkout --clear` does not take an artifact id.'
      );
    }
    if (!opts.clear && (opts.artifactId === undefined || opts.artifactId.length === 0)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Missing artifact id. Pass `<artifact-id>` to pin, or `--clear` to remove the current pin.'
      );
    }

    const ctx = await buildContext();
    try {
      const targets = await resolvePinTargets(ctx);
      if (targets.shellKey.kind === 'none') {
        throw new OrcaopsError(
          ErrorCodes.NO_SHELL_KEY,
          'No shell-key resolvable from environment. Set $CLAUDE_SESSION_ID, ' +
            '$CODEX_SESSION_ID, $TMUX_PANE, $STY+$WINDOW, or $TTY before retrying.'
        );
      }

      if (opts.clear) {
        const result = await clearPinForCurrentShell({ targets });
        if (opts.json) {
          emitOk({
            action: 'cleared',
            cleared: result.cleared,
            shell_key: targets.shellKey,
            previous_artifact_id: result.pin?.artifact_id ?? null,
          });
          return;
        }
        if (result.cleared && result.pin) {
          writeTerminalSafeStdout(
            `Cleared pin (was ${result.pin.artifact_id} on ${result.pin.branch}).\n`
          );
        } else {
          writeTerminalSafeStdout('No pin to clear for this shell.\n');
        }
        return;
      }

      // Explicit checkout: validate artifact, write pin, emit
      // pin_displaced if appropriate.
      const artifactId = opts.artifactId as string;
      const artifactRow = ctx.store.store.getArtifact(artifactId);
      if (!artifactRow) {
        throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
      }
      const artifact = await ctx.store.readArtifact(artifactId);
      if (artifact === null) {
        throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
      }
      if (artifact.state === 'summarized') {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Cannot pin summarized artifact "${artifactId}"; its work is already complete.`,
          'artifactId'
        );
      }
      const result = await replacePin({
        ctx,
        artifactId,
        branch: artifactRow.branch,
        pinnedAt: new Date().toISOString(),
        pinnedVia: 'explicit-checkout',
        targets,
      });

      if (opts.json) {
        emitOk({
          action: 'pinned',
          artifact_id: artifactId,
          branch: artifactRow.branch,
          shell_key: targets.shellKey,
          pin_file: result.pinFile,
          displaced_artifact_id: result.displacedArtifactId,
        });
        return;
      }
      const lines: string[] = [
        `Pinned ${artifactId}  (${artifactRow.task})`,
        `  branch: ${artifactRow.branch}`,
        `  shell-key: ${targets.shellKey.kind}`,
      ];
      if (result.displacedArtifactId) {
        lines.push(
          `  displaced ${result.displacedArtifactId} (still active or blocked — emitted pin_displaced)`
        );
      }
      writeTerminalSafeStdout(lines.join('\n') + '\n');
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
