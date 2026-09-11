import { refuseJsonBytes } from './authored-bytes.js';
import { type ArtifactThread, reconstructArtifactThread } from '../../events/artifact-thread.js';
import type { EventWithPayload } from '../../events/rebuilders.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { decodeArtifactRecords, digest } from '../event-integrity.js';
import { ProjectDatabaseError } from './errors.js';

export interface ArtifactSidecarPayload {
  readonly eventId: string;
  readonly bytes: Uint8Array;
}

export interface RetainedArtifactEvent {
  event: EventWithPayload;
  bytes: Buffer;
  sidecar: Buffer | null;
}

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}

export function decodeArtifactInput(
  bytes: Uint8Array,
  sidecars: readonly ArtifactSidecarPayload[],
  secretAllow: readonly string[],
  checkSecrets = true
): RetainedArtifactEvent[] {
  if (!(bytes instanceof Uint8Array) || !Array.isArray(sidecars))
    invalid('Provide exact event bytes and an explicit sidecar payload array');
  const copy = Buffer.from(bytes);
  if (checkSecrets) refuseJsonBytes(copy, secretAllow);
  const payloads = new Map<string, Buffer>();
  for (const sidecar of sidecars) {
    if (
      !sidecar ||
      typeof sidecar.eventId !== 'string' ||
      !(sidecar.bytes instanceof Uint8Array) ||
      payloads.has(sidecar.eventId)
    )
      invalid('Provide one exact sidecar payload per referring event ID');
    const payloadBytes = Buffer.from(sidecar.bytes);
    if (checkSecrets) refuseJsonBytes(payloadBytes, secretAllow);
    payloads.set(sidecar.eventId, payloadBytes);
  }
  let records;
  try {
    records = decodeArtifactRecords(copy);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Event bytes violate the original wire schema or checksum; correct the authored input',
      { cause }
    );
  }
  if (!records.length) invalid('An artifact append must contain at least one event');
  let offset = 0;
  const result = records.map((record) => {
    const end = copy.indexOf(0x0a, offset) + 1;
    const recordBytes = copy.subarray(offset, end);
    offset = end;
    const sidecar = payloads.get(record.event_id) ?? null;
    payloads.delete(record.event_id);
    let payload: unknown;
    if ('sidecar_sha256' in record) {
      if (
        !sidecar ||
        sidecar.length !== record.sidecar_size ||
        digest(sidecar) !== record.sidecar_sha256
      )
        invalid('Sidecar bytes must match the original event size and SHA-256');
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sidecar));
      } catch (cause) {
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Sidecar payload must be valid UTF-8 JSON',
          { cause }
        );
      }
    } else {
      if (sidecar) invalid('Inline events cannot also publish sidecar payloads');
      payload = record.payload;
    }
    try {
      if (checkSecrets) {
        assertNoSecretsInPayload(record, secretAllow);
        assertNoSecretsInPayload(payload, secretAllow);
      }
    } catch (cause) {
      if (!(cause instanceof SecretInPayloadError)) throw cause;
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Secret refusal: remove the secret from authored content or explicitly allow a known-dead test value before opening storage',
        { cause }
      );
    }
    return { event: { record, payload }, bytes: recordBytes, sidecar };
  });
  if (payloads.size) invalid('Unreferenced sidecar payloads cannot be persisted');
  return result;
}

export function reconstructDatabaseArtifact(
  artifactId: string,
  events: RetainedArtifactEvent[],
  retained: boolean
): ArtifactThread {
  // These pure rebuilders predate the typed database boundary and throw both
  // schema errors and ordinary Error for invalid event sequences.
  try {
    const thread = reconstructArtifactThread(
      artifactId,
      events.map((entry) => entry.event)
    );
    if (!thread.plan || !thread.artifactJson)
      throw new Error('A complete initial plan is required');
    return thread;
  } catch (cause) {
    throw new ProjectDatabaseError(
      retained ? 'HISTORY_INTEGRITY_REQUIRED' : 'INVALID_INPUT',
      retained
        ? 'Retained artifact events cannot reconstruct; preserve history for explicit repair'
        : 'The authored event sequence cannot reconstruct a valid artifact; correct the input',
      { cause }
    );
  }
}

export function artifactEventsChangeIntent(events: readonly EventWithPayload[]): boolean {
  return events.some(
    ({ record, payload }) =>
      record.type === 'plan_captured' ||
      record.type === 'plan_revised' ||
      record.type === 'git_import_enriched' ||
      (record.type === 'checkpoint_closed' &&
        payload !== null &&
        typeof payload === 'object' &&
        Array.isArray((payload as { decisions?: unknown }).decisions) &&
        (payload as { decisions: unknown[] }).decisions.length > 0)
  );
}
