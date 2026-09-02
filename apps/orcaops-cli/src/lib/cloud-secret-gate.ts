import {
  assertNoSecretsInPayload,
  type SecretFinding,
  SecretInPayloadError,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError, type SecretFindingReport } from '../io/errors.js';
import { writeTerminalSafeStderr } from '../io/output.js';

/**
 * The secret gate for outbound cloud writes.
 *
 * Every outbound cloud verb that sends author-written text calls this,
 * **before** computing any `content_hash` and before any wire call. That
 * ordering is the whole point: refusing before the hash prevents an anchor
 * from ever being minted, where refusing after would be trying to un-mint one.
 * `runPlanUpload`, `runReviewPush` and `runReviewPropose` assert control
 * characters on the same ordering, for the same reason.
 *
 * The verb list is not maintained here. `cloud-write-surface.test.ts` derives
 * it from the SDK's `OrcaCloudClient` type, so a cloud method added later
 * fails a test rather than silently escaping the gate.
 *
 * Bodies are not special. The metadata riding the same call — a title, a
 * review note, a proposal summary, a comment quote, a verdict note, a decline
 * reason — is authored by the same agent and travels to the same place.
 */

export type AuthoredField = readonly [label: string, value: string | null | undefined];

export type WithSecretWarnings<T> = T & { secret_warnings?: readonly SecretFindingReport[] };

/** Drops `tier` — an internal enforcement decision an agent cannot act on. */
export function toSecretFindingReport(finding: SecretFinding): SecretFindingReport {
  return {
    path: finding.path,
    patterns: [...finding.patterns],
    ...(finding.keyPrefix === undefined ? {} : { key_prefix: finding.keyPrefix }),
  };
}

/** Convert and deduplicate sanitized warn-tier findings for a command response. */
export function toSecretWarningReports(
  findings: readonly SecretFinding[]
): readonly SecretFindingReport[] {
  const reports: SecretFindingReport[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const report = toSecretFindingReport(finding);
    const key = JSON.stringify([
      report.path,
      [...report.patterns].sort(),
      report.key_prefix ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    reports.push(report);
  }
  return reports;
}

/** Attach sanitized warnings to a result without changing clean response shapes. */
export function withSecretWarnings<T extends object>(
  result: T,
  findings: readonly SecretFinding[]
): WithSecretWarnings<T> {
  const secretWarnings = toSecretWarningReports(findings);
  return secretWarnings.length === 0 ? result : { ...result, secret_warnings: secretWarnings };
}

/** Surface JSON response warnings in human-readable command mode as well. */
export function writeSecretWarnings(warnings: readonly SecretFindingReport[] | undefined): void {
  for (const warning of warnings ?? []) {
    writeTerminalSafeStderr(
      `warning: secret-shaped content at ${warning.path} (${warning.patterns.join(', ')}); ` +
        `review the authored value before sharing it.\n`
    );
  }
}

/**
 * Refuse the call if any authored field carries a refuse-tier secret.
 *
 * `command` names the CLI verb for the error path, matching how the
 * control-char asserts label theirs (`plan-upload`, `plan-review-push`, …).
 * Returns warn-tier findings so a caller can disclose them without blocking —
 * the generic `key=value` matcher fires on ordinary quoted code, and a review
 * comment quoting a diff hunk is exactly that.
 *
 * Absent and empty fields are skipped rather than scanned as `''`, so an
 * optional flag that was never passed cannot appear in a finding path.
 */
export function assertNoSecretsOutbound(
  command: string,
  fields: readonly AuthoredField[],
  // REQUIRED, not optional: optional lets a call site compile while passing
  // nothing, and the only other guard is a test grepping each file for the
  // loader's name — which an unused import satisfies.
  allow: readonly string[],
  options: { approvedCloudPin?: boolean } = {}
): readonly SecretFinding[] {
  const payload: Record<string, string> = {};
  for (const [label, value] of fields) {
    if (typeof value === 'string' && value.length > 0) payload[label] = value;
  }

  try {
    return assertNoSecretsInPayload(payload, allow);
  } catch (err) {
    if (err instanceof SecretInPayloadError) {
      const findings = err.findings;
      throw new OrcaopsError(
        ErrorCodes.SECRET_IN_PAYLOAD,
        options.approvedCloudPin
          ? `${err.message} The approved cloud pin was not persisted. If the exact detected ` +
              `value is known dead, add it to redact.allow and retry; otherwise fix the cloud ` +
              `plan, re-upload and re-approve it, then pull the approved version again.`
          : `${err.message} Nothing was sent to the cloud and no content hash was computed.`,
        command,
        { secret_findings: findings.map(toSecretFindingReport) }
      );
    }
    throw err;
  }
}
