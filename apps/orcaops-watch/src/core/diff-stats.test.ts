// Cache-identity regression: DiffStatReader.read() consumes BOTH the event
// log path and the sidecars directory, so its cache must be keyed by both. A
// cache keyed on the log path alone serves one sidecar root's stats to a
// caller asking about another root — observable whenever a payload spilled to
// a sidecar exists under one root and not the other.

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvent } from '@orcaops/storage';

import { DiffStatReader } from './diff-stats';

describe('DiffStatReader cache identity', () => {
  let tmpRoot: string;
  let eventsPath: string;
  let sidecarsA: string;
  let sidecarsB: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-diffstats-'));
    eventsPath = path.join(tmpRoot, 'events.ndjson');
    sidecarsA = path.join(tmpRoot, 'sidecars-a');
    sidecarsB = path.join(tmpRoot, 'sidecars-b');
    await mkdir(sidecarsB, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /** A checkpoint_closed whose payload exceeds the 8 KiB inline budget, so it
   * spills into the sidecars dir passed at append time (root A). */
  async function appendSpilledClose(): Promise<void> {
    await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-04-26T12:00:00.000Z',
        idempotency_key: 'close-1',
        payload: {
          n: 1,
          diff_fingerprint_manifest: {
            hunks: [{ added_line_count: 7, deleted_line_count: 3 }],
          },
          pad: 'x'.repeat(16 * 1024),
        },
      },
      { eventLogPath: eventsPath, sidecarsDir: sidecarsA }
    );
  }

  it('does not serve one sidecar root the stats read under another', async () => {
    await appendSpilledClose();
    const reader = new DiffStatReader();

    const underA = await reader.read(eventsPath, sidecarsA);
    expect(underA.get(1)).toEqual({ added: 7, removed: 3 });

    // Root B has no sidecar for the spilled payload: the read must degrade to
    // "unknown" (cp omitted) — NOT return root A's cached stats.
    const underB = await reader.read(eventsPath, sidecarsB);
    expect(underB.get(1)).toBeUndefined();

    // And root A's entry still serves correctly afterwards.
    const underAAgain = await reader.read(eventsPath, sidecarsA);
    expect(underAAgain.get(1)).toEqual({ added: 7, removed: 3 });
  });

  it('treats a hot log deleted after selection as absent', async () => {
    expect(
      await new DiffStatReader().read(
        path.join(tmpRoot, 'missing.ndjson'),
        sidecarsA,
        tmpRoot,
        true
      )
    ).toEqual(new Map());
  });

  it('does not follow a final hot sidecar symlink', async () => {
    await appendSpilledClose();
    const [sidecarName] = await readdir(sidecarsA);
    const sidecar = path.join(sidecarsA, sidecarName);
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-diffstats-outside-'));
    try {
      const external = path.join(outside, 'payload.json');
      await writeFile(external, await readFile(sidecar));
      await unlink(sidecar);
      await symlink(external, sidecar);

      expect(await new DiffStatReader().read(eventsPath, sidecarsA, tmpRoot)).toEqual(new Map());
      await expect(new DiffStatReader().read(eventsPath, sidecarsA, tmpRoot, true)).rejects.toThrow(
        /must not contain symlinks/
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
