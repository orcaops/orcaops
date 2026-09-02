import { describe, expect, it } from 'vitest';

import { CITATION_KIND, FINDING_KIND, FINDING_ORIGIN, FINDING_SCOPE } from './enums.js';
import {
  changedRangeTargetKey,
  checkpointKey,
  checkpointRef,
  type CitationIdParts,
  findingKey,
  formatCitationId,
  hunkKey,
  isCitationId,
  parseCitationId,
  stableHash64,
  threadKey,
} from './keys.js';

const A = '019f38b7-1111-7000-8000-000000000001';
const B = '019f5978-1111-7000-8000-000000000001';

describe('stableHash64', () => {
  it('is deterministic', async () => {
    expect(await stableHash64('d', ['a', 'b'])).toBe(await stableHash64('d', ['a', 'b']));
  });

  it('is domain-separated', async () => {
    expect(await stableHash64('d1', ['a'])).not.toBe(await stableHash64('d2', ['a']));
  });

  it('is order-sensitive at the raw level (callers canonicalize)', async () => {
    expect(await stableHash64('d', ['a', 'b'])).not.toBe(await stableHash64('d', ['b', 'a']));
  });

  it('length-prefixes parts (no boundary collision)', async () => {
    // ['ab', ''] and ['a', 'b'] concatenate to the same bytes only without framing.
    expect(await stableHash64('d', ['ab', ''])).not.toBe(await stableHash64('d', ['a', 'b']));
  });

  it('emits base64url (no pad, url-safe)', async () => {
    const h = await stableHash64('d', ['a']);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toContain('=');
  });
});

describe('threadKey', () => {
  // A thread's key takes the artifact id and NOTHING else — the signature does
  // not accept a member set, so a key that moves when a checkpoint closes is
  // unrepresentable.

  it('is fixed for an artifact, however many checkpoints it accumulates', async () => {
    // The property that matters, stated directly: nothing about a thread's
    // contents can move its key. (The end-to-end coverage consequence is proved
    // in review-engine/outline.test.ts.)
    expect(await threadKey(A)).toBe(await threadKey(A));
  });

  it('distinguishes threads', async () => {
    expect(await threadKey(A)).not.toBe(await threadKey(B));
  });

  it('carries the sec_ prefix', async () => {
    expect((await threadKey(A)).startsWith('sec_')).toBe(true);
  });

  it('cannot collide with a checkpoint key for the same artifact', async () => {
    // Distinct domains, and the member ref is `<artifact>:thread`, not
    // `<artifact>:cp<n>` — so the two key spaces cannot alias even at the body.
    const thread = await threadKey(A);
    const checkpoint = await checkpointKey([checkpointRef(A, 1)]);
    expect(thread.slice('sec_'.length)).not.toBe(checkpoint.slice('chap_'.length));
  });
});

describe('checkpointKey', () => {
  it('normalizes member order and duplicates', async () => {
    // A member-set recipe, and safely so: a checkpoint's members are fixed
    // when it closes, so the set cannot grow beneath it.
    const ordered = [checkpointRef(A, 1), checkpointRef(A, 2), checkpointRef(A, 3)];
    const shuffledWithDup = [
      checkpointRef(A, 3),
      checkpointRef(A, 1),
      checkpointRef(A, 2),
      checkpointRef(A, 1),
    ];
    expect(await checkpointKey(shuffledWithDup)).toBe(await checkpointKey(ordered));
  });

  it('distinguishes member sets', async () => {
    expect(await checkpointKey([checkpointRef(A, 1)])).not.toBe(
      await checkpointKey([checkpointRef(A, 2)])
    );
  });

  it('carries its prefix', async () => {
    expect((await checkpointKey([checkpointRef(A, 1)])).startsWith('chap_')).toBe(true);
  });
});

describe('findingKey', () => {
  const base = {
    kind: FINDING_KIND.CAPTURE_GAP,
    scope: FINDING_SCOPE.CAPTURE,
    origin: FINDING_ORIGIN.CANDIDATE_PROMOTED,
    anchors: [
      'hunk_x',
      formatCitationId({ artifact: A, checkpointN: null, kind: CITATION_KIND.PLAN_STEP, index: 0 }),
    ],
  };

  it('is anchor-order independent', async () => {
    const k1 = await findingKey(base);
    const k2 = await findingKey({ ...base, anchors: [...base.anchors].reverse() });
    expect(k1).toBe(k2);
    expect(k1.startsWith('find_')).toBe(true);
  });

  it('changes with kind, and with a discriminator', async () => {
    const k1 = await findingKey(base);
    expect(await findingKey({ ...base, kind: FINDING_KIND.STALE_EVIDENCE })).not.toBe(k1);
    expect(await findingKey({ ...base, discriminator: 'second' })).not.toBe(k1);
  });
});

describe('hunkKey', () => {
  it('is stable and occurrence-sensitive', async () => {
    const h0 = await hunkKey({ filePath: 'src/a.ts', contentHash: 'abc', occurrence: 0 });
    expect(await hunkKey({ filePath: 'src/a.ts', contentHash: 'abc', occurrence: 0 })).toBe(h0);
    expect(await hunkKey({ filePath: 'src/a.ts', contentHash: 'abc', occurrence: 1 })).not.toBe(h0);
    expect(h0.startsWith('hunk_')).toBe(true);
  });
});

describe('citation-id grammar', () => {
  const cases: CitationIdParts[] = [
    { artifact: A, checkpointN: 2, kind: CITATION_KIND.CHECKPOINT_DECISION, index: 0 },
    { artifact: A, checkpointN: 3, kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY, index: 1 },
    { artifact: A, checkpointN: 1, kind: CITATION_KIND.CHECKPOINT_ALTERNATIVE, index: 2 },
    { artifact: A, checkpointN: 4, kind: CITATION_KIND.CRITERION_EVIDENCE, index: 0 },
    { artifact: A, checkpointN: 5, kind: CITATION_KIND.CHECKPOINT_VERIFICATION, index: 3 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.PLAN_STEP, index: 2 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.PLAN_NON_GOAL, index: 0 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.PLAN_DECISION, index: 0 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.PLAN_ALTERNATIVE, index: 7 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.ACCEPTANCE_CRITERION, index: 4 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.SUMMARY, index: 0 },
    { artifact: A, checkpointN: null, kind: CITATION_KIND.EVALUATOR_RUN, index: 1 },
  ];

  it('covers every citation kind — a new kind cannot ship without a round-trip', () => {
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(Object.values(CITATION_KIND)));
  });

  it('round-trips every kind', () => {
    for (const c of cases) {
      const id = formatCitationId(c);
      expect(parseCitationId(id)).toEqual(c);
      expect(isCitationId(id)).toBe(true);
    }
  });

  it('renders the canonical shapes', () => {
    const of = (kind: CitationIdParts['kind']) =>
      formatCitationId(cases.find((c) => c.kind === kind)!);
    expect(of(CITATION_KIND.CHECKPOINT_DECISION)).toBe(`cite:${A}:cp2:decision:0`);
    expect(of(CITATION_KIND.PLAN_STEP)).toBe(`cite:${A}:plan_step:2`);
    expect(of(CITATION_KIND.PLAN_DECISION)).toBe(`cite:${A}:plan_decision:0`);
    expect(of(CITATION_KIND.PLAN_ALTERNATIVE)).toBe(`cite:${A}:plan_alternative:7`);
    expect(of(CITATION_KIND.CRITERION_EVIDENCE)).toBe(`cite:${A}:cp4:criterion_evidence:0`);
    expect(of(CITATION_KIND.CHECKPOINT_VERIFICATION)).toBe(`cite:${A}:cp5:verification:3`);
  });

  it('enforces cp-required vs cp-forbidden per kind', () => {
    expect(() =>
      formatCitationId({
        artifact: A,
        checkpointN: null,
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        index: 0,
      })
    ).toThrow();
    expect(() =>
      formatCitationId({ artifact: A, checkpointN: 2, kind: CITATION_KIND.PLAN_STEP, index: 0 })
    ).toThrow();
    // WHY PLAN_ALTERNATIVE is its own kind rather than a reuse of
    // CHECKPOINT_ALTERNATIVE: a plan decision has no checkpoint, and the
    // checkpoint-scoped kind throws on a null cp.
    expect(() =>
      formatCitationId({
        artifact: A,
        checkpointN: null,
        kind: CITATION_KIND.CHECKPOINT_ALTERNATIVE,
        index: 0,
      })
    ).toThrow();
    expect(() =>
      formatCitationId({
        artifact: A,
        checkpointN: null,
        kind: CITATION_KIND.PLAN_ALTERNATIVE,
        index: 0,
      })
    ).not.toThrow();
  });

  it('rejects malformed ids', () => {
    expect(parseCitationId('nope')).toBeNull();
    expect(parseCitationId(`cite:${A}:decision:0`)).toBeNull(); // decision needs cp
    expect(parseCitationId(`cite:${A}:cp2:plan_step:0`)).toBeNull(); // plan_step forbids cp
    expect(parseCitationId(`cite:${A}:cp2:decision:x`)).toBeNull(); // non-numeric index
    expect(parseCitationId(`cite::cp2:decision:0`)).toBeNull(); // empty artifact
    expect(parseCitationId(`cite:${A}:cp0:decision:0`)).toBeNull(); // cp0 invalid
    expect(isCitationId('nope')).toBe(false);
  });
});

describe('regeneration stability', () => {
  it('rebuilds identical keys across a simulated re-compose', async () => {
    const uncertaintyCite = formatCitationId({
      artifact: A,
      checkpointN: 4,
      kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
      index: 0,
    });
    const makeFinding = () =>
      findingKey({
        kind: FINDING_KIND.UNRESOLVED_UNCERTAINTY,
        scope: FINDING_SCOPE.CAPTURE,
        origin: FINDING_ORIGIN.LLM_NATIVE,
        anchors: [uncertaintyCite],
      });

    // First composition: mint stable keys for one thread, checkpoint, and finding.
    const firstThread = await threadKey(A);
    const firstCheckpoint = await checkpointKey([checkpointRef(A, 4)]);
    const firstFinding = await makeFinding();

    // Re-compose the same inputs.
    const reThread = await threadKey(A);
    const reCheckpoint = await checkpointKey([checkpointRef(A, 4)]);
    const reFinding = await makeFinding();

    // Identical semantic inputs produce identical content-addressed keys.
    expect(reThread).toBe(firstThread);
    expect(reCheckpoint).toBe(firstCheckpoint);
    expect(reFinding).toBe(firstFinding);
  });
});

describe('changedRangeTargetKey', () => {
  it('keys CHANGED_RANGE from content without accepting an ordinal', async () => {
    const input = {
      file: 'src/a.ts',
      hunkKey: 'hunk_a',
      ranges: [
        { side: 'add' as const, startLine: 4, endLine: 5, lineHashes: ['h1', 'h2'] },
        { side: 'delete' as const, startLine: 4, endLine: 4, lineHashes: ['old'] },
      ],
    };
    const first = await changedRangeTargetKey(input);
    expect(await changedRangeTargetKey({ ...input, ranges: [...input.ranges].reverse() })).toBe(
      first
    );
    expect(first).toMatch(/^target_/);
  });
});
