import { describe, expect, it } from 'vitest';

import {
  citationIdSchema,
  citationSchema,
  commentAnchorSchema,
  commentEventSchema,
  commentRecordSchema,
  FLOOR_SCHEMA_VERSION,
  floorSchema,
  floorScopeSchema,
  journalEventSchema,
  persistedCommentAnchorSchema,
} from './schema.js';

const A = '019f38b7-1111-7000-8000-000000000001';
const ISO = '2026-07-06T00:00:00.000Z';
const CITE = `cite:${A}:cp1:decision:0`;

function minimalFloor(): unknown {
  return {
    schema_version: FLOOR_SCHEMA_VERSION,
    input_hash: 'floorhash',
    generated_at: ISO,
    scope: {
      branch: 'feature/demo-review',
      branch_slug: 'feature%2Fdemo-review',
      base_sha: 'deadbeef',
      pinned_tree_sha: 'cafef00d',
      head_sha: 'facefeed',
      default_branch: 'main',
      artifact_ids: [A],
      threads: [
        {
          artifact: A,
          branch: 'feature/demo-review',
          label: 'Demo review',
          first_activity_at: ISO,
        },
      ],
    },
    coverage: {
      items: [
        {
          hunkKey: 'hunk_x',
          file: 'src/a.ts',
          verdict: 'MATCHED',
          old_start: 1,
          new_start: 1,
          added_lines: 1,
          removed_lines: 0,
          units: [],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 0,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: 0,
      },
    },
    attribution: {
      active_rung: 'snapshot_chain',
    },
    integrity: [],
    outline: {
      threads: [
        {
          threadKey: 'sec_x',
          order: 1,
          title: 'Data layer',
          artifact: A,
          checkpoints: [
            {
              checkpointKey: 'chap_x',
              order: 1,
              checkpoint: { artifact: A, cp: 1, label: 'Checkpoint one' },
              summary: 'Checkpoint one',
              members: [{ artifact: A, cp: 1 }],
              sliceRefs: [],
              citationIds: [CITE],
            },
          ],
        },
      ],
      unassigned: {
        gap: { sliceRefs: [], files: [] },
        ambiguous: { hunkKeys: [], files: [] },
      },
    },
    plan_coverage: [
      {
        artifact: A,
        step_id: '019f38b7-2222-7000-8000-000000000002',
        label: 'rate limiter',
        text: 'rate limiting for the public API',
        order: 0,
        claimed_by: [{ artifact: A, cp: 1 }],
        declared_by: [{ artifact: A, cp: 1 }],
        unclaimed: false,
      },
    ],
    citations: [
      {
        id: CITE,
        kind: 'CHECKPOINT_DECISION',
        artifact: A,
        cp: 1,
        text: 'token bucket over fixed window',
      },
    ],
    landmarks: [{ kind: 'OFF_PLAN', text: 'unscoped change' }],
    disclosure: [],
  };
}

describe('floorSchema', () => {
  it('accepts a current producer-shaped floor without coercion', () => {
    const parsed = floorSchema.parse(minimalFloor());
    expect(parsed.schema_version).toBe(FLOOR_SCHEMA_VERSION);
    expect(parsed.coverage.items[0].added_lines).toBe(1);
    expect(parsed.coverage.items[0].units).toEqual([]);
    expect(parsed.coverage.summary.reviewable_rows).toBe(0);
    expect(parsed.outline.threads[0].checkpoints[0].sliceRefs).toEqual([]);
    expect(parsed.outline.unassigned).toEqual({
      gap: { sliceRefs: [], files: [] },
      ambiguous: { hunkKeys: [], files: [] },
    });
  });

  it('rejects unknown fields at every representative floor depth', () => {
    for (const mutate of [
      (floor: any) => (floor.retired = true),
      (floor: any) => (floor.scope.retired = true),
      (floor: any) => (floor.coverage.items[0].owner = { artifact: A, cp: 1 }),
      (floor: any) => (floor.outline.threads[0].checkpoints[0].hunkKeys = ['hunk_x']),
      (floor: any) => (floor.citations[0].legacy = true),
    ]) {
      const floor: any = minimalFloor();
      mutate(floor);
      expect(floorSchema.safeParse(floor).success).toBe(false);
    }
  });

  it('requires the current schema_version', () => {
    const noVersion: any = minimalFloor();
    delete noVersion.schema_version;
    expect(floorSchema.safeParse(noVersion).success).toBe(false);
    expect(
      floorSchema.safeParse({
        ...(minimalFloor() as object),
        schema_version: FLOOR_SCHEMA_VERSION - 1,
      }).success
    ).toBe(false);
  });

  it('REFUSES a v2-shaped floor rather than tolerantly coercing it', () => {
    // A tolerant object would strip fields the schema no longer carries. That
    // is right for RETIRED fields and catastrophic for RENAMED ones: a v2
    // floor's `sections`/`sectionKey` could disappear and leave an empty review
    // that looks fully reviewed. The exact current schema must fail loudly.
    //
    // This is the schema half of the version gate; review-engine applies the
    // same strict current-version rule to the containing directory.
    const v2: any = minimalFloor();
    v2.outline = {
      sections: [
        {
          sectionKey: 'sec_x',
          order: 1,
          title: 'Data layer',
          thread: { artifact: A },
          subsections: [
            {
              chapterKey: 'chap_x',
              order: 1,
              checkpoint: { artifact: A, cp: 1 },
              members: [{ artifact: A, cp: 1 }],
              citationIds: [CITE],
            },
          ],
        },
      ],
    };
    const parsed = floorSchema.safeParse(v2);
    expect(parsed.success).toBe(false);
    // And it fails AT the renamed field, not somewhere incidental.
    expect(parsed.error!.issues.some((issue) => issue.path.join('.') === 'outline.threads')).toBe(
      true
    );
  });

  it('rejects a malformed citation id', () => {
    const bad: any = minimalFloor();
    bad.citations[0].id = 'not-a-cite';
    expect(floorSchema.safeParse(bad).success).toBe(false);
  });
});

describe('citationSchema — exact current variants', () => {
  const ALT = `cite:${A}:cp1:alternative:0`;
  function alternative(): any {
    return { id: ALT, kind: 'CHECKPOINT_ALTERNATIVE', artifact: A, cp: 1, text: 'polling instead' };
  }

  it('requires a checkpoint alternative parent', () => {
    expect(citationSchema.safeParse(alternative()).success).toBe(false);
  });

  it('carries the parent decision id through a parse', () => {
    const parsed = citationSchema.parse({ ...alternative(), parent: CITE });
    if (parsed.kind !== 'CHECKPOINT_ALTERNATIVE') {
      throw new Error('expected a CHECKPOINT_ALTERNATIVE citation');
    }
    expect(parsed.parent).toBe(CITE);
  });

  it('rejects a parent that is not a citation id', () => {
    expect(citationSchema.safeParse({ ...alternative(), parent: 'decision-0' }).success).toBe(
      false
    );
  });

  it('rejects cp, parent, and evaluator fields on kinds that do not own them', () => {
    const plan = {
      id: `cite:${A}:plan_step:0`,
      kind: 'PLAN_STEP',
      artifact: A,
      text: 'Ship the strict floor',
    };
    expect(citationSchema.safeParse({ ...plan, cp: 1 }).success).toBe(false);
    expect(citationSchema.safeParse({ ...plan, parent: CITE }).success).toBe(false);
    expect(
      citationSchema.safeParse({
        ...plan,
        evaluator: {
          evaluator_ref: 'core/example',
          severity: 'warn',
          run_status: 'completed',
          verdict: 'pass',
          disposition: null,
          summary: 'pass',
        },
      }).success
    ).toBe(false);
  });

  it('requires cp for checkpoint kinds and structured metadata for evaluator runs', () => {
    expect(
      citationSchema.safeParse({
        id: CITE,
        kind: 'CHECKPOINT_DECISION',
        artifact: A,
        text: 'Use the current schema',
      }).success
    ).toBe(false);
    expect(
      citationSchema.safeParse({
        id: `cite:${A}:evaluator_run:0`,
        kind: 'EVALUATOR_RUN',
        artifact: A,
        text: 'core/example — pass',
      }).success
    ).toBe(false);
  });

  it('requires the id grammar to agree with the projected fields', () => {
    expect(
      citationSchema.safeParse({
        id: CITE,
        kind: 'CHECKPOINT_UNCERTAINTY',
        artifact: A,
        cp: 1,
        text: 'This id still says decision',
      }).success
    ).toBe(false);
    expect(
      citationSchema.safeParse({
        ...alternative(),
        parent: `cite:${A}:cp1:uncertainty:0`,
      }).success
    ).toBe(false);
  });

  it('keeps criterion evidence parent optional for a dropped criterion', () => {
    expect(
      citationSchema.safeParse({
        id: `cite:${A}:cp1:criterion_evidence:0`,
        kind: 'CRITERION_EVIDENCE',
        artifact: A,
        cp: 1,
        text: 'Evidence remains after the criterion leaves the current plan',
      }).success
    ).toBe(true);
  });

  it('requires acceptance criteria and criterion evidence to name their exact parent kinds', () => {
    const step = `cite:${A}:plan_step:0`;
    const criterion = `cite:${A}:acceptance:0`;
    expect(
      citationSchema.safeParse({
        id: criterion,
        kind: 'ACCEPTANCE_CRITERION',
        artifact: A,
        parent: step,
        text: 'The current producer output parses',
      }).success
    ).toBe(true);
    expect(
      citationSchema.safeParse({
        id: criterion,
        kind: 'ACCEPTANCE_CRITERION',
        artifact: A,
        parent: `cite:${A}:plan_decision:0`,
        text: 'The current producer output parses',
      }).success
    ).toBe(false);
    expect(
      citationSchema.safeParse({
        id: `cite:${A}:cp1:criterion_evidence:0`,
        kind: 'CRITERION_EVIDENCE',
        artifact: A,
        cp: 1,
        parent: criterion,
        text: 'The generated floor parsed',
      }).success
    ).toBe(true);
    expect(
      citationSchema.safeParse({
        id: `cite:${A}:cp1:criterion_evidence:0`,
        kind: 'CRITERION_EVIDENCE',
        artifact: A,
        cp: 1,
        parent: step,
        text: 'The generated floor parsed',
      }).success
    ).toBe(false);
  });
});

describe('floorScopeSchema — current staleness fields', () => {
  function scope(): any {
    return {
      branch: 'feature/demo-review',
      branch_slug: 'feature%2Fdemo-review',
      base_sha: 'deadbeef',
      pinned_tree_sha: 'cafef00d',
      head_sha: null,
      default_branch: null,
      artifact_ids: [A],
      threads: [
        {
          artifact: A,
          branch: 'feature/demo-review',
          label: null,
          first_activity_at: null,
        },
      ],
    };
  }

  it('requires the current staleness fields', () => {
    const withoutHead: any = scope();
    delete withoutHead.head_sha;
    expect(floorScopeSchema.safeParse(withoutHead).success).toBe(false);
  });

  it('parses head_sha as a string or null', () => {
    expect(floorScopeSchema.parse({ ...scope(), head_sha: 'abc123' }).head_sha).toBe('abc123');
    expect(floorScopeSchema.parse({ ...scope(), head_sha: null }).head_sha).toBeNull();
  });

  it('rejects an empty-string head_sha (nonEmptyString)', () => {
    expect(floorScopeSchema.safeParse({ ...scope(), head_sha: '' }).success).toBe(false);
  });
});

describe('journalEventSchema', () => {
  const currentEvents = [
    {
      type: 'section',
      ts: ISO,
      threadKey: 'sec_x',
      action: 'VISIT',
    },
    {
      type: 'finding',
      ts: ISO,
      findingKey: 'find_x',
      action: 'ACKNOWLEDGE',
    },
    {
      type: 'uncertainty',
      ts: ISO,
      citationId: `cite:${A}:cp1:uncertainty:0`,
      action: 'RESOLVE',
    },
    {
      type: 'prompt',
      ts: ISO,
      promptKey: 'prompt_x',
      action: 'ACKNOWLEDGE',
    },
    {
      type: 'unassigned',
      ts: ISO,
      action: 'MARK_INSPECTED',
      target: {
        kind: 'AMBIGUOUS_HUNK',
        hunkKey: 'hunk_x',
      },
    },
    {
      type: 'review_coverage',
      ts: ISO,
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'floor_hash',
      ledger_generation: 'ledger_generation',
      threads: [
        {
          threadKey: 'sec_x',
          coveredRows: [{ file: 'src/a.ts', side: 'add', lineHash: 'line_hash', line: 1 }],
          coveredRowsDigest: 'rows_digest',
        },
      ],
    },
    {
      type: 'review_lifecycle',
      ts: ISO,
      action: 'COMPLETE',
      review_basis: 'FLOOR_ONLY',
      floor_input_hash: 'floor_hash',
      story_generation: null,
      ledger_generation: 'ledger_generation',
      actor: 'REVIEWER',
      source: 'WATCH',
    },
  ];

  it('accepts every current persisted event variant', () => {
    for (const event of currentEvents) {
      expect(journalEventSchema.parse(event)).toEqual(event);
    }
  });

  it('rejects unknown keys on every persisted event variant', () => {
    for (const event of currentEvents) {
      expect(journalEventSchema.safeParse({ ...event, unexpected: true }).success, event.type).toBe(
        false
      );
    }
  });

  it('accepts a section VISIT with no reason', () => {
    expect(
      journalEventSchema.safeParse({
        type: 'section',
        ts: ISO,
        threadKey: 'sec_x',
        action: 'VISIT',
      }).success
    ).toBe(true);
  });

  it('requires a reason for SKIP / PARTIAL / DISMISS', () => {
    expect(
      journalEventSchema.safeParse({
        type: 'section',
        ts: ISO,
        threadKey: 'sec_x',
        action: 'SKIP',
      }).success
    ).toBe(false);
    expect(
      journalEventSchema.safeParse({
        type: 'section',
        ts: ISO,
        threadKey: 'sec_x',
        action: 'SKIP',
        reason: 'not relevant to this review',
      }).success
    ).toBe(true);
    expect(
      journalEventSchema.safeParse({
        type: 'finding',
        ts: ISO,
        findingKey: 'find_x',
        action: 'DISMISS',
      }).success
    ).toBe(false);
    expect(
      journalEventSchema.safeParse({
        type: 'finding',
        ts: ISO,
        findingKey: 'find_x',
        action: 'DISMISS',
        reason: 'false positive',
      }).success
    ).toBe(true);
  });

  it('accepts a finding ACKNOWLEDGE and an uncertainty RESOLVE without reason', () => {
    expect(
      journalEventSchema.safeParse({
        type: 'finding',
        ts: ISO,
        findingKey: 'find_x',
        action: 'ACKNOWLEDGE',
      }).success
    ).toBe(true);
    expect(
      journalEventSchema.safeParse({
        type: 'uncertainty',
        ts: ISO,
        citationId: `cite:${A}:cp1:uncertainty:0`,
        action: 'RESOLVE',
      }).success
    ).toBe(true);
  });

  it('rejects removed section-level review marks instead of reading legacy state', () => {
    expect(
      journalEventSchema.safeParse({
        type: 'section',
        ts: ISO,
        threadKey: 'sec_x',
        action: 'MARK_REVIEWED',
        rows: [{ file: 'src/a.ts', side: 'add', lineHash: 'hash', line: 1 }],
        rows_digest: 'digest',
      }).success
    ).toBe(false);
    expect(
      journalEventSchema.safeParse({
        type: 'section',
        ts: ISO,
        threadKey: 'sec_x',
        action: 'PARTIAL',
        reason: 'work remains',
        rows: [{ file: 'src/a.ts', side: 'add', lineHash: 'hash', line: 1 }],
        rows_digest: 'digest',
      }).success
    ).toBe(false);
  });
});

describe('comment schemas', () => {
  const anchor = { file: 'src/a.ts', side: 'add', line: 4, lineHash: 'lh_x' };
  const lineAnchor = { kind: 'DIFF_LINE', ...anchor };

  it('parses add / reply / status events', () => {
    expect(
      commentEventSchema.safeParse({
        type: 'add',
        comment_id: 'c1',
        ts: ISO,
        author: 'reviewer',
        body: 'why 1s?',
        anchor: lineAnchor,
      }).success
    ).toBe(true);
    expect(
      commentEventSchema.safeParse({
        type: 'add',
        comment_id: 'legacy',
        ts: ISO,
        author: 'reviewer',
        body: 'old anchor',
        anchor,
      }).success
    ).toBe(false);
    expect(
      commentEventSchema.safeParse({
        type: 'reply',
        comment_id: 'c1',
        ts: ISO,
        author: 'agent',
        body: 'switched to backoff',
        checkpoint_ref: { artifact: A, cp: 7 },
      }).success
    ).toBe(true);
    expect(
      commentEventSchema.safeParse({
        type: 'status',
        comment_id: 'c1',
        ts: ISO,
        author: 'agent',
        status: 'resolved',
      }).success
    ).toBe(true);
  });

  it('rejects a REVIEW_ITEM anchor', () => {
    const anchor = { kind: 'REVIEW_ITEM', itemKey: 'legacy-item', threadKey: 'sec_1' };
    expect(commentAnchorSchema.safeParse(anchor).success).toBe(false);
    const persisted = persistedCommentAnchorSchema.safeParse(anchor);
    expect(persisted.success).toBe(false);
    expect(
      persisted.success ? [] : persisted.error.issues.map((issue) => issue.path.join('.'))
    ).toContain('kind');
    expect(
      commentEventSchema.safeParse({
        type: 'add',
        comment_id: 'legacy-item-comment',
        ts: ISO,
        author: 'reviewer',
        body: 'historical item comment',
        anchor,
      }).success
    ).toBe(false);
    expect(
      commentRecordSchema.safeParse({
        comment_id: 'legacy-item-comment',
        ts: ISO,
        author: 'reviewer',
        body: 'historical item comment',
        status: 'open',
        anchor,
        replies: [],
      }).success
    ).toBe(false);
  });

  it('parses the replayed aggregate record', () => {
    const record = {
      comment_id: 'c1',
      ts: ISO,
      author: 'reviewer',
      body: 'why 1s?',
      status: 'open',
      anchor: lineAnchor,
      replies: [
        { ts: ISO, author: 'agent', body: 'backoff', checkpoint_ref: { artifact: A, cp: 7 } },
      ],
    };
    expect(commentRecordSchema.safeParse(record).success).toBe(true);
  });

  describe('range anchors (additive endLine/lineHashes)', () => {
    it('accepts a well-formed range anchor (endLine === line included)', () => {
      expect(
        commentAnchorSchema.safeParse({
          kind: 'DIFF_RANGE',
          ...anchor,
          endLine: 7,
          lineHashes: ['lh_x', 'lh_y', 'lh_z'],
        }).success
      ).toBe(true);
      expect(
        commentAnchorSchema.safeParse({
          kind: 'DIFF_RANGE',
          ...anchor,
          endLine: 4,
          lineHashes: ['lh_x'],
        }).success
      ).toBe(true);
    });

    it('rejects endLine < line', () => {
      const result = commentAnchorSchema.safeParse({
        kind: 'DIFF_RANGE',
        ...anchor,
        endLine: 3,
        lineHashes: ['lh_x'],
      });
      expect(result.success).toBe(false);
    });

    it('rejects endLine without lineHashes', () => {
      expect(
        commentAnchorSchema.safeParse({ kind: 'DIFF_RANGE', ...anchor, endLine: 7 }).success
      ).toBe(false);
    });

    it('rejects lineHashes[0] !== lineHash — old readers must see the range start', () => {
      expect(
        commentAnchorSchema.safeParse({
          kind: 'DIFF_RANGE',
          ...anchor,
          endLine: 7,
          lineHashes: ['lh_other', 'lh_x'],
        }).success
      ).toBe(false);
    });

    it('a range anchor rides through the add event and the aggregate record', () => {
      const rangeAnchor = {
        kind: 'DIFF_RANGE',
        ...anchor,
        endLine: 7,
        lineHashes: ['lh_x', 'lh_y'],
      };
      expect(
        commentEventSchema.safeParse({
          type: 'add',
          comment_id: 'c2',
          ts: ISO,
          author: 'reviewer',
          body: 'this whole block',
          anchor: rangeAnchor,
        }).success
      ).toBe(true);
      expect(
        commentRecordSchema.safeParse({
          comment_id: 'c2',
          ts: ISO,
          author: 'reviewer',
          body: 'this whole block',
          status: 'open',
          anchor: rangeAnchor,
          replies: [],
        }).success
      ).toBe(true);
    });
  });
});

describe('citationIdSchema', () => {
  it('accepts a valid id and rejects a malformed one', () => {
    expect(citationIdSchema.safeParse(CITE).success).toBe(true);
    expect(citationIdSchema.safeParse('not-a-cite').success).toBe(false);
  });
});
