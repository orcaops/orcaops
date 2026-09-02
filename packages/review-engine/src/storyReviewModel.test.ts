import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  attribute,
  type AttributionResult,
  buildChain,
  type CheckpointDescriptor,
  type LineOwner,
  type OverlapSegment,
} from '@orcaops/review-core';

import {
  type AccountProjection,
  DOSSIER_SCHEMA_VERSION,
  type DossierV1,
  type ProjectionLedgerEntry,
} from './dossier.js';
import type { PartTopology } from './storyOwnership.js';
import {
  installStoryReviewModel,
  parseStoryReviewModel,
  projectStoryReviewModel,
  resolvePartRangesAgainstDiff,
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  storyReviewGeneration,
  StoryReviewModelInvariantError,
  storyReviewModelSchema,
} from './storyReviewModel.js';
import {
  type AccountPayload,
  composeStory,
  type ForensicPayload,
  renderSlice,
} from './twolaneSlice.js';

// Real end-to-end: run the genuine attribute() pipeline over the committed
// scenario, compose the Story, then project + validate + round-trip the model.
const SCENARIO_URL = new URL('../fixtures/story-ownership/scenario.json', import.meta.url);
const STORY_CITATION = 'cite:a1:plan_step:0';

interface Scenario {
  base: string;
  worktree: string;
  checkpoints: CheckpointDescriptor[];
  overlapSegments: OverlapSegment[];
  diffLines: string[];
  lineOwners: LineOwner[];
  topology: PartTopology;
}

let scenario: Scenario;
let coverage: AttributionResult['coverage'];
let diffText: string;

beforeAll(async () => {
  scenario = JSON.parse(await readFile(SCENARIO_URL, 'utf8')) as Scenario;
  diffText = scenario.diffLines.join('\n');
  const chain = buildChain({
    base: scenario.base,
    worktree: scenario.worktree,
    checkpoints: scenario.checkpoints,
  });
  const result = await attribute({
    chain,
    reviewDiff: new TextEncoder().encode(diffText),
    reviewDiffTruncated: false,
    reviewMaxDiffBytes: 2_000_000,
    lineOwners: scenario.lineOwners,
    overlapSegments: scenario.overlapSegments,
  });
  coverage = result.coverage;
});

const storyFromParts = (
  parts: { id: string; act?: string; checkpoint_refs: string[] }[]
): AccountPayload => ({
  overview: {
    text: 'The branch carries one causal change from intent through validation.',
    citations: [STORY_CITATION],
  },
  acts: [
    { id: 'ActI', title: 'The first act', interpretation: 'Sets up.' },
    { id: 'ActII', title: 'The second act' },
  ],
  parts: parts.map((p) => ({
    id: p.id,
    title: `Part ${p.id}`,
    // Every fixture part carries an act; PartInput merely types it optional.
    act: p.act!,
    checkpoint_refs: [...p.checkpoint_refs],
    interpretation: `Part ${p.id} did its work.`,
    citations: [STORY_CITATION],
  })),
  questions: ['Does the reconstructed arc match intent?'],
});

const miniProjection = (
  refs: string[],
  ledger: ProjectionLedgerEntry[] = []
): AccountProjection => ({
  schema_version: DOSSIER_SCHEMA_VERSION,
  branch: 'model-branch',
  floor_input_hash: 'f'.repeat(16),
  // Production always aliases every served artifact; the fixture's ids are
  // already alias-form, so identity entries mirror the real shape.
  artifactAliases: Object.fromEntries(
    ['a1', ...refs.map((r) => r.split(':cp')[0]!)].map((a) => [a, a])
  ),
  accountCore: {
    checkpoints: refs.map((r) => {
      const [artifact, cpStr] = r.split(':cp');
      return {
        artifact: artifact!,
        cp: Number(cpStr),
        status: 'closed' as const,
        label: null,
        summary: null,
        decisions: [],
        uncertainty: [],
      };
    }),
    planSteps: [{ citationId: STORY_CITATION, text: 'Carry the causal change.' }],
    nonGoals: [],
    planDecisions: [],
    acceptanceCriteria: [],
    criterionEvidence: [],
    verification: [],
    evaluatorRuns: [],
    ledger,
  },
  implicatedHunks: [],
  riskRemainder: [],
  fileInventory: [],
  inventoryMode: 'full',
  manifestSummary: { counts: {}, topOmittedHunks: [] },
});

const miniDossier = (): DossierV1 =>
  ({
    schema_version: 1,
    branch: 'model-branch',
    floor_input_hash: 'f'.repeat(16),
    file_index: [
      {
        path: 'src/alpha.ts',
        oldPath: null,
        newPath: 'src/alpha.ts',
        changeType: 'added',
        hunkCount: 1,
        capture: false,
        generated: false,
        topSignal: null,
      },
    ],
  }) as unknown as DossierV1;

const allRefs = (): string[] => scenario.topology.parts.flatMap((p) => p.checkpoint_refs);

const derivedComposed = (
  extraParts: { id: string; act?: string; checkpoint_refs: string[] }[] = []
) => {
  const account = storyFromParts([...scenario.topology.parts, ...extraParts]);
  const refs = [...allRefs(), ...extraParts.flatMap((p) => p.checkpoint_refs)];
  const projection = miniProjection(refs);
  return {
    projection,
    composed: composeStory({
      account,
      forensic: { findings: [], questions: [] } as ForensicPayload,
      projection,
      dossier: miniDossier(),
      coverage,
    }),
  };
};

const projectDerived = (
  extraParts: { id: string; act?: string; checkpoint_refs: string[] }[] = []
) => {
  const derived = derivedComposed(extraParts);
  return projectStoryReviewModel(derived.composed, derived.projection);
};

describe('storyReviewModel — schema pin + projection', () => {
  it('projects a schema-valid, versioned model that round-trips against diff.patch', () => {
    const model = projectDerived();
    // Schema-pinned.
    expect(model.schema_version).toBe(STORY_REVIEW_MODEL_SCHEMA_VERSION);
    expect(() => storyReviewModelSchema.parse(model)).not.toThrow();
    expect(model.label).toBe('DERIVED');
    expect(model.overview).toEqual({
      text: 'The branch carries one causal change from intent through validation.',
      citations: [STORY_CITATION],
    });

    // Every Part's ranges resolve against the run's diff.patch.
    const resolution = resolvePartRangesAgainstDiff(model, diffText);
    expect(resolution.errors).toEqual([]);
    expect(resolution.ok).toBe(true);
  });

  it('metrics totals equal the changed-row count (bucket reconciliation surfaced)', () => {
    const m = projectDerived().metrics;
    expect(m.attributedRows + m.ambiguousRows + m.contestedRows + m.unattributedRows).toBe(
      m.reviewableRows
    );
    expect(m.reviewableRows).toBe(coverage.summary.reviewable_rows);
    expect(m.reviewableRows).toBe(18);
  });

  it('a corrupted range is detected by the round-trip (fails closed)', () => {
    const model = projectDerived();
    const part = model.parts.find((p) => p.segments.length > 0)!;
    const seg = part.segments[0]!;
    const broken = {
      ...model,
      parts: model.parts.map((p) =>
        p.id === part.id
          ? {
              ...p,
              segments: [{ ...seg, add_range: { start: 9000, end: 9000 } }, ...p.segments.slice(1)],
            }
          : p
      ),
    };
    const resolution = resolvePartRangesAgainstDiff(broken, diffText);
    expect(resolution.ok).toBe(false);
    expect(resolution.errors.join('\n')).toContain('9000');
  });

  it('carries complete item obligations and rejects retired installed models', () => {
    const projection = miniProjection([]);
    const composed = composeStory({
      account: null,
      forensic: {
        findings: [
          {
            claim: 'The primary change relies on a second changed module.',
            file: 'src/alpha.ts',
            related_files: ['src/beta.ts'],
            severity: 'CAUTION',
            confidence: 'HIGH',
          },
        ],
        questions: [],
      },
      projection,
      dossier: miniDossier(),
      coverage: null,
    });
    const model = projectStoryReviewModel(composed, projection);
    expect(model.findings[0]!.relatedFiles).toEqual(['src/beta.ts']);
    expect(model.findings[0]!.required).toBe(true);
    expect(model.findings[0]!.citationsByLane).toEqual({ account: [], forensic: [] });

    const legacy = JSON.parse(JSON.stringify(model)) as Record<string, unknown> & {
      schema_version: number;
    };
    for (const version of [2, 3]) {
      legacy.schema_version = version;
      expect(() => parseStoryReviewModel(legacy)).toThrow();
    }
  });

  it('rejects unknown fields at nested v4 boundaries', () => {
    const model = projectDerived();
    expect(() =>
      parseStoryReviewModel({
        ...model,
        metrics: { ...model.metrics, future_metric: 1 },
      })
    ).toThrow();
    expect(() =>
      parseStoryReviewModel({
        ...model,
        parts: model.parts.map((part, index) =>
          index === 0 ? { ...part, future_part_field: true } : part
        ),
      })
    ).toThrow();
  });

  it('requires the shared 8-word/120-codepoint title contract in v4', () => {
    const model = projectDerived();
    expect(model.parts[0]!.title).toBe('Part P1');
    for (const title of ['one two three four five six seven eight nine', '🌊'.repeat(121)]) {
      expect(() =>
        storyReviewModelSchema.parse({
          ...model,
          parts: model.parts.map((part, index) => (index === 0 ? { ...part, title } : part)),
        })
      ).toThrow();
    }
  });
});

describe('storyReviewModel — self-sufficient v4 catalog and obligations', () => {
  const ids = {
    planStep: 'cite:a1:plan_step:0',
    acceptance: 'cite:a1:acceptance:0',
    evidence: 'cite:a1:cp1:criterion_evidence:0',
    evaluator: 'cite:a1:evaluator_run:0',
    planDecision: 'cite:a1:plan_decision:0',
    planAlternative: 'cite:a1:plan_alternative:0',
    decision: 'cite:a1:cp1:decision:0',
    alternative: 'cite:a1:cp1:alternative:0',
    uncertainty: 'cite:a1:cp1:uncertainty:0',
    verification: 'cite:a1:cp1:verification:0',
  } as const;
  const ledgerId = 'ldg:COVERAGE_GAP:catalog-test';

  const richProjection = (): AccountProjection => ({
    ...miniProjection(['a1:cp1']),
    artifactAliases: { a2: 'artifact-2', a1: 'artifact-1' },
    accountCore: {
      checkpoints: [
        {
          artifact: 'a1',
          cp: 1,
          status: 'closed',
          label: 'catalog',
          summary: 'Catalogued the review.',
          decisions: [
            {
              citationId: ids.decision,
              cp: 1,
              text: 'Keep one canonical catalog.',
              alternatives: [{ citationId: ids.alternative, text: 'Read the dossier in Watch.' }],
            },
          ],
          uncertainty: [{ citationId: ids.uncertainty, text: 'An anchor may be absent.' }],
        },
      ],
      planSteps: [{ citationId: ids.planStep, text: 'Install the Story catalog.' }],
      nonGoals: [],
      planDecisions: [
        {
          citationId: ids.planDecision,
          cp: null,
          text: 'Keep semantic anchors opt-in.',
          alternatives: [
            { citationId: ids.planAlternative, text: 'Generate anchors on every review.' },
          ],
        },
      ],
      acceptanceCriteria: [
        {
          citationId: ids.acceptance,
          text: 'Every referenced identity resolves.',
          parent: ids.planStep,
        },
      ],
      criterionEvidence: [
        {
          citationId: ids.evidence,
          text: 'The catalog round-trips.',
          parent: ids.acceptance,
        },
      ],
      verification: [{ citationId: ids.verification, text: 'pnpm test exited 0.' }],
      evaluatorRuns: [
        {
          citationId: ids.evaluator,
          text: 'contract — pass',
          evaluator: {
            evaluator_ref: 'contract',
            severity: 'block',
            run_status: 'completed',
            verdict: 'pass',
            disposition: null,
            summary: 'The contract passed.',
          },
        },
      ],
      ledger: [
        {
          id: ledgerId,
          kind: 'COVERAGE_GAP',
          status: 'CANDIDATE',
          message: 'Inspect the uncovered path.',
          citations: [ids.decision],
          anchors: [],
          citedFallback: {},
        } as ProjectionLedgerEntry,
      ],
    },
  });

  const richComposition = () => {
    const projection = richProjection();
    const account: AccountPayload = {
      overview: {
        text: 'The branch installs a complete, canonical Story review contract.',
        citations: [ids.evidence],
      },
      acts: [{ id: 'A1', title: 'Install the contract' }],
      parts: [
        {
          id: 'P1',
          title: 'Catalog review context',
          act: 'A1',
          checkpoint_refs: ['a1:cp1'],
          interpretation: 'The Story becomes self-sufficient.',
          citations: [ledgerId, ids.evidence],
        },
      ],
      questions: [{ text: 'Did the evaluator remain structured?', citations: [ids.evaluator] }],
    };
    const composed = composeStory({
      account,
      forensic: null,
      projection,
      dossier: miniDossier(),
      coverage: null,
    });
    return { projection, composed };
  };

  it('installs full citation kinds, parent closure, evaluator truth, and question provenance', () => {
    const { projection, composed } = richComposition();
    const model = projectStoryReviewModel(composed, projection);
    expect(model.questions[0]).toMatchObject({
      file: null,
      required: true,
      citationsByLane: { account: [ids.evaluator], forensic: [] },
    });
    expect(model.citations[ids.evidence]).toMatchObject({
      kind: 'CRITERION_EVIDENCE',
      cp: 1,
      parent: ids.acceptance,
    });
    expect(model.citations[ids.acceptance]?.parent).toBe(ids.planStep);
    expect(model.citations[ids.evaluator]?.evaluator).toMatchObject({
      evaluator_ref: 'contract',
      verdict: 'pass',
    });
    for (const eligible of [
      ids.planDecision,
      ids.planAlternative,
      ids.decision,
      ids.alternative,
      ids.uncertainty,
    ])
      expect(model.citations[eligible], eligible).toBeDefined();
    expect(Object.values(model.citations).every((citation) => 'cp' in citation)).toBe(true);
    expect(model.ledger.map((entry) => entry.id)).toContain(ledgerId);
    expect(() => storyReviewModelSchema.parse(model)).not.toThrow();
  });

  it('canonicalizes map insertion order for bytes and lifecycle generation', async () => {
    const { projection, composed } = richComposition();
    const model = projectStoryReviewModel(composed, projection);
    const shuffled = {
      ...model,
      citations: Object.fromEntries(Object.entries(model.citations).reverse()),
      artifactAliases: Object.fromEntries(Object.entries(model.artifactAliases).reverse()),
    };
    expect(serializeStoryReviewModel(shuffled)).toBe(serializeStoryReviewModel(model));
    expect(await storyReviewGeneration(shuffled)).toBe(await storyReviewGeneration(model));
  });

  it('fails closed on conflicting citation identities and orphan must-decide items', () => {
    const conflicted = richComposition();
    conflicted.projection.accountCore.checkpoints[0]!.decisions.push({
      citationId: 'cite:a1:cp1:decision:1',
      cp: 1,
      text: 'A second decision.',
      alternatives: [{ citationId: ids.alternative, text: 'A different identity collision.' }],
    });
    expect(() => projectStoryReviewModel(conflicted.composed, conflicted.projection)).toThrowError(
      /conflicting citation/
    );

    const orphaned = richComposition();
    orphaned.composed.merge.mustDecide.push({
      ...orphaned.composed.merge.mustDecide[0]!,
      id: 'missing-item',
    });
    expect(() => projectStoryReviewModel(orphaned.composed, orphaned.projection)).toThrowError(
      /must-decide item missing-item/
    );
  });
});

describe('storyReviewModel — context-only Part is legal', () => {
  it('a Part whose checkpoints own no surviving code validates and is contextOnly', () => {
    // P4 groups a checkpoint that owns nothing in the coverage — zero segments.
    const model = projectDerived([{ id: 'P4', act: 'ActII', checkpoint_refs: ['a9:cp9'] }]);
    expect(() => storyReviewModelSchema.parse(model)).not.toThrow();
    const p4 = model.parts.find((p) => p.id === 'P4')!;
    expect(p4.segments).toEqual([]);
    expect(p4.contextOnly).toBe(true);
    expect(p4.checkpointRefs).toEqual(['a9:cp9']);
    // It still round-trips (nothing to resolve) and still renders under its Act.
    expect(resolvePartRangesAgainstDiff(model, diffText).ok).toBe(true);
    expect(model.acts.find((a) => a.id === 'ActII')!.partIds).toContain('P4');
  });
});

describe('storyReviewModel — residues are explicit, never silently absent', () => {
  it('contested and unattributed both appear as first-class residue sections', () => {
    const model = projectDerived();
    // Cross-Part contested (P1 vs P2).
    expect(model.residue.contested).toHaveLength(1);
    expect(model.residue.contested[0]!.partIds).toEqual(['P1', 'P2']);
    // Genuinely unattributed gap + unowned rows.
    expect(model.residue.unattributed.length).toBeGreaterThan(0);
    expect(model.residue.reviewableRows).toBe(4);
    expect(model.residue.files.length).toBeGreaterThan(0);
  });
});

describe('storyReviewModel — degraded attribution renders coherently', () => {
  it('DEGRADED_ATTRIBUTION: story retained, all Parts context-only, code in residue', () => {
    const account = storyFromParts(scenario.topology.parts);
    const projection = miniProjection(allRefs());
    const composed = composeStory({
      account,
      forensic: null,
      projection,
      dossier: miniDossier(),
      coverage: null, // capture present, attribution unusable
    });
    const model = projectStoryReviewModel(composed, projection);
    expect(() => storyReviewModelSchema.parse(model)).not.toThrow();
    expect(model.label).toBe('DEGRADED_ATTRIBUTION');
    // The Story is RETAINED — every authored Part still renders...
    expect(model.parts.length).toBe(scenario.topology.parts.length);
    // ...but owns no code: ALL of it is in the unattributed residue.
    expect(model.parts.every((p) => p.contextOnly && p.segments.length === 0)).toBe(true);
    expect(model.residue.files.length).toBeGreaterThan(0);
  });

  it('CODE_ONLY: no story → no Parts/Acts, findings + residue still present', () => {
    const projection = miniProjection([]);
    const composed = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection,
      dossier: miniDossier(),
      coverage,
    });
    const model = projectStoryReviewModel(composed, projection);
    expect(model.label).toBe('CODE_ONLY');
    expect(model.parts).toEqual([]);
    expect(model.acts).toEqual([]);
    expect(model.residue.reviewableRows).toBe(18);
    expect(() => storyReviewModelSchema.parse(model)).not.toThrow();
  });
});

describe('review.md — concise standalone rendering', () => {
  const renderReviewMd = () => {
    const account = storyFromParts(scenario.topology.parts);
    const projection = miniProjection(allRefs());
    const dossier = miniDossier();
    const forensic: ForensicPayload = {
      findings: [
        {
          claim: 'a risk',
          file: 'src/alpha.ts',
          related_files: ['src/beta.ts'],
          severity: 'CAUTION',
          confidence: 'HIGH',
        },
      ],
      questions: [],
    };
    const composed = composeStory({ account, forensic, projection, dossier, coverage });
    return {
      md: renderSlice({
        dossier,
        projection,
        merge: composed.merge,
        composed,
        accountPresent: true,
        forensicPresent: true,
      }).markdown,
      composed,
      model: projectStoryReviewModel(composed, projection),
    };
  };

  it('renders each Part theory exactly once (causal story leads; ownership references only)', () => {
    const { md } = renderReviewMd();
    for (const partId of scenario.topology.parts.map((p) => p.id)) {
      const needle = `Part ${partId} did its work.`;
      const count = md.split(needle).length - 1;
      expect(count, `theory for ${partId} should appear exactly once`).toBe(1);
    }
  });

  it('renders the complete overview exactly once before the causal Story', () => {
    const { md } = renderReviewMd();
    const overview = 'The branch carries one causal change from intent through validation.';
    expect(md.split(overview)).toHaveLength(2);
    expect(md.indexOf('## Overview')).toBeLessThan(md.indexOf('## Causal story'));
    expect(md.indexOf(overview)).toBeLessThan(md.indexOf('## Causal story'));
  });

  it('carries file references and points at the model for ranges, never diff bodies', () => {
    const { md, model } = renderReviewMd();
    // review.md names the FILES a Part owns and points at the story model for
    // the ranges. Enumerating every segment range inline bloats a file no one
    // can read by hand, and every range is already in the model, richer.
    expect(md).toContain('src/alpha.ts');
    expect(md).toContain('full segment ranges in `story-review-model-v4.json`');
    expect(md).not.toMatch(/\+L\d/);
    // The ranges are not lost — the model still carries them.
    expect(JSON.stringify(model)).toContain('"add_range"');
    // ...and no line of the actual diff body (the synthetic adds like `a_add1`).
    for (const token of ['a_add1', 'g_add3', 'b_add2', 'h_gap1']) {
      expect(md.includes(token), `review.md must not carry diff body ${token}`).toBe(false);
    }
    // No unified-diff structure leaks in (hunk headers / raw diff lines).
    expect(md.includes('@@ ')).toBe(false);
    expect(md.split('\n').some((line) => line.startsWith('diff --git'))).toBe(false);
  });

  it('the metrics totals equal the changed-row count', () => {
    const { md, composed } = renderReviewMd();
    const m = composed.ownership.metrics;
    expect(m.attributedRows + m.ambiguousRows + m.contestedRows + m.unattributedRows).toBe(
      m.reviewableRows
    );
    expect(md).toContain(`${m.reviewableRows} reviewable row(s)`);
  });
});

describe('storyReviewModel — atomic install (validated write, no partial states)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'story-model-'));
  });

  it('installs a validated model that reads back through the schema', async () => {
    const model = projectDerived();
    await installStoryReviewModel({ runDir: dir, model, diffText });
    const raw = JSON.parse(await readFile(path.join(dir, STORY_REVIEW_MODEL_FILE), 'utf8'));
    const back = parseStoryReviewModel(raw);
    expect(back.schema_version).toBe(STORY_REVIEW_MODEL_SCHEMA_VERSION);
    expect(back.parts.map((p) => p.id)).toEqual(model.parts.map((p) => p.id));
    expect(back.overview).toEqual(model.overview);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to install a model whose ranges do not resolve against diff.patch', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'story-model-bad-'));
    const model = projectDerived();
    const part = model.parts.find((p) => p.segments.length > 0)!;
    const broken = {
      ...model,
      parts: model.parts.map((p) =>
        p.id === part.id
          ? {
              ...p,
              segments: p.segments.map((s, i) =>
                i === 0 ? { ...s, add_range: { start: 9000, end: 9000 } } : s
              ),
            }
          : p
      ),
    };
    await expect(
      installStoryReviewModel({ runDir: tmp, model: broken, diffText })
    ).rejects.toBeInstanceOf(StoryReviewModelInvariantError);
    await rm(tmp, { recursive: true, force: true });
  });
});
