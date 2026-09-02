import {
  type EvaluatorResultEnvelope,
  EvaluatorResultEnvelopeSchema,
} from '@orcaops/evaluator-protocol';

/**
 * Constructors for the three verdict-carrying envelope shapes. Each
 * returns a fully-typed `EvaluatorResultEnvelope` that
 * `EvaluatorResultEnvelopeSchema.parse` accepts unchanged.
 *
 * The optional `raw` field carries structured data the runner may
 * validate against the spec's `engine.output_schema`. The optional
 * `metrics` map is evaluator-defined numeric data (e.g.,
 * `{ files_scanned: 42 }`) that lands on `EvaluatorRunPayload.metrics`.
 */

export interface EnvelopeExtras {
  raw?: unknown;
  metrics?: Record<string, number>;
}

export function pass(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelope {
  return buildEnvelope('pass', body, extras);
}

export function violation(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelope {
  return buildEnvelope('violation', body, extras);
}

export function info(body: string, extras: EnvelopeExtras = {}): EvaluatorResultEnvelope {
  return buildEnvelope('info', body, extras);
}

/**
 * Serialize an envelope to stdout for the command engine to consume.
 * `console.log` would add a trailing newline + buffer differently;
 * `process.stdout.write` of the raw JSON keeps the contract minimal:
 * one JSON object, no trailing whitespace, no log lines.
 *
 * Validates the envelope before writing — catches pack-author bugs at
 * the boundary instead of after the runner's strict-parse fails.
 */
export function writeResult(envelope: EvaluatorResultEnvelope): void {
  const validated = EvaluatorResultEnvelopeSchema.parse(envelope);
  process.stdout.write(JSON.stringify(validated));
}

function buildEnvelope(
  verdict: EvaluatorResultEnvelope['verdict'],
  body: string,
  extras: EnvelopeExtras
): EvaluatorResultEnvelope {
  return {
    schema: 'orcaops.evaluator_result/v1',
    verdict,
    body,
    ...(extras.raw !== undefined ? { raw: extras.raw } : {}),
    ...(extras.metrics !== undefined ? { metrics: extras.metrics } : {}),
  };
}
