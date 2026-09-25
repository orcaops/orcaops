import {
  CURRENT_RESULT_ENVELOPE_SCHEMA,
  type EvaluatorFinding,
  type EvaluatorResultEnvelopeV2,
  EvaluatorResultEnvelopeV2Schema,
} from '@orcaops/evaluator-protocol';

/**
 * Constructors for the three verdict-carrying envelope shapes. Each
 * returns a fully-typed `EvaluatorResultEnvelopeV2` that
 * `EvaluatorResultEnvelopeV2Schema.parse` accepts unchanged.
 *
 * The optional `raw` field carries structured data the runner may
 * validate against the spec's `engine.output_schema`. The optional
 * `metrics` map is evaluator-defined numeric data (e.g.,
 * `{ files_scanned: 42 }`) that lands on `EvaluatorRunPayload.metrics`.
 *
 * The optional `findings` array carries the protocol's structured findings.
 * They are optional under every verdict and never decide the gate: a pass may
 * carry them, a violation may carry none.
 */

export interface EnvelopeExtras {
  raw?: unknown;
  metrics?: Record<string, number>;
  /** Build each one with `finding()`; keys must be unique within the array. */
  findings?: readonly EvaluatorFinding[];
}

export function pass(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelopeV2 {
  return buildEnvelope('pass', body, extras);
}

export function violation(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelopeV2 {
  return buildEnvelope('violation', body, extras);
}

export function info(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelopeV2 {
  return buildEnvelope('info', body, extras);
}

/**
 * Serialize an envelope to stdout for the command engine to consume.
 * `console.log` would add a trailing newline + buffer differently;
 * `process.stdout.write` of the raw JSON keeps the contract minimal:
 * one JSON object, no trailing whitespace, no log lines.
 *
 * Validates the envelope with the STRICT schema before writing, findings
 * included — so a malformed finding fails here, in the author's own process
 * and with a field path, rather than reaching the runner as findings that
 * could not be read.
 */
export function writeResult(envelope: EvaluatorResultEnvelopeV2): void {
  const validated = EvaluatorResultEnvelopeV2Schema.parse(envelope);
  process.stdout.write(JSON.stringify(validated));
}

function buildEnvelope(
  verdict: EvaluatorResultEnvelopeV2['verdict'],
  body: string,
  extras: EnvelopeExtras
): EvaluatorResultEnvelopeV2 {
  return {
    schema: CURRENT_RESULT_ENVELOPE_SCHEMA,
    verdict,
    body,
    ...(extras.raw !== undefined ? { raw: extras.raw } : {}),
    ...(extras.metrics !== undefined ? { metrics: extras.metrics } : {}),
    ...(extras.findings !== undefined ? { findings: [...extras.findings] } : {}),
  };
}
