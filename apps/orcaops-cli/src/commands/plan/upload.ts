import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { resolveCloudTarget, resolveCredentialStore, resolveReviewBaseline } from '@orcaops/core';
import { createCanonicalCloudClient } from '@orcaops/core/history';
import {
  OssSourcePlanUploadPayload,
  type SourcePlanReviewerDiscoveryResponse,
  type SourcePlanUploadResponse,
} from '@orcaops/sdk';
import { firstForbiddenControlChar } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import {
  emitError,
  emitOk,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { CLI_VERSION } from '../../lib/cli-version.js';
import {
  assertNoSecretsOutbound,
  type AuthoredField,
  type WithSecretWarnings,
  writeSecretWarnings,
} from '../../lib/cloud-secret-gate.js';
import {
  type DatabaseCaptureCommandContext,
  openDatabaseCaptureWriter,
  resolveDatabaseCaptureContext,
} from '../../lib/database-capture-context.js';
import { runDatabaseSourcePlanUpload } from '../../lib/database-source-plan-upload.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';
import type { ReviewerSuggestion } from '../../lib/source-plan-upload-shared.js';
import { reviewUsageStamp } from '../../lib/usage-stamp.js';

export {
  computeUploadExternalId,
  computeUploadFingerprint,
  displaySafeSourceRef,
  suggestReviewers,
  type ReviewerSuggestion,
  type UploadFingerprintInput,
} from '../../lib/source-plan-upload-shared.js';

export interface PlanUploadOptions {
  title?: string;
  reviewer?: string[];
  reviewNote?: string;
  baseUrl?: string;
  json?: boolean;
}

/**
 * The cloud methods the upload operation needs — fakeable in tests. `listReviewers`
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

async function stampPlanUploadUsage(
  context: DatabaseCaptureCommandContext,
  result: PlanUploadResult,
  signal: AbortSignal,
  onWait: () => void
): Promise<void> {
  let writer;
  try {
    if (signal.aborted)
      throw new ProjectDatabaseError('CANCELLED', 'Plan upload cancelled before usage attribution');
    writer = await openDatabaseCaptureWriter(context, signal);
    await stampDatabaseUsage(
      writer,
      {
        descriptor: reviewUsageStamp('upload', result.external_id),
        invokingAgent: context.invokingAgent.agent,
        env: context.env,
        cwd: getInvocationCwd(),
        secretAllow: context.config.redact.allow,
      },
      { signal, onWait }
    );
  } catch {
    return;
  } finally {
    writer?.close();
  }
}

/**
 * Upload a local plan file as a cloud draft for web review. `--title` is
 * required. The upload id is crash-safe and deterministic, so a re-run of
 * the same file+content replays onto the same
 * draft; an edit mints a new (immutable) draft and the prior-draft id is
 * reported.
 */
export async function planUploadAction(file: string, opts: PlanUploadOptions = {}): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
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
    // first. The database upload operation re-asserts the same policy for
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
    // the network rather than only preceding the mutation. The database upload
    // operation re-asserts the same policy for programmatic callers.
    const fileRealpath = await realpath(absPath);
    assertNoSecretsOutbound(
      'plan-upload',
      [
        ['file', file],
        ['file_realpath', fileRealpath],
        ['body', body],
        ['title', title],
        ['review_note', opts.reviewNote],
        ['base_url', opts.baseUrl],
        ...(opts.reviewer ?? []).map((tag, at): AuthoredField => [`reviewer[${at}]`, tag]),
      ],
      await loadSecretAllowlist()
    );
    const context = await resolveDatabaseCaptureContext({
      registerWorktree: true,
      signal: controller.signal,
    });
    const credentialStore = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    let result: WithSecretWarnings<PlanUploadResult>;
    try {
      const { client, target } = await createCanonicalCloudClient({
        baseUrl,
        store: credentialStore,
        cliVersion: CLI_VERSION,
        requires: [],
        operation: 'plan upload',
        signal: controller.signal,
      });
      let waiting = false;
      const onWait = () => {
        if (waiting) return;
        waiting = true;
        writeTerminalSafeStderr(
          'Waiting for plan upload on the selected project database; Ctrl-C cancels the wait.\n'
        );
      };
      result = await runDatabaseSourcePlanUpload({
        reader: context.project.database,
        openWriter: () => openDatabaseCaptureWriter(context, controller.signal),
        client,
        repoRoot: context.registered.git.worktreeRoot,
        target,
        absPath,
        fileRealpath,
        body,
        title,
        reviewers: opts.reviewer ?? [],
        reviewNote: opts.reviewNote ?? null,
        secretAllow: context.config.redact.allow,
        resolveBaseline: () => resolveReviewBaseline(context.repo),
        now: () => new Date().toISOString(),
        signal: controller.signal,
        onWait,
      });
      await stampPlanUploadUsage(context, result, controller.signal, onWait);
    } finally {
      context.close();
    }

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
      out += `    add corrected reviewers: orcaops plan review request ${result.external_id} --reviewer <email>\n`;
    }
    out += `  pull it after approval with: orcaops plan pull ${result.external_id}\n`;
    out += '  Next: orcaops plan review status   (watch for feedback)\n';
    out += `        orcaops plan review approve ${result.external_id} --wait   (when ready for approval)\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  } finally {
    process.off('SIGINT', interrupt);
  }
}
