import { scrubTerminalDiagnosticAndBound } from '@orcaops/storage';

/**
 * Best-effort secret stripping for an error message before it lands in
 * the local sqlite store as `cloud_last_push_error_message`. The shared
 * redactor covers the same recognized shapes used by output, search, and
 * evaluator persistence; arbitrary high-entropy substrings remain out of
 * scope to avoid destroying ordinary diagnostics.
 */
const MAX_LEN = 200;

export function scrubError(message: string): string {
  const scrubbed = scrubAndBound(message, MAX_LEN);
  return scrubbed.trim().length > 0 || message.trim().length === 0
    ? scrubbed
    : '[diagnostic removed]';
}

/**
 * Scrub, THEN bound — never the other way round, or a secret straddling the
 * cut survives as an unmatched prefix.
 *
 * The bound is a parameter because one size does not fit both callers. Cloud
 * wire errors get {@link MAX_LEN} (200) since anything long there is an
 * echoed upstream body. Authored CLI messages need far more room: they carry
 * deliberate guidance — for example, candidate artifacts in an
 * AMBIGUOUS_ARTIFACT error — and truncating those to
 * 200 would destroy the diagnostic to no benefit, since they are audited
 * strings rather than echoed remote content.
 *
 * The maximum includes the truncation marker. Truncation is disclosed rather
 * than silent: a caller reading a cut message should be able to tell it was cut.
 */
export function scrubAndBound(message: string, maxLen: number): string {
  return scrubTerminalDiagnosticAndBound(message, maxLen);
}
