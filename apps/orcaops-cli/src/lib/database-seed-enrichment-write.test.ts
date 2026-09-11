import { describe, expect, it } from 'vitest';

import type { DetailedCommit, SeedCheckpointGroup, SeedCluster } from '@orcaops/core';
import { type GitImportEnrichmentPayload, prepareArtifactDraft, uuidv7 } from '@orcaops/storage';
import {
  appendProjectImportedArtifact,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { writeDatabaseGitImportEnrichment } from './database-seed-enrichment.js';
import { writeDatabaseSeedCluster } from './database-seed-write.js';
import { fixture as databaseFixture } from '../../tests/helpers/database-history.js';
import { type SeedClusterSynthesis, synthesizeSeedCluster } from '../commands/seed/synthesize.js';

const sha = (value: string) => value.repeat(40).slice(0, 40);
const importedAt = '2026-01-02T00:00:00.000Z';

function synthesis(): SeedClusterSynthesis {
  const commit: DetailedCommit = {
    sha: sha('a'),
    parentShas: [sha('0')],
    authorEmail: 'dev@example.test',
    committerDateIso: '2026-01-01T00:00:00.000Z',
    subject: 'Adopt durable cache storage',
    body: '',
    files: ['src/cache.ts'],
  };
  const checkpoint: SeedCheckpointGroup = {
    key: 'cache-storage',
    commits: [commit],
    parentSha: sha('0'),
    headSha: commit.sha,
    files: commit.files,
    committerDateIso: commit.committerDateIso,
  };
  const cluster: SeedCluster = {
    key: 'cache-storage',
    kind: 'run',
    label: 'Adopt durable cache storage',
    baseSha: checkpoint.parentSha,
    headSha: checkpoint.headSha,
    commits: [commit],
    checkpoints: [checkpoint],
    authors: [commit.authorEmail],
    files: commit.files,
    firstParentPosition: 0,
    displayDateIso: commit.committerDateIso,
    latestCommitDateIso: commit.committerDateIso,
    conventionalType: null,
    conventionalScope: null,
    warnings: [],
  };
  return synthesizeSeedCluster({
    cluster,
    branch: 'main',
    rootSha: sha('r'),
    installNonce: '00112233445566778899aabbccddeeff',
    importedAt,
    toolVersion: 'test',
  });
}

function enrichment(
  value: SeedClusterSynthesis,
  overrides: Partial<GitImportEnrichmentPayload> = {}
): GitImportEnrichmentPayload {
  const origin = value.plan.origin;
  if (origin?.kind !== 'git-import' || !origin.cluster_key || !origin.member_shas_hash)
    throw new Error('Fixture lacks exact git-import membership');
  return {
    provenance_version: 1,
    artifact_id: value.artifactId,
    cluster_key: origin.cluster_key,
    member_shas_hash: origin.member_shas_hash,
    enriched_at: '2026-02-01T00:00:00.000Z',
    prior_enrichment_event_id: null,
    label: 'Durable cache choice',
    task: 'Use cache storage that survives process restarts.',
    steps: value.checkpoints.map(() => ({
      label: 'Adopt durable cache',
      text: 'Add the durable cache implementation.',
    })),
    checkpoint_summaries: value.checkpoints.map((checkpoint) => ({
      n: checkpoint.n,
      summary: 'Landed the durable cache implementation.',
    })),
    outcome: 'Shipped durable cache storage.',
    decisions: { mode: 'preserve' },
    ...overrides,
  };
}

async function completeFixture(options: { poisonedMembership?: boolean } = {}) {
  const database = await databaseFixture();
  const value = synthesis();
  if (options.poisonedMembership) {
    const origin = value.plan.origin;
    if (origin?.kind !== 'git-import' || !origin.member_shas)
      throw new Error('Fixture lacks exact git-import membership');
    value.plan.origin = { ...origin, member_shas: [...origin.member_shas, sha('b')] };
  }
  await writeDatabaseSeedCluster(database.writer, value);
  return { database, value };
}

async function incompleteFixture() {
  const database = await databaseFixture();
  const value = synthesis();
  const draft = await prepareArtifactDraft(
    {
      artifactId: value.artifactId,
      priorEvents: [],
      authoredPayload: value.plan,
      secretAllow: [],
      idempotencyBlocks: [],
    },
    (semantics) => semantics.writePlan(value.plan, { idempotencyKey: value.idempotencyKeys.plan })
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  await appendProjectImportedArtifact(database.writer, {
    artifactId: value.artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
    sidecarPayloads: draft.events.flatMap((event) =>
      event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
    ),
    secretAllow: [],
  });
  return { database, value };
}

function retainedArtifact(input: Awaited<ReturnType<typeof completeFixture>>) {
  return readProjectArtifact(input.database.writer, input.value.artifactId)!;
}

describe('database seed enrichment writer', () => {
  it('replays exact content and rejects conflicting or superseded operations without writes', async () => {
    const current = await completeFixture();
    const original = enrichment(current.value);
    const first = await writeDatabaseGitImportEnrichment(current.database.writer, original, {
      idempotencyKey: 'first-enrichment',
    });
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') throw new Error('Expected an enrichment event');

    const afterFirst = retainedArtifact(current);
    await expect(
      writeDatabaseGitImportEnrichment(
        current.database.writer,
        { ...original, enriched_at: '2026-02-02T00:00:00.000Z' },
        { idempotencyKey: 'first-enrichment' }
      )
    ).resolves.toMatchObject({
      outcome: 'replay',
      priorEventId: first.event_id,
      enrichment: { enriched_at: original.enriched_at },
    });
    expect(retainedArtifact(current)).toEqual(afterFirst);

    await expect(
      writeDatabaseGitImportEnrichment(
        current.database.writer,
        { ...original, label: 'Changed cache choice' },
        { idempotencyKey: 'first-enrichment' }
      )
    ).resolves.toMatchObject({ outcome: 'conflict', priorEventId: first.event_id });
    expect(retainedArtifact(current)).toEqual(afterFirst);

    const second = await writeDatabaseGitImportEnrichment(
      current.database.writer,
      {
        ...original,
        label: 'Refined durable cache choice',
        prior_enrichment_event_id: first.event_id,
      },
      { idempotencyKey: 'second-enrichment' }
    );
    expect(second.outcome).toBe('created');
    if (second.outcome !== 'created') throw new Error('Expected a second enrichment event');
    const afterSecond = retainedArtifact(current);

    await expect(
      writeDatabaseGitImportEnrichment(current.database.writer, original, {
        idempotencyKey: 'first-enrichment',
      })
    ).rejects.toMatchObject({
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
      latestEnrichmentEventId: second.event_id,
    });
    await expect(
      writeDatabaseGitImportEnrichment(
        current.database.writer,
        { ...original, label: 'Stale third choice', prior_enrichment_event_id: first.event_id },
        { idempotencyKey: 'third-enrichment' }
      )
    ).rejects.toMatchObject({
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
      latestEnrichmentEventId: second.event_id,
    });
    expect(retainedArtifact(current)).toEqual(afterSecond);
  });

  it.each([
    {
      name: 'a mismatched immutable member hash',
      payload(value: SeedClusterSynthesis) {
        return enrichment(value, { member_shas_hash: 'd'.repeat(64) });
      },
      code: 'GIT_IMPORT_ENRICHMENT_INVALID',
    },
    {
      name: 'decision evidence outside the imported member set',
      payload(value: SeedClusterSynthesis) {
        return enrichment(value, {
          decisions: {
            mode: 'replace',
            decisions: [
              {
                decision: 'Use an external cache change',
                reason: 'The external change used durable storage.',
                revision_n: 0,
                evidence: {
                  kind: 'git-commit',
                  commit_sha: sha('f'),
                  quote: 'Use durable storage',
                },
              },
            ],
          },
        });
      },
      code: 'GIT_IMPORT_ENRICHMENT_INVALID',
    },
    {
      name: 'a changed plan and checkpoint shape',
      payload(value: SeedClusterSynthesis) {
        return enrichment(value, { steps: [], checkpoint_summaries: [] });
      },
      code: 'GIT_IMPORT_ENRICHMENT_INVALID',
    },
    {
      name: 'a stale prior enrichment identity',
      payload(value: SeedClusterSynthesis) {
        return enrichment(value, { prior_enrichment_event_id: uuidv7() });
      },
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
    },
  ])('rejects $name without changing retained history', async ({ payload, code }) => {
    const current = await completeFixture();
    const before = retainedArtifact(current);
    await expect(
      writeDatabaseGitImportEnrichment(current.database.writer, payload(current.value), {
        idempotencyKey: `rejected-${code}`,
      })
    ).rejects.toMatchObject({ code });
    expect(retainedArtifact(current)).toEqual(before);
  });

  it('rejects inconsistent stored membership without changing retained history', async () => {
    const current = await completeFixture({ poisonedMembership: true });
    const before = retainedArtifact(current);
    await expect(
      writeDatabaseGitImportEnrichment(current.database.writer, enrichment(current.value), {
        idempotencyKey: 'poisoned-membership',
      })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID' });
    expect(retainedArtifact(current)).toEqual(before);
  });

  it('rejects an incomplete imported thread without changing retained history', async () => {
    const current = await incompleteFixture();
    const before = retainedArtifact(current);
    await expect(
      writeDatabaseGitImportEnrichment(current.database.writer, enrichment(current.value), {
        idempotencyKey: 'incomplete-thread',
      })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID_TARGET' });
    expect(retainedArtifact(current)).toEqual(before);
  });
});
