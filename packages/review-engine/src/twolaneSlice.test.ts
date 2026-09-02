import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  attribute,
  type AttributionResult,
  buildChain,
  type CheckpointDescriptor,
  type LineOwner,
  type OverlapSegment,
} from '@orcaops/review-core';

import { DOSSIER_SCHEMA_VERSION } from './dossier.js';
import type { AccountProjection, DossierV1, PolicyStub, ProjectionLedgerEntry } from './dossier.js';
import { PartOwnershipInvariantError, type PartTopology } from './storyOwnership.js';
import {
  type AccountPayload,
  type AuthoredAccountPayload,
  buildAccountPromptAliases,
  composeStory,
  type ForensicPayload,
  freshSliceRunState,
  mergeLanes,
  partitionAccountEvaluatorRuns,
  renderSlice,
  sliceContext,
  type SliceValidationContext,
  storyTopology,
  submitLane,
  validateLanePayload,
} from './twolaneSlice.js';

const FIX = path.join(__dirname, '..', 'fixtures', 'dossier-gate', 'slice');
const loadGz = <T>(name: string): T =>
  JSON.parse(gunzipSync(readFileSync(path.join(FIX, name))).toString('utf8')) as T;

const ctxOf = (subject: string, lane: 'account' | 'forensic') => {
  const dossier = loadGz<DossierV1>(`${subject}-dossier-v1.json.gz`);
  const projection = loadGz<AccountProjection>(`${subject}-account-projection-v1.json.gz`);
  return { dossier, projection, ctx: sliceContext(dossier, projection, lane) };
};

const capturedSubject = () => {
  const dossier = loadGz<DossierV1>('demo-library-dossier-v1.json.gz');
  const projection = loadGz<AccountProjection>('demo-library-account-projection-v1.json.gz');
  const file = dossier.file_index.find((f) => !f.capture)!.path;
  const citation = projection.accountCore.checkpoints.flatMap((cp) =>
    cp.decisions.map((d) => d.citationId)
  )[0]!;
  return { dossier, projection, file, citation };
};

/** A valid full Story over a projection: every completed checkpoint in one Part. */
const fullStory = (projection: AccountProjection): AccountPayload => {
  const c = projection.accountCore;
  const cite = (cp: (typeof c.checkpoints)[number]): string =>
    cp.decisions[0]?.citationId ??
    cp.uncertainty[0]?.citationId ??
    c.planSteps[0]?.citationId ??
    c.ledger[0]!.id;
  return {
    overview: {
      text: 'The branch advances one coherent change from intent through validation.',
      citations: [cite(c.checkpoints[0]!)],
    },
    acts: [{ id: 'ACT1', title: 'The change', interpretation: 'One causal arc.' }],
    parts: c.checkpoints.map((cp, i) => ({
      id: `P${i + 1}`,
      title: `Part ${i + 1}`,
      act: 'ACT1',
      checkpoint_refs: [`${cp.artifact}:cp${cp.cp}`],
      interpretation: `Part ${i + 1} advances the change.`,
      citations: [cite(cp)],
    })),
    questions: [],
  };
};

/** The alias-only nested shape accepted at the account submission boundary. */
const authoredFullStory = (projection: AccountProjection): AuthoredAccountPayload => {
  const c = projection.accountCore;
  const aliases = buildAccountPromptAliases(projection);
  const checkpointAlias = new Map(
    aliases.checkpoints.map((entry) => [entry.canonical, entry.alias])
  );
  const citationAlias = new Map(aliases.citations.map((entry) => [entry.canonical, entry.alias]));
  const cite = (cp: (typeof c.checkpoints)[number]): string =>
    cp.decisions[0]?.citationId ??
    cp.uncertainty[0]?.citationId ??
    c.planSteps[0]?.citationId ??
    c.ledger[0]!.id;
  return {
    schema_version: 1,
    overview: {
      text: 'The branch advances one coherent change from intent through validation.',
      citations: [citationAlias.get(cite(c.checkpoints[0]!))!],
    },
    acts: [
      {
        title: 'The change',
        interpretation: 'One causal arc.',
        parts: c.checkpoints.map((cp, i) => ({
          title: `Part ${i + 1}`,
          checkpoints: [checkpointAlias.get(`${cp.artifact}:cp${cp.cp}`)!],
          interpretation: `Part ${i + 1} advances the change.`,
          citations: [citationAlias.get(cite(cp))!],
        })),
      },
    ],
    questions: [],
  };
};

describe('slice v3 — story submission contract', () => {
  it('accepts a well-formed full story that covers every checkpoint', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const r = validateLanePayload('account', authoredFullStory(projection), ctx, { routine: true });
    expect(r.diagnostics).toEqual([]);
    expect(r.payload).not.toBeNull();
    const compiled = r.payload as AccountPayload;
    expect(compiled.acts.map((act) => act.id)).toEqual(['A1']);
    expect(compiled.parts.map((part) => part.id)).toEqual(
      compiled.parts.map((_, index) => `P${index + 1}`)
    );
    expect(compiled.parts.every((part) => part.act === 'A1')).toBe(true);
    expect(compiled.overview).toEqual({
      text: 'The branch advances one coherent change from intent through validation.',
      citations: [compiled.parts[0]!.citations[0]],
    });
  });

  it('rejects missing, unknown, overlong, and known bracketed-alias overview input', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');

    const missing = authoredFullStory(projection) as unknown as Record<string, unknown>;
    delete missing.overview;
    expect(validateLanePayload('account', missing, ctx, { routine: true }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );

    const unknown = authoredFullStory(projection);
    unknown.overview.citations = ['c999999'];
    expect(validateLanePayload('account', unknown, ctx, { routine: true }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_UNKNOWN_CITATION' })])
    );

    const tooLong = authoredFullStory(projection);
    tooLong.overview.text = Array.from({ length: 151 }, () => 'word').join(' ');
    expect(validateLanePayload('account', tooLong, ctx, { routine: true }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );

    const leakedAlias = authoredFullStory(projection);
    leakedAlias.overview.text = `The branch completes the change [${leakedAlias.overview.citations[0]}].`;
    expect(validateLanePayload('account', leakedAlias, ctx, { routine: true }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_OVERVIEW_ALIAS_LEAK' })])
    );

    const ordinaryIdentifier = authoredFullStory(projection);
    ordinaryIdentifier.overview.text = 'The compiler keeps the ordinary c2 identifier intact.';
    expect(
      validateLanePayload('account', ordinaryIdentifier, ctx, { routine: true }).diagnostics
    ).toEqual([]);
  });

  it('rejects bracketed citations and the removed question key', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const story = authoredFullStory(projection);
    const known = story.acts[0]!.parts[0]!.citations[0]!;
    story.acts[0]!.parts[0]!.citations = [`[${known}]`];
    story.questions = [{ question: 'What remains?', citations: [`[${known}]`] } as never];

    const result = validateLanePayload('account', story, ctx, { routine: true });
    expect(result.payload).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );
  });

  it('bounds durable Act and Part titles by words and Unicode code points', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const tooManyWords = authoredFullStory(projection);
    tooManyWords.acts[0]!.parts[0]!.title = 'one two three four five six seven eight nine';
    expect(
      validateLanePayload('account', tooManyWords, ctx, { routine: true }).diagnostics[0]?.code
    ).toBe('SLICE_PAYLOAD_SHAPE');

    const tooManyCodePoints = authoredFullStory(projection);
    tooManyCodePoints.acts[0]!.title = '🌊'.repeat(121);
    expect(
      validateLanePayload('account', tooManyCodePoints, ctx, { routine: true }).diagnostics[0]?.code
    ).toBe('SLICE_PAYLOAD_SHAPE');
  });

  it('rejects code-assignment keys (memberTargetKeys / placements / file) on a Part', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const story = authoredFullStory(projection);
    const parts = story.acts[0]!.parts;
    for (const bad of [
      {
        ...story,
        acts: [
          {
            ...story.acts[0]!,
            parts: parts.map((p, i) => (i === 0 ? { ...p, memberTargetKeys: ['x'] } : p)),
          },
        ],
      },
      {
        ...story,
        acts: [
          {
            ...story.acts[0]!,
            parts: parts.map((p, i) => (i === 0 ? { ...p, file: 'src/x.ts' } : p)),
          },
        ],
      },
      { ...story, placements: [] },
    ]) {
      const r = validateLanePayload('account', bad, ctx);
      expect(r.payload).toBeNull();
      expect(r.diagnostics[0]!.code).toBe('SLICE_PAYLOAD_SHAPE');
    }
  });

  it('pins nested routine Story authoring to schema version 1', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const story = authoredFullStory(projection);
    const { schema_version: _removed, ...missingVersion } = story;
    expect(validateLanePayload('account', missingVersion, ctx).payload).toBeNull();
    expect(validateLanePayload('account', { ...story, schema_version: 2 }, ctx).payload).toBeNull();
  });

  it('requires each Part to carry a non-empty checkpoint_refs and citations', () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    const story = authoredFullStory(projection);
    const noCite = {
      ...story,
      acts: story.acts.map((act) => ({
        ...act,
        parts: act.parts.map((part) => ({ ...part, citations: [] })),
      })),
    };
    expect(validateLanePayload('account', noCite, ctx).payload).toBeNull();
    const noRefs = {
      ...story,
      acts: story.acts.map((act) => ({
        ...act,
        parts: act.parts.map((part) => ({ ...part, checkpoints: [] })),
      })),
    };
    expect(validateLanePayload('account', noRefs, ctx).payload).toBeNull();
  });

  it('the forensic contract is unchanged: structural story keys are rejected', () => {
    const { ctx } = ctxOf('demo-library', 'forensic');
    const r = validateLanePayload('forensic', { findings: [], questions: [], acts: [] }, ctx);
    expect(r.payload).toBeNull();
    expect(r.diagnostics[0]!.code).toBe('SLICE_PAYLOAD_SHAPE');
  });
});

describe('account evaluator visibility and alias contract', () => {
  const mixedProjection = (): AccountProjection => {
    const projection = structuredClone(capturedSubject().projection);
    const artifact = projection.accountCore.checkpoints[0]!.artifact;
    const row = (
      index: number,
      evaluator: AccountProjection['accountCore']['evaluatorRuns'][number]['evaluator']
    ): AccountProjection['accountCore']['evaluatorRuns'][number] => ({
      citationId: `cite:${artifact}:evaluator_run:${index}`,
      text: `evaluator-${index} — captured text ${index}`,
      evaluator,
    });
    const metadata = (
      evaluator_ref: string,
      severity: 'info' | 'warn' | 'block',
      run_status: 'completed' | 'error' | 'skipped',
      verdict: 'pass' | 'violation' | 'info' | null,
      disposition: 'unresolved' | 'acknowledged' | 'dismissed' | 'policy-excepted' | null = null
    ) => ({ evaluator_ref, severity, run_status, verdict, disposition, summary: evaluator_ref });
    projection.accountCore.evaluatorRuns = [
      row(0, metadata('routine-pass', 'warn', 'completed', 'pass')),
      row(1, metadata('routine-info', 'info', 'completed', 'info')),
      row(2, metadata('benign-skip', 'warn', 'skipped', null)),
      row(3, metadata('same-name', 'block', 'completed', 'violation', 'unresolved')),
      row(4, metadata('errored-run', 'warn', 'error', null)),
      row(5, metadata('missed-block-gate', 'block', 'skipped', null)),
      row(6, metadata('excepted-pass', 'block', 'completed', 'pass', 'policy-excepted')),
      row(7, metadata('same-name', 'block', 'completed', 'violation', 'dismissed')),
      row(8, metadata('same-name', 'block', 'completed', 'pass')),
      row(9, metadata('disposed-pass', 'warn', 'completed', 'pass', 'acknowledged')),
    ];
    return projection;
  };

  it('partitions every raw row exactly once without collapsing exceptions by evaluator name', () => {
    const runs = mixedProjection().accountCore.evaluatorRuns;
    const partition = partitionAccountEvaluatorRuns(runs);
    expect(partition.summarized.map((run) => run.citationId)).toEqual(
      [0, 1, 2, 8].map((index) => expect.stringContaining(`:evaluator_run:${index}`))
    );
    expect(partition.expanded.map((run) => run.citationId)).toEqual(
      [3, 4, 5, 6, 7, 9].map((index) => expect.stringContaining(`:evaluator_run:${index}`))
    );
    const all = [...partition.summarized, ...partition.expanded].map((run) => run.citationId);
    expect(all).toHaveLength(runs.length);
    expect(new Set(all).size).toBe(runs.length);
    expect(
      partition.expanded.filter((run) => run.evaluator.evaluator_ref === 'same-name')
    ).toHaveLength(2);
  });

  it('withholds summarized aliases without renumbering visible aliases and rejects a hidden one', () => {
    const { dossier } = capturedSubject();
    const projection = mixedProjection();
    // Alias baseline: the same rows with none of them summarized (an
    // unresolved disposition always expands), so the aliases below are exactly
    // what withholding must not renumber.
    const allVisibleProjection = structuredClone(projection);
    allVisibleProjection.accountCore.evaluatorRuns =
      allVisibleProjection.accountCore.evaluatorRuns.map((run) => ({
        ...run,
        evaluator: { ...run.evaluator, disposition: 'unresolved' as const },
      }));
    const allVisibleAliases = new Map(
      buildAccountPromptAliases(allVisibleProjection).citations.map((entry) => [
        entry.canonical,
        entry.alias,
      ])
    );
    const aliases = buildAccountPromptAliases(projection).citations;
    const byCanonical = new Map(aliases.map((entry) => [entry.canonical, entry.alias]));
    const hidden = projection.accountCore.evaluatorRuns[0]!.citationId;
    const expanded = projection.accountCore.evaluatorRuns[3]!.citationId;
    expect(byCanonical.has(hidden)).toBe(false);
    expect(byCanonical.get(expanded)).toBe(allVisibleAliases.get(expanded));

    const hiddenAlias = allVisibleAliases.get(hidden)!;
    expect(aliases.some((entry) => entry.alias === hiddenAlias)).toBe(false);
    const story = authoredFullStory(projection);
    story.overview.citations = [hiddenAlias];
    const result = validateLanePayload(
      'account',
      story,
      sliceContext(dossier, projection, 'account'),
      {
        routine: true,
      }
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_UNKNOWN_CITATION' })])
    );
  });
});

describe('forensic related_files contract', () => {
  const ctx: SliceValidationContext = {
    diffFiles: new Set(['src/primary.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
    completedCheckpointRefs: new Set(),
    checkpointAliases: new Map(),
    citationAliases: new Map(),
  };
  const payload = (related_files?: string[]) => ({
    findings: [
      {
        claim: 'The caller and callee disagree about the persisted shape.',
        file: 'src/primary.ts',
        ...(related_files !== undefined ? { related_files } : {}),
        severity: 'CAUTION',
        confidence: 'HIGH',
      },
    ],
    questions: [],
  });

  it('requires the current list and canonicalizes authored paths', () => {
    const omitted = validateLanePayload('forensic', payload(), ctx);
    expect(omitted.payload).toBeNull();
    expect(omitted.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );

    const authored = validateLanePayload('forensic', payload(['src/d.ts', 'src/a.ts']), ctx);
    expect((authored.payload as ForensicPayload).findings[0]!.related_files).toEqual([
      'src/a.ts',
      'src/d.ts',
    ]);
  });

  it('requires at most four unique paths, all distinct from the primary file', () => {
    for (const related of [
      ['src/a.ts', 'src/a.ts'],
      ['src/primary.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
    ]) {
      const result = validateLanePayload('forensic', payload(related), ctx);
      expect(result.payload, related.join(',')).toBeNull();
      expect(result.diagnostics.some((d) => d.code === 'SLICE_PAYLOAD_SHAPE')).toBe(true);
    }
  });

  it('rejects a related path outside the served changed-file universe', () => {
    const result = validateLanePayload('forensic', payload(['src/not-served.ts']), ctx);
    expect(result.payload).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SLICE_UNKNOWN_FILE',
        message: expect.stringContaining('findings[0].related_files[0]'),
      }),
    ]);
  });
});

describe('slice v3 — topology diagnostics (each a named repair signal)', () => {
  const setup = () => {
    const { projection } = capturedSubject();
    const { ctx } = ctxOf('demo-library', 'account');
    return { projection, ctx };
  };

  it('missing checkpoint → STORY_CHECKPOINT_UNCLAIMED naming the missing ref', () => {
    const { projection, ctx } = setup();
    const story = authoredFullStory(projection);
    const droppedAlias = story.acts[0]!.parts[0]!.checkpoints[0]!;
    const dropped = ctx.checkpointAliases.get(droppedAlias)!;
    const missingOne = {
      ...story,
      acts: [{ ...story.acts[0]!, parts: story.acts[0]!.parts.slice(1) }],
    };
    const r = validateLanePayload('account', missingOne, ctx);
    expect(r.payload).toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'STORY_CHECKPOINT_UNCLAIMED');
    expect(d).toBeDefined();
    expect(d!.message).toContain(dropped);
  });

  it('duplicated checkpoint across Parts → STORY_CHECKPOINT_DUPLICATED', () => {
    const { projection, ctx } = setup();
    const story = authoredFullStory(projection);
    const dupRef = story.acts[0]!.parts[0]!.checkpoints[0]!;
    const withDup: AuthoredAccountPayload = {
      ...story,
      acts: [
        {
          ...story.acts[0]!,
          parts: [
            ...story.acts[0]!.parts,
            {
              title: 'Duplicate',
              checkpoints: [dupRef],
              interpretation: 'a second claim on the same checkpoint',
              citations: story.acts[0]!.parts[0]!.citations,
            },
          ],
        },
      ],
    };
    const r = validateLanePayload('account', withDup, ctx);
    expect(r.payload).toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'STORY_CHECKPOINT_DUPLICATED');
    expect(d).toBeDefined();
    expect(d!.message).toContain(ctx.checkpointAliases.get(dupRef)!);
  });

  it('a ref that resolves to nothing → STORY_UNKNOWN_CHECKPOINT_REF', () => {
    const { projection, ctx } = setup();
    const story = authoredFullStory(projection);
    const bad = {
      ...story,
      acts: story.acts.map((act) => ({
        ...act,
        parts: act.parts.map((part, i) =>
          i === 0 ? { ...part, checkpoints: [...part.checkpoints, 'k999'] } : part
        ),
      })),
    };
    const r = validateLanePayload('account', bad, ctx);
    expect(r.diagnostics.some((x) => x.code === 'STORY_UNKNOWN_CHECKPOINT_REF')).toBe(true);
  });

  it('derives Part membership from nesting rather than accepting authored Act ids', () => {
    const { projection, ctx } = setup();
    const story = authoredFullStory(projection);
    const bad = {
      ...story,
      acts: story.acts.map((act) => ({
        ...act,
        parts: act.parts.map((part, i) => (i === 0 ? { ...part, act: 'NOPE' } : part)),
      })),
    };
    expect(validateLanePayload('account', bad, ctx).diagnostics[0]!.code).toBe(
      'SLICE_PAYLOAD_SHAPE'
    );
  });

  it('an unresolvable citation → SLICE_UNKNOWN_CITATION (rule unchanged)', () => {
    const { projection, ctx } = setup();
    const story = authoredFullStory(projection);
    const bad = {
      ...story,
      acts: story.acts.map((act) => ({
        ...act,
        parts: act.parts.map((part, i) => (i === 0 ? { ...part, citations: ['c999'] } : part)),
      })),
    };
    const r = validateLanePayload('account', bad, ctx);
    expect(r.diagnostics.some((x) => x.code === 'SLICE_UNKNOWN_CITATION')).toBe(true);
  });

  it('projects a valid story onto storyOwnership PartTopology (adopts PartInput)', () => {
    const { projection } = capturedSubject();
    const compiled = validateLanePayload(
      'account',
      authoredFullStory(projection),
      ctxOf('demo-library', 'account').ctx
    ).payload as AccountPayload;
    const topo = storyTopology(compiled);
    expect(topo.parts.length).toBe(projection.accountCore.checkpoints.length);
    expect(topo.parts.every((p) => p.checkpoint_refs.length >= 1)).toBe(true);
    // No interpretation/citations leak into the ownership input — membership only.
    expect(topo.parts.every((p) => !('interpretation' in p) && !('citations' in p))).toBe(true);
  });
});

describe('slice v3 — independent lane outcomes and repair credits', () => {
  const goodF: ForensicPayload = { findings: [], questions: [] };
  const badF = {
    findings: [{ claim: 'x', file: 'no/such.ts', severity: 'INFO', confidence: 'LOW' }],
    questions: [],
  };
  const goodA = () => authoredFullStory(ctxOf('demo-library', 'account').projection);
  // A story missing a checkpoint is rejected (STORY_CHECKPOINT_UNCLAIMED).
  const badA = () => {
    const story = goodA();
    return { ...story, acts: [{ ...story.acts[0]!, parts: story.acts[0]!.parts.slice(1) }] };
  };

  it('allows one independent repair in each lane after both initials fail', () => {
    const fCtx = ctxOf('demo-library', 'forensic').ctx;
    const aCtx = ctxOf('demo-library', 'account').ctx;
    let s = freshSliceRunState();
    s = submitLane(s, 'forensic', badF, fCtx).state;
    s = submitLane(s, 'account', badA(), aCtx).state;
    const fFix = submitLane(s, 'forensic', goodF, fCtx);
    expect(fFix.accepted).toBe(true);
    expect(fFix.state.lanes.forensic.outcome).toBe('ACCEPTED_REPAIRED');
    s = fFix.state;
    const aFix = submitLane(s, 'account', goodA(), aCtx);
    expect(aFix.accepted).toBe(true);
    expect(aFix.state.lanes.account.outcome).toBe('ACCEPTED_REPAIRED');
    const fAfter = submitLane(aFix.state, 'forensic', goodF, fCtx);
    expect(fAfter.accepted).toBe(false);
    expect(fAfter.diagnostics[0]!.code).toBe('SLICE_SUBMIT_AFTER_ACCEPT');
  });

  it('permits repair before the other lane submits and records terminal rejection', () => {
    const fCtx = ctxOf('demo-library', 'forensic').ctx;
    let s = freshSliceRunState();
    s = submitLane(s, 'forensic', badF, fCtx).state;
    const repaired = submitLane(s, 'forensic', goodF, fCtx);
    expect(repaired.accepted).toBe(true);
    expect(repaired.state.lanes.forensic.repairCredit).toBe(0);

    const terminal = submitLane(
      submitLane(freshSliceRunState(), 'forensic', badF, fCtx).state,
      'forensic',
      badF,
      fCtx
    );
    expect(terminal.state.lanes.forensic.outcome).toBe('TERMINAL_REJECTED');
  });
});

describe('slice v3 — merge and story render', () => {
  const { projection, citation } = capturedSubject();

  it('the merged item set is invariant to forensic finding array order (content-id merge)', () => {
    const { file } = capturedSubject();
    const story = fullStory(projection);
    const forensic: ForensicPayload = {
      findings: [
        { claim: 'one', file, related_files: [], severity: 'REVIEW', confidence: 'HIGH' },
        { claim: 'two', file, related_files: [], severity: 'REVIEW', confidence: 'HIGH' },
      ],
      questions: [],
    };
    const reversed: ForensicPayload = { findings: [...forensic.findings].reverse(), questions: [] };
    const a = mergeLanes({ account: story, forensic, projection });
    const b = mergeLanes({ account: story, forensic: reversed, projection });
    expect(JSON.stringify(a.items)).toBe(JSON.stringify(b.items));
  });

  it('propagates related files through merge, review.md, and brief.json', () => {
    const { dossier, file } = capturedSubject();
    const related = dossier.file_index
      .filter((entry) => !entry.capture)
      .flatMap((entry) => [entry.oldPath, entry.newPath])
      .find((path): path is string => path !== null && path !== file)!;
    expect(related).toBeDefined();
    const forensic: ForensicPayload = {
      findings: [
        {
          claim: 'The primary change relies on a second changed module.',
          file,
          related_files: [related],
          severity: 'CAUTION',
          confidence: 'HIGH',
        },
      ],
      questions: [],
    };
    const composed = composeStory({ account: null, forensic, projection, dossier, coverage: null });
    expect(composed.merge.items[0]!.relatedFiles).toEqual([related]);

    const { markdown, brief } = renderSlice({
      dossier,
      projection,
      merge: composed.merge,
      composed,
      accountPresent: false,
      forensicPresent: true,
    });
    expect(markdown).toContain(`related: \`${related}\``);
    expect(brief.mustDecide[0]!.relatedFiles).toEqual([related]);
  });

  it('a Part citation to a ledger row acknowledges it in the dispositions', () => {
    const ledgerRow = projection.accountCore.ledger[0]!.id;
    const story = fullStory(projection);
    story.parts[0]!.citations = [ledgerRow];
    const m = mergeLanes({ account: story, forensic: null, projection });
    expect(m.dispositions.find((d) => d.id === ledgerRow)!.disposition).toBe(
      'ACKNOWLEDGED_BY_ACCOUNT'
    );
  });

  it('renders every ledger row OUTSTANDING when no story is present', () => {
    const m = mergeLanes({ account: null, forensic: { findings: [], questions: [] }, projection });
    expect(m.dispositions.length).toBe(projection.accountCore.ledger.length);
    expect(m.dispositions.every((d) => d.disposition === 'OUTSTANDING')).toBe(true);
    expect(m.story).toBeNull();
  });

  it('leads with the causal story section, carrying Part interpretation and refs', () => {
    const { dossier } = capturedSubject();
    const story = fullStory(projection);
    story.questions = ['Does the reconstructed arc match intent?'];
    void citation;
    const forensic = { findings: [], questions: [] } satisfies ForensicPayload;
    const composed = composeStory({
      account: story,
      forensic,
      projection,
      dossier,
      coverage: null,
    });
    const { markdown, brief } = renderSlice({
      dossier,
      projection,
      merge: composed.merge,
      composed,
      accountPresent: true,
      forensicPresent: true,
    });
    expect(markdown.indexOf('## Causal story')).toBeLessThan(markdown.indexOf('## Must decide'));
    expect(markdown).toContain('Part 1 advances the change');
    expect(markdown).toContain(story.parts[0]!.checkpoint_refs[0]!);
    expect(brief.story).toEqual({
      acts: story.acts.length,
      parts: story.parts.length,
      questions: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// composeStory — ownership fold, ledger attachment, explicit-link
// reconciliation, and the two never-conflated degraded labels.
// ---------------------------------------------------------------------------

describe('renderSlice — review.stub_paths enumeration + residue marking', () => {
  const stub = (over: Partial<PolicyStub> & Pick<PolicyStub, 'path'>): PolicyStub => ({
    adds: 3,
    dels: 1,
    bytes: 4096,
    reason: 'review.stub_paths',
    ...over,
  });

  it('summarizes stubs in review.md with the per-file detail kept in brief.json', () => {
    // CODE_ONLY composition (no coverage) → the whole diff is residue; the
    // dossier file is src/x.ts, which we also stub.
    const composed = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection: miniProjection([]),
      dossier: miniDossier(),
      coverage: null,
    });
    const policyStubs = [stub({ path: 'src/x.ts', adds: 5, dels: 2, bytes: 9001 })];
    const { markdown, brief } = renderSlice({
      dossier: miniDossier(),
      projection: miniProjection([]),
      merge: composed.merge,
      composed,
      accountPresent: false,
      forensicPresent: true,
      policyStubs,
    });
    // review.md carries the TOTALS and points at brief.json. Enumerating the
    // per-file list here would duplicate brief.json — which carries the
    // same rows plus the `reason` field review.md never had.
    expect(markdown).toContain('_Policy-stubbed (review.stub_paths): 1 file(s), 7 row(s) / 9001');
    expect(markdown).toContain('Per-file counts and the reason for each in `brief.json`');
    expect(markdown).not.toContain('### Policy-stubbed');
    // The residue reports its stubbed count without naming every file.
    expect(markdown).toContain('1 of them policy-stubbed');
    // Nothing is lost: brief.json still enumerates the stubs with reason.
    expect(brief.policyStubs).toEqual([
      { path: 'src/x.ts', adds: 5, dels: 2, bytes: 9001, reason: 'review.stub_paths' },
    ]);
  });

  it('residue reports the two measurements SEPARATELY, claiming no causal split', () => {
    // The engine knows the unattributed row total, and it knows how many
    // checkpoints were dropped for a missing boundary snapshot. It does NOT
    // know how many of those rows each dropped checkpoint would have owned —
    // the snapshot that would have said is the thing that is missing.
    const dossier: DossierV1 = { ...miniDossier(), missing_boundary_checkpoints: 3 };
    const composed = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection: miniProjection([]),
      dossier,
      coverage: null,
    });
    expect(composed.ownership.missingBoundaryCheckpoints).toBe(3);
    const { markdown } = renderSlice({
      dossier,
      projection: miniProjection([]),
      merge: composed.merge,
      composed,
      accountPresent: false,
      forensicPresent: true,
    });
    expect(markdown).toContain('3 checkpoint(s) were excluded from attribution');
    expect(markdown).toContain('cannot determine how many of the unattributed rows above');
    // The two numbers never appear joined by a causal claim.
    expect(markdown).not.toMatch(/\d+ row\(s\) (?:lost|unattributed) (?:because|due to)/);
  });

  it('review.md stays hand-readable: a size ceiling with the counts intact', () => {
    // Unchecked, four enumerations that every structured output already carries
    // dominate review.md. It points at them instead, so the size is a property
    // worth pinning — a future section that starts enumerating again trips this.
    const stubs = Array.from({ length: 60 }, (_, i) =>
      stub({ path: `src/generated/file-${String(i)}.ts`, adds: 40, dels: 12, bytes: 5000 })
    );
    const composed = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection: miniProjection([]),
      dossier: miniDossier(),
      coverage: null,
    });
    const { markdown } = renderSlice({
      dossier: miniDossier(),
      projection: miniProjection([]),
      merge: composed.merge,
      composed,
      accountPresent: false,
      forensicPresent: true,
      policyStubs: stubs,
    });
    // 60 stubbed files would have been 60 lines; they are now one summary line.
    expect(markdown.length).toBeLessThan(4000);
    // ...and the counts survive: 60 files, 60*(40+12) rows, 60*5000 bytes.
    expect(markdown).toContain('60 file(s), 3120 row(s) / 300000 byte(s)');
    for (const p of stubs) expect(markdown).not.toContain(p.path);
  });

  it('no policy ⇒ no Policy-stubbed section and an empty brief list (residue unmarked)', () => {
    const composed = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection: miniProjection([]),
      dossier: miniDossier(),
      coverage: null,
    });
    const { markdown, brief } = renderSlice({
      dossier: miniDossier(),
      projection: miniProjection([]),
      merge: composed.merge,
      composed,
      accountPresent: false,
      forensicPresent: true,
    });
    expect(markdown).not.toContain('Policy-stubbed');
    expect(markdown).not.toContain('(policy-stubbed)');
    expect(brief.policyStubs).toEqual([]);
  });
});

const SCENARIO_URL = new URL('../fixtures/story-ownership/scenario.json', import.meta.url);

interface OwnershipScenario {
  base: string;
  worktree: string;
  checkpoints: CheckpointDescriptor[];
  overlapSegments: OverlapSegment[];
  diffLines: string[];
  lineOwners: LineOwner[];
  topology: PartTopology;
}

let ownScenario: OwnershipScenario;
let ownCoverage: AttributionResult['coverage'];

beforeAll(async () => {
  ownScenario = JSON.parse(await readFile(SCENARIO_URL, 'utf8')) as OwnershipScenario;
  const chain = buildChain({
    base: ownScenario.base,
    worktree: ownScenario.worktree,
    checkpoints: ownScenario.checkpoints,
  });
  const result = await attribute({
    chain,
    reviewDiff: new TextEncoder().encode(ownScenario.diffLines.join('\n')),
    reviewDiffTruncated: false,
    reviewMaxDiffBytes: 2_000_000,
    lineOwners: ownScenario.lineOwners,
    overlapSegments: ownScenario.overlapSegments,
  });
  ownCoverage = result.coverage;
});

const storyFromTopology = (topo: PartTopology): AccountPayload => ({
  overview: {
    text: 'The branch advances one coherent change through implementation and validation.',
    citations: ['whatever'],
  },
  acts: [{ id: 'A1', title: 'Fixture topology' }],
  parts: topo.parts.map((p) => ({
    id: p.id,
    title: `Part ${p.id}`,
    act: 'A1',
    checkpoint_refs: [...p.checkpoint_refs],
    interpretation: `Part ${p.id} did its work.`,
    citations: ['whatever'],
  })),
  questions: [],
});

const miniProjection = (
  refs: string[],
  ledger: ProjectionLedgerEntry[] = [],
  artifactAliases?: Record<string, string>
): AccountProjection => ({
  schema_version: DOSSIER_SCHEMA_VERSION,
  branch: 'compose-branch',
  floor_input_hash: 'f'.repeat(16),
  // Production always populates the alias table for every served artifact;
  // the fixture's artifact ids are already alias-form, so identity entries
  // mirror the real shape.
  artifactAliases:
    artifactAliases ?? Object.fromEntries(refs.map((r) => r.split(':cp')[0]!).map((a) => [a, a])),
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
    planSteps: [],
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
    branch: 'compose-branch',
    floor_input_hash: 'f'.repeat(16),
    file_index: [
      {
        path: 'src/x.ts',
        oldPath: null,
        newPath: 'src/x.ts',
        changeType: 'added',
        hunkCount: 1,
        capture: false,
        generated: false,
        topSignal: null,
      },
    ],
  }) as unknown as DossierV1;

const ledgerRow = (
  over: Partial<ProjectionLedgerEntry> & Pick<ProjectionLedgerEntry, 'id' | 'kind'>
): ProjectionLedgerEntry => ({
  status: 'CANDIDATE',
  message: 'm',
  citations: [],
  anchors: [],
  citedFallback: {},
  ...over,
});

describe('composeStory — ownership fold + fail-closed invariant', () => {
  const allRefs = () => ownScenario.topology.parts.flatMap((p) => p.checkpoint_refs);

  it('the exactly-once invariant fails closed through composeStory', () => {
    // Drop P2 from the authored story: a2:cp1 owns beta.ts but no Part groups it.
    const account = storyFromTopology({
      parts: ownScenario.topology.parts.filter((p) => p.id !== 'P2'),
    });
    expect(() =>
      composeStory({
        account,
        forensic: null,
        projection: miniProjection(allRefs()),
        dossier: miniDossier(),
        coverage: ownCoverage,
      })
    ).toThrow(PartOwnershipInvariantError);
  });

  it('DERIVED: a full topology folds ownership, contested, residue, and metrics', () => {
    const account = storyFromTopology(ownScenario.topology);
    const c = composeStory({
      account,
      forensic: null,
      projection: miniProjection(allRefs()),
      dossier: miniDossier(),
      coverage: ownCoverage,
    });
    expect(c.ownership.label).toBe('DERIVED');
    expect(c.ownership.metrics.reviewableRows).toBe(18);
    expect(c.ownership.metrics.attributedRows).toBe(9);
    expect(c.ownership.contested).toHaveLength(1);
    expect(c.ownership.contested[0]!.partIds).toEqual(['P1', 'P2']);
    // Residue carries the unattributed rows (4), never conflated with attributed.
    expect(c.ownership.residue.reviewableRows).toBe(4);
    expect(c.story).not.toBeNull();
  });

  // REGRESSION: production
  // coverage records owners by FULL artifact uuid while the story contract
  // speaks projection aliases. Without uuid→alias translation the fold saw
  // every owned slice as ungrouped and deterministically dead-ended the run.
  it('REGRESSION: uuid-form coverage owners fold via the projection alias table', () => {
    const uuidOf: Record<string, string> = {
      a1: '019f791c-1111-7000-8000-000000000001',
      a2: '019f791c-aaaa-7000-8000-000000000002',
      a3: '019f791c-bbbb-7000-8000-000000000003',
    };
    const uuidCoverage: typeof ownCoverage = {
      summary: ownCoverage.summary,
      items: ownCoverage.items.map((item) => ({
        ...item,
        units: item.units.map((unit) => {
          if (unit.kind === 'owned_slice')
            return {
              ...unit,
              owner: { ...unit.owner, artifact: uuidOf[unit.owner.artifact]! },
            };
          if (unit.kind === 'ambiguous_hunk')
            return {
              ...unit,
              candidates: unit.candidates.map((cand) =>
                cand.kind === 'checkpoint' ? { ...cand, artifact: uuidOf[cand.artifact]! } : cand
              ),
            };
          return unit;
        }),
      })),
    };
    const account = storyFromTopology(ownScenario.topology);
    const aliases = Object.fromEntries(Object.entries(uuidOf).map(([a, u]) => [a, u]));
    const c = composeStory({
      account,
      forensic: null,
      projection: miniProjection(allRefs(), [], aliases),
      dossier: miniDossier(),
      coverage: uuidCoverage,
    });
    // Identical derivation to the alias-form test: translation is lossless.
    expect(c.ownership.label).toBe('DERIVED');
    expect(c.ownership.metrics.attributedRows).toBe(9);
    expect(c.ownership.contested[0]!.partIds).toEqual(['P1', 'P2']);
  });

  it('an owner outside the served story universe degrades honestly, never dead-ends', () => {
    const foreign = '019f7999-ffff-7000-8000-00000000dead';
    const foreignCoverage: typeof ownCoverage = {
      summary: ownCoverage.summary,
      items: ownCoverage.items.map((item) => ({
        ...item,
        units: item.units.map((unit) =>
          unit.kind === 'owned_slice'
            ? { ...unit, owner: { ...unit.owner, artifact: foreign } }
            : unit
        ),
      })),
    };
    const account = storyFromTopology(ownScenario.topology);
    const c = composeStory({
      account,
      forensic: null,
      projection: miniProjection(allRefs()),
      dossier: miniDossier(),
      coverage: foreignCoverage,
    });
    expect(c.ownership.label).toBe('DEGRADED_ATTRIBUTION');
    expect(c.ownership.banner).toContain(foreign);
    expect(c.ownership.parts).toEqual([]);
  });
});

describe('composeStory — two degraded states, never conflated', () => {
  it('CODE_ONLY: no captured threads → labeled code-only, entire diff residue', () => {
    const c = composeStory({
      account: null,
      forensic: { findings: [], questions: [] },
      projection: miniProjection([]),
      dossier: miniDossier(),
      coverage: ownCoverage,
    });
    expect(c.ownership.label).toBe('CODE_ONLY');
    expect(c.ownership.parts).toEqual([]);
    expect(c.ownership.banner).toContain('CODE-ONLY');
    // The whole reviewable diff is residue; no fabricated topology.
    expect(c.ownership.residue.reviewableRows).toBe(18);
    expect(c.story).toBeNull();
  });

  it('DEGRADED_ATTRIBUTION: story retained, all code residue, distinct label', () => {
    const account = storyFromTopology(ownScenario.topology);
    const refs = ownScenario.topology.parts.flatMap((p) => p.checkpoint_refs);
    const c = composeStory({
      account,
      forensic: null,
      projection: miniProjection(refs),
      dossier: miniDossier(),
      coverage: null, // capture present, attribution unusable
    });
    expect(c.ownership.label).toBe('DEGRADED_ATTRIBUTION');
    expect(c.ownership.label).not.toBe('CODE_ONLY');
    expect(c.story).not.toBeNull(); // the Story is RETAINED
    expect(c.ownership.parts).toEqual([]);
    expect(c.ownership.banner).toContain('DEGRADED');
  });
});

describe('composeStory — ledger attachment, with nothing adjudicated', () => {
  it('every ledger row attaches to a Part or a residue, no orphans', () => {
    const ledger: ProjectionLedgerEntry[] = [
      ledgerRow({ id: 'ldg:VERIFICATION_GAP:a', kind: 'VERIFICATION_GAP', anchors: ['a1:cp1'] }),
      // File-anchored rather than checkpoint-anchored — the case this assertion
      // exists for. UNTRACKED_EVIDENCE is the file-anchored ledger kind.
      ledgerRow({
        id: 'ldg:UNTRACKED_EVIDENCE:b',
        kind: 'UNTRACKED_EVIDENCE',
        anchors: ['src/x.ts'],
      }),
      ledgerRow({ id: 'ldg:COVERAGE_GAP:c', kind: 'COVERAGE_GAP' }),
    ];
    const projection = miniProjection(['a1:cp1'], ledger);
    const account = storyFromTopology({ parts: [{ id: 'P1', checkpoint_refs: ['a1:cp1'] }] });
    const c = composeStory({
      account,
      forensic: null,
      projection,
      dossier: miniDossier(),
      coverage: null,
    });
    expect(c.ledger).toHaveLength(3);
    expect(new Set(c.ledger.map((l) => l.id)).size).toBe(3);
    expect(
      c.ledger.every((l) => l.attachment.kind === 'part' || l.attachment.kind === 'residue')
    ).toBe(true);
    expect(c.ledger.find((l) => l.id === 'ldg:VERIFICATION_GAP:a')!.attachment).toEqual({
      kind: 'part',
      partId: 'P1',
    });
    expect(c.ledger.find((l) => l.id === 'ldg:UNTRACKED_EVIDENCE:b')!.attachment).toEqual({
      kind: 'residue',
      residue: 'floor',
    });
    expect(c.ledger.find((l) => l.id === 'ldg:COVERAGE_GAP:c')!.attachment).toEqual({
      kind: 'residue',
      residue: 'unattributed',
    });
  });

  it('NOTHING mechanical reconciles — every uncertainty stays exposed with its position', () => {
    // Reading a ledger row as an "explicit machine link" and promoting the
    // uncertainty it cites to RECONCILED asserts a resolution the engine cannot
    // observe: the row that produced the link is itself only a lexical match.
    // The capture format records no explicit resolution, so there is no honest
    // mechanical path to resolved, and exposure-with-position is the whole job.
    const projection = miniProjection(['a1:cp1', 'a1:cp2']);
    projection.accountCore.checkpoints[0]!.uncertainty = [
      { citationId: 'u1', text: 'the API timeout may be too low' },
      { citationId: 'u2', text: 'the retry policy is unclear' },
    ];
    // A row shaped exactly like the one such a promotion would key on: it
    // cites an uncertainty AND anchors a later checkpoint.
    projection.accountCore.ledger = [
      ledgerRow({
        id: 'ldg:POSSIBLE_TEXT_DUPLICATE:x',
        kind: 'POSSIBLE_TEXT_DUPLICATE',
        citations: ['u1', 'd1'],
        anchors: ['a1:cp2'],
      }),
    ];
    const account = storyFromTopology({
      parts: [{ id: 'P1', checkpoint_refs: ['a1:cp1', 'a1:cp2'] }],
    });
    const c = composeStory({
      account,
      forensic: null,
      projection,
      dossier: miniDossier(),
      coverage: null,
    });
    const byId = new Map(c.uncertainties.map((u) => [u.citationId, u]));
    for (const id of ['u1', 'u2']) {
      expect(byId.get(id)!.state).toBe('UNADJUDICATED');
      // Exposure with position is what the engine CAN assert, and does.
      expect(byId.get(id)!.partId).toBe('P1');
      expect(byId.get(id)!.artifact).toBe('a1');
      expect(byId.get(id)!.cp).toBe(1);
    }
    // The row carries its merge disposition, never one it granted itself.
    expect(c.ledger.find((l) => l.id === 'ldg:POSSIBLE_TEXT_DUPLICATE:x')!.disposition).toBe(
      'OUTSTANDING'
    );
  });
});

describe('compiled account payload rendering', () => {
  it('renders a Part even when its act reference is unresolved', () => {
    const story: AccountPayload = {
      overview: { text: '', citations: [] },
      acts: [],
      parts: [
        {
          id: 'P9',
          title: 'P9',
          act: 'GHOST',
          checkpoint_refs: ['a1:cp1'],
          interpretation: 'P9 did work',
          citations: [],
        },
      ],
      questions: [],
    };
    const projection = miniProjection(['a1:cp1']);
    const dossier = miniDossier();
    const composed = composeStory({
      account: story,
      forensic: null,
      projection,
      dossier,
      coverage: null,
    });

    const { markdown } = renderSlice({
      dossier,
      projection,
      merge: composed.merge,
      composed,
      accountPresent: true,
      forensicPresent: false,
    });

    expect(markdown).toContain('P9');
  });
});
