import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { prepareSourceCommitTime, resolveSourceEvidenceTime } from '../source-time.js';
import {
  type ArtifactAttemptInput,
  artifactAttemptPreparation,
  type LifecycleCompletionInput,
  lifecycleCompletionPreparation,
  type PlanIdempotencyInput,
  planIdempotencyPreparation,
  prepareAuthoredArtifactAttempt,
  prepareAuthoredLifecycleCompletion,
  prepareAuthoredPlanIdempotency,
  prepareAuthoredSourceTime,
  prepareHistoricalArtifactAttempt,
  prepareHistoricalLifecycleCompletion,
  prepareHistoricalPlanIdempotency,
  prepareHistoricalSourceTime,
  sourceTimePreparation,
} from './capture-operation-input.js';

const authored = { secretAllow: [] };
const historical = { sourceProfile: '0.2.0-rc.2' as const };
function lifecycle(
  bytes = Buffer.from(' {"fires_at":"pre-pr","cp_n":0,"triggered_at":"original time"}\n')
): LifecycleCompletionInput {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId: uuidv7(),
    artifactRevision: {
      generation: 1,
      orderedHash: 'a'.repeat(64),
      eventCount: 1,
      byteLength: 9,
      tailEventId: uuidv7(),
    },
    expectedSelection: null,
    source: {
      identity: 'sqlite:evaluator_lifecycles',
      locator: '/original/db.sqlite#row/7',
      revisionId: 'original-revision',
      eventId: null,
      operationId: null,
      sha256: digest(bytes),
    },
    bytes,
  };
}
function attempt(envelope: string | null = null): Extract<ArtifactAttemptInput, { action: 'set' }> {
  const base = lifecycle();
  const bytes = Buffer.from(
    ' ' +
      JSON.stringify({
        artifact_id: base.artifactId,
        event_type: 'checkpoint_closed',
        idempotency_key: 'original-attempt-key',
        outcome: 'soft_blocked',
        payload_hash: 'b'.repeat(64),
        evaluator_fingerprint: 'original fingerprint',
        envelope,
        recorded_at: 'original timestamp',
      }) +
      '\n'
  );
  return {
    ...base,
    action: 'set',
    bytes,
    source: { ...base.source, identity: 'sqlite:idempotency_blocks', sha256: digest(bytes) },
  };
}
it('retains noncanonical lifecycle bytes and original non-UUID source identities', () => {
  const input = lifecycle();
  const result = lifecycleCompletionPreparation(
    prepareHistoricalLifecycleCompletion(input, historical)
  );
  expect(Buffer.from(result.bytesBase64!, 'base64')).toEqual(input.bytes);
  expect(result.source).toEqual(input.source);
  expect(result.source.eventId).toBeNull();
  expect(result.source.operationId).toBeNull();
  expect(result.key).toBe('["pre-pr",0]');
  expect(result.row).toEqual({ fires_at: 'pre-pr', cp_n: 0, triggered_at: 'original time' });
});
it('detaches bytes, source metadata, exact artifact revision and selected predecessor', () => {
  const input = lifecycle();
  input.expectedSelection = { revisionId: uuidv7(), version: 2 };
  const bytes = Buffer.from(input.bytes);
  const result = lifecycleCompletionPreparation(
    prepareAuthoredLifecycleCompletion(input, authored)
  );
  input.bytes.fill(0);
  input.source.identity = 'changed';
  input.artifactRevision.generation = 99;
  input.expectedSelection.version = 7;
  expect(Buffer.from(result.bytesBase64!, 'base64')).toEqual(bytes);
  expect(result.source.identity).toBe('sqlite:evaluator_lifecycles');
  expect(result.artifactRevision.generation).toBe(1);
  expect(result.expectedSelection?.version).toBe(2);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.row)).toBe(true);
  expect(Object.isFrozen(result.source)).toBe(true);
});
it.each(['post-plan-revision', 'checkpoint-open', 'checkpoint-close'] as const)(
  'preserves historical zero for %s while authored completion requires positive sequence',
  (fires_at) => {
    const input = lifecycle(
      Buffer.from(JSON.stringify({ fires_at, cp_n: 0, triggered_at: 'original' }))
    );
    expect(() => prepareAuthoredLifecycleCompletion(input, authored)).toThrow('positive sequence');
    expect(
      lifecycleCompletionPreparation(prepareHistoricalLifecycleCompletion(input, historical)).row
        .cp_n
    ).toBe(0);
  }
);
it('retains historical unknown lifecycle fields without admitting them as newly authored fields', () => {
  const bytes = Buffer.from(
    '{"fires_at":"pre-pr","cp_n":0,"triggered_at":"old","future":{"kept":true}}'
  );
  const input = lifecycle(bytes);
  expect(() => prepareAuthoredLifecycleCompletion(input, authored)).toThrow('without dropping');
  expect(
    Buffer.from(
      lifecycleCompletionPreparation(prepareHistoricalLifecycleCompletion(input, historical))
        .bytesBase64!,
      'base64'
    )
  ).toEqual(bytes);
});
it.each(['metadata', 'envelope'] as const)(
  'refuses authored secrets in %s and retains historical originals',
  (where) => {
    const token = 'ghp_' + 'a'.repeat(36);
    const input = attempt(where === 'envelope' ? JSON.stringify({ detail: token }) : null);
    if (where === 'metadata') input.source.locator = '/original/' + token;
    expect(() => prepareAuthoredArtifactAttempt(input, authored)).toThrow(
      expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
    );
    const retained = artifactAttemptPreparation(
      prepareHistoricalArtifactAttempt(input, historical)
    );
    expect(Buffer.from(retained.bytesBase64!, 'base64')).toEqual(input.bytes);
    expect(retained.source).toEqual(input.source);
  }
);
it('preserves original attempt outcome, fingerprint, envelope and byte identity', () => {
  const input = attempt('{"result":"original"}');
  const result = artifactAttemptPreparation(prepareAuthoredArtifactAttempt(input, authored));
  expect(result).toMatchObject({
    action: 'set',
    eventType: 'checkpoint_closed',
    idempotencyKey: 'original-attempt-key',
    row: {
      outcome: 'soft_blocked',
      evaluator_fingerprint: 'original fingerprint',
      envelope: '{"result":"original"}',
      recorded_at: 'original timestamp',
    },
  });
  expect(Buffer.from(result.bytesBase64!, 'base64')).toEqual(input.bytes);
});
it('retains explicit clear separately from missing attempt selection', () => {
  const { bytes: _bytes, ...base } = attempt();
  const input = {
    ...base,
    action: 'clear' as const,
    expectedSelection: { revisionId: uuidv7(), version: 1 },
    eventType: 'checkpoint_closed',
    idempotencyKey: 'original-attempt-key',
    source: { ...base.source, sha256: null },
  };
  expect(artifactAttemptPreparation(prepareAuthoredArtifactAttempt(input, authored))).toMatchObject(
    {
      action: 'clear',
      bytesBase64: null,
      recordHash: null,
      row: null,
      expectedSelection: input.expectedSelection,
    }
  );
  expect(() =>
    prepareAuthoredArtifactAttempt(
      { ...input, expectedSelection: null } as unknown as ArtifactAttemptInput,
      authored
    )
  ).toThrow('exact typed');
});
it('refuses changed original bytes and attempts for another artifact', () => {
  const input = attempt();
  expect(() =>
    prepareHistoricalArtifactAttempt({ ...input, artifactId: uuidv7() }, historical)
  ).toThrow('exact artifact owner');
  input.bytes = Buffer.from('{}');
  expect(() => prepareHistoricalArtifactAttempt(input, historical)).toThrow('checksum');
});
it('requires exact supported source profile, authored options and genuine prepared handles', () => {
  expect(() =>
    prepareHistoricalLifecycleCompletion(lifecycle(), {
      sourceProfile: 'unknown',
    } as unknown as typeof historical)
  ).toThrow('exact typed');
  expect(() =>
    prepareAuthoredLifecycleCompletion(lifecycle(), undefined as unknown as typeof authored)
  ).toThrow('exact typed');
  expect(() => lifecycleCompletionPreparation({ kind: 'prepared-lifecycle-completion' })).toThrow(
    'genuine'
  );
  expect(() => artifactAttemptPreparation({ kind: 'prepared-artifact-attempt' })).toThrow(
    'genuine'
  );
});
it('rejects invalid UTF-8 and unsafe exact revision counters', () => {
  expect(() =>
    prepareHistoricalLifecycleCompletion(lifecycle(Buffer.from([0xff])), historical)
  ).toThrow('UTF-8');
  const input = lifecycle();
  input.artifactRevision.eventCount = Number.MAX_SAFE_INTEGER + 1;
  expect(() => prepareAuthoredLifecycleCompletion(input, authored)).toThrow('exact typed');
});

function planKey(): PlanIdempotencyInput {
  const { revisionId: _revision, expectedSelection: _selection, ...input } = lifecycle();
  const bytes = Buffer.from(
    ' ' +
      JSON.stringify({
        idempotency_key: 'original sqlite key',
        artifact_id: input.artifactId,
        created_at: 'original date',
      }) +
      '\n'
  );
  return { ...input, bytes, source: { ...input.source, sha256: digest(bytes) } };
}
function chronology() {
  const input = lifecycle();
  const commitBytes = Buffer.from(
    'tree ' +
      'a'.repeat(40) +
      '\nauthor A <a@example.test> 1 +0000\ncommitter B <b@example.test> 1234567890 -0800\n\nOriginal message\n'
  );
  const commitOid = createHash('sha1')
    .update('commit ' + commitBytes.length + '\0')
    .update(commitBytes)
    .digest('hex');
  const fact = prepareSourceCommitTime({ commitOid, commitBytes });
  const member = {
    schema_version: 1 as const,
    artifact_id: input.artifactId,
    member_commits: [commitOid],
    sources: [
      {
        schema_version: 1 as const,
        artifact_id: input.artifactId,
        source_id: 'digest',
        attributed_commits: [commitOid],
        facts: [fact],
      },
    ],
  };
  const bytes = Buffer.from(' ' + JSON.stringify(member) + '\n');
  return {
    input: { ...input, bytes, source: { ...input.source, sha256: digest(bytes) } },
    member,
    commitObjects: [{ commitOid, commitBytes }],
  };
}
it('retains the original plan key and bytes without inventing event or revision identities', () => {
  const input = planKey();
  input.source.eventId = null;
  input.source.revisionId = null;
  const result = planIdempotencyPreparation(prepareHistoricalPlanIdempotency(input, historical));
  expect(result.row.idempotency_key).toBe('original sqlite key');
  expect(result.source.eventId).toBeNull();
  expect(result.source.revisionId).toBeNull();
  expect(result).not.toHaveProperty('revisionId');
  expect(Buffer.from(result.bytesBase64!, 'base64')).toEqual(input.bytes);
  input.bytes.fill(0);
  input.source.locator = 'changed';
  expect(result.source.locator).not.toBe('changed');
  expect(() =>
    prepareAuthoredPlanIdempotency({ ...planKey(), artifactId: uuidv7() }, authored)
  ).toThrow('exact artifact owner');
});
it('refuses newly authored plan secrets while preserving original historical fields', () => {
  const input = planKey();
  input.bytes = Buffer.from(
    JSON.stringify({
      idempotency_key: 'ghp_' + 'a'.repeat(36),
      artifact_id: input.artifactId,
      created_at: 'old',
    })
  );
  input.source.sha256 = digest(input.bytes);
  expect(() => prepareAuthoredPlanIdempotency(input, authored)).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  expect(
    Buffer.from(
      planIdempotencyPreparation(prepareHistoricalPlanIdempotency(input, historical)).bytesBase64!,
      'base64'
    )
  ).toEqual(input.bytes);
});
it('verifies original commit time and retains digest source identity with detached bytes', () => {
  const { input, member, commitObjects } = chronology();
  const result = sourceTimePreparation(
    prepareAuthoredSourceTime({ ...input, commitObjects }, authored)
  );
  expect(result.member).toEqual(member);
  expect(result.member.sources[0]!.source_id).toBe('digest');
  expect(
    resolveSourceEvidenceTime({
      artifactId: input.artifactId,
      sourceId: 'digest',
      evidence: result.member.sources[0],
    })
  ).toMatchObject({
    evidence_time: '2009-02-13T23:31:30.000Z',
    evidence_time_basis: 'commit',
  });
  const original = Buffer.from(input.bytes);
  input.bytes.fill(0);
  commitObjects[0]!.commitBytes.fill(0);
  expect(Buffer.from(result.bytesBase64!, 'base64')).toEqual(original);
  expect(Object.isFrozen(result.member.sources[0]!.facts[0])).toBe(true);
});
it('requires original objects for authored facts without requiring them for historical decoding', () => {
  const { input, commitObjects } = chronology();
  expect(() => prepareAuthoredSourceTime({ ...input, commitObjects: [] }, authored)).toThrow(
    'exact original Git object'
  );
  commitObjects[0]!.commitBytes[0] = 0;
  expect(() => prepareAuthoredSourceTime({ ...input, commitObjects }, authored)).toThrow(
    'Verify original Git'
  );
  expect(
    Buffer.from(
      sourceTimePreparation(prepareHistoricalSourceTime(input, historical)).bytesBase64!,
      'base64'
    )
  ).toEqual(input.bytes);
});
it('rejects fabricated commit times, duplicate objects, wrong owner and unsupported historical profile', () => {
  const { input, member, commitObjects } = chronology();
  expect(() =>
    prepareAuthoredSourceTime(
      { ...input, commitObjects: [...commitObjects, ...commitObjects] },
      authored
    )
  ).toThrow('at most once');
  expect(() => prepareHistoricalSourceTime({ ...input, artifactId: uuidv7() }, historical)).toThrow(
    'exact artifact owner'
  );
  member.sources[0]!.facts[0]!.committer_time = '2000-01-01T00:00:00.000Z';
  input.bytes = Buffer.from(JSON.stringify(member));
  input.source.sha256 = digest(input.bytes);
  expect(() => prepareAuthoredSourceTime({ ...input, commitObjects }, authored)).toThrow(
    'exact original Git object'
  );
  expect(() =>
    prepareHistoricalSourceTime(input, { sourceProfile: 'unknown' } as unknown as typeof historical)
  ).toThrow('exact typed');
});
it('retains incomplete evidence as unknown without fabricating an import or current timestamp', () => {
  const { input, member } = chronology();
  member.sources[0]!.facts = [];
  input.bytes = Buffer.from(JSON.stringify(member));
  input.source.sha256 = digest(input.bytes);
  const result = sourceTimePreparation(
    prepareAuthoredSourceTime({ ...input, commitObjects: [] }, authored)
  );
  expect(
    resolveSourceEvidenceTime({
      artifactId: input.artifactId,
      sourceId: 'digest',
      evidence: result.member.sources[0],
    })
  ).toMatchObject({
    evidence_time: null,
    evidence_time_basis: 'unknown',
    reason: 'incomplete',
  });
  expect(() => sourceTimePreparation({ kind: 'prepared-source-time' })).toThrow('genuine');
  expect(() => planIdempotencyPreparation({ kind: 'prepared-plan-idempotency' })).toThrow(
    'genuine'
  );
});
