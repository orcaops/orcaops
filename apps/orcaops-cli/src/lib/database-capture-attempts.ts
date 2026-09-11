import {
  canonicalJson,
  computePayloadHash,
  type IdempotencyBlockRow,
  uuidv7,
} from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectDatabase,
  type ProjectOperationOptions,
  publishProjectArtifactAttempt,
  readProjectArtifactAttempts,
} from '@orcaops/storage/history/database';

export type ArtifactAttemptChanges = ReadonlyArray<{
  before: IdempotencyBlockRow | null;
  after: IdempotencyBlockRow | null;
}>;

/** Retained rejected-attempt evidence, in the shape the in-memory draft seeds from. */
export function retainedAttemptBlocks(
  handle: ProjectDatabase,
  artifactId: string
): IdempotencyBlockRow[] {
  return readProjectArtifactAttempts(handle, artifactId).records.flatMap((entry) =>
    entry.action === 'set' && entry.record ? [entry.record] : []
  );
}

/**
 * Publishes the attempt rows the draft added or replaced. A rejected open must leave
 * the same soft-blocked or hard-rejected receipt the file era wrote, so this runs
 * before the refusal is rethrown.
 */
export async function publishDatabaseCaptureAttempts(
  handle: ProjectDatabase,
  input: {
    artifactId: string;
    artifactRevision: ArtifactRevision;
    changes: ArtifactAttemptChanges;
    command: string;
    secretAllow: readonly string[];
  },
  options: ProjectOperationOptions = {}
): Promise<void> {
  if (!input.changes.length) return;
  const selections = new Map(
    readProjectArtifactAttempts(handle, input.artifactId).records.map((entry) => [
      canonicalJson([entry.eventType, entry.idempotencyKey]),
      entry.selection,
    ])
  );
  for (const change of input.changes) {
    const row = change.after ?? change.before;
    if (!row) continue;
    const expectedSelection = selections.get(canonicalJson([row.event_type, row.idempotency_key]));
    const source = {
      identity: `cli:${input.command}`,
      locator: `sqlite:artifact_attempt_revisions:${input.artifactId}/${row.event_type}/${row.idempotency_key}`,
      revisionId: null,
      eventId: null,
      operationId: null,
      sha256: null,
    };
    const common = {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      artifactId: input.artifactId,
      artifactRevision: input.artifactRevision,
      source,
    };
    await publishProjectArtifactAttempt(
      handle,
      change.after
        ? {
            ...common,
            action: 'set',
            expectedSelection: expectedSelection ?? null,
            bytes: Buffer.from(canonicalJson(change.after)),
          }
        : {
            ...common,
            action: 'clear',
            // A clear names the selection it retires, so it can never erase an unseen row.
            expectedSelection: expectedSelection!,
            eventType: row.event_type,
            idempotencyKey: row.idempotency_key,
          },
      { secretAllow: [...input.secretAllow] },
      options
    );
  }
}

export interface DatabaseCaptureRefusal {
  code: string;
  message: string;
  path?: string;
}

/** The retained refusal a rejected capture replays, and the payload it was refused for. */
interface RefusalEnvelope {
  kind: 'capture-refusal';
  refusal: DatabaseCaptureRefusal;
}

function refusalEnvelope(value: string | null): DatabaseCaptureRefusal | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RefusalEnvelope>;
    return parsed?.kind === 'capture-refusal' && parsed.refusal ? parsed.refusal : null;
  } catch {
    // An unreadable receipt is no receipt; the caller prepares afresh.
    return null;
  }
}

/**
 * A refusal whose precondition can never be satisfied by replaying the original
 * operation — a capture prepared against an artifact revision that has since moved —
 * is retained as its own receipt so the same key returns the same answer instead of
 * re-running a request that can only fail again.
 */
export async function recordDatabaseCaptureRefusal(
  handle: ProjectDatabase,
  input: {
    artifactId: string;
    artifactRevision: ArtifactRevision;
    eventType: string;
    idempotencyKey: string;
    replayPayload: unknown;
    refusal: DatabaseCaptureRefusal;
    command: string;
    secretAllow: readonly string[];
  },
  options: ProjectOperationOptions = {}
): Promise<void> {
  const envelope: RefusalEnvelope = { kind: 'capture-refusal', refusal: input.refusal };
  const row: IdempotencyBlockRow = {
    artifact_id: input.artifactId,
    idempotency_key: input.idempotencyKey,
    event_type: input.eventType,
    outcome: 'hard_rejected',
    payload_hash: computePayloadHash(input.replayPayload),
    evaluator_fingerprint: null,
    envelope: JSON.stringify(envelope),
    recorded_at: new Date().toISOString(),
  };
  await publishDatabaseCaptureAttempts(
    handle,
    {
      artifactId: input.artifactId,
      artifactRevision: input.artifactRevision,
      changes: [{ before: null, after: row }],
      command: input.command,
      secretAllow: input.secretAllow,
    },
    options
  );
}

export type RetainedCaptureRefusal =
  | { state: 'refused'; refusal: DatabaseCaptureRefusal }
  | { state: 'conflict' };

/**
 * Receipt-first lookup for a retained refusal. A matching payload replays the recorded
 * answer; a different payload under the same key is the ordinary key conflict.
 */
export function readDatabaseCaptureRefusal(
  handle: ProjectDatabase,
  input: {
    artifactId: string;
    eventType: string;
    idempotencyKey: string;
    replayPayload: unknown;
  }
): RetainedCaptureRefusal | null {
  const retained = readProjectArtifactAttempts(handle, input.artifactId).records.find(
    (entry) => entry.eventType === input.eventType && entry.idempotencyKey === input.idempotencyKey
  );
  const refusal = refusalEnvelope(retained?.record?.envelope ?? null);
  if (!retained?.record || !refusal) return null;
  return retained.record.payload_hash === computePayloadHash(input.replayPayload)
    ? { state: 'refused', refusal }
    : { state: 'conflict' };
}
