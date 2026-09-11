import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ArtifactSourceTimeMemberSchema,
  mergeArtifactSourceTimeEvidence,
  prepareArtifactSourceTimeMember,
  prepareSourceCommitTime,
  prepareSourceTimeEvidence,
  resolveSourceEvidenceTime,
  SourceTimeEvidenceSchema,
} from './source-time.js';
import { uuidv7 } from '../ids/uuidv7.js';

function commit(epoch: string, offset = '-0700', algorithm: 'sha1' | 'sha256' = 'sha1') {
  const bytes = Buffer.from(
    `tree ${'1'.repeat(algorithm === 'sha1' ? 40 : 64)}\nauthor Original Author <author@example.test> 946684800 +0000\ncommitter Recorded Committer <committer@example.test> ${epoch} ${offset}\n\nRetained source message\n`
  );
  const oid = createHash(algorithm).update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
  return { commitOid: oid, commitBytes: bytes };
}

describe('verified source evidence time', () => {
  it('unions missing facts from immutable members without changing attribution', () => {
    const artifactId = uuidv7();
    const sourceId = uuidv7();
    const facts = [
      prepareSourceCommitTime(commit('1704067200')),
      prepareSourceCommitTime(commit('1735689600')),
    ];
    const memberCommits = facts.map((fact) => fact.commit_oid);
    const members = facts.map((fact) =>
      prepareArtifactSourceTimeMember({
        artifactId,
        memberCommits,
        sources: [
          prepareSourceTimeEvidence({
            artifactId,
            sourceId,
            attributedCommits: memberCommits,
            facts: [fact],
          }).evidence,
        ],
      })
    );
    const merge = (entries: typeof members) =>
      mergeArtifactSourceTimeEvidence(
        artifactId,
        new Map(entries.map((entry) => [entry.relativePath, entry.bytes]))
      );
    const merged = merge(members)!;
    expect(merged).toEqual(merge([...members].reverse()));
    expect(
      resolveSourceEvidenceTime({ artifactId, sourceId, evidence: merged.sources[0] })
    ).toMatchObject({
      evidence_time: '2025-01-01T00:00:00.000Z',
      evidence_time_basis: 'commit_set_latest',
    });
    expect(members[0].member.sources[0].facts).toHaveLength(1);
    expect(mergeArtifactSourceTimeEvidence(artifactId, new Map())).toBeNull();
  });

  it.each(['membership', 'attribution', 'fact', 'artifact', 'path', 'bytes'])(
    'rejects conflicting or unqualified source-time %s',
    (change) => {
      const artifactId = uuidv7();
      const sourceId = uuidv7();
      const fact = prepareSourceCommitTime(commit('1704067200'));
      const other = prepareSourceCommitTime(commit('1735689600'));
      const memberCommits = [fact.commit_oid, other.commit_oid];
      const create = (
        id: string,
        members: string[],
        attributed: string[],
        facts: (typeof fact)[]
      ) =>
        prepareArtifactSourceTimeMember({
          artifactId: id,
          memberCommits: members,
          sources: [
            prepareSourceTimeEvidence({
              artifactId: id,
              sourceId,
              attributedCommits: attributed,
              facts,
            }).evidence,
          ],
        });
      const first = create(artifactId, memberCommits, memberCommits, [fact]);
      const second = create(
        change === 'artifact' ? uuidv7() : artifactId,
        change === 'membership' ? [fact.commit_oid] : memberCommits,
        ['membership', 'attribution'].includes(change) ? [fact.commit_oid] : memberCommits,
        [{ ...fact, ...(change === 'fact' ? { committer_time: '2023-01-01T00:00:00.000Z' } : {}) }]
      );
      const entries: Array<[string, Buffer]> = [
        [first.relativePath, first.bytes],
        [
          change === 'path' ? 'source-time/unqualified.json' : second.relativePath,
          change === 'bytes' ? Buffer.concat([second.bytes, Buffer.from(' ')]) : second.bytes,
        ],
      ];
      expect(() => mergeArtifactSourceTimeEvidence(artifactId, new Map(entries))).toThrow();
    }
  );

  it('verifies object identity and uses committer epoch without shifting its timezone twice', () => {
    const object = commit('1704067200');
    expect(prepareSourceCommitTime(object)).toEqual({
      commit_oid: object.commitOid,
      committer_time: '2024-01-01T00:00:00.000Z',
      verification_basis: 'git_commit_object',
    });
    expect(prepareSourceCommitTime(commit('1704067200', '+0530')).committer_time).toBe(
      '2024-01-01T00:00:00.000Z'
    );
    expect(prepareSourceCommitTime(commit('-1')).committer_time).toBe('1969-12-31T23:59:59.000Z');
    expect(
      prepareSourceCommitTime(commit('1704067200', '+0000', 'sha256')).commit_oid
    ).toHaveLength(64);
    expect(() =>
      prepareSourceCommitTime({
        ...object,
        commitBytes: Buffer.concat([object.commitBytes, Buffer.from('changed')]),
      })
    ).toThrow('object identity');
    expect(() => prepareSourceCommitTime(commit('1704067200', '+2460'))).toThrow('date is invalid');
    expect(() => prepareSourceCommitTime(commit('9999999999999999999999999'))).toThrow(
      'epoch is invalid'
    );
  });

  it('selects the latest committer time only from a complete explicitly attributed set', () => {
    const artifactId = uuidv7();
    const sourceId = uuidv7();
    const older = prepareSourceCommitTime(commit('1704067200'));
    const newer = prepareSourceCommitTime(commit('1735689600'));
    const input = {
      artifactId,
      sourceId,
      attributedCommits: [newer.commit_oid, older.commit_oid],
      facts: [older, newer],
    };
    const { evidence, bytes } = prepareSourceTimeEvidence(input);
    expect(SourceTimeEvidenceSchema.parse(JSON.parse(bytes.toString()))).toEqual(evidence);
    expect(resolveSourceEvidenceTime({ artifactId, sourceId, evidence })).toMatchObject({
      evidence_time: '2025-01-01T00:00:00.000Z',
      evidence_time_basis: 'commit_set_latest',
    });
    const single = prepareSourceTimeEvidence({
      ...input,
      attributedCommits: [older.commit_oid],
      facts: [older],
    });
    expect(
      resolveSourceEvidenceTime({ artifactId, sourceId, evidence: single.evidence })
    ).toMatchObject({
      evidence_time: '2024-01-01T00:00:00.000Z',
      evidence_time_basis: 'commit',
    });
  });

  it('keeps missing, invalid and incomplete evidence unknown without substituting recording time', () => {
    const artifactId = uuidv7();
    const sourceId = uuidv7();
    const older = prepareSourceCommitTime(commit('1704067200'));
    const newer = prepareSourceCommitTime(commit('1735689600'));
    const { evidence } = prepareSourceTimeEvidence({
      artifactId,
      sourceId,
      attributedCommits: [older.commit_oid, newer.commit_oid],
      facts: [older],
    });
    const source = {
      ts: '2026-09-05T15:00:00.000Z',
      imported_at: '2026-09-06T15:00:00.000Z',
      evidence,
    };
    const before = structuredClone(source);
    expect(
      resolveSourceEvidenceTime({ artifactId, sourceId, evidence: source.evidence })
    ).toMatchObject({ evidence_time: null, reason: 'incomplete' });
    expect(resolveSourceEvidenceTime({ artifactId, sourceId, evidence: undefined })).toMatchObject({
      evidence_time: null,
      reason: 'missing',
    });
    const invalid = {
      ...evidence,
      facts: [{ ...older, committer_time: '2026-02-30T00:00:00.000Z' }],
    };
    expect(resolveSourceEvidenceTime({ artifactId, sourceId, evidence: invalid })).toMatchObject({
      evidence_time: null,
      reason: 'invalid',
    });
    expect(source).toEqual(before);
  });

  it('refuses foreign source identities and unrelated newer commit facts', () => {
    const artifactId = uuidv7();
    const sourceId = uuidv7();
    const older = prepareSourceCommitTime(commit('1704067200'));
    const newer = prepareSourceCommitTime(commit('1735689600'));
    const { evidence } = prepareSourceTimeEvidence({
      artifactId,
      sourceId,
      attributedCommits: [older.commit_oid],
      facts: [older],
    });
    expect(resolveSourceEvidenceTime({ artifactId, sourceId: uuidv7(), evidence })).toMatchObject({
      evidence_time: null,
      reason: 'identity_mismatch',
    });
    expect(resolveSourceEvidenceTime({ artifactId: uuidv7(), sourceId, evidence })).toMatchObject({
      evidence_time: null,
      reason: 'identity_mismatch',
    });
    expect(
      resolveSourceEvidenceTime({
        artifactId,
        sourceId,
        attributedCommits: [newer.commit_oid],
        evidence,
      })
    ).toMatchObject({ evidence_time: null, reason: 'identity_mismatch' });
    expect(() =>
      prepareSourceTimeEvidence({
        artifactId,
        sourceId,
        attributedCommits: [older.commit_oid],
        facts: [older, newer],
      })
    ).toThrow('outside the attributed set');
    expect(() =>
      prepareSourceTimeEvidence({
        artifactId,
        sourceId,
        attributedCommits: [older.commit_oid],
        facts: [older, older],
      })
    ).toThrow('unique and sorted');
  });

  it('retains canonical prepared facts independently of caller-owned inputs', () => {
    const fact = prepareSourceCommitTime(commit('1704067200'));
    const input = {
      artifactId: uuidv7(),
      sourceId: uuidv7(),
      attributedCommits: [fact.commit_oid],
      facts: [fact],
    };
    const prepared = prepareSourceTimeEvidence(input);
    const before = prepared.bytes.toString();
    input.sourceId = uuidv7();
    fact.committer_time = '2026-01-01T00:00:00.000Z';
    expect(prepared.bytes.toString()).toBe(before);
    expect(JSON.parse(before)).toEqual(prepared.evidence);
  });
});

describe('artifact source time membership', () => {
  it('retains explicit SHA-1 and SHA-256 membership independently of caller-owned sources', () => {
    const artifactId = uuidv7();
    const facts = [
      prepareSourceCommitTime(commit('1704067200')),
      prepareSourceCommitTime(commit('1735689600', '+0000', 'sha256')),
    ];
    const sources = ['z', 'a'].map(
      (sourceId) =>
        prepareSourceTimeEvidence({
          artifactId,
          sourceId,
          attributedCommits: facts.map((fact) => fact.commit_oid),
          facts,
        }).evidence
    );
    const memberCommits = facts.map((fact) => fact.commit_oid).reverse();
    const prepared = prepareArtifactSourceTimeMember({ artifactId, memberCommits, sources });
    expect(prepared.member.member_commits).toEqual([...memberCommits].sort());
    expect(prepared.member.sources.map((source) => source.source_id)).toEqual(['a', 'z']);
    const before = prepared.bytes.toString();
    memberCommits.pop();
    sources[0]!.source_id = 'changed';
    sources[1]!.facts[0]!.committer_time = '2026-01-01T00:00:00.000Z';
    expect(ArtifactSourceTimeMemberSchema.parse(JSON.parse(before))).toEqual(prepared.member);
    expect(prepared.bytes.toString()).toBe(before);
  });

  it('rejects missing membership, foreign or duplicate sources and conflicting commit facts', () => {
    const artifactId = uuidv7();
    const fact = prepareSourceCommitTime(commit('1704067200'));
    const source = prepareSourceTimeEvidence({
      artifactId,
      sourceId: 'a',
      attributedCommits: [fact.commit_oid],
      facts: [fact],
    }).evidence;
    const input = { artifactId, memberCommits: [fact.commit_oid], sources: [source] };
    expect(() => prepareArtifactSourceTimeMember({ ...input, memberCommits: [] })).toThrow();
    expect(() => prepareArtifactSourceTimeMember({ ...input, sources: [source, source] })).toThrow(
      'unique and sorted'
    );
    expect(() =>
      prepareArtifactSourceTimeMember({ ...input, sources: [{ ...source, artifact_id: uuidv7() }] })
    ).toThrow('another artifact');
    expect(() =>
      prepareArtifactSourceTimeMember({ ...input, memberCommits: ['f'.repeat(64)] })
    ).toThrow('outside artifact membership');
    expect(() =>
      prepareArtifactSourceTimeMember({
        ...input,
        sources: [
          source,
          {
            ...source,
            source_id: 'b',
            facts: [{ ...fact, committer_time: '2025-01-01T00:00:00.000Z' }],
          },
        ],
      })
    ).toThrow('disagree');
    const member = prepareArtifactSourceTimeMember(input).member;
    expect(
      ArtifactSourceTimeMemberSchema.safeParse({
        ...member,
        member_commits: [fact.commit_oid, fact.commit_oid],
      }).success
    ).toBe(false);
    expect(
      ArtifactSourceTimeMemberSchema.safeParse({ ...member, member_commits: undefined }).success
    ).toBe(false);
  });

  it('keeps incomplete or absent source facts unknown within a complete member declaration', () => {
    const artifactId = uuidv7();
    const facts = [
      prepareSourceCommitTime(commit('1704067200')),
      prepareSourceCommitTime(commit('1735689600')),
    ];
    const source = prepareSourceTimeEvidence({
      artifactId,
      sourceId: 'digest',
      attributedCommits: facts.map((fact) => fact.commit_oid),
      facts: facts.slice(0, 1),
    }).evidence;
    const { member } = prepareArtifactSourceTimeMember({
      artifactId,
      memberCommits: source.attributed_commits,
      sources: [source],
    });
    expect(
      resolveSourceEvidenceTime({
        artifactId,
        sourceId: 'digest',
        attributedCommits: member.member_commits,
        evidence: member.sources[0],
      })
    ).toMatchObject({ evidence_time: null, reason: 'incomplete' });
    expect(
      prepareArtifactSourceTimeMember({
        artifactId,
        memberCommits: source.attributed_commits,
        sources: [],
      }).member.sources
    ).toEqual([]);
  });
});
