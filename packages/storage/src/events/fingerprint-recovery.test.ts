import { describe, expect, it } from 'vitest';

import type { ArtifactThread } from './artifact-thread.js';
import { resolveRecordedFingerprintBaseline } from './fingerprint-recovery.js';
import type { ClosedCheckpoint } from '../schema/checkpoint.js';

const seedTree = 'a'.repeat(40);
const fenceTree = 'b'.repeat(40);
const priorTree = 'c'.repeat(40);

function checkpoint(n = 1): ClosedCheckpoint {
  return {
    artifact_id: 'artifact',
    n,
    status: 'closed',
    files_changed: ['value.ts'],
    open_snapshot: { tree_sha: fenceTree },
    close_snapshot: { tree_sha: fenceTree },
    source_event_ids: { opened: `open-${n}`, closed: `close-${n}` },
  } as unknown as ClosedCheckpoint;
}

function event(id: string, type: string, payload: unknown) {
  return { record: { event_id: id, type }, payload };
}

function thread(events: ReturnType<typeof event>[]): ArtifactThread {
  return { events } as unknown as ArtifactThread;
}

describe('recorded fingerprint recovery baseline', () => {
  it('resolves the plan seed before the exact retained close', () => {
    const events = [
      event('plan', 'plan_captured', { baseline_seed_tree_sha: seedTree }),
      event('open-1', 'checkpoint_opened', { n: 1, open_snapshot: { tree_sha: fenceTree } }),
      event('close-1', 'checkpoint_closed', { n: 1 }),
    ];
    expect(resolveRecordedFingerprintBaseline(thread(events), checkpoint())).toBe(seedTree);
  });

  it('prefers the prior finalized high-water tree over the plan seed', () => {
    const events = [
      event('plan', 'plan_captured', { baseline_seed_tree_sha: seedTree }),
      event('open-1', 'checkpoint_opened', { n: 1, open_snapshot: { tree_sha: seedTree } }),
      event('close-1', 'checkpoint_closed', {
        n: 1,
        close_snapshot: { tree_sha: priorTree },
      }),
      event('open-2', 'checkpoint_opened', { n: 2, open_snapshot: { tree_sha: fenceTree } }),
      event('close-2', 'checkpoint_closed', { n: 2 }),
    ];
    expect(resolveRecordedFingerprintBaseline(thread(events), checkpoint(2))).toBe(priorTree);
  });

  it('rejects a conflicted seed and an overlapping checkpoint', () => {
    const conflicted = [
      event('plan', 'plan_captured', {
        baseline_seed_tree_sha: seedTree,
        baseline_unmerged_paths: ['value.ts'],
      }),
      event('open-1', 'checkpoint_opened', { n: 1 }),
      event('close-1', 'checkpoint_closed', { n: 1 }),
    ];
    expect(resolveRecordedFingerprintBaseline(thread(conflicted), checkpoint())).toBeNull();

    const overlapping = [
      event('plan', 'plan_captured', { baseline_seed_tree_sha: seedTree }),
      event('open-1', 'checkpoint_opened', { n: 1 }),
      event('open-2', 'checkpoint_opened', { n: 2 }),
      event('close-2', 'checkpoint_closed', { n: 2 }),
    ];
    expect(resolveRecordedFingerprintBaseline(thread(overlapping), checkpoint(2))).toBeNull();
  });

  it('rejects missing or reversed projected event boundaries', () => {
    const events = [
      event('plan', 'plan_captured', { baseline_seed_tree_sha: seedTree }),
      event('close-1', 'checkpoint_closed', { n: 1 }),
      event('open-1', 'checkpoint_opened', { n: 1 }),
    ];
    expect(resolveRecordedFingerprintBaseline(thread(events), checkpoint())).toBeNull();
  });
});
