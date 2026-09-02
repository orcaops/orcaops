import { flushPendingPushes, resolveCloudTarget, resolveCredentialStore } from '@orcaops/core';

import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

export interface ResyncOptions {
  json?: boolean;
  /** Target cloud base URL; defaults to the resolved cloud (write intent). */
  baseUrl?: string;
  /**
   * When true, the underlying drain ignores per-artifact exponential
   * backoff. The ONLY surface that sets this is `orcaops resync --force`;
   * implicit drains (every capture command, login) leave it false so a
   * thundering-herd on a permanently-broken artifact requires explicit
   * user intent.
   */
  force?: boolean;
}

/**
 * Manually flush any artifacts whose last eager push may have failed.
 * Same code path as the implicit drain inside every capture command;
 * exposes it as an explicit user-triggered knob for cron / scripting and
 * for after-the-fact recovery (e.g. when a finalize-fired summary push
 * was lost to a flaky network and there are no further captures coming).
 */
export async function resyncAction(opts: ResyncOptions = {}): Promise<void> {
  try {
    const credentialStore = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);

    const ctx = await buildContext();
    try {
      const result = await flushPendingPushes({
        env: getInvocationEnv(),
        store: ctx.store,
        repo: ctx.repo,
        repoRoot: ctx.repoRoot,
        credentialStore,
        baseUrl,
        ...(opts.force === true ? { force: true } : {}),
      });
      if (opts.json) {
        emitOk(result);
        return;
      }
      if (result.skipped) {
        const reason =
          result.reason === 'not-connected'
            ? 'not connected — run `orcaops login` first'
            : result.reason === 'missing-remote'
              ? 'no `origin` remote configured'
              : 'drain disabled by ORCAOPS_DISABLE_DRAIN';
        writeTerminalSafeStdout(`Skipped: ${reason}.\n`);
        return;
      }
      writeTerminalSafeStdout(
        `Drained ${result.attempted} artifact(s)` +
          (result.timedOut ? ' (timed out before completing the queue)' : '') +
          '.\n'
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    emitError(err);
  }
}
