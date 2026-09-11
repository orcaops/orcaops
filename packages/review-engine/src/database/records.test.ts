import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import {
  decodeRetainedReviewRecord,
  prepareReviewRecords,
  type ReviewRecordInput,
} from './records.js';
import { terminalRunFileSeed } from '../../tests/support/twolaneRunFile.js';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function identity(): ReviewRecordInput<'identity'> {
  return {
    kind: 'identity',
    bytes: bytes({
      schema_version: 1,
      review_id: uuidv7(),
      project_id: uuidv7(),
      store_instance_id: uuidv7(),
      repository_instance_id: null,
      created_by_operation: uuidv7(),
      initial_context: { worktree_id: null, branch: 'topic', base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: ['original-stream:topic'],
    }),
  };
}
function comment(): ReviewRecordInput<'comment'> {
  return {
    kind: 'comment',
    bytes: bytes({
      type: 'add',
      comment_id: 'legacy-comment-id',
      ts: '2026-01-01T00:00:00.000Z',
      author: 'reviewer',
      body: 'Review this retained behavior',
      anchor: {
        kind: 'UNCHANGED_CONTEXT_LINE',
        file: 'source.ts',
        headBlobOid: 'a'.repeat(40),
        line: 9,
        lineHash: 'retained-line-hash',
      },
    }),
  };
}

describe('review record preparation', () => {
  it('retains exact original identity bytes and nullable historical ownership', () => {
    const input = identity();
    const [prepared] = prepareReviewRecords({ records: [input], secretAllow: [] });
    expect(prepared!.bytes).toEqual(input.bytes);
    expect(prepared!.sha256).toBe(createHash('sha256').update(input.bytes).digest('hex'));
    const read = decodeRetainedReviewRecord(input);
    expect(read.value.repository_instance_id).toBeNull();
    expect(read.value.legacy_source_ids).toEqual(['original-stream:topic']);
  });
  it.each(['artifact_ids', 'legacy_source_ids'] as const)(
    'rejects duplicate retained identity values in %s',
    (field) => {
      const input = identity();
      const value = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as Record<
        string,
        unknown
      >;
      const original = field === 'artifact_ids' ? [uuidv7()] : (value[field] as string[]);
      value[field] = [...original, ...original];
      expect(() =>
        prepareReviewRecords({
          records: [{ kind: 'identity', bytes: bytes(value) }],
          secretAllow: [],
        })
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  );
  it('rejects a retained worktree identity without repository ownership', () => {
    const input = identity();
    const value = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as {
      repository_instance_id: string | null;
      initial_context: { worktree_id: string | null };
    };
    value.repository_instance_id = null;
    value.initial_context.worktree_id = uuidv7();
    expect(() =>
      prepareReviewRecords({
        records: [{ kind: 'identity', bytes: bytes(value) }],
        secretAllow: [],
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('preserves non-UUID comment identity and original anchor without inventing an event ID', () => {
    const input = comment();
    const [prepared] = prepareReviewRecords({ records: [input], secretAllow: [] });
    const read = decodeRetainedReviewRecord(input);
    expect(read.value.comment_id).toBe('legacy-comment-id');
    expect(read.value).not.toHaveProperty('event_id');
    expect(read.value).toMatchObject({
      anchor: { kind: 'UNCHANGED_CONTEXT_LINE', headBlobOid: 'a'.repeat(40), line: 9 },
    });
    expect(prepared!.bytes).toEqual(input.bytes);
  });
  it('owns copied bytes independently from later caller mutation', () => {
    const input = identity();
    const original = Buffer.from(input.bytes);
    const records: ReviewRecordInput[] = [input];
    const [prepared] = prepareReviewRecords({ records, secretAllow: [] });
    input.bytes.fill(65);
    records.push(comment());
    expect(prepared!.bytes).toEqual(original);
    expect(prepared!.value).toMatchObject({ legacy_source_ids: ['original-stream:topic'] });
  });
  it.each([false, true])(
    'refuses earlier duplicate-key secret bytes with unicode escapes %s',
    (escaped) => {
      const secret = 'ghp_' + 'A'.repeat(36);
      const encoded = escaped
        ? Array.from(secret)
            .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join('')
        : secret;
      const body = Buffer.from(comment().bytes)
        .toString('utf8')
        .replace('"body":', `"body":"${encoded}","body":`);
      expect(() =>
        prepareReviewRecords({
          records: [identity(), { kind: 'comment', bytes: Buffer.from(body) }],
          secretAllow: [],
        })
      ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
    }
  );
  it('retains harmless duplicate keys while validating the interpreted record', () => {
    const body = Buffer.from(comment().bytes)
      .toString('utf8')
      .replace('"body":', '"body":"earlier retained wording","body":');
    const input = { kind: 'comment' as const, bytes: Buffer.from(body) };
    expect(prepareReviewRecords({ records: [input], secretAllow: [] })[0]!.bytes).toEqual(
      input.bytes
    );
    expect(decodeRetainedReviewRecord(input).value).toMatchObject({
      body: 'Review this retained behavior',
    });
  });
  it('retains an explicitly exempted historical value without reapplying refusal on read', () => {
    const allowed = 'ghp_' + 'A'.repeat(36);
    const value = JSON.parse(Buffer.from(comment().bytes).toString('utf8')) as Record<
      string,
      unknown
    >;
    value.body = allowed;
    const input = { kind: 'comment' as const, bytes: bytes(value) };
    expect(() => prepareReviewRecords({ records: [input], secretAllow: [] })).toThrow(
      expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
    );
    expect(prepareReviewRecords({ records: [input], secretAllow: [allowed] })[0]!.bytes).toEqual(
      input.bytes
    );
    expect(decodeRetainedReviewRecord(input).value).toMatchObject({ body: allowed });
  });
  it('rejects sparse records and allowlists rather than skipping unknown slots', () => {
    expect(() =>
      prepareReviewRecords({ records: new Array<ReviewRecordInput>(1), secretAllow: [] })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() =>
      prepareReviewRecords({ records: [identity()], secretAllow: new Array<string>(1) })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('rejects invalid UTF-8, BOM-prefixed JSON, trailing values and unsupported kinds', () => {
    for (const invalid of [
      Buffer.from([0xff]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), identity().bytes]),
      Buffer.from('{}{}'),
    ]) {
      expect(() =>
        prepareReviewRecords({ records: [{ kind: 'identity', bytes: invalid }], secretAllow: [] })
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    expect(() =>
      prepareReviewRecords({
        records: [{ kind: 'run-record' as 'run', bytes: bytes({ schema_version: 1 }) }],
        secretAllow: [],
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('requires the complete persisted run schema and retains its original version', () => {
    const run = terminalRunFileSeed({
      runId: uuidv7(),
      branch: 'topic',
      finalizedAt: '2026-07-23T09:00:01.000Z',
    });
    const input = { kind: 'run' as const, bytes: bytes(run) };
    expect(prepareReviewRecords({ records: [input], secretAllow: [] })[0]!.bytes).toEqual(
      input.bytes
    );
    expect(decodeRetainedReviewRecord(input).value.schema_version).toBe(2);
    const { execution_profile: omitted, ...incomplete } = run;
    expect(omitted).toBeDefined();
    expect(() =>
      prepareReviewRecords({
        records: [{ kind: 'run', bytes: bytes(incomplete) }],
        secretAllow: [],
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('rejects floor-only workflow basis carrying a Story generation', () => {
    const event = {
      type: 'review_lifecycle',
      ts: '2026-01-01T00:00:00.000Z',
      action: 'COMPLETE',
      review_basis: 'FLOOR_ONLY',
      floor_input_hash: 'retained-floor',
      story_generation: 'different-story',
      ledger_generation: 'retained-ledger',
      actor: 'REVIEWER',
      source: 'WATCH',
    };
    expect(() =>
      prepareReviewRecords({
        records: [{ kind: 'workflow', bytes: bytes(event) }],
        secretAllow: [],
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    const valid = { ...event, story_generation: null };
    expect(
      prepareReviewRecords({
        records: [{ kind: 'workflow', bytes: bytes(valid) }],
        secretAllow: [],
      })[0]!.bytes
    ).toEqual(bytes(valid));
  });
  it('classifies malformed retained content as integrity failure without repair', () => {
    expect(() => decodeRetainedReviewRecord({ kind: 'identity', bytes: Buffer.from('{') })).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });
});
