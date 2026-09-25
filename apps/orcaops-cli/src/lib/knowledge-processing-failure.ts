import type { DatabaseJson } from '@orcaops/storage/history/database';

const MAX_TEXT = 300;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clipped(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`;
}

/** Why one settled attempt ended, from the detail the worker retained for it. */
function describeSettlement(detail: Record<string, unknown> | null): string | null {
  if (detail === null) return null;
  const call = record(detail.call);
  if (call !== null && typeof call.code === 'string')
    return typeof call.message === 'string'
      ? `the provider call failed with ${call.code}: ${clipped(call.message)}`
      : `the provider call failed with ${call.code}`;
  if (typeof detail.error === 'string') return `the answer was not JSON: ${clipped(detail.error)}`;
  if (Array.isArray(detail.failures)) {
    const rules = detail.failures
      .map((failure) => record(failure)?.rule)
      .filter((rule): rule is string => typeof rule === 'string');
    return `the proposal was refused (${rules.join(', ') || 'no rule named'})`;
  }
  if (typeof detail.source_preflight_refused === 'string')
    return `the store refused the unit's sources: ${clipped(detail.source_preflight_refused)}`;
  const refused = record(detail.publication_refused);
  if (refused !== null)
    return `the store refused to publish the result (${String(refused.code)}): ${clipped(String(refused.detail))}`;
  if (typeof detail.publication_failed === 'string')
    return `publishing the result failed (${detail.publication_failed})`;
  const withdrawn = record(detail.withdrawn);
  if (withdrawn !== null && typeof withdrawn.wait_reason === 'string')
    return `its authorization was withdrawn (${withdrawn.wait_reason})`;
  return null;
}

/**
 * Why a job gave up, in one sentence a person can act on. A spent allowance names no reason of
 * its own, so the last attempt's is given with it.
 */
export function describeProcessingFailure(
  result: DatabaseJson,
  lastAttemptDetail: DatabaseJson
): string {
  const outcome = record(result);
  if (outcome?.outcome === 'attempts_exhausted') {
    const spent = `It spent its allowance of ${String(outcome.max_attempts)} attempt(s)`;
    const last = describeSettlement(record(lastAttemptDetail));
    return last === null ? `${spent}.` : `${spent}; on the last one ${last}.`;
  }
  const reason = describeSettlement(outcome);
  if (reason !== null) return `It gave up because ${reason}.`;
  return result === null
    ? 'It gave up without recording a reason.'
    : `It gave up with ${clipped(JSON.stringify(result))}.`;
}
