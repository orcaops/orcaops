import { type ArtifactDraftSemantics, prepareArtifactDraft } from './draft-preparation.js';
import type { AppendEventInput } from '../events/event-log.js';
import type { EventWithPayload } from '../events/rebuilders.js';
import { encodeArtifactEvent } from '../history/event-encoding.js';
import type { IdempotencyBlockRow } from '../store/sqlite.js';

export interface RetainedArtifactDraft {
  readonly semantics: ArtifactDraftSemantics;
  readonly events: readonly EventWithPayload[];
  retain(input: AppendEventInput): void;
}

function authoredValue(value: unknown): unknown {
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(authoredValue);
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const authored = authoredValue(entry);
        return authored === undefined ? [] : [[key, authored]];
      })
    );
  }
  return value;
}

export function createRetainedArtifactDraft(artifactId: string): RetainedArtifactDraft {
  const events: EventWithPayload[] = [];
  let idempotencyBlocks: IdempotencyBlockRow[] = [];
  const semantics = new Proxy({} as ArtifactDraftSemantics, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        const result = await prepareArtifactDraft(
          {
            artifactId,
            priorEvents: events,
            authoredPayload: authoredValue(args),
            secretAllow: [],
            idempotencyBlocks,
          },
          async (draft) => {
            const method = draft[property as keyof ArtifactDraftSemantics] as unknown;
            if (typeof method !== 'function') {
              throw new TypeError(`Unknown draft method ${String(property)}`);
            }
            return method.apply(draft, args) as Promise<unknown>;
          }
        );
        for (const change of result.idempotencyChanges) {
          if (change.before) {
            idempotencyBlocks = idempotencyBlocks.filter(
              (row) =>
                row.event_type !== change.before!.event_type ||
                row.idempotency_key !== change.before!.idempotency_key
            );
          }
          if (change.after) idempotencyBlocks.push(change.after);
        }
        if (result.evaluation.kind === 'threw') throw result.evaluation.error;
        events.push(
          ...result.events.map((event) => ({
            record: event.record,
            payload: JSON.parse(event.payloadBytes.toString('utf8')),
          }))
        );
        return result.evaluation.value;
      };
    },
  });
  return {
    semantics,
    events,
    retain(input) {
      const event = encodeArtifactEvent(input);
      events.push({
        record: event.record,
        payload: JSON.parse(event.payloadBytes.toString('utf8')),
      });
    },
  };
}
