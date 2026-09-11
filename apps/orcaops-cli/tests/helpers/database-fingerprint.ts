import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildDiffFingerprintManifest,
  diffSnapshotTrees,
  Repo,
  SNAPSHOT_REF_PREFIX,
} from '@orcaops/core';
import { type CheckpointDecision, uuidv7 } from '@orcaops/storage';

import { type fixture, git } from './database-history.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function commitFile(f: Fixture, file: string, content: string, message = file) {
  const target = path.join(f.main, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  await git(f.main, ['add', '--', file]);
  await git(f.main, ['commit', '-qm', message]);
  return (await git(f.main, ['rev-parse', 'HEAD'])).stdout.trim();
}
export async function treeOf(f: Fixture, ref: string) {
  return (await git(f.main, ['rev-parse', `${ref}^{tree}`])).stdout.trim();
}

export interface FingerprintedCloseInput {
  files: string[];
  openRef: string;
  closeRef: string;
  summary?: string;
  decisions?: CheckpointDecision[];
  uncertainty?: string[];
  verification?: Array<{
    command: string;
    exit_code: number;
    output_digest?: string;
    note?: string;
  }>;
  completedStepIds?: string[];
  crossArtifactSiblings?: Array<{ artifact_id: string; n: number }>;
  unmergedPaths?: string[];
  unmergedProbeFailed?: boolean;
  /** Omit the manifest while keeping a captured summary, the retained-hash-only case. */
  withoutManifest?: boolean;
  skipFingerprint?: boolean;
  openPublicationId?: string;
  closePublicationId?: string;
}

/**
 * Opens and closes one checkpoint through the storage close pipeline with a manifest
 * built from two committed trees, exactly as the capture command's callbacks do.
 */
export async function closeFingerprintedCheckpoint(
  f: Fixture,
  artifactId: string,
  input: FingerprintedCloseInput
) {
  const openSha = (await git(f.main, ['rev-parse', input.openRef])).stdout.trim();
  const closeSha = (await git(f.main, ['rev-parse', input.closeRef])).stdout.trim();
  const openTree = await treeOf(f, input.openRef);
  const closeTree = await treeOf(f, input.closeRef);
  const repo = new Repo(f.main);
  return f.mutate(artifactId, { files: input.files }, async (semantics) => {
    const plan = await semantics.readPlan(artifactId);
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [plan!.plan_steps[0].step_id] },
      {
        idempotencyKey: uuidv7(),
        headSha: openSha,
        snapshotCallbacks: {
          captureOpenSnapshot: async ({ n: proposed }) => ({
            boundary: {
              snapshot_ref: `${SNAPSHOT_REF_PREFIX}/${artifactId}/${proposed}/open${
                input.openPublicationId ? `-${input.openPublicationId}` : ''
              }`,
              tree_sha: openTree,
              snapshot_commit_sha: openSha,
              snapshot_error_reason: null,
            },
            ...(input.unmergedPaths ? { unmerged_paths: [...input.unmergedPaths] } : {}),
            ...(input.unmergedProbeFailed ? { unmerged_probe_failed: true } : {}),
          }),
        },
      }
    );
    if (!('checkpoint' in opened)) throw new Error('Fixture checkpoint did not open');
    const n = opened.checkpoint.n;
    const closed = await semantics.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n,
        head_sha: closeSha,
        summary: input.summary ?? 'Recorded fingerprinted evidence',
        files_changed: [...input.files],
        completed_step_ids: [...(input.completedStepIds ?? [])],
        decisions: [...(input.decisions ?? [])],
        uncertainty: [...(input.uncertainty ?? [])],
        done_criteria: [],
        ...(input.verification ? { verification: [...input.verification] } : {}),
      },
      {
        idempotencyKey: uuidv7(),
        ...(input.crossArtifactSiblings
          ? { crossArtifactSiblings: input.crossArtifactSiblings }
          : {}),
        ...(input.skipFingerprint
          ? {}
          : {
              snapshotCallbacks: {
                captureCloseFingerprint: async () => {
                  const diff = await diffSnapshotTrees({
                    repo,
                    openTreeSha: openTree,
                    closeTreeSha: closeTree,
                    maxDiffBytes: 2_000_000,
                  });
                  if (!diff.ok) throw new Error('Fixture diff failed');
                  const built = await buildDiffFingerprintManifest({
                    artifactId,
                    checkpointN: n,
                    openTreeSha: openTree,
                    closeTreeSha: closeTree,
                    diffBytes: diff.diff,
                    truncated: diff.truncated,
                    maxDiffBytes: 2_000_000,
                  });
                  return {
                    boundary: {
                      snapshot_ref: `${SNAPSHOT_REF_PREFIX}/${artifactId}/${n}/close${
                        input.closePublicationId ? `-${input.closePublicationId}` : ''
                      }`,
                      tree_sha: closeTree,
                      snapshot_commit_sha: closeSha,
                      snapshot_error_reason: null,
                    },
                    summary: built.summary,
                    manifest: input.withoutManifest ? null : built.manifest,
                  };
                },
              },
            }),
      }
    );
    return { n, closed, openTree, closeTree, openSha, closeSha };
  });
}
