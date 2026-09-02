import { describe, expect, it } from 'vitest';

import { CITATION_KIND } from '@orcaops/review-core';

import { type AccountProjection, DOSSIER_SCHEMA_VERSION, type ForensicInput } from './dossier.js';
import {
  buildSemanticAnchorChangeBlockCatalog,
  collectEligibleSemanticAnchorCitations,
  parseSemanticAnchorInputReceipt,
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_PROFILE_V1,
  semanticAnchorChangeBlockKey,
  semanticAnchorStoryCatalogIssue,
  UnsupportedSemanticAnchorInputVersionError,
} from './semanticAnchors.js';
import type { CoverageInput } from './storyOwnership.js';
import { STORY_REVIEW_MODEL_SCHEMA_VERSION, type StoryReviewModel } from './storyReviewModel.js';

const projection = (): AccountProjection =>
  ({
    schema_version: DOSSIER_SCHEMA_VERSION,
    branch: 'feature',
    floor_input_hash: 'floor-1',
    artifactAliases: { a1: 'artifact-1' },
    accountCore: {
      planSteps: [{ citationId: 'step', text: 'not eligible' }],
      nonGoals: [],
      planDecisions: [
        {
          citationId: 'plan-decision',
          cp: null,
          text: 'Use the indexed representation in full.',
          alternatives: [{ citationId: 'plan-alt', text: 'Clip it.' }],
        },
      ],
      acceptanceCriteria: [{ citationId: 'criterion', text: 'also not eligible', parent: 'step' }],
      criterionEvidence: [],
      verification: [],
      evaluatorRuns: [],
      checkpoints: [
        {
          artifact: 'a1',
          cp: 2,
          status: 'closed',
          label: 'implementation',
          summary: 'Built it.',
          decisions: [
            {
              citationId: 'checkpoint-decision',
              cp: 2,
              text: 'Use one durable target.',
              alternatives: [{ citationId: 'checkpoint-alt', text: 'Persist prompt IDs.' }],
            },
          ],
          uncertainty: [
            { citationId: 'checkpoint-uncertainty', text: 'Deletion-only anchors may occur.' },
          ],
        },
      ],
      ledger: [],
    },
    implicatedHunks: [],
    riskRemainder: [],
    fileInventory: [],
    inventoryMode: 'full',
    manifestSummary: { counts: {}, topOmittedHunks: [] },
  }) as AccountProjection;

const story = (): StoryReviewModel =>
  ({
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: 'feature',
    floor_input_hash: 'floor-1',
    label: 'DERIVED',
    banner: 'Derived ownership.',
    overview: {
      text: 'The branch makes semantic anchors durable and validates their geometry.',
      citations: ['checkpoint-decision'],
    },
    acts: [{ id: 'A1', title: 'Build it', interpretation: null, partIds: ['P1'] }],
    parts: [
      {
        id: 'P1',
        title: 'Make the representation durable',
        act: 'A1',
        checkpointRefs: ['a1:cp2'],
        interpretation: 'The representation became durable.',
        citations: ['checkpoint-decision'],
        segments: [],
        ambiguous: [],
        changedRows: 0,
        ambiguousRows: 0,
        contextOnly: true,
      },
    ],
    residue: { contested: [], unattributed: [], reviewableRows: 0, files: [] },
    metrics: {
      reviewableRows: 0,
      attributedRows: 0,
      attributedPct: 0,
      ambiguousRows: 0,
      contestedRows: 0,
      unattributedRows: 0,
      contributingThreads: 1,
      contributingCheckpoints: 1,
    },
    ledger: [],
    uncertainties: [],
    findings: [],
    questions: [],
    citations: {},
    artifactAliases: { a1: 'artifact-1' },
  }) as StoryReviewModel;

const coverage = (): CoverageInput => ({
  items: [
    {
      hunkKey: 'hunk_durable_1',
      file: 'src/x.ts',
      verdict: 'MATCHED',
      old_start: 10,
      new_start: 10,
      added_lines: 2,
      removed_lines: 1,
      units: [],
    },
  ],
  summary: {
    excluded: 0,
    unreviewable: 0,
    matched_rows: 3,
    unexplained_rows: 0,
    ambiguous_rows: 0,
    reviewable_rows: 3,
  },
});

const diff =
  'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n';

const forensicInput = (): ForensicInput => ({
  schema_version: 2,
  baseSha: null,
  diff,
  excludedPaths: ['.orcaops/private.json'],
  unreviewablePaths: ['assets/logo.bin'],
  policyStubs: [
    {
      path: 'fixtures/large.json',
      adds: 20,
      dels: 4,
      bytes: 4096,
      reason: 'review.stub_paths',
    },
  ],
  metrics: {
    eligibleFiles: 1,
    excludedFiles: 1,
    unreviewableFiles: 1,
    policyStubFiles: 1,
    policyStubRows: 24,
    policyStubBytes: 4096,
    eligibleDiffBytes: Buffer.byteLength(diff),
  },
});

const readyInput = () => {
  const p = projection();
  const s = story();
  const c = coverage();
  const f = forensicInput();
  return {
    runId: 'run-1',
    storyModel: s,
    storyModelBytes: `${JSON.stringify(s)}\n`,
    accountProjection: p,
    accountProjectionBytes: `${JSON.stringify(p)}\n`,
    coverage: c,
    coverageBytes: `${JSON.stringify(c)}\n`,
    pinnedDiffText: diff,
    forensicInput: f,
    forensicInputBytes: `${JSON.stringify(f)}\n`,
    accountLineage: {
      acceptedEnvelopeSha256: 'a'.repeat(64),
      compiledPayloadSha256: 'b'.repeat(64),
    },
  };
};

const geometryDiff = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
  '\\ No newline at end of file',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -3,2 +0,0 @@',
  '-old',
  '-gone',
  'diff --git a/src/mod.ts b/src/mod.ts',
  '--- a/src/mod.ts',
  '+++ b/src/mod.ts',
  '@@ -10,4 +10,4 @@',
  '-old value',
  '+new value',
  ' context one',
  '+inserted',
  ' context two',
  '-deleted',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 100%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '',
].join('\n');

const geometryCoverage = (): CoverageInput =>
  ({
    items: [
      {
        hunkKey: 'hunk_add',
        file: 'src/new.ts',
        verdict: 'MATCHED',
        old_start: null,
        new_start: 1,
        added_lines: 2,
        removed_lines: 0,
        units: [],
      },
      {
        hunkKey: 'hunk_delete',
        file: 'src/gone.ts',
        verdict: 'MATCHED',
        old_start: 3,
        new_start: null,
        added_lines: 0,
        removed_lines: 2,
        units: [],
      },
      {
        hunkKey: 'hunk_modify',
        file: 'src/mod.ts',
        verdict: 'MATCHED',
        old_start: 10,
        new_start: 10,
        added_lines: 2,
        removed_lines: 2,
        units: [],
      },
    ],
    summary: {
      excluded: 0,
      unreviewable: 0,
      matched_rows: 8,
      unexplained_rows: 0,
      ambiguous_rows: 0,
      reviewable_rows: 8,
    },
  }) as CoverageInput;

const withoutChangeMarkers = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('@@@ change-'))
    .map((line) => line.replace(/^([+-])[AD]\d+ /, '$1'))
    .join('\n');

describe('semantic anchor input preparation', () => {
  it('pins the exact five eligible kinds once and keeps their complete prose', () => {
    const citations = collectEligibleSemanticAnchorCitations(projection());
    expect(citations.map((citation) => citation.alias)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(citations.map((citation) => citation.kind)).toEqual([
      CITATION_KIND.PLAN_DECISION,
      CITATION_KIND.PLAN_ALTERNATIVE,
      CITATION_KIND.CHECKPOINT_DECISION,
      CITATION_KIND.CHECKPOINT_ALTERNATIVE,
      CITATION_KIND.CHECKPOINT_UNCERTAINTY,
    ]);
    expect(new Set(citations.map((citation) => citation.id)).size).toBe(citations.length);
    expect(citations.some((citation) => citation.id === 'criterion')).toBe(false);
    expect(citations.find((citation) => citation.id === 'checkpoint-alt')?.parent).toBe(
      'checkpoint-decision'
    );
  });

  it('requires every later anchor item to resolve once through the Story v4 catalog', () => {
    const items = collectEligibleSemanticAnchorCitations(projection());
    const installed = story();
    installed.citations = Object.fromEntries(
      items.map((item) => [
        item.id,
        {
          id: item.id,
          kind: item.kind,
          artifact: 'a1',
          cp: item.checkpoint_ref === undefined ? null : 2,
          text: item.text,
          ...(item.parent !== undefined ? { parent: item.parent } : {}),
        },
      ])
    );
    expect(semanticAnchorStoryCatalogIssue(installed, items)).toBeNull();
    delete installed.citations[items[0]!.id];
    expect(semanticAnchorStoryCatalogIssue(installed, items)).toContain('absent');
    installed.citations[items[0]!.id] = {
      id: items[0]!.id,
      kind: 'PLAN_STEP',
      artifact: 'a1',
      cp: null,
      text: items[0]!.text,
    };
    expect(semanticAnchorStoryCatalogIssue(installed, items)).toContain('disagrees');
    expect(semanticAnchorStoryCatalogIssue(installed, [...items, items[0]!])).toContain(
      'more than once'
    );
  });

  it('emits deterministic nested change-block aliases and a complete v3 payload receipt', () => {
    const catalog = buildSemanticAnchorChangeBlockCatalog(diff, coverage());
    expect(catalog.text).toContain('@@@ change-hunk:h1 MODIFICATION @@@');
    expect(catalog.text).toContain('@@@ change-block:h1.b1 REPLACEMENT old:11:11 new:11:12 @@@');
    expect(catalog.changedRowCount).toBe(3);
    expect(catalog.blockCount).toBe(1);
    expect(catalog.hunks[0]).toMatchObject({
      alias: 'h1',
      oldFile: 'src/x.ts',
      newFile: 'src/x.ts',
      hunkKey: 'hunk_durable_1',
      fileChange: 'MODIFICATION',
      blocks: [
        {
          alias: 'h1.b1',
          kind: 'REPLACEMENT',
          oldRange: { start: 11, end: 11 },
          newRange: { start: 11, end: 12 },
        },
      ],
    });
    expect(catalog.hunks[0]!.blocks[0]!.blockKey).toMatch(/^block_[0-9a-f]{64}$/);
    expect(catalog.hunks[0]!.blocks[0]!.lines.map((line) => line.ref)).toEqual(['D1', 'A1', 'A2']);
    expect(catalog.text).toContain('-D1 old');
    expect(catalog.text).toContain('+A2 more');
    expect(catalog.text).not.toContain('@@@ change-row:');
    expect(catalog.blockAliases['h1.b1']).toBe(catalog.hunks[0]!.blocks[0]!.blockKey);
    expect(catalog.hunkAliases.h1).toBe('hunk_durable_1');

    const first = prepareSemanticAnchorInput(readyInput());
    const second = prepareSemanticAnchorInput(readyInput());
    expect(first).toEqual(second);
    expect(first.receipt.status).toBe('READY');
    expect(first.receipt.profile).toBe('semantic-anchor-profile-v1');
    expect(first.receipt.profile_source).toBe('ENGINE_REGISTERED');
    expect(first.receipt.eligible_citation_count).toBe(5);
    expect(first.receipt.schema_version).toBe(4);
    expect(first.receipt.change_block_count).toBe(1);
    expect(first.receipt.estimated_minimum_output_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify({ schema_version: 3, dispositions: [] })) / 3)
    );
    expect(first.receipt.source_hashes.diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.receipt.source_hashes.accepted_account_envelope_sha256).toBe('a'.repeat(64));
    expect(first.receipt.source_hashes.compiled_account_payload_sha256).toBe('b'.repeat(64));
    expect(first.receipt.derivation_hashes.policy_eligible_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.receipt.derivation_hashes.change_block_catalog_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.receipt.target_scope).toMatchObject({
      kind: 'POLICY_ELIGIBLE_DIFF',
      eligible_files: 1,
      excluded_files: 3,
      policy_stub_files: 1,
      known_excluded_adds: 20,
      known_excluded_deletes: 4,
      known_excluded_bytes: 4096,
    });
    expect(first.payload).toContain('Deletion-only anchors may occur.');
    expect(first.payload).toContain('The branch makes semantic anchors durable');
    expect(first.payload).toContain('"interpretation": "The representation became durable."');
    expect(first.payload).toContain('fixtures/large.json');
    expect(first.payload).not.toContain('"segments"');
    expect(first.payload).toContain('### i1');
    expect(first.payload).toContain('change-block:h1.b1 REPLACEMENT');
    expect(first.payload).toContain('+A2 more');
    expect(first.payload).not.toContain(catalog.hunks[0]!.blocks[0]!.blockKey);
    expect(first.payload).not.toContain(catalog.hunks[0]!.blocks[0]!.lines[0]!.lineHash);
    expect(first.items.map((item) => item.alias)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(first.blockCatalog).toEqual(catalog);
  });

  it('compiles additions, deletions, replacements, and context splits while leaving pure renames untargetable', () => {
    const catalog = buildSemanticAnchorChangeBlockCatalog(geometryDiff, geometryCoverage());

    expect(withoutChangeMarkers(catalog.text)).toBe(geometryDiff);
    expect(catalog.hunks.map((hunk) => [hunk.alias, hunk.fileChange])).toEqual([
      ['h1', 'ADDITION'],
      ['h2', 'DELETION'],
      ['h3', 'MODIFICATION'],
    ]);
    expect(catalog.hunks.flatMap((hunk) => hunk.blocks.map((block) => block.alias))).toEqual([
      'h1.b1',
      'h2.b1',
      'h3.b1',
      'h3.b2',
      'h3.b3',
    ]);
    expect(catalog.hunks.flatMap((hunk) => hunk.blocks.map((block) => block.kind))).toEqual([
      'ADDITION',
      'DELETION',
      'REPLACEMENT',
      'ADDITION',
      'DELETION',
    ]);
    expect(catalog.hunks[0]!.blocks[0]!.lines.at(-1)).toMatchObject({
      side: 'add',
      newLine: 2,
      noNewline: true,
    });
    expect(catalog.hunks[2]!.blocks.map((block) => [block.oldRange, block.newRange])).toEqual([
      [
        { start: 10, end: 10 },
        { start: 10, end: 10 },
      ],
      [null, { start: 12, end: 12 }],
      [{ start: 13, end: 13 }, null],
    ]);
    expect(catalog.text).toContain('rename from old/name.ts');
    expect(catalog.text).toContain('rename to new/name.ts');
    expect(catalog.hunks.every((hunk) => hunk.displayPath === (hunk.newFile ?? hunk.oldFile))).toBe(
      true
    );
  });

  it('derives block identity from canonical file/hunk/range/hash material only', () => {
    const catalog = buildSemanticAnchorChangeBlockCatalog(geometryDiff, geometryCoverage());
    const block = catalog.hunks[2]!.blocks[0]!;
    const input = {
      oldFile: catalog.hunks[2]!.oldFile,
      newFile: catalog.hunks[2]!.newFile,
      hunkKey: catalog.hunks[2]!.hunkKey,
      oldRange: block.oldRange,
      newRange: block.newRange,
      changedLines: block.lines,
    };
    const first = semanticAnchorChangeBlockKey(input);

    expect(
      semanticAnchorChangeBlockKey({ ...input, changedLines: [...block.lines].reverse() })
    ).toBe(first);
    expect(semanticAnchorChangeBlockKey({ ...input, oldFile: 'src/other.ts' })).not.toBe(first);
    expect(semanticAnchorChangeBlockKey({ ...input, hunkKey: 'hunk_other' })).not.toBe(first);
    expect(
      semanticAnchorChangeBlockKey({
        ...input,
        oldRange: { start: input.oldRange!.start + 1, end: input.oldRange!.end + 1 },
      })
    ).not.toBe(first);
    expect(
      semanticAnchorChangeBlockKey({
        ...input,
        changedLines: [{ ...block.lines[0]!, lineHash: 'different' }, ...block.lines.slice(1)],
      })
    ).not.toBe(first);

    const reorderedSections = geometryDiff.split('diff --git ').filter(Boolean).reverse();
    const reorderedDiff = reorderedSections.map((section) => `diff --git ${section}`).join('');
    const reordered = buildSemanticAnchorChangeBlockCatalog(reorderedDiff, {
      ...geometryCoverage(),
      items: [...geometryCoverage().items].reverse(),
    });
    const byKey = (value: ReturnType<typeof buildSemanticAnchorChangeBlockCatalog>) =>
      new Set(value.hunks.flatMap((hunk) => hunk.blocks.map((candidate) => candidate.blockKey)));
    expect(byKey(reordered)).toEqual(byKey(catalog));
  });

  it('keeps changed-row coordinates compact instead of adding one marker line per row', () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => `+const value${index} = ${index};`);
    const largeDiff = [
      'diff --git a/src/large.ts b/src/large.ts',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      '@@ -0,0 +1,2000 @@',
      ...rows,
      '',
    ].join('\n');
    const largeCoverage: CoverageInput = {
      items: [
        {
          hunkKey: 'hunk_large',
          file: 'src/large.ts',
          verdict: 'MATCHED',
          old_start: null,
          new_start: 1,
          added_lines: rows.length,
          removed_lines: 0,
          units: [],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: rows.length,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: rows.length,
      },
    };
    const catalog = buildSemanticAnchorChangeBlockCatalog(largeDiff, largeCoverage);
    const overhead = Buffer.byteLength(catalog.text) - Buffer.byteLength(largeDiff);

    expect(withoutChangeMarkers(catalog.text)).toBe(largeDiff);
    expect(catalog.text).toContain('+A2000 const value1999 = 1999;');
    expect(catalog.text).not.toContain('@@@ change-row:');
    expect(overhead).toBeLessThan(rows.length * 10 + 500);
  });

  it('retains both file identities for a renamed file that also changes rows', () => {
    const renamedDiff = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 80%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -10 +10 @@',
      '-old value',
      '+new value',
      '',
    ].join('\n');
    const renamedCoverage: CoverageInput = {
      items: [
        {
          hunkKey: 'hunk_rename_edit',
          file: 'new/name.ts',
          verdict: 'MATCHED',
          old_start: 10,
          new_start: 10,
          added_lines: 1,
          removed_lines: 1,
          units: [],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 2,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: 2,
      },
    };
    const catalog = buildSemanticAnchorChangeBlockCatalog(renamedDiff, renamedCoverage);
    expect(catalog.hunks).toHaveLength(1);
    expect(catalog.hunks[0]).toMatchObject({
      oldFile: 'old/name.ts',
      newFile: 'new/name.ts',
      displayPath: 'new/name.ts',
      fileChange: 'RENAME',
      blocks: [{ kind: 'REPLACEMENT' }],
    });
  });

  it('rejects historical v1 through v3 receipts instead of reinterpreting them as v4', () => {
    for (const schemaVersion of [1, 2, 3]) {
      expect(() => parseSemanticAnchorInputReceipt({ schema_version: schemaVersion })).toThrow(
        UnsupportedSemanticAnchorInputVersionError
      );
    }
  });

  it('uses the policy-eligible diff when the full pinned diff exceeds transport', () => {
    const prepared = prepareSemanticAnchorInput({
      ...readyInput(),
      pinnedDiffText: 'full-only-line\n'.repeat(180_000),
    });
    expect(Buffer.byteLength('full-only-line\n'.repeat(180_000))).toBeGreaterThan(2_000_000);
    expect(prepared.receipt.status).toBe('READY');
    expect(prepared.payload).not.toContain('full-only-line');
    expect(prepared.payload).toContain('+A2 more');
  });

  it('refuses complete input at every registered budget and never returns a truncated payload', () => {
    const transport = prepareSemanticAnchorInput({
      ...readyInput(),
      profile: { ...SEMANTIC_ANCHOR_PROFILE_V1, hard_transport_bytes: 1 },
    });
    expect(transport.receipt.status).toBe('TOO_LARGE');
    expect(transport.receipt.reason).toBe('HARD_TRANSPORT_BYTES_EXCEEDED');
    expect(transport.receipt.payload_bytes).toBeGreaterThan(1);
    expect(transport.receipt.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transport.receipt.payload_file).toBeNull();
    expect(transport.payload).toBeNull();

    const inputTokens = prepareSemanticAnchorInput({
      ...readyInput(),
      profile: { ...SEMANTIC_ANCHOR_PROFILE_V1, context_window_tokens: 48_000 },
    });
    expect(inputTokens.receipt.status).toBe('TOO_LARGE');
    expect(inputTokens.receipt.reason).toBe('ESTIMATED_TOKEN_BUDGET_EXCEEDED');
    expect(inputTokens.payload).toBeNull();

    const minimumOutput = prepareSemanticAnchorInput({
      ...readyInput(),
      profile: { ...SEMANTIC_ANCHOR_PROFILE_V1, maximum_output_tokens: 1 },
    });
    expect(minimumOutput.receipt.status).toBe('TOO_LARGE');
    expect(minimumOutput.receipt.reason).toBe('MINIMUM_OUTPUT_BUDGET_EXCEEDED');
    expect(minimumOutput.receipt.estimated_minimum_output_tokens).toBeGreaterThan(1);
    expect(minimumOutput.payload).toBeNull();
  });

  it('distinguishes an ineligible review from unavailable source data', () => {
    const noStory = prepareSemanticAnchorInput({
      ...readyInput(),
      storyModel: null,
      storyModelBytes: null,
    });
    expect(noStory.receipt.status).toBe('NOT_ELIGIBLE');
    expect(noStory.receipt.reason).toBe('CORE_STORY_ABSENT');

    const noCoverage = prepareSemanticAnchorInput({
      ...readyInput(),
      coverage: null,
      coverageBytes: null,
    });
    expect(noCoverage.receipt.status).toBe('UNAVAILABLE');
    expect(noCoverage.receipt.reason).toBe('COVERAGE_UNAVAILABLE');

    const none = projection();
    none.accountCore.planDecisions = [];
    for (const checkpoint of none.accountCore.checkpoints) {
      checkpoint.decisions = [];
      checkpoint.uncertainty = [];
    }
    const noEligibleCitations = prepareSemanticAnchorInput({
      ...readyInput(),
      accountProjection: none,
      accountProjectionBytes: JSON.stringify(none),
      coverage: null,
      coverageBytes: null,
    });
    expect(noEligibleCitations.receipt.status).toBe('NOT_ELIGIBLE');
    expect(noEligibleCitations.receipt.reason).toBe('NO_ELIGIBLE_CITATIONS');
  });
});
