import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadSeedHistory, Repo } from '@orcaops/core';
import { getDefaultConfig } from '@orcaops/storage';
import { readProjectArtifact, readProjectSeedBundle } from '@orcaops/storage/history/database';
import { createHistoryRepo } from '@orcaops/test-harness';

import {
  databaseInitialSeedPersistence,
  databaseSeedEnrichContext,
  databaseSeedEnrichPersistence,
  prepareDatabasePendingSeedBundle,
  prepareDatabaseSeedEnrichmentSources,
  writeDatabaseGitImportEnrichment,
} from './database-seed-enrichment.js';
import { writeDatabaseSeedCluster } from './database-seed-write.js';
import { fixture as databaseFixture, inventory } from '../../tests/helpers/database-history.js';
import { runSeedEnrich } from '../commands/seed/enrich.js';
import {
  importedArtifactEnrichmentDir,
  pendingSeedEnrichmentDir,
  resolveSeedEnrichment,
  writeSeedEnrichmentBundles,
} from '../commands/seed/enrichment.js';
import { synthesizeSeedCluster } from '../commands/seed/synthesize.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture({ writeImport = true } = {}) {
  const history = await createHistoryRepo([
    {
      type: 'commit',
      label: 'root',
      subject: 'feat: choose cache',
      body: 'Use Redis instead of memory because restarts lose state.',
      files: { 'src/cache.ts': 'cache\n' },
    },
  ]);
  cleanups.push(history.cleanup);
  const database = await databaseFixture();
  const loaded = await loadSeedHistory(new Repo(history.path), {
    sinceIso: '2020-01-01T00:00:00.000Z',
  });
  const synthesis = synthesizeSeedCluster({
    cluster: loaded.clusters[0]!,
    branch: loaded.branch.ref,
    rootSha: history.shas.root!,
    installNonce: '00112233445566778899aabbccddeeff',
    importedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: '0.0.5',
  });
  if (writeImport) await writeDatabaseSeedCluster(database.writer, synthesis);
  const config = getDefaultConfig();
  const directory = importedArtifactEnrichmentDir(history.path, config, synthesis.artifactId);
  const context = databaseSeedEnrichContext({
    handle: database.writer,
    repo: new Repo(history.path),
    config,
  });
  const persistence = () =>
    databaseSeedEnrichPersistence({
      handle: database.writer,
      artifactId: synthesis.artifactId,
      repoRoot: history.path,
      directory,
    });
  return { history, database, synthesis, config, directory, context, persistence };
}

function authored(
  synthesis: Awaited<ReturnType<typeof fixture>>['synthesis'],
  optionsHash: string,
  clusterKey = synthesis.cluster.key
) {
  return {
    schema_version: 2,
    cluster_key: clusterKey,
    options_hash: optionsHash,
    used_pr_context: false,
    label: 'Durable cache choice',
    task: 'Adopt a cache that survives process restarts.',
    steps: synthesis.checkpoints.map(() => ({
      label: 'Adopt Redis cache',
      text: 'Add the Redis-backed cache.',
    })),
    checkpoint_summaries: synthesis.checkpoints.map(() => 'Landed the Redis-backed cache.'),
    outcome: 'Shipped the durable cache.',
    decisions: [
      {
        decision: 'Use Redis for cache storage.',
        reason:
          `Restarts lose in-memory state (evidence: commit ` +
          `${synthesis.cluster.commits[0]!.sha.slice(0, 7)} — "Redis instead of memory")`,
      },
    ],
  };
}

describe('database seed enrichment', () => {
  it('retains exact initial preview sources under the pending bundle identity', async () => {
    const f = await fixture();
    const directory = pendingSeedEnrichmentDir(f.history.path, f.config);
    await writeSeedEnrichmentBundles(f.history.path, f.config, [f.synthesis], {
      optionsHash: 'a'.repeat(64),
      prContextConsented: false,
    });
    const prepared = await prepareDatabasePendingSeedBundle({ directory, secretAllow: [] });
    if (!prepared) throw new Error('Pending preview fixture was not prepared');
    const original = await Promise.all(
      prepared.files.map(async ({ filename }) => ({
        filename,
        bytes: await readFile(path.join(directory, filename)),
      }))
    );
    const persistence = databaseInitialSeedPersistence({
      handle: f.database.writer,
      repoRoot: f.history.path,
      directory,
    });
    await persistence.bundle.preflight({
      syntheses: [f.synthesis],
      optionsHash: prepared.manifest.options_hash,
      prContextConsented: false,
    });
    await persistence.bundle.publish(prepared.files);

    const retained = readProjectSeedBundle(f.database.writer, { kind: 'pending' });
    expect(retained?.sources.map(({ key, bytes }) => ({ key, bytes: Buffer.from(bytes) }))).toEqual(
      original.map(({ filename, bytes }) => ({
        key: filename === 'manifest.json' ? 'manifest' : `bundle:${filename}`,
        bytes,
      }))
    );
    expect(await persistence.bundle.readManifest()).toEqual(prepared.manifest);
  });

  it('resumes retained initial enrichment and refuses changed authored input', async () => {
    const f = await fixture();
    const directory = pendingSeedEnrichmentDir(f.history.path, f.config);
    const optionsHash = 'b'.repeat(64);
    await writeSeedEnrichmentBundles(f.history.path, f.config, [f.synthesis], {
      optionsHash,
      prContextConsented: false,
    });
    const pending = await prepareDatabasePendingSeedBundle({ directory, secretAllow: [] });
    if (!pending) throw new Error('Pending preview fixture was not prepared');
    const initial = databaseInitialSeedPersistence({
      handle: f.database.writer,
      repoRoot: f.history.path,
      directory,
    });
    await initial.bundle.preflight({
      syntheses: [f.synthesis],
      optionsHash,
      prContextConsented: false,
    });
    await initial.bundle.publish(pending.files);
    const source = authored(f.synthesis, optionsHash);
    const sourceFile = path.join(directory, 'authored.json');
    const sourceBytes = Buffer.from(JSON.stringify(source));
    await writeFile(sourceFile, sourceBytes);
    const preparedAuthored = await prepareDatabaseSeedEnrichmentSources({
      directory,
      secretAllow: [],
    });
    const accepted = databaseInitialSeedPersistence({
      handle: f.database.writer,
      repoRoot: f.history.path,
      directory,
      preparedAuthored,
    });
    const first = await resolveSeedEnrichment(f.history.path, f.config, [f.synthesis], {
      enrichmentDir: directory,
      optionsHash,
      prContextConsented: false,
      persistence: accepted.enrichment,
    });
    expect(first.report.applied).toBe(1);
    const retained = readProjectSeedBundle(f.database.writer, {
      kind: 'accepted',
      artifactId: f.synthesis.artifactId,
    })!;
    expect(Buffer.from(retained.sources.find(({ key }) => key === 'authored')!.bytes)).toEqual(
      sourceBytes
    );

    await rm(sourceFile);
    const resumed = await resolveSeedEnrichment(f.history.path, f.config, [f.synthesis], {
      optionsHash,
      prContextConsented: false,
      persistence: databaseInitialSeedPersistence({
        handle: f.database.writer,
        repoRoot: f.history.path,
        directory,
      }).enrichment,
    });
    expect(resumed.report.applied).toBe(1);
    expect(resumed.syntheses[0]!.plan.label).toBe(first.syntheses[0]!.plan.label);

    await writeFile(sourceFile, JSON.stringify({ ...source, outcome: 'Changed after acceptance' }));
    const changed = await prepareDatabaseSeedEnrichmentSources({ directory, secretAllow: [] });
    await expect(
      resolveSeedEnrichment(f.history.path, f.config, [f.synthesis], {
        enrichmentDir: directory,
        optionsHash,
        prContextConsented: false,
        persistence: databaseInitialSeedPersistence({
          handle: f.database.writer,
          repoRoot: f.history.path,
          directory,
          preparedAuthored: changed,
        }).enrichment,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('distinguishes applied import enrichment from the same content pending an amendment', async () => {
    const f = await fixture({ writeImport: false });
    const optionsHash = 'd'.repeat(64);
    const source = authored(f.synthesis, optionsHash);
    const sourceBytes = Buffer.from(JSON.stringify(source));
    const acceptedBytes = Buffer.from(
      JSON.stringify({
        ...source,
        enriched_at: '2026-02-01T00:00:00.000Z',
      })
    );
    await mkdir(f.directory, { recursive: true });
    const sourceFile = path.join(f.directory, 'authored.json');
    await writeFile(sourceFile, sourceBytes);
    const initial = databaseInitialSeedPersistence({
      handle: f.database.writer,
      repoRoot: f.history.path,
      directory: f.directory,
      linkPending: false,
    });
    await initial.enrichment.writeAccepted({
      artifactId: f.synthesis.artifactId,
      bytes: acceptedBytes,
      source: { bytes: sourceBytes, originalPath: sourceFile },
    });
    const resolved = await resolveSeedEnrichment(f.history.path, f.config, [f.synthesis], {
      enrichmentDir: f.directory,
      optionsHash,
      prContextConsented: false,
      persistence: initial.enrichment,
    });
    expect(resolved.report.applied).toBe(1);
    const enriched = resolved.syntheses[0]!;
    await writeDatabaseSeedCluster(f.database.writer, enriched);
    const retained = readProjectSeedBundle(f.database.writer, {
      kind: 'accepted',
      artifactId: f.synthesis.artifactId,
    })!;
    expect(retained.sources.every((source) => source.sourceRevisionId === undefined)).toBe(true);
    expect(
      readProjectSeedBundle(f.database.writer, {
        kind: 'amend',
        artifactId: f.synthesis.artifactId,
      })
    ).toBeNull();
    expect(await initial.enrichment.readOriginalAccepted?.(f.synthesis.artifactId)).toBeNull();

    const pending = f.persistence();
    await writeSeedEnrichmentBundles(f.history.path, f.config, [enriched], {
      optionsHash,
      prContextConsented: false,
      directory: f.directory,
      persistence: pending.bundle,
      amendment: {
        artifact_id: f.synthesis.artifactId,
        prior_enrichment_event_id: null,
        member_shas_hash: enriched.plan.origin!.member_shas_hash!,
        decision_mode: 'replace',
        pr_context_consented: false,
      },
    });
    await pending.bundle.readManifest();
    await pending.enrichment.writeAccepted({
      artifactId: f.synthesis.artifactId,
      bytes: acceptedBytes,
      source: { bytes: sourceBytes, originalPath: sourceFile },
    });
    const replay = await pending.enrichment.readOriginalAccepted?.(f.synthesis.artifactId);
    expect(replay?.bytes).toEqual(acceptedBytes);
    expect(replay?.originalPath).toBe(sourceFile);
  });

  it('retains the preview bundle and materializes only its generated workspace files', async () => {
    const f = await fixture();
    await mkdir(f.directory, { recursive: true });
    await writeFile(path.join(f.directory, 'authored.json'), '{}\n');

    const result = await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true },
      f.persistence()
    );

    expect(result).toMatchObject({ mode: 'dry-run', ready: false });
    const retained = readProjectSeedBundle(f.database.writer, {
      kind: 'amend',
      artifactId: f.synthesis.artifactId,
    });
    expect(retained?.manifest?.amendment?.artifact_id).toBe(f.synthesis.artifactId);
    expect(await readFile(path.join(f.directory, 'authored.json'), 'utf8')).toBe('{}\n');
    expect(await readFile(path.join(f.directory, 'manifest.json'), 'utf8')).toContain(
      f.synthesis.artifactId
    );
  });

  it('recovers exact accepted input after cancellation between bundle and artifact commits', async () => {
    const f = await fixture();
    const persistence = f.persistence();
    await runSeedEnrich(f.context, { artifact: f.synthesis.artifactId, dryRun: true }, persistence);
    const manifest = (await persistence.bundle.readManifest())!;
    const source = authored(f.synthesis, manifest.options_hash, manifest.bundles[0]!.cluster_key);
    const sourceFile = path.join(f.directory, 'authored.json');
    await writeFile(sourceFile, JSON.stringify(source));

    const controller = new AbortController();
    const applyPersistence = databaseSeedEnrichPersistence({
      handle: f.database.writer,
      artifactId: f.synthesis.artifactId,
      repoRoot: f.history.path,
      directory: f.directory,
      operationOptions: { signal: controller.signal },
    });
    let acceptedWrites = 0;
    const writeAccepted = applyPersistence.enrichment.writeAccepted.bind(
      applyPersistence.enrichment
    );
    applyPersistence.enrichment.writeAccepted = (input) => {
      acceptedWrites += 1;
      return writeAccepted(input);
    };
    const interruptedContext = databaseSeedEnrichContext({
      handle: f.database.writer,
      repo: new Repo(f.history.path),
      config: f.config,
      operationOptions: { signal: controller.signal },
    });
    const originalWrite = interruptedContext.store.writeGitImportEnrichment;
    interruptedContext.store.writeGitImportEnrichment = (input, options) => {
      controller.abort();
      return originalWrite(input, options);
    };
    const interrupted = await runSeedEnrich(
      interruptedContext,
      { artifact: f.synthesis.artifactId, yes: true, enrichmentDir: f.directory },
      applyPersistence
    );
    expect(acceptedWrites).toBe(1);
    expect(interrupted).toMatchObject({
      totals: { amended: 0, failed: 1 },
      failures: [expect.stringContaining('cancel')],
    });
    const accepted = readProjectSeedBundle(f.database.writer, {
      kind: 'accepted',
      artifactId: f.synthesis.artifactId,
    })!;
    expect(accepted.sources.map((item) => item.key)).toEqual(['enrichment', 'authored']);
    expect(
      readProjectArtifact(f.database.writer, f.synthesis.artifactId)!.thread.events.filter(
        (event) => event.record.type === 'git_import_enriched'
      )
    ).toEqual([]);

    const beforeRead = await inventory(f.database.root);
    await applyPersistence.bundle.readManifest();
    await applyPersistence.enrichment.readAccepted(f.synthesis.artifactId);
    await applyPersistence.enrichment.readOriginalAccepted?.(f.synthesis.artifactId);
    expect(await inventory(f.database.root)).toEqual(beforeRead);

    await writeFile(sourceFile, JSON.stringify({ ...source, outcome: 'Changed after acceptance' }));
    const changedPersistence = f.persistence();
    await expect(
      changedPersistence.enrichment.readOriginalAccepted?.(f.synthesis.artifactId)
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      readProjectArtifact(f.database.writer, f.synthesis.artifactId)!.thread.events.filter(
        (event) => event.record.type === 'git_import_enriched'
      )
    ).toEqual([]);

    await rm(sourceFile);
    const resumed = await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, yes: true },
      f.persistence()
    );
    expect(resumed.totals).toMatchObject({ amended: 1, failed: 0 });
    const event = readProjectArtifact(
      f.database.writer,
      f.synthesis.artifactId
    )!.thread.events.find((item) => item.record.type === 'git_import_enriched')!;
    expect(event.payload).toMatchObject({
      enriched_at: accepted.enrichment!.enriched_at,
      outcome: source.outcome,
    });
    await expect(
      writeDatabaseGitImportEnrichment(f.database.writer, event.payload as never, {
        idempotencyKey: event.record.idempotency_key,
      })
    ).resolves.toMatchObject({ outcome: 'replay', priorEventId: event.record.event_id });
  });

  it('recovers a different accepted amendment that shares an applied timestamp', async () => {
    const f = await fixture();
    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true },
      f.persistence()
    );
    const manifest = (await f.persistence().bundle.readManifest())!;
    const sourceFile = path.join(f.directory, 'authored.json');
    const firstSource = authored(
      f.synthesis,
      manifest.options_hash,
      manifest.bundles[0]!.cluster_key
    );
    await writeFile(sourceFile, JSON.stringify(firstSource));
    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, yes: true, enrichmentDir: f.directory },
      f.persistence()
    );
    const firstEvent = readProjectArtifact(
      f.database.writer,
      f.synthesis.artifactId
    )!.thread.events.find((event) => event.record.type === 'git_import_enriched')!;

    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true },
      f.persistence()
    );
    const secondSource = { ...firstSource, outcome: 'Shipped a second durable cache result.' };
    await writeFile(sourceFile, JSON.stringify(secondSource));
    await f.persistence().enrichment.writeAccepted({
      artifactId: f.synthesis.artifactId,
      bytes: Buffer.from(
        JSON.stringify({
          ...secondSource,
          enriched_at: (firstEvent.payload as { enriched_at: string }).enriched_at,
        })
      ),
      source: { bytes: Buffer.from(JSON.stringify(secondSource)), originalPath: sourceFile },
    });
    await rm(sourceFile);

    const resumed = await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, yes: true },
      f.persistence()
    );
    expect(resumed.totals).toMatchObject({ amended: 1, failed: 0 });
    const events = readProjectArtifact(
      f.database.writer,
      f.synthesis.artifactId
    )!.thread.events.filter((event) => event.record.type === 'git_import_enriched');
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({
      enriched_at: (events[1]!.payload as { enriched_at: string }).enriched_at,
      outcome: firstSource.outcome,
    });
    expect(events[1]!.payload).toMatchObject({ outcome: secondSource.outcome });

    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true, preserveDecisions: true },
      f.persistence()
    );
    const withoutNewSource = await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, yes: true, preserveDecisions: true },
      f.persistence()
    );
    expect(withoutNewSource.totals).toMatchObject({ amended: 0, unchanged: 0, failed: 1 });
    expect(
      readProjectArtifact(f.database.writer, f.synthesis.artifactId)!.thread.events.filter(
        (event) => event.record.type === 'git_import_enriched'
      )
    ).toHaveLength(2);
  });

  it('settles a preserve amendment accepted from the current preview after its source is removed', async () => {
    const f = await fixture();
    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true, preserveDecisions: true },
      f.persistence()
    );
    const firstManifest = (await f.persistence().bundle.readManifest())!;
    const sourceFile = path.join(f.directory, 'authored.json');
    const firstSource = authored(
      f.synthesis,
      firstManifest.options_hash,
      firstManifest.bundles[0]!.cluster_key
    );
    await writeFile(sourceFile, JSON.stringify(firstSource));
    await runSeedEnrich(
      f.context,
      {
        artifact: f.synthesis.artifactId,
        yes: true,
        preserveDecisions: true,
        enrichmentDir: f.directory,
      },
      f.persistence()
    );
    const firstEvent = readProjectArtifact(
      f.database.writer,
      f.synthesis.artifactId
    )!.thread.events.find((event) => event.record.type === 'git_import_enriched')!;

    await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, dryRun: true, preserveDecisions: true },
      f.persistence()
    );
    const pendingPersistence = f.persistence();
    await pendingPersistence.bundle.readManifest();
    const amendment = readProjectSeedBundle(f.database.writer, {
      kind: 'amend',
      artifactId: f.synthesis.artifactId,
    })!;
    const firstAccepted = readProjectSeedBundle(f.database.writer, {
      kind: 'accepted',
      artifactId: f.synthesis.artifactId,
    })!;
    await pendingPersistence.enrichment.writeAccepted({
      artifactId: f.synthesis.artifactId,
      bytes: Buffer.from(
        firstAccepted.sources.find((source) => source.key === 'enrichment')!.bytes
      ),
      source: { bytes: Buffer.from(JSON.stringify(firstSource)), originalPath: sourceFile },
    });
    const secondSource = {
      ...firstSource,
      decisions: [
        {
          ...firstSource.decisions[0]!,
          decision: 'Keep the accepted Redis choice.',
        },
      ],
    };
    await pendingPersistence.enrichment.writeAccepted({
      artifactId: f.synthesis.artifactId,
      bytes: Buffer.from(
        JSON.stringify({
          ...secondSource,
          enriched_at: (firstEvent.payload as { enriched_at: string }).enriched_at,
        })
      ),
      source: { bytes: Buffer.from(JSON.stringify(secondSource)), originalPath: sourceFile },
    });
    await rm(sourceFile);
    const accepted = readProjectSeedBundle(f.database.writer, {
      kind: 'accepted',
      artifactId: f.synthesis.artifactId,
    })!;
    expect(accepted.sources.map((source) => source.sourceRevisionId)).toEqual([
      amendment.revision.revisionId,
      amendment.revision.revisionId,
    ]);
    const original = await pendingPersistence.enrichment.readOriginalAccepted?.(
      f.synthesis.artifactId
    );
    expect(JSON.parse(original!.bytes.toString('utf8')).decisions).toEqual(secondSource.decisions);

    const resumed = await runSeedEnrich(
      f.context,
      { artifact: f.synthesis.artifactId, yes: true, preserveDecisions: true },
      f.persistence()
    );
    expect(resumed.totals).toMatchObject({ amended: 0, unchanged: 1, failed: 0 });
    expect(
      readProjectArtifact(f.database.writer, f.synthesis.artifactId)!.thread.events.filter(
        (event) => event.record.type === 'git_import_enriched'
      )
    ).toHaveLength(1);
  });

  it('refuses accepted authored secrets before creating bundle receipts', async () => {
    const f = await fixture();
    const token = 'ghp_' + 'A'.repeat(36);
    const before = await inventory(f.database.root);
    const persistence = f.persistence().enrichment;
    const source = authored(f.synthesis, createHash('sha256').update('options').digest('hex'));
    await expect(
      persistence.writeAccepted({
        artifactId: f.synthesis.artifactId,
        bytes: Buffer.from(
          JSON.stringify({ ...source, outcome: token, enriched_at: new Date().toISOString() })
        ),
        source: {
          bytes: Buffer.from(JSON.stringify({ ...source, outcome: token })),
          originalPath: path.join(f.directory, 'authored.json'),
        },
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(await inventory(f.database.root)).toEqual(before);
  });

  it('refuses generated secrets before creating the bundle workspace or receipt', async () => {
    const f = await fixture();
    const token = 'ghp_' + 'A'.repeat(36);
    const synthesis = {
      ...f.synthesis,
      cluster: {
        ...f.synthesis.cluster,
        commits: f.synthesis.cluster.commits.map((commit, index) =>
          index === 0 ? { ...commit, body: token } : commit
        ),
      },
    };
    const before = await inventory(f.database.root);

    await expect(
      writeSeedEnrichmentBundles(f.history.path, f.config, [synthesis], {
        optionsHash: createHash('sha256').update('options').digest('hex'),
        prContextConsented: false,
        persistence: f.persistence().bundle,
        amendment: {
          artifact_id: f.synthesis.artifactId,
          prior_enrichment_event_id: null,
          member_shas_hash: f.synthesis.plan.origin!.member_shas_hash!,
          decision_mode: 'replace',
          pr_context_consented: false,
        },
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inventory(f.database.root)).toEqual(before);
  });
});
