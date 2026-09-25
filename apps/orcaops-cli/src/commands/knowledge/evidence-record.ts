// What `knowledge observe` and `knowledge assess` share: reading the record somebody wrote and
// taking the acting party and the operation identity out of it.
//
// The acting party is a named argument of every knowledge writer, never a field of the record, so
// it is a key of its own here too and the record keeps none. A document that names one wins, basis
// and all, and nothing here verifies that basis — exactly as nothing in the store does. A document
// that names nobody is attributed to whoever invoked this command, on the basis `processingActor`
// gives every other local act: the account this process runs as, never `authenticated`, because a
// local invocation carries no authentication.
import { type Actor, ActorSchema, uuidv7 } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';

export interface EvidenceDocument {
  /** The contract record, with the acting party and the operation identity removed. */
  readonly record: Record<string, unknown>;
  readonly actor: Actor;
  readonly operationId: string;
}

const invoking = (): Actor => {
  const actor = processingActor();
  return { identity: actor.changedBy, basis: actor.changedByBasis };
};

function actorOf(value: unknown, field: string): Actor {
  if (value === undefined || value === null) return invoking();
  const parsed = ActorSchema.safeParse(value);
  if (!parsed.success)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${field} names who acted: an identity, and the basis that name is known on. ` +
        'An unknown actor has no identity, and a named one states its basis.',
      field
    );
  return parsed.data;
}

/**
 * The document a verb reads: the record itself, plus `<actorField>` and an optional `operation_id`
 * an interrupted call repeats under.
 */
export async function readEvidenceDocument(
  inputPath: string | undefined,
  actorField: string
): Promise<EvidenceDocument> {
  const document = await readPayloadInput({ inputPath });
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Provide the record as a YAML or JSON object.'
    );
  const {
    [actorField]: acting,
    operation_id: operationId,
    ...record
  } = document as Record<string, unknown>;
  if (operationId !== undefined && typeof operationId !== 'string')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'operation_id is the identity an interrupted publication repeats under.',
      'operation_id'
    );
  return {
    record,
    actor: actorOf(acting, actorField),
    operationId: (operationId as string | undefined) ?? uuidv7(),
  };
}
