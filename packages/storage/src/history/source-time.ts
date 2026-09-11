import { createHash } from 'node:crypto';
import { z } from 'zod';

import { digest } from './event-integrity.js';
import { canonicalJson } from '../events/canonical-json.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

const CommitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const CommitTimeSchema = z
  .string()
  .datetime()
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });

export const SourceCommitTimeFactSchema = z.strictObject({
  commit_oid: CommitOidSchema,
  committer_time: CommitTimeSchema,
  verification_basis: z.literal('git_commit_object'),
});
export type SourceCommitTimeFact = z.infer<typeof SourceCommitTimeFactSchema>;

const sortedUnique = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! < value);

export const SourceTimeEvidenceSchema = z
  .strictObject({
    schema_version: z.literal(1),
    artifact_id: UuidV7Schema,
    source_id: z.string().min(1),
    attributed_commits: z.array(CommitOidSchema).min(1).refine(sortedUnique),
    facts: z.array(SourceCommitTimeFactSchema),
  })
  .superRefine((value, context) => {
    const commits = value.facts.map((fact) => fact.commit_oid);
    if (!sortedUnique(commits))
      context.addIssue({
        code: 'custom',
        message: 'Commit facts must be unique and sorted',
        path: ['facts'],
      });
    if (commits.some((oid) => !value.attributed_commits.includes(oid)))
      context.addIssue({
        code: 'custom',
        message: 'A commit fact is outside the attributed set',
        path: ['facts'],
      });
  });
export type SourceTimeEvidence = z.infer<typeof SourceTimeEvidenceSchema>;

export const ArtifactSourceTimeMemberSchema = z
  .strictObject({
    schema_version: z.literal(1),
    artifact_id: UuidV7Schema,
    member_commits: z.array(CommitOidSchema).min(1).refine(sortedUnique),
    sources: z.array(SourceTimeEvidenceSchema),
  })
  .superRefine((value, context) => {
    if (!sortedUnique(value.sources.map((source) => source.source_id)))
      context.addIssue({
        code: 'custom',
        message: 'Source identities must be unique and sorted',
        path: ['sources'],
      });
    const facts = new Map<string, string>();
    for (const [index, source] of value.sources.entries()) {
      if (source.artifact_id !== value.artifact_id)
        context.addIssue({
          code: 'custom',
          message: 'Source belongs to another artifact',
          path: ['sources', index, 'artifact_id'],
        });
      if (source.attributed_commits.some((oid) => !value.member_commits.includes(oid)))
        context.addIssue({
          code: 'custom',
          message: 'Source attribution is outside artifact membership',
          path: ['sources', index, 'attributed_commits'],
        });
      for (const fact of source.facts) {
        const previous = facts.get(fact.commit_oid);
        if (previous !== undefined && previous !== fact.committer_time)
          context.addIssue({
            code: 'custom',
            message: 'Commit facts disagree across sources',
            path: ['sources', index, 'facts'],
          });
        facts.set(fact.commit_oid, fact.committer_time);
      }
    }
  });
export type ArtifactSourceTimeMember = z.infer<typeof ArtifactSourceTimeMemberSchema>;

export function prepareArtifactSourceTimeMember(input: {
  artifactId: string;
  memberCommits: readonly string[];
  sources: readonly SourceTimeEvidence[];
}): { member: ArtifactSourceTimeMember; bytes: Buffer; relativePath: string } {
  const member = ArtifactSourceTimeMemberSchema.parse({
    schema_version: 1,
    artifact_id: input.artifactId,
    member_commits: [...new Set(input.memberCommits)].sort(),
    sources: [...input.sources].sort((a, b) =>
      a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0
    ),
  });
  const bytes = Buffer.from(`${canonicalJson(member)}\n`);
  return { member, bytes, relativePath: `source-time/${digest(bytes)}.json` };
}

export function mergeArtifactSourceTimeEvidence(
  artifactId: string,
  witnessedFiles: ReadonlyMap<string, Uint8Array>
): ArtifactSourceTimeMember | null {
  let memberCommits: string[] | null = null;
  const sources = new Map<string, SourceTimeEvidence>();
  for (const [relativePath, content] of witnessedFiles) {
    if (!relativePath.startsWith('source-time/')) continue;
    const bytes = Buffer.from(content);
    const member = ArtifactSourceTimeMemberSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    const expected = prepareArtifactSourceTimeMember({
      artifactId: member.artifact_id,
      memberCommits: member.member_commits,
      sources: member.sources,
    });
    if (
      relativePath !== expected.relativePath ||
      !bytes.equals(expected.bytes) ||
      member.artifact_id !== artifactId
    )
      throw new Error('Source-time member differs from its canonical content identity');
    if (memberCommits && canonicalJson(memberCommits) !== canonicalJson(member.member_commits))
      throw new Error('Source-time members disagree on the complete artifact commit set');
    memberCommits = member.member_commits;
    for (const source of member.sources) {
      const previous = sources.get(source.source_id);
      if (!previous) {
        sources.set(source.source_id, source);
        continue;
      }
      if (canonicalJson(previous.attributed_commits) !== canonicalJson(source.attributed_commits))
        throw new Error('Source-time members disagree on the attributed commit set');
      const facts = new Map(previous.facts.map((fact) => [fact.commit_oid, fact]));
      for (const fact of source.facts) {
        const prior = facts.get(fact.commit_oid);
        if (prior && canonicalJson(prior) !== canonicalJson(fact))
          throw new Error('Source-time members contain conflicting commit facts');
        facts.set(fact.commit_oid, fact);
      }
      previous.facts = [...facts.values()].sort((a, b) =>
        a.commit_oid < b.commit_oid ? -1 : a.commit_oid > b.commit_oid ? 1 : 0
      );
    }
  }
  return memberCommits
    ? prepareArtifactSourceTimeMember({ artifactId, memberCommits, sources: [...sources.values()] })
        .member
    : null;
}

export function prepareSourceCommitTime(input: {
  commitOid: string;
  commitBytes: Uint8Array;
}): SourceCommitTimeFact {
  const oid = CommitOidSchema.parse(input.commitOid);
  const bytes = Buffer.from(input.commitBytes);
  const actual = createHash(oid.length === 40 ? 'sha1' : 'sha256')
    .update(`commit ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (actual !== oid) throw new Error('Git commit bytes differ from their object identity');
  const boundary = bytes.indexOf('\n\n');
  if (boundary < 0) throw new Error('Git commit headers are incomplete');
  const headers = bytes.subarray(0, boundary).toString('latin1').split('\n');
  const object = `[a-f0-9]{${oid.length}}`;
  if (
    !new RegExp(`^tree ${object}$`, 'u').test(headers[0]!) ||
    headers.filter((line) => line.startsWith('tree ')).length !== 1 ||
    headers.some(
      (line) =>
        line.includes('\0') ||
        (line.startsWith('parent ') && !new RegExp(`^parent ${object}$`, 'u').test(line))
    )
  )
    throw new Error('Git commit tree/header is invalid');
  const identities = ['author', 'committer'].map((kind) => {
    const lines = headers.filter((line) => line.startsWith(`${kind} `));
    const match =
      lines.length === 1
        ? new RegExp(`^${kind} .+ <[^<>]*> (-?\\d+) ([+-])(\\d{2})(\\d{2})$`, 'u').exec(lines[0]!)
        : null;
    if (match === null || Number(match[3]) > 23 || Number(match[4]) > 59)
      throw new Error(`Git commit ${kind} date is invalid`);
    const seconds = Number(match[1]);
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000))
      throw new Error(`Git commit ${kind} epoch is invalid`);
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) throw new Error(`Git commit ${kind} epoch is invalid`);
    return date.toISOString();
  });
  return SourceCommitTimeFactSchema.parse({
    commit_oid: oid,
    committer_time: identities[1],
    verification_basis: 'git_commit_object',
  });
}

export function prepareSourceTimeEvidence(input: {
  artifactId: string;
  sourceId: string;
  attributedCommits: readonly string[];
  facts: readonly SourceCommitTimeFact[];
}): { evidence: SourceTimeEvidence; bytes: Buffer } {
  const evidence = SourceTimeEvidenceSchema.parse({
    schema_version: 1,
    artifact_id: input.artifactId,
    source_id: input.sourceId,
    attributed_commits: [...new Set(input.attributedCommits)].sort(),
    facts: [...input.facts].sort((a, b) =>
      a.commit_oid < b.commit_oid ? -1 : a.commit_oid > b.commit_oid ? 1 : 0
    ),
  });
  return { evidence, bytes: Buffer.from(`${canonicalJson(evidence)}\n`) };
}

export type SourceEvidenceTime =
  | {
      evidence_time: string;
      evidence_time_basis: 'commit' | 'commit_set_latest';
      commit_oids: string[];
    }
  | {
      evidence_time: null;
      evidence_time_basis: 'unknown';
      reason: 'missing' | 'invalid' | 'identity_mismatch' | 'incomplete';
      commit_oids: string[];
    };

export function resolveSourceEvidenceTime(input: {
  artifactId: string;
  sourceId: string;
  evidence: unknown;
  attributedCommits?: readonly string[];
}): SourceEvidenceTime {
  const unknown = (
    reason: Extract<SourceEvidenceTime, { evidence_time: null }>['reason'],
    commits: string[] = []
  ): SourceEvidenceTime => ({
    evidence_time: null,
    evidence_time_basis: 'unknown',
    reason,
    commit_oids: commits,
  });
  if (input.evidence === null || input.evidence === undefined) return unknown('missing');
  const result = SourceTimeEvidenceSchema.safeParse(input.evidence);
  if (!result.success) return unknown('invalid');
  const evidence = result.data;
  if (
    evidence.artifact_id !== input.artifactId ||
    evidence.source_id !== input.sourceId ||
    (input.attributedCommits !== undefined &&
      canonicalJson([...new Set(input.attributedCommits)].sort()) !==
        canonicalJson(evidence.attributed_commits))
  )
    return unknown('identity_mismatch');
  if (evidence.facts.length !== evidence.attributed_commits.length)
    return unknown('incomplete', evidence.attributed_commits);
  return {
    evidence_time: evidence.facts
      .map((fact) => fact.committer_time)
      .sort()
      .at(-1)!,
    evidence_time_basis: evidence.attributed_commits.length === 1 ? 'commit' : 'commit_set_latest',
    commit_oids: evidence.attributed_commits,
  };
}
