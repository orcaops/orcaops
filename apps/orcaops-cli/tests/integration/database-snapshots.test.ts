import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  previewDatabaseGitReclamation,
  publishDatabaseGitRef,
  requireDatabaseExecutionContext,
} from '@orcaops/core/history/database-retention';
import { uuidv7 } from '@orcaops/storage';
import {
  beginProjectGitReclamation,
  beginProjectGitRetention,
  gitRetentionPreparation,
  prepareProjectGitRetention,
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
  retireProjectGitRetention,
} from '@orcaops/storage/history/database';

import {
  closeFingerprintedCheckpoint,
  commitFile,
  treeOf,
} from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function run(f: Fixture, args: string[], env: Record<string, string> = {}) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1', ...env },
  }).runRaw(['snapshots', ...args]);
}

async function captured(options: { content?: string; withoutManifest?: boolean } = {}) {
  const f = await fixture();
  const baseline = await treeOf(f, 'HEAD');
  const id = await f.capture(undefined, { baselineSeedTreeSha: baseline });
  const head = await commitFile(
    f,
    'src/retained.ts',
    options.content ?? 'export const retained = 1;\n'
  );
  const openPublicationId = uuidv7();
  const closePublicationId = uuidv7();
  const closed = await closeFingerprintedCheckpoint(f, id, {
    files: ['src/retained.ts'],
    openRef: f.context.headOid!,
    closeRef: head,
    openPublicationId,
    closePublicationId,
    withoutManifest: options.withoutManifest,
  });
  return { f, id, baseline, closed, openPublicationId, closePublicationId };
}

async function retainedPublication(
  f: Fixture,
  artifactId: string,
  closed: Awaited<ReturnType<typeof closeFingerprintedCheckpoint>>,
  options: {
    role?: 'checkpoint' | 'baseline';
    phase?: 'open' | 'close';
    retired?: boolean;
    publicationId?: string;
  } = {}
) {
  const artifact = readProjectArtifact(f.writer, artifactId)!;
  const execution = readProjectExecution(f.writer, artifactId)!;
  const checkpoint = artifact.thread.checkpoints[0];
  if (checkpoint?.status !== 'closed') throw new Error('Fixture checkpoint is not closed');
  const role = options.role ?? 'checkpoint';
  const phase = options.phase ?? 'close';
  const operationId = uuidv7();
  const retention = prepareProjectGitRetention({
    operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: f.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-05T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId,
      expectedRevision: artifact.revision,
      expectedExecutionVersion: execution.version,
      expectedBindingGeneration: execution.state.binding_generation,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: options.publicationId ?? uuidv7(),
        role,
        targetId:
          role === 'checkpoint'
            ? checkpoint.source_event_ids[phase === 'open' ? 'opened' : 'closed']
            : artifact.thread.events[0]!.record.event_id,
        checkpointNumber: role === 'checkpoint' ? 1 : null,
        checkpointPhase: role === 'checkpoint' ? phase : null,
        objectOid: role === 'baseline' || phase === 'open' ? closed.openSha : closed.closeSha,
        treeOid: role === 'baseline' || phase === 'open' ? closed.openTree : closed.closeTree,
      },
    ],
    secretAllow: [],
  });
  const prepared = gitRetentionPreparation(retention);
  const publication = prepared.publications[0]!;
  await beginProjectGitRetention(f.writer, retention);
  const current = await requireDatabaseExecutionContext({ cwd: f.main, root: f.root });
  await publishDatabaseGitRef(current, {
    fullRef: publication.fullRef,
    objectOid: publication.objectOid,
    treeOid: publication.treeOid,
    objectFormat: prepared.objectFormat,
  });
  if (options.retired) {
    await retireProjectGitRetention(f.writer, {
      operationId: uuidv7(),
      originalOperationId: operationId,
      expectedTransitionId: prepared.preparedTransitionId,
      transitionId: uuidv7(),
      reason: 'Original publication was not selected',
      secretAllow: [],
    });
  }
  return { prepared, publication };
}

describe('database snapshot reads', () => {
  it('diffs an exact retained checkpoint selected by artifact prefix without writes', async () => {
    const { f, id, closed } = await captured();
    const before = await inventory(f.root);
    const result = await run(f, ['diff', '--artifact', id.slice(0, 12), '1', '--json']);

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifact: id,
      from_sha: closed.openTree,
      to_sha: closed.closeTree,
      tree_source: 'stored_manifest_trees',
      diff: expect.stringContaining('export const retained = 1;'),
    });
    expect(await inventory(f.root)).toEqual(before);
  });

  it('diffs from the retained plan baseline tree without resolving a legacy ref', async () => {
    const { f, id, baseline, closed } = await captured();
    const result = await run(f, ['diff', '--artifact', id, 'baseline..1', '--json']);

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifact: id,
      from: { kind: 'baseline', ref: null },
      from_sha: baseline,
      to_sha: closed.closeTree,
    });
  });

  it('materializes the physical checkpoint boundary into an explicit scratch directory', async () => {
    const { f, id, closed } = await captured();
    const destination = path.join(f.temporary, 'snapshot-checkout');
    const before = await inventory(f.root);
    const result = await run(f, [
      'checkout',
      '--artifact',
      id.slice(0, 12),
      '--checkpoint',
      '1',
      '--into',
      destination,
      '--json',
    ]);

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifact: id,
      checkpoint: 1,
      phase: 'close',
      tree_sha: closed.closeTree,
      snapshot_commit_sha: closed.closeSha,
      dir: destination,
    });
    expect(await readFile(path.join(destination, 'src/retained.ts'), 'utf8')).toBe(
      'export const retained = 1;\n'
    );
    expect(await inventory(f.root)).toEqual(before);
  });

  it('materializes the retained open boundary when explicitly selected', async () => {
    const { f, id, baseline } = await captured();
    const destination = path.join(f.temporary, 'snapshot-open');
    const result = await run(f, [
      'checkout',
      '--artifact',
      id,
      '--checkpoint',
      '1',
      '--phase',
      'open',
      '--into',
      destination,
      '--json',
    ]);

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ phase: 'open', tree_sha: baseline });
    await expect(readFile(path.join(destination, 'src/retained.ts'), 'utf8')).rejects.toThrow();
  });

  it('refuses a non-empty checkout destination', async () => {
    const { f, id } = await captured();
    const destination = path.join(f.temporary, 'occupied');
    await mkdir(destination);
    await writeFile(path.join(destination, 'keep.txt'), 'keep\n');

    const result = await run(f, [
      'checkout',
      '--artifact',
      id,
      '--checkpoint',
      '1',
      '--into',
      destination,
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('INVALID_INPUT');
    expect(await readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses missing retained manifest evidence for a declared fingerprint', async () => {
    const { f, id } = await captured({ withoutManifest: true });
    const before = await inventory(f.root);
    const result = await run(f, ['diff', '--artifact', id, '1', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('EVENT_LOG_CORRUPT');
    expect(await inventory(f.root)).toEqual(before);
  });

  it('redacts retained secret content from diff output', async () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const { f, id } = await captured({ content: `export const token = '${secret}';\n` });
    const result = await run(f, ['diff', '--artifact', id, '1', '--json']);

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).diff).toContain('[REDACTED_SECRET]');
    expect(result.stdout).not.toContain(secret);
  });

  it('does not replace missing registered history for checkout or diff', async () => {
    const { f, id } = await captured();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.root);

    for (const args of [
      ['checkout', '--artifact', id, '--checkpoint', '1', '--json'],
      ['diff', '--artifact', id, '1', '--json'],
    ]) {
      const result = await run(f, args);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_MISSING');
    }
    expect(await inventory(f.root)).toEqual(before);
  });

  it('ignores ambient Git selectors and replacement objects for diff and checkout', async () => {
    const { f, id, baseline, closed } = await captured();
    const redirected = path.join(f.temporary, 'redirected');
    await mkdir(redirected);
    await git(redirected, ['init', '-q']);
    await git(f.main, ['update-ref', `refs/replace/${closed.closeTree}`, baseline]);
    const env = {
      GIT_DIR: path.join(redirected, '.git'),
      GIT_WORK_TREE: redirected,
      GIT_NO_REPLACE_OBJECTS: '0',
    };

    const diff = await run(f, ['diff', '--artifact', id, '1', '--json'], env);
    expect(diff.exitCode, diff.stdout + diff.stderr).toBe(0);
    expect(JSON.parse(diff.stdout).diff).toContain('export const retained = 1;');

    const destination = path.join(f.temporary, 'sanitized-checkout');
    const checkout = await run(
      f,
      ['checkout', '--artifact', id, '--checkpoint', '1', '--into', destination, '--json'],
      env
    );
    expect(checkout.exitCode, checkout.stdout + checkout.stderr).toBe(0);
    expect(await readFile(path.join(destination, 'src/retained.ts'), 'utf8')).toBe(
      'export const retained = 1;\n'
    );
  });
});

describe('database snapshot pruning', () => {
  it('uses retired publication state without an archive-cache derivation gate', async () => {
    const { f, id, closed, closePublicationId } = await captured({ withoutManifest: true });
    const checkpoint = await retainedPublication(f, id, closed, {
      retired: true,
      publicationId: closePublicationId,
    });

    const dry = await run(f, ['prune', '--artifact', id, '--json']);
    expect(dry.exitCode, dry.stdout + dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).candidates).toEqual([checkpoint.publication.fullRef]);

    const applied = await run(f, ['prune', '--artifact', id, '--apply', '--json']);
    expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).deleted).toBe(1);
    await expect(git(f.main, ['rev-parse', checkpoint.publication.fullRef])).rejects.toThrow();
  });

  it('previews and applies only retired checkpoint publications for the selected artifact', async () => {
    const { f, id, closed, openPublicationId, closePublicationId } = await captured();
    const checkpoint = await retainedPublication(f, id, closed, {
      retired: true,
      publicationId: closePublicationId,
    });
    const baseline = await retainedPublication(f, id, closed, { role: 'baseline', retired: true });
    const pending = await retainedPublication(f, id, closed, {
      phase: 'open',
      publicationId: openPublicationId,
    });
    const unknown = `refs/orcaops/snap/${id}/99/open-${uuidv7()}`;
    await git(f.main, ['update-ref', unknown, closed.closeSha]);

    const dry = await run(f, ['prune', '--artifact', id.slice(0, 12), '--json']);
    expect(dry.exitCode, dry.stdout + dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      applied: false,
      artifact: id,
      candidates: [checkpoint.publication.fullRef],
      protected: expect.arrayContaining([
        expect.objectContaining({ full_ref: pending.publication.fullRef, reason: 'pending' }),
        expect.objectContaining({ full_ref: unknown, reason: 'unknown' }),
      ]),
      deleted: 0,
    });
    expect((await git(f.main, ['rev-parse', checkpoint.publication.fullRef])).stdout.trim()).toBe(
      closed.closeSha
    );

    const applied = await run(f, ['prune', '--artifact', id.slice(0, 12), '--apply', '--json']);
    expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      artifact: id,
      deleted: 1,
      outcomes: { publications: 1, operations: 1, removed: 1, absent: 0, replayed: 0 },
    });
    await expect(git(f.main, ['rev-parse', checkpoint.publication.fullRef])).rejects.toThrow();
    expect((await git(f.main, ['rev-parse', baseline.publication.fullRef])).stdout.trim()).toBe(
      closed.openSha
    );
    expect((await git(f.main, ['rev-parse', pending.publication.fullRef])).stdout.trim()).toBe(
      closed.openSha
    );
    expect((await git(f.main, ['rev-parse', unknown])).stdout.trim()).toBe(closed.closeSha);
  });

  it('resumes the exact pending reclamation and reports its operation outcome', async () => {
    const { f, id, closed, closePublicationId } = await captured();
    const checkpoint = await retainedPublication(f, id, closed, {
      retired: true,
      publicationId: closePublicationId,
    });
    const preview = checkpoint.publication;
    const target = previewDatabaseGitReclamation(f.writer, preview.publicationId).value;
    if (target.status !== 'eligible') throw new Error('Fixture publication is not eligible');
    const admission = {
      admissionOperationId: uuidv7(),
      terminalOperationId: uuidv7(),
      target: target.target,
    };
    await beginProjectGitReclamation(f.writer, admission);

    const result = await run(f, ['prune', '--orphans', '--apply', '--json']);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      deleted: 1,
      outcomes: { publications: 1, operations: 1, removed: 1, absent: 0, replayed: 0 },
    });
    await expect(git(f.main, ['rev-parse', checkpoint.publication.fullRef])).rejects.toThrow();
  });

  it('requires apply for all and never initializes an unregistered project', async () => {
    const f = await fixture();
    await rm(path.join(f.main, '.git', 'orcaops', 'registration.json'));
    const before = await inventory(f.root);
    const refused = await run(f, ['prune', '--all', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('INVALID_INPUT');
    const dry = await run(f, ['prune', '--orphans', '--json']);
    expect(dry.exitCode, dry.stdout + dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ project_id: null, candidates: [] });
    expect(await inventory(f.root)).toEqual(before);
  });
});
