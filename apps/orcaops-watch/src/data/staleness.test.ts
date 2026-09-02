import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '@orcaops/test-harness';

import { computeFloorStaleness, readWorktreeProbe } from './staleness';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DIG_A = 'digest-a';
const DIG_B = 'digest-b';
const execFileAsync = promisify(execFile);

describe('computeFloorStaleness', () => {
  it('is null when nothing moved (same HEAD, same digest)', () => {
    expect(
      computeFloorStaleness({
        floorHeadSha: HEAD_A,
        currentHeadSha: HEAD_A,
        loadDigest: DIG_A,
        currentDigest: DIG_A,
      })
    ).toBeNull();
  });

  it('flags a moved HEAD', () => {
    const row = computeFloorStaleness({
      floorHeadSha: HEAD_A,
      currentHeadSha: HEAD_B,
      loadDigest: DIG_A,
      currentDigest: DIG_A,
    });
    expect(row?.code).toBe('floor_stale');
    expect(row?.message).toContain('HEAD moved');
    expect(row?.message).toContain('press R to rebuild');
  });

  it('flags a changed working tree (digest drift), even with a stable HEAD', () => {
    const row = computeFloorStaleness({
      floorHeadSha: HEAD_A,
      currentHeadSha: HEAD_A,
      loadDigest: DIG_A,
      currentDigest: DIG_B,
    });
    expect(row?.message).toContain('the working tree changed');
    expect(row?.message).not.toContain('HEAD moved');
  });

  it('names both signals when HEAD moved AND the tree changed', () => {
    const row = computeFloorStaleness({
      floorHeadSha: HEAD_A,
      currentHeadSha: HEAD_B,
      loadDigest: DIG_A,
      currentDigest: DIG_B,
    });
    expect(row?.message).toContain('HEAD moved and the working tree changed');
  });

  it('never false-fires the HEAD signal when the floor recorded no HEAD (null head_sha)', () => {
    expect(
      computeFloorStaleness({
        floorHeadSha: null,
        currentHeadSha: HEAD_B,
        loadDigest: DIG_A,
        currentDigest: DIG_A,
      })
    ).toBeNull();
  });

  it('never false-fires when a probe failed (null current head / digest)', () => {
    expect(
      computeFloorStaleness({
        floorHeadSha: HEAD_A,
        currentHeadSha: null,
        loadDigest: DIG_A,
        currentDigest: null,
      })
    ).toBeNull();
  });

  it('does not flag the tree when the load-time baseline is missing', () => {
    // A missing baseline (loadDigest null) must not read as drift — the tree
    // signal is gated on BOTH sides being known.
    expect(
      computeFloorStaleness({
        floorHeadSha: HEAD_A,
        currentHeadSha: HEAD_A,
        loadDigest: null,
        currentDigest: DIG_B,
      })
    ).toBeNull();
  });

  it('ignores review state but detects an unrelated untracked product file', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      await writeFile(path.join(repo.path, '.gitignore'), '.orcaops/reviews/\n', 'utf8');
      await execFileAsync('git', ['add', '.gitignore'], { cwd: repo.path });
      await execFileAsync('git', ['commit', '-m', 'ignore review state'], { cwd: repo.path });
      const baseline = await readWorktreeProbe(repo.path);

      const reviewDir = path.join(repo.path, '.orcaops', 'reviews', 'main');
      await mkdir(path.join(reviewDir, 'twolane'), { recursive: true });
      await writeFile(path.join(reviewDir, 'comments.ndjson'), '{"comment":"ignored"}\n');
      await writeFile(path.join(reviewDir, 'journal.ndjson'), '{"journal":"ignored"}\n');
      await writeFile(
        path.join(reviewDir, 'twolane', 'current-story-v1.json'),
        '{"story":"ignored"}\n'
      );
      expect(await readWorktreeProbe(repo.path)).toEqual(baseline);

      await mkdir(path.join(repo.path, 'src'));
      await writeFile(
        path.join(repo.path, 'src', 'untracked.ts'),
        'export const changed = true;\n'
      );
      const afterProductFile = await readWorktreeProbe(repo.path);
      expect(afterProductFile.headSha).toBe(baseline.headSha);
      expect(afterProductFile.porcelainDigest).not.toBe(baseline.porcelainDigest);
      expect(
        computeFloorStaleness({
          floorHeadSha: baseline.headSha,
          currentHeadSha: afterProductFile.headSha,
          loadDigest: baseline.porcelainDigest,
          currentDigest: afterProductFile.porcelainDigest,
        })?.message
      ).toContain('working tree changed');
    } finally {
      await repo.cleanup();
    }
  });
});
