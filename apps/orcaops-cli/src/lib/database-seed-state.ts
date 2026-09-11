import { createHash } from 'node:crypto';

import { uuidv7 } from '@orcaops/storage';
import {
  prepareProjectSeedState,
  type ProjectDatabase,
  type ProjectOperationOptions,
  type ProjectSeedStateSnapshot,
  publishProjectSeedState,
  readProjectSeedState,
  type SeedRevision,
  type SeedStatePublicationResult,
  type SeedStateSource,
} from '@orcaops/storage/history/database';
import type {
  SeedCoverageReport,
  SeedJournal,
  SeedPreciousState,
} from '@orcaops/storage/history/seed-schema';

const sha256 = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest();
const sha256Hex = (bytes: Uint8Array): string => sha256(bytes).toString('hex');

function deterministicId(timestamp: string, identity: string): string {
  const now = Date.parse(timestamp);
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError(`Seed state timestamp is outside the UUIDv7 range: ${timestamp}`);
  return uuidv7({ now, random: () => sha256(identity) });
}

function stateSource(
  kind: SeedStateSource['kind'],
  value: unknown,
  timestamp: string
): SeedStateSource {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const identity = sha256Hex(bytes);
  return {
    kind,
    sourceId: deterministicId(timestamp, `orcaops-seed-state:source:${kind}:${identity}`),
    sourceIdentity: identity,
    sourceLocation: `seed/${kind}.json`,
    sourceSha256: identity,
    bytes,
  };
}

export interface DatabaseSeedStateInput {
  precious: SeedPreciousState;
  journal: SeedJournal;
  coverage?: SeedCoverageReport | null;
  /** The revision this write is anchored to — read from a prior state, or null on first. */
  expectedRevision: SeedRevision | null;
}

export interface DatabaseSeedStateForWrite {
  precious: SeedPreciousState;
  journal: SeedJournal;
  coverage: SeedCoverageReport | null;
  expectedRevision: SeedRevision | null;
}

export function loadDatabaseSeedStateForWrite(
  handle: ProjectDatabase,
  now = new Date()
): DatabaseSeedStateForWrite {
  const snapshot = readDatabaseSeedState(handle);
  const installNonce =
    snapshot?.precious?.install_nonce ??
    sha256Hex(
      Buffer.from(
        `orcaops-seed:${handle.authority.projectId}:${handle.authority.storeInstanceId}`,
        'utf8'
      )
    ).slice(0, 32);
  const timestamp = now.toISOString();
  return {
    precious: structuredClone(
      snapshot?.precious ?? {
        schema_version: 1,
        install_nonce: installNonce,
        pr_context: false,
        pending_importance: false,
        commit_graph_hint_shown: false,
        discovery_areas: {},
        updated_at: timestamp,
      }
    ),
    journal: structuredClone(
      snapshot?.journal ?? {
        schema_version: 2,
        install_nonce: installNonce,
        options_hash: '',
        updated_at: timestamp,
        clusters: {},
        jobs: {},
      }
    ),
    coverage: snapshot?.coverage ? structuredClone(snapshot.coverage) : null,
    expectedRevision: snapshot?.revision ?? null,
  };
}

/**
 * Publish precious state, the journal, and optional coverage as one immutable revision.
 * `expectedRevision` is the compare-and-swap anchor for composing multiple publications.
 */
export async function publishDatabaseSeedState(
  handle: ProjectDatabase,
  input: DatabaseSeedStateInput,
  options: ProjectOperationOptions = {}
): Promise<SeedStatePublicationResult> {
  const timestamp = input.journal.updated_at;
  const sources: SeedStateSource[] = [
    stateSource('precious', input.precious, timestamp),
    stateSource('journal', input.journal, timestamp),
  ];
  if (input.coverage) sources.push(stateSource('coverage', input.coverage, timestamp));
  const identity = sha256Hex(
    Buffer.from(
      JSON.stringify({
        expectedRevision: input.expectedRevision,
        sources: sources.map((source) => [source.kind, source.sourceIdentity]),
      }),
      'utf8'
    )
  );
  const prepared = prepareProjectSeedState({
    operationId: deterministicId(timestamp, `orcaops-seed-state:operation:${identity}`),
    revisionId: deterministicId(timestamp, `orcaops-seed-state:revision:${identity}`),
    expectedRevision: input.expectedRevision,
    secretAllow: [],
    sources,
  });
  const result = await publishProjectSeedState(handle, prepared, options);
  return result.value;
}

/** The retained seed state (precious/journal/coverage + its revision), or null if none. */
export function readDatabaseSeedState(handle: ProjectDatabase): ProjectSeedStateSnapshot | null {
  return readProjectSeedState(handle);
}
