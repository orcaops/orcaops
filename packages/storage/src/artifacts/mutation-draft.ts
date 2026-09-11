import path from 'node:path';

import type { ArtifactPaths } from './artifact-paths.js';
import { reconstructArtifactThread } from '../events/artifact-thread.js';
import { canonicalJson } from '../events/canonical-json.js';
import type { AppendEventInput, EventRecord } from '../events/event-log.js';
import type { EventWithPayload } from '../events/rebuilders.js';
import { encodeArtifactEvent } from '../history/event-encoding.js';
import { HistoryPersistenceError } from '../history/persistence-error.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

export class ArtifactMutationDraft {
  readonly artifactId: string;
  readonly renderedFiles = new Map<string, string | Buffer>();
  private readonly source: EventWithPayload[];
  private readonly additions: AppendEventInput[] = [];
  private readonly replays = new Set<string>();

  constructor(artifactId: string, events: readonly EventWithPayload[]) {
    this.artifactId = UuidV7Schema.parse(artifactId);
    this.source = structuredClone([...events]);
    reconstructArtifactThread(artifactId, this.source);
  }

  assertArtifact(artifactId: string): void {
    if (artifactId !== this.artifactId) throw new Error('Artifact draft belongs to another target');
  }

  read(artifactId: string = this.artifactId): EventWithPayload[] {
    this.assertArtifact(artifactId);
    return structuredClone(this.source);
  }

  pendingEvents(): AppendEventInput[] {
    return structuredClone(this.additions);
  }

  isReplay(eventId: string): boolean {
    return this.replays.has(eventId);
  }

  append(artifactId: string, input: AppendEventInput): EventRecord {
    this.assertArtifact(artifactId);
    const copy = JSON.parse(canonicalJson(input)) as AppendEventInput;
    const prior = [...this.source]
      .reverse()
      .find(
        (event) =>
          event.record.type === copy.type && event.record.idempotency_key === copy.idempotency_key
      );
    if (prior) {
      if (canonicalJson(prior.payload) !== canonicalJson(copy.payload))
        throw new HistoryPersistenceError(
          'IDEMPOTENCY_CONFLICT',
          'Artifact event key belongs to another payload'
        );
      this.replays.add(prior.record.event_id);
      return structuredClone(prior.record);
    }
    const encoded = encodeArtifactEvent(copy);
    const event = {
      record: encoded.record,
      payload: JSON.parse(encoded.payloadBytes.toString('utf8')) as unknown,
    };
    reconstructArtifactThread(artifactId, [...this.source, event]);
    this.source.push(event);
    this.additions.push({ ...copy, event_id: encoded.record.event_id });
    return structuredClone(encoded.record);
  }

  paths(artifactId: string): ArtifactPaths {
    this.assertArtifact(artifactId);
    const dir = path.join(path.sep, 'artifact-draft', artifactId);
    const file = (name: string) => path.join(dir, name);
    return {
      artifactId,
      dir,
      artifactJson: file('artifact.json'),
      eventsNdjson: file('events.ndjson'),
      sidecarsDir: file('sidecars'),
      planMd: file('plan.md'),
      planJson: file('plan.json'),
      checkpointMd: (n) => file(`checkpoint-${n}.md`),
      checkpointJson: (n) => file(`checkpoint-${n}.json`),
      evaluatorsJson: file('evaluators.json'),
      summaryMd: file('summary.md'),
      summaryJson: file('summary.json'),
      digestMd: file('digest.md'),
      resumeMd: file('resume.md'),
      digestMeta: file('digest.meta.json'),
    };
  }
}
