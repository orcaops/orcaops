import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeBaseUrl } from './canonical-base-url.js';
import {
  type PullCacheRecord,
  scanByExternalIdVersion,
  sourcePlanCacheDir,
  writePullCacheRecord,
} from './pull-cache.js';
import {
  readReviewCandidate,
  readReviewProposal,
  type ReviewPullRecord,
  ReviewPullRecordSchema,
  scanReviewPullRecordsForIntegrity,
  writeReviewPullRecord,
} from './review-pull-cache.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function mkCandidate(overrides: Partial<ReviewPullRecord> = {}): ReviewPullRecord {
  const body = overrides.body ?? '# Candidate\n\nthe pending candidate body';
  return {
    schema_version: 1,
    target: 'candidate',
    external_id: 'ext-1',
    version_id: 'ver_abc',
    version_number: 4,
    proposal_id: null,
    base_version_number: null,
    content_hash: sha(body),
    body,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function mkProposal(overrides: Partial<ReviewPullRecord> = {}): ReviewPullRecord {
  const body = overrides.body ?? '# Proposal\n\nthe proposal body';
  return {
    schema_version: 1,
    target: 'proposal',
    external_id: 'ext-1',
    version_id: null,
    version_number: null,
    proposal_id: 'prop_xyz',
    base_version_number: 4,
    content_hash: sha(body),
    body,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete pull-cache record used to prove the scan reads persisted data. */
function mkPullRecord(body: string): PullCacheRecord {
  return {
    schema_version: 1,
    external_id: 'ext-1',
    slug: 'my-plan',
    version_number: 4,
    title: 'My Plan',
    body,
    content_hash: sha(body),
    source_ref: null,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-09T00:00:00.000Z',
  };
}

describe('review-pull-cache', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pull-cache-'));
    cacheDir = sourcePlanCacheDir(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a candidate (version-less by-id read)', async () => {
    const rec = mkCandidate();
    await writeReviewPullRecord(cacheDir, rec);
    const read = await readReviewCandidate(cacheDir, rec.base_url, rec.org_id, rec.external_id);
    expect(read).toEqual(rec);
  });

  it('round-trips a proposal (by-proposal read)', async () => {
    const rec = mkProposal();
    await writeReviewPullRecord(cacheDir, rec);
    const read = await readReviewProposal(cacheDir, rec.base_url, rec.org_id, 'prop_xyz');
    expect(read).toEqual(rec);
  });

  it('candidate and proposal for the same plan coexist (separate keyspaces)', async () => {
    await writeReviewPullRecord(cacheDir, mkCandidate());
    await writeReviewPullRecord(cacheDir, mkProposal());
    expect(
      (await readReviewCandidate(cacheDir, 'https://cloud.example', 'org_1', 'ext-1'))?.target
    ).toBe('candidate');
    expect(
      (await readReviewProposal(cacheDir, 'https://cloud.example', 'org_1', 'prop_xyz'))?.target
    ).toBe('proposal');
  });

  it('rejects a record whose body hash does not match content_hash', async () => {
    const rec = { ...mkCandidate(), content_hash: 'deadbeef' };
    await expect(writeReviewPullRecord(cacheDir, rec)).rejects.toThrow(/integrity/);
  });

  it('schema requires version_id + version_number, and no proposal_id, for a candidate', () => {
    expect(ReviewPullRecordSchema.safeParse({ ...mkCandidate(), version_id: null }).success).toBe(
      false
    );
    expect(
      ReviewPullRecordSchema.safeParse({ ...mkCandidate(), version_number: null }).success
    ).toBe(false);
    expect(
      ReviewPullRecordSchema.safeParse({ ...mkCandidate(), proposal_id: 'prop_x' }).success
    ).toBe(false);
  });

  it('schema requires proposal_id for a proposal, and allows null version fields', () => {
    expect(ReviewPullRecordSchema.safeParse({ ...mkProposal(), proposal_id: null }).success).toBe(
      false
    );
    // A proposal with null version_id/version_number is the NORMAL shape.
    expect(ReviewPullRecordSchema.safeParse(mkProposal()).success).toBe(true);
    // ...and it must NOT carry candidate version fields (the tightened invariant):
    // a stray version_id/version_number would be a CAS-token trap for a reader.
    expect(ReviewPullRecordSchema.safeParse({ ...mkProposal(), version_id: 'ver_x' }).success).toBe(
      false
    );
    expect(ReviewPullRecordSchema.safeParse({ ...mkProposal(), version_number: 7 }).success).toBe(
      false
    );
  });

  it('org-scopes candidates: same externalId under two orgs stays distinct', async () => {
    await writeReviewPullRecord(cacheDir, mkCandidate({ org_id: 'org_a', body: 'A body' }));
    await writeReviewPullRecord(cacheDir, mkCandidate({ org_id: 'org_b', body: 'B body' }));
    expect(
      (await readReviewCandidate(cacheDir, 'https://cloud.example', 'org_a', 'ext-1'))?.body
    ).toBe('A body');
    expect(
      (await readReviewCandidate(cacheDir, 'https://cloud.example', 'org_b', 'ext-1'))?.body
    ).toBe('B body');
  });

  it('overwrites the candidate on re-pull (latest-wins, no @version accumulation)', async () => {
    await writeReviewPullRecord(
      cacheDir,
      mkCandidate({ version_id: 'ver_v4', version_number: 4, body: 'four' })
    );
    await writeReviewPullRecord(
      cacheDir,
      mkCandidate({ version_id: 'ver_v5', version_number: 5, body: 'five' })
    );
    const read = await readReviewCandidate(cacheDir, 'https://cloud.example', 'org_1', 'ext-1');
    expect(read?.version_number).toBe(5);
    expect(read?.version_id).toBe('ver_v5');
    expect(read?.body).toBe('five');
  });

  it('namespace is stable across trailing-slash / case base_url variants', async () => {
    await writeReviewPullRecord(cacheDir, mkCandidate({ base_url: 'https://Cloud.Example' }));
    const read = await readReviewCandidate(cacheDir, 'https://cloud.example/', 'org_1', 'ext-1');
    expect(read?.version_id).toBe('ver_abc');
  });

  it('refuses a final candidate symlink without reading or replacing its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pull-outside-'));
    try {
      const rec = mkCandidate();
      const { recordPath } = await writeReviewPullRecord(cacheDir, rec, root);
      const external = path.join(outside, 'candidate.json');
      await writeFile(external, 'external sentinel', 'utf8');
      await unlink(recordPath);
      await symlink(external, recordPath);

      await expect(
        readReviewCandidate(cacheDir, rec.base_url, rec.org_id, rec.external_id, root)
      ).rejects.toThrow(/must not contain symlinks/);
      await expect(writeReviewPullRecord(cacheDir, rec, root)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe('external sentinel');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // ── the isolation proof: a review body is INVISIBLE to the capture-pin scan ──
  it('is invisible to scanByExternalIdVersion (the pin resolver scans only pull/)', async () => {
    const rec = mkCandidate();
    await writeReviewPullRecord(cacheDir, rec);
    // The resolver reads only the pull/ subtree → a review candidate must never
    // surface as a pinnable cloud:<id>@<n> anchor, regardless of filename.
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 4)).toEqual([]);

    // Belt-and-braces: plant a decoy at the BYTE-EXACT filename pull/ would use,
    // but under review-pull/. The scan still returns [] — the SUBTREE isolates,
    // not the filename.
    const ns = sha(`${canonicalizeBaseUrl(rec.base_url)}|${rec.org_id}`);
    const pullStyleName = `${sha('ext-1')}@4.json`;
    const decoyPath = path.join(cacheDir, 'review-pull', ns, 'by-id', pullStyleName);
    await mkdir(path.dirname(decoyPath), { recursive: true });
    await writeFile(decoyPath, JSON.stringify({ ...rec, body: 'decoy' }, null, 2), 'utf8');
    expect(await scanByExternalIdVersion(cacheDir, 'ext-1', 4)).toEqual([]);

    // Non-vacuity: a REAL pull/ record for the SAME (externalId, version) IS
    // found — proving the scan is live (not a no-op) and returns ONLY the pull
    // record, never the review/decoy ones. This is the pinned==graded property,
    // self-contained here rather than leaning on pull-cache.test.ts.
    await writePullCacheRecord(cacheDir, mkPullRecord('PULL BODY'));
    const matches = await scanByExternalIdVersion(cacheDir, 'ext-1', 4);
    expect(matches).toHaveLength(1);
    expect(matches[0].record.body).toBe('PULL BODY');
  });

  // ── scanReviewPullRecordsForIntegrity (doctor's local re-hash source) ──
  describe('scanReviewPullRecordsForIntegrity', () => {
    it('is an empty scan when the review-pull subtree does not exist', async () => {
      expect(await scanReviewPullRecordsForIntegrity(cacheDir, root)).toEqual({
        records: [],
        corrupt: 0,
      });
    });

    it('fails closed when an untyped caller omits the containment root', async () => {
      await expect(scanReviewPullRecordsForIntegrity(cacheDir, undefined as never)).rejects.toThrow(
        /requires a containment root/
      );
    });

    it('fails closed when an untyped caller supplies an empty containment root', async () => {
      await expect(scanReviewPullRecordsForIntegrity(cacheDir, '' as never)).rejects.toThrow(
        /requires a containment root/
      );
    });

    it('does not misreport an uninspectable review-pull path as an empty scan', async () => {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path.join(cacheDir, 'review-pull'), 'not a directory', 'utf8');

      await expect(scanReviewPullRecordsForIntegrity(cacheDir, root)).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });

    it('ignores benign non-directory entries beside cache namespaces', async () => {
      const rootDir = path.join(cacheDir, 'review-pull');
      await mkdir(rootDir, { recursive: true });
      await writeFile(path.join(rootDir, '.DS_Store'), 'finder metadata', 'utf8');

      await expect(scanReviewPullRecordsForIntegrity(cacheDir, root)).resolves.toEqual({
        records: [],
        corrupt: 0,
      });
    });

    it('refuses a namespace symlink before non-directory filtering can skip it', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-namespace-outside-'));
      try {
        const rootDir = path.join(cacheDir, 'review-pull');
        await mkdir(rootDir, { recursive: true });
        await symlink(outside, path.join(rootDir, 'redirected-namespace'));

        await expect(scanReviewPullRecordsForIntegrity(cacheDir, root)).rejects.toThrow(
          /must not contain symlinks/
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('enumerates candidates and proposals across keyspaces, all hash-clean', async () => {
      await writeReviewPullRecord(cacheDir, mkCandidate());
      await writeReviewPullRecord(cacheDir, mkProposal());
      const scan = await scanReviewPullRecordsForIntegrity(cacheDir, root);
      expect(scan.corrupt).toBe(0);
      expect(scan.records).toHaveLength(2);
      for (const { record } of scan.records) {
        expect(sha(record.body)).toBe(record.content_hash);
      }
    });

    it('a body tampered on disk still parses but re-hashes dirty (the drift doctor catches)', async () => {
      const { recordPath } = await writeReviewPullRecord(cacheDir, mkCandidate());
      const onDisk = JSON.parse(await readFile(recordPath, 'utf8'));
      onDisk.body = 'tampered body';
      await writeFile(recordPath, JSON.stringify(onDisk, null, 2), 'utf8');

      const scan = await scanReviewPullRecordsForIntegrity(cacheDir, root);
      expect(scan.corrupt).toBe(0);
      expect(scan.records).toHaveLength(1);
      const rec = scan.records[0].record;
      expect(sha(rec.body)).not.toBe(rec.content_hash);
    });

    it('garbage and schema-invalid files count as corrupt, never throw', async () => {
      await writeReviewPullRecord(cacheDir, mkCandidate());
      const ns = sha(`${canonicalizeBaseUrl('https://cloud.example')}|org_1`);
      const dir = path.join(cacheDir, 'review-pull', ns, 'by-proposal');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'garbage.json'), 'not json at all', 'utf8');
      await writeFile(
        path.join(dir, 'invalid.json'),
        JSON.stringify({ schema_version: 1, target: 'proposal' }),
        'utf8'
      );

      const scan = await scanReviewPullRecordsForIntegrity(cacheDir, root);
      expect(scan.corrupt).toBe(2);
      expect(scan.records).toHaveLength(1);
    });

    it('refuses a redirected review-pull subtree instead of reporting an empty scan', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pull-outside-'));
      try {
        await mkdir(cacheDir, { recursive: true });
        await symlink(outside, path.join(cacheDir, 'review-pull'));

        await expect(scanReviewPullRecordsForIntegrity(cacheDir, root)).rejects.toThrow(
          /must not contain symlinks/
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
