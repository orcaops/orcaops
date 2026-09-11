import type { ArtifactPaths } from './artifact-paths.js';
import { ArtifactMutationDraft } from './mutation-draft.js';
import { ArtifactSemantics } from './semantics.js';
import { canonicalJson } from '../events/canonical-json.js';
import type { AppendEventInput } from '../events/event-log.js';
import {
  type EventWithPayload,
  rebuildAllCheckpointsFromEvents,
  rebuildArtifactJsonFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from '../events/rebuilders.js';
import { encodeArtifactEvent, type EncodedArtifactEvent } from '../history/event-encoding.js';
import { HistoryPersistenceError } from '../history/persistence-error.js';
import { type ArtifactJson, ArtifactJsonSchema } from '../schema/artifact-json.js';
import { type IdempotencyBlockRow, Store } from '../store/sqlite.js';
import { assertNoSecretsInPayload } from '../text/secret-guard.js';

const methods = [
  'writePlan',
  'hasCommittedPlanCapture',
  'revisePlan',
  'writeCheckpointOpened',
  'writeCheckpointClosed',
  'writeCheckpointAbandoned',
  'writeSummary',
  'writeEvaluatorRunPayload',
  'writeEvaluatorDisposition',
  'appendBranchLineage',
  'writePrePrChecked',
  'writePinDisplaced',
  'readPlan',
  'readPlanRevision',
  'resolveOpenRevisionPlanStrict',
  'readCheckpoint',
  'readCheckpoints',
  'findCommittedCheckpointCloseN',
  'readCheckpointDiffFingerprint',
  'readCheckpointDiffFingerprints',
  'adjudicateWindowOverlap',
  'readSummary',
  'readEvaluatorLog',
  'readPrePrReview',
  'readArtifact',
] as const;
export type ArtifactDraftSemantics = Pick<ArtifactSemantics, (typeof methods)[number]>;
export interface ArtifactDraftInput {
  readonly artifactId: string;
  readonly priorEvents: readonly EventWithPayload[];
  readonly authoredPayload: unknown;
  readonly secretAllow: readonly string[];
  readonly idempotencyBlocks: readonly IdempotencyBlockRow[];
}
export interface ArtifactDraftResult<T> {
  evaluation: { kind: 'returned'; value: T } | { kind: 'threw'; error: unknown };
  events: EncodedArtifactEvent[];
  idempotencyChanges: Array<{
    before: IdempotencyBlockRow | null;
    after: IdempotencyBlockRow | null;
  }>;
}

class MemoryArtifactSemantics extends ArtifactSemantics {
  readonly repoRoot = '/artifact-draft';
  readonly store: Store;
  protected readonly preparation: ArtifactMutationDraft;
  constructor(draft: ArtifactMutationDraft, store: Store) {
    super();
    this.preparation = draft;
    this.store = store;
    this.seedPreparation();
  }
  protected artifactPaths(artifactId: string) {
    return this.preparation.paths(artifactId);
  }
  protected async writeProjection(file: string, content: string | Buffer) {
    this.preparation.renderedFiles.set(
      file,
      typeof content === 'string' ? content : Buffer.from(content)
    );
  }
  protected async writeArtifactProjection(file: string, value: ArtifactJson) {
    await this.writeProjection(file, JSON.stringify(ArtifactJsonSchema.parse(value)) + '\n');
  }
  protected async withOperationalProjectionWrite<T>(_root: string, write: () => T | Promise<T>) {
    return write();
  }
  protected async withWriteLock<T>(artifactId: string, fn: () => Promise<T>) {
    this.preparation.assertArtifact(artifactId);
    return fn();
  }
  protected async appendAndMirror(input: AppendEventInput, paths: ArtifactPaths) {
    return this.preparation.append(paths.artifactId, input);
  }
  protected async loadAllEvents(_log: string, _sidecars: string, artifactId: string) {
    return this.preparation.read(artifactId);
  }
  protected async loadAllEventsTolerant() {
    return this.preparation.read();
  }
  async readPlan(artifactId: string) {
    return rebuildPlanFromEvents(this.preparation.read(artifactId))?.plan ?? null;
  }
  async readCheckpointsRecovered(artifactId: string) {
    return rebuildAllCheckpointsFromEvents(this.preparation.read(artifactId));
  }
  async readSummary(artifactId: string) {
    return rebuildSummaryFromEvents(this.preparation.read(artifactId))?.summary ?? null;
  }
  async readEvaluatorLog(artifactId: string) {
    return (
      rebuildEvaluatorLogFromEvents(this.preparation.read(artifactId), artifactId)?.log ?? null
    );
  }
  async readArtifact(artifactId: string) {
    return rebuildArtifactJsonFromEvents(this.preparation.read(artifactId))?.json ?? null;
  }
}

function changedAttempts(
  before: readonly IdempotencyBlockRow[],
  after: readonly IdempotencyBlockRow[]
) {
  const key = (row: IdempotencyBlockRow) => canonicalJson([row.event_type, row.idempotency_key]);
  const old = new Map(before.map((row) => [key(row), row]));
  const current = new Map(after.map((row) => [key(row), row]));
  return [...new Set([...old.keys(), ...current.keys()])].sort().flatMap((key) => {
    const before = old.get(key) ?? null,
      after = current.get(key) ?? null;
    return canonicalJson(before) === canonicalJson(after) ? [] : [{ before, after }];
  });
}

export async function prepareArtifactDraft<T>(
  input: ArtifactDraftInput,
  evaluate: (semantics: ArtifactDraftSemantics) => Promise<T>
): Promise<ArtifactDraftResult<T>> {
  const copied = structuredClone(input);
  assertNoSecretsInPayload(copied.authoredPayload, copied.secretAllow);
  const draft = new ArtifactMutationDraft(copied.artifactId, copied.priorEvents);
  const identities = new Set<string>();
  for (const row of copied.idempotencyBlocks) {
    const key = canonicalJson([row.event_type, row.idempotency_key]);
    if (row.artifact_id !== copied.artifactId || identities.has(key))
      throw new HistoryPersistenceError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Rejected-attempt evidence differs from its artifact scope'
      );
    identities.add(key);
  }
  const memory = new Store(':memory:');
  let active = true;
  const pending = new Set<Promise<unknown>>();
  try {
    const semantics = new MemoryArtifactSemantics(draft, memory);
    for (const row of copied.idempotencyBlocks) memory.upsertIdempotencyBlock(row);
    const facade = Object.freeze(
      Object.fromEntries(
        methods.map((name) => [
          name,
          (...args: unknown[]) => {
            if (!active)
              return Promise.reject(
                new HistoryPersistenceError(
                  'INVALID_INPUT',
                  'Artifact draft preparation has ended; prepare a new draft'
                )
              );
            const method = semantics[name] as (...args: unknown[]) => Promise<unknown>;
            const result = method.apply(semantics, args);
            pending.add(result);
            void result.then(
              () => pending.delete(result),
              () => pending.delete(result)
            );
            return result;
          },
        ])
      )
    ) as ArtifactDraftSemantics;
    let evaluation: ArtifactDraftResult<T>['evaluation'];
    try {
      evaluation = { kind: 'returned', value: await evaluate(facade) };
    } catch (error) {
      evaluation = { kind: 'threw', error };
    }
    active = false;
    if (pending.size) {
      await Promise.allSettled([...pending]);
      throw new HistoryPersistenceError(
        'INVALID_INPUT',
        'Await every artifact draft operation before returning its prepared result'
      );
    }
    const events = evaluation.kind === 'returned' ? draft.pendingEvents() : [];
    assertNoSecretsInPayload(events, copied.secretAllow);
    const idempotencyChanges = changedAttempts(
      copied.idempotencyBlocks,
      memory.listIdempotencyBlocks(copied.artifactId)
    );
    for (const { after } of idempotencyChanges) {
      if (!after) continue;
      assertNoSecretsInPayload(after, copied.secretAllow);
      // JSON escaping can hide control-separated secrets from the serialized-row scan.
      if (after.envelope !== null)
        assertNoSecretsInPayload(JSON.parse(after.envelope), copied.secretAllow);
    }
    return {
      evaluation,
      events: events.map(encodeArtifactEvent),
      idempotencyChanges,
    };
  } finally {
    active = false;
    memory.close();
  }
}
