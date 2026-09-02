// The two-lane vertical slice and slice repair.
// Engine-minted acts, per-lane payload schemas (account claims carry a
// required slot and REQUIRED citations; the blind lane can express
// neither slots nor citations), one independent repair credit per lane,
// a deterministic merge (the always-empty
// OVERLAP/CONTESTED machinery is gone), per-lane citation provenance that
// survives folding, content-derived
// item identity (true input-permutation determinism), and a STANDALONE
// review markdown + brief — no narrative install anywhere.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { AccountProjection, DossierV1, PolicyStub } from './dossier.js';
import {
  type CaptureQualityMetrics,
  type ContestedEntry,
  type CoverageInput,
  derivePartOwnership,
  type PartOwnership,
  type PartTopology,
  type UnattributedEntry,
} from './storyOwnership.js';
import {
  STORY_TITLE_MAX_CODE_POINTS,
  STORY_TITLE_MAX_WORDS,
  storyTitleSchema,
} from './storyTitle.js';

export const SLICE_SCHEMA_VERSION = 5;
export const ROUTINE_STORY_AUTHORING_SCHEMA_VERSION = 1;

// review.md is a STANDALONE, hand-readable rendering. It can balloon: four
// enumerations that every structured output already carries losslessly
// dominate it, so it points at them instead of reprinting them. These names
// are what it points at.
const STORY_MODEL_REF = '`story-review-model-v4.json`';
const BRIEF_REF = '`brief.json`';

// ---------------------------------------------------------------------------
// Per-lane payload schemas — STRICT: unknown keys rejected. The lanes have
// DIFFERENT expressible shapes. The forensic lane submits file-anchored
// findings (unchanged). The ACCOUNT lane submits a causal STORY (v3): a
// topology of Acts/Parts over the in-scope checkpoints, concise interpretation,
// judgment-call questions, and citations — and NOTHING that assigns code. The
// engine derives which code each Part owns mechanically (storyOwnership.ts);
// any key that would let the model assert ownership (placements,
// memberTargetKeys, file anchors on a Part) is unrepresentable and rejected.
// ---------------------------------------------------------------------------

const severityEnum = z.enum(['CRITICAL', 'CAUTION', 'REVIEW', 'INFO']);
const confidenceEnum = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const forensicFindingSchema = z
  .object({
    claim: z.string().min(1),
    file: z.string().min(1),
    related_files: z.array(z.string().min(1)).max(4),
    severity: severityEnum,
    confidence: confidenceEnum,
  })
  .strict()
  .superRefine((finding, ctx) => {
    const seen = new Set<string>();
    finding.related_files.forEach((file, i) => {
      if (file === finding.file)
        ctx.addIssue({
          code: 'custom',
          path: ['related_files', i],
          message: 'related file must be distinct from the primary file',
        });
      if (seen.has(file))
        ctx.addIssue({
          code: 'custom',
          path: ['related_files', i],
          message: 'related files must be unique',
        });
      seen.add(file);
    });
  })
  .transform((finding) => ({
    ...finding,
    related_files: [...finding.related_files].sort(codePointCompare),
  }));

const forensicQuestionSchema = z.union([
  z.string().min(1),
  z.object({ text: z.string().min(1), file: z.string().min(1).optional() }).strict(),
]);

export const forensicPayloadSchema = z
  .object({ findings: z.array(forensicFindingSchema), questions: z.array(forensicQuestionSchema) })
  .strict();

// -- Story (account lane) --------------------------------------------------
// The authored contract is deliberately nested and alias-only. The payload
// exposes globally unique `k#` checkpoint aliases and `c#` citation aliases;
// the model groups Parts under Acts without authoring ids or cross-references.
// Compilation resolves aliases to canonical capture refs, assigns A1/P1 ids in
// authored order, and derives Part→Act membership from nesting.
const PROMPT_CHECKPOINT_ALIAS_RE = /^k\d+$/;
const PROMPT_CITATION_ALIAS_RE = /^c\d+$/;
const BRACKETED_PROMPT_CITATION_ALIAS_RE = /\[(c\d+)\]/g;
const promptCheckpointAlias = z
  .string()
  .regex(PROMPT_CHECKPOINT_ALIAS_RE, "checkpoint alias must be engine-issued 'k#'");
const promptCitationAlias = z
  .string()
  .regex(PROMPT_CITATION_ALIAS_RE, "citation alias must be engine-issued 'c#'");
const OVERVIEW_MAX_WORDS = 150;
const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
const nonBlank = z.string().trim().min(1);

const authoredStoryPartSchema = z
  .object({
    title: storyTitleSchema,
    checkpoints: z.array(promptCheckpointAlias).min(1),
    interpretation: nonBlank,
    citations: z.array(promptCitationAlias).min(1),
  })
  .strict();

const authoredStoryActSchema = z
  .object({
    title: storyTitleSchema,
    interpretation: nonBlank.optional(),
    parts: z.array(authoredStoryPartSchema).min(1),
  })
  .strict();

const authoredStoryQuestionSchema = z.union([
  nonBlank,
  z.object({ text: nonBlank, citations: z.array(promptCitationAlias).optional() }).strict(),
]);

const authoredStoryOverviewSchema = z
  .object({
    text: nonBlank.refine((value) => countWords(value) <= OVERVIEW_MAX_WORDS, {
      message: `overview text must be at most ${OVERVIEW_MAX_WORDS} words`,
    }),
    citations: z
      .array(promptCitationAlias)
      .min(1)
      .refine((aliases) => new Set(aliases).size === aliases.length, {
        message: 'overview citations must be unique',
      }),
  })
  .strict();

export const storyPayloadSchema = z
  .object({
    schema_version: z.literal(ROUTINE_STORY_AUTHORING_SCHEMA_VERSION),
    overview: authoredStoryOverviewSchema,
    acts: z.array(authoredStoryActSchema).min(1),
    questions: z.array(authoredStoryQuestionSchema),
  })
  .strict();

export type AuthoredAccountPayload = z.infer<typeof storyPayloadSchema>;

export interface CompiledStoryAct {
  id: string;
  title: string;
  interpretation?: string;
}

export interface CompiledStoryPart {
  id: string;
  title: string;
  act: string;
  checkpoint_refs: string[];
  interpretation: string;
  citations: string[];
}

export interface CompiledStoryOverview {
  text: string;
  citations: string[];
}

export interface AccountPayload {
  overview: CompiledStoryOverview;
  acts: CompiledStoryAct[];
  parts: CompiledStoryPart[];
  questions: Array<string | { text: string; citations?: string[] }>;
}

export type StoryPayload = AccountPayload;
export type ForensicPayload = z.input<typeof forensicPayloadSchema>;
export type LanePayload = AccountPayload | ForensicPayload;

/** Single source of truth — the persisted run schema's z.enum derives from it. */
export const LANES = ['account', 'forensic'] as const;
export type Lane = (typeof LANES)[number];

/** Single source of truth — the persisted run schema's z.enum derives from it. */
export const SLICE_DIAGNOSTIC_CODES = [
  'SLICE_PAYLOAD_SHAPE',
  'SLICE_UNKNOWN_FILE',
  'SLICE_UNKNOWN_CITATION',
  'SLICE_OVERVIEW_ALIAS_LEAK',
  'SLICE_ROUTINE_LIMITS',
  // Story-topology diagnostics (v3) — each a distinct repair signal.
  'STORY_UNKNOWN_CHECKPOINT_REF',
  'STORY_CHECKPOINT_UNCLAIMED',
  'STORY_CHECKPOINT_DUPLICATED',
  'TWOLANE_ATTEMPT_BUDGET',
  'SLICE_SUBMIT_AFTER_ACCEPT',
] as const;

export interface SliceDiagnostic {
  code: (typeof SLICE_DIAGNOSTIC_CODES)[number];
  message: string;
}

/**
 * Routine-review output caps: bounded triage, not exhaustive
 * audit. Enforced deterministically here — validation, never authoring —
 * and stated with the same numbers in the canonical task-review skill.
 */
export const ROUTINE_LIMITS_V1 = {
  forensic: { maxFindings: 3, maxQuestions: 1, maxClaimWords: 60 },
  // Story caps are CEILINGS, not quotas: the number of Parts is driven by the
  // topology (every completed checkpoint must be placed), so only the prose
  // length and the judgment-question count are bounded.
  account: {
    maxOverviewWords: OVERVIEW_MAX_WORDS,
    maxTitleWords: STORY_TITLE_MAX_WORDS,
    maxTitleCodePoints: STORY_TITLE_MAX_CODE_POINTS,
    maxInterpretationWords: 80,
    maxQuestions: 3,
    maxQuestionWords: 60,
  },
  bannedSeverity: 'INFO',
} as const;

function forensicRoutineDiagnostics(payload: ForensicPayload): SliceDiagnostic[] {
  const out: SliceDiagnostic[] = [];
  const push = (message: string) => out.push({ code: 'SLICE_ROUTINE_LIMITS', message });
  const L = ROUTINE_LIMITS_V1;
  payload.findings.forEach((f, i) => {
    if (f.severity === L.bannedSeverity)
      push(`findings[${i}]: severity ${L.bannedSeverity} is not part of a routine review`);
  });
  if (payload.findings.length > L.forensic.maxFindings)
    push(
      `findings: ${payload.findings.length} exceeds the routine cap of ${L.forensic.maxFindings}`
    );
  if (payload.questions.length > L.forensic.maxQuestions)
    push(
      `questions: ${payload.questions.length} exceeds the routine cap of ${L.forensic.maxQuestions}`
    );
  payload.findings.forEach((f, i) => {
    if (countWords(f.claim) > L.forensic.maxClaimWords)
      push(
        `findings[${i}]: claim is ${countWords(f.claim)} words; the routine cap is ${L.forensic.maxClaimWords}`
      );
  });
  return out;
}

function storyRoutineDiagnostics(story: AccountPayload): SliceDiagnostic[] {
  const out: SliceDiagnostic[] = [];
  const push = (message: string) => out.push({ code: 'SLICE_ROUTINE_LIMITS', message });
  const L = ROUTINE_LIMITS_V1.account;
  story.parts.forEach((p, i) => {
    // Titles were already parsed through the shared authored/persisted Story
    // title contract. Keep prose-only routine limits here.
    if (countWords(p.interpretation) > L.maxInterpretationWords)
      push(
        `parts[${i}] (${p.id}): interpretation is ${countWords(p.interpretation)} words; the routine ceiling is ${L.maxInterpretationWords}`
      );
  });
  story.acts.forEach((a, i) => {
    if (a.interpretation !== undefined && countWords(a.interpretation) > L.maxInterpretationWords)
      push(
        `acts[${i}] (${a.id}): interpretation is ${countWords(a.interpretation)} words; the routine ceiling is ${L.maxInterpretationWords}`
      );
  });
  if (story.questions.length > L.maxQuestions)
    push(`questions: ${story.questions.length} exceeds the routine ceiling of ${L.maxQuestions}`);
  story.questions.forEach((q, i) => {
    const text = typeof q === 'string' ? q : q.text;
    if (countWords(text) > L.maxQuestionWords)
      push(
        `questions[${i}]: is ${countWords(text)} words; the routine ceiling is ${L.maxQuestionWords}`
      );
  });
  return out;
}

export interface SliceValidationContext {
  diffFiles: ReadonlySet<string>;
  /** In-scope COMPLETED checkpoints, `a<i>:cp<n>` — the Story's coverage universe. */
  completedCheckpointRefs: ReadonlySet<string>;
  /** Globally unique prompt aliases resolved only by the deterministic compiler. */
  checkpointAliases: ReadonlyMap<string, string>;
  citationAliases: ReadonlyMap<string, string>;
}

function shapeDiagnostics(error: z.ZodError): SliceDiagnostic[] {
  return error.issues.map((issue) => ({
    code: 'SLICE_PAYLOAD_SHAPE',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

function validateForensicPayload(
  raw: unknown,
  ctx: SliceValidationContext,
  opts: { routine?: boolean }
): { payload: ForensicPayload | null; diagnostics: SliceDiagnostic[] } {
  const parsed = forensicPayloadSchema.safeParse(raw);
  if (!parsed.success) return { payload: null, diagnostics: shapeDiagnostics(parsed.error) };
  const diagnostics: SliceDiagnostic[] = [];
  const checkFile = (file: string, where: string) => {
    if (!ctx.diffFiles.has(file))
      diagnostics.push({
        code: 'SLICE_UNKNOWN_FILE',
        message: `${where} anchors '${file}', which is not a changed file in this review`,
      });
  };
  parsed.data.findings.forEach((f, i) => {
    checkFile(f.file, `findings[${i}].file`);
    f.related_files.forEach((file, j) => checkFile(file, `findings[${i}].related_files[${j}]`));
  });
  parsed.data.questions.forEach((q, i) => {
    if (typeof q !== 'string' && q.file !== undefined) checkFile(q.file, `questions[${i}]`);
  });
  if (opts.routine === true) diagnostics.push(...forensicRoutineDiagnostics(parsed.data));
  return { payload: diagnostics.length === 0 ? parsed.data : null, diagnostics };
}

/** Compile nested alias-only authoring into the canonical internal Story. */
export function compileStoryPayload(
  raw: unknown,
  ctx: SliceValidationContext,
  opts: { routine?: boolean }
): { payload: AccountPayload | null; diagnostics: SliceDiagnostic[] } {
  const parsed = storyPayloadSchema.safeParse(raw);
  if (!parsed.success) return { payload: null, diagnostics: shapeDiagnostics(parsed.error) };
  const diagnostics: SliceDiagnostic[] = [];
  let nextPart = 1;
  const acts: CompiledStoryAct[] = [];
  const parts: CompiledStoryPart[] = [];

  const resolveCitations = (aliases: readonly string[] | undefined, where: string): string[] =>
    (aliases ?? []).flatMap((alias) => {
      const canonical = ctx.citationAliases.get(alias);
      if (canonical === undefined) {
        diagnostics.push({
          code: 'SLICE_UNKNOWN_CITATION',
          message: `${where} cites '${alias}', which is not an engine-issued citation alias`,
        });
        return [];
      }
      return [canonical];
    });

  for (const match of parsed.data.overview.text.matchAll(BRACKETED_PROMPT_CITATION_ALIAS_RE)) {
    const alias = match[1]!;
    if (ctx.citationAliases.has(alias)) {
      diagnostics.push({
        code: 'SLICE_OVERVIEW_ALIAS_LEAK',
        message: `overview text contains bracketed prompt-local citation alias '[${alias}]'; keep aliases only in overview.citations`,
      });
    }
  }

  parsed.data.acts.forEach((authoredAct, actIndex) => {
    const actId = `A${actIndex + 1}`;
    acts.push({
      id: actId,
      title: authoredAct.title,
      ...(authoredAct.interpretation !== undefined
        ? { interpretation: authoredAct.interpretation }
        : {}),
    });
    authoredAct.parts.forEach((authoredPart) => {
      const partId = `P${nextPart++}`;
      const checkpoint_refs = authoredPart.checkpoints.flatMap((alias) => {
        const canonical = ctx.checkpointAliases.get(alias);
        if (canonical === undefined) {
          diagnostics.push({
            code: 'STORY_UNKNOWN_CHECKPOINT_REF',
            message: `part ${partId} references '${alias}', which is not an engine-issued checkpoint alias`,
          });
          return [];
        }
        return [canonical];
      });
      parts.push({
        id: partId,
        title: authoredPart.title,
        act: actId,
        checkpoint_refs,
        interpretation: authoredPart.interpretation,
        citations: resolveCitations(authoredPart.citations, `part ${partId}`),
      });
    });
  });

  const questions = parsed.data.questions.map((question, i) =>
    typeof question === 'string'
      ? question
      : {
          text: question.text,
          ...(question.citations !== undefined
            ? { citations: resolveCitations(question.citations, `questions[${i}]`) }
            : {}),
        }
  );
  const story: AccountPayload = {
    overview: {
      text: parsed.data.overview.text,
      citations: resolveCitations(parsed.data.overview.citations, 'overview'),
    },
    acts,
    parts,
    questions,
  };

  // partsByRef: completed ref -> Parts that claim it (for exactly-once).
  const partsByRef = new Map<string, string[]>();
  story.parts.forEach((p) => {
    for (const ref of p.checkpoint_refs) {
      if (!ctx.completedCheckpointRefs.has(ref)) {
        diagnostics.push({
          code: 'STORY_UNKNOWN_CHECKPOINT_REF',
          message: `part ${p.id} resolves to '${ref}', which is not an in-scope completed checkpoint`,
        });
      } else {
        partsByRef.set(ref, [...(partsByRef.get(ref) ?? []), p.id]);
      }
    }
  });

  // Exactly-once coverage over the served completed checkpoints.
  const missing = [...ctx.completedCheckpointRefs].filter((r) => !partsByRef.has(r)).sort();
  if (missing.length > 0)
    diagnostics.push({
      code: 'STORY_CHECKPOINT_UNCLAIMED',
      message: `every in-scope completed checkpoint must appear in exactly one Part; missing: ${missing.join(', ')}`,
    });
  const duplicated = [...partsByRef.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([ref, ids]) => `${ref} (in ${[...new Set(ids)].sort().join(', ')})`)
    .sort();
  if (duplicated.length > 0)
    diagnostics.push({
      code: 'STORY_CHECKPOINT_DUPLICATED',
      message: `a completed checkpoint may appear in only one Part; duplicated: ${duplicated.join('; ')}`,
    });

  if (opts.routine === true) diagnostics.push(...storyRoutineDiagnostics(story));
  return { payload: diagnostics.length === 0 ? story : null, diagnostics };
}

export function validateLanePayload(
  lane: Lane,
  raw: unknown,
  ctx: SliceValidationContext,
  opts: { routine?: boolean } = {}
): { payload: LanePayload | null; diagnostics: SliceDiagnostic[] } {
  return lane === 'account'
    ? compileStoryPayload(raw, ctx, opts)
    : validateForensicPayload(raw, ctx, opts);
}

/**
 * Translate the coverage snapshot's owner ids into the projection's alias
 * space. The floor's `attribute()` records owners by FULL artifact uuid;
 * every other composition surface — checkpoint refs, citations, the story
 * contract — speaks the projection's `a<i>` aliases. The fold must compare
 * like with like, so owners are rewritten uuid→alias before derivation.
 * Owners whose artifact has no alias sit OUTSIDE the served story universe
 * (the floor attributed rows to a thread the projection did not serve); they
 * are returned separately so the caller degrades honestly instead of failing
 * the fold with an impossible-to-satisfy topology demand.
 */
export function aliasCoverage(
  coverage: CoverageInput,
  artifactAliases: Record<string, string>
): { coverage: CoverageInput; unknownArtifacts: string[] } {
  const aliasOf = new Map(Object.entries(artifactAliases).map(([alias, uuid]) => [uuid, alias]));
  const unknown = new Set<string>();
  const mapArtifact = (artifact: string): string => {
    const alias = aliasOf.get(artifact);
    if (alias !== undefined) return alias;
    unknown.add(artifact);
    return artifact;
  };
  const items = coverage.items.map((item) => ({
    ...item,
    units: item.units.map((unit) => {
      if (unit.kind === 'owned_slice')
        return { ...unit, owner: { ...unit.owner, artifact: mapArtifact(unit.owner.artifact) } };
      if (unit.kind === 'ambiguous_hunk')
        return {
          ...unit,
          candidates: unit.candidates.map((c) =>
            c.kind === 'checkpoint' ? { ...c, artifact: mapArtifact(c.artifact) } : c
          ),
        };
      return unit;
    }),
  }));
  return {
    coverage: { items, summary: coverage.summary },
    unknownArtifacts: [...unknown].sort(codePointCompare),
  };
}

/**
 * Project the accepted Story onto storyOwnership.ts's `PartTopology` — the
 * mechanical ownership derivation's input. The contract's Part shape IS a
 * superset of `PartInput`, so this is a straight structural narrowing.
 */
export function storyTopology(story: AccountPayload): PartTopology {
  return {
    parts: story.parts.map((p) => ({
      id: p.id,
      act: p.act,
      checkpoint_refs: [...p.checkpoint_refs],
    })),
  };
}

// ---------------------------------------------------------------------------
// Run state: one independent repair per lane.
// ---------------------------------------------------------------------------

/** Single source of truth — the persisted run schema's z.enum derives from it. */
export const SLICE_LANE_OUTCOMES = [
  'PENDING',
  'ACCEPTED_CLEAN_FIRST_PASS',
  'ACCEPTED_NORMALIZED_FIRST_PASS',
  'REJECTED_FIRST_PASS',
  'ACCEPTED_REPAIRED',
  'TERMINAL_REJECTED',
] as const;
export type SliceLaneOutcome = (typeof SLICE_LANE_OUTCOMES)[number];

export interface SliceLaneState {
  attempts: number;
  accepted: boolean;
  repairCredit: number;
  outcome: SliceLaneOutcome;
  /** Diagnostics from every consumed attempt, retained in attempt order. */
  diagnostics: SliceDiagnostic[];
}

export interface SliceRunState {
  schema_version: typeof SLICE_SCHEMA_VERSION;
  lanes: Record<Lane, SliceLaneState>;
}

export const freshSliceRunState = (): SliceRunState => ({
  schema_version: SLICE_SCHEMA_VERSION,
  lanes: {
    account: { attempts: 0, accepted: false, repairCredit: 1, outcome: 'PENDING', diagnostics: [] },
    forensic: {
      attempts: 0,
      accepted: false,
      repairCredit: 1,
      outcome: 'PENDING',
      diagnostics: [],
    },
  },
});

export interface SubmitResult {
  state: SliceRunState;
  accepted: boolean;
  payload: LanePayload | null;
  diagnostics: SliceDiagnostic[];
}

export function submitLane(
  state: SliceRunState,
  lane: Lane,
  raw: unknown,
  ctx: SliceValidationContext,
  opts: { routine?: boolean; normalized?: boolean } = {}
): SubmitResult {
  const laneState = state.lanes[lane];
  const refuse = (code: SliceDiagnostic['code'], message: string): SubmitResult => ({
    state,
    accepted: false,
    payload: null,
    diagnostics: [{ code, message }],
  });
  if (laneState.accepted)
    return refuse(
      'SLICE_SUBMIT_AFTER_ACCEPT',
      `${lane} lane already accepted; first acceptance is immutable`
    );
  const isRepair = laneState.attempts >= 1;
  if (isRepair && laneState.repairCredit <= 0)
    return refuse('TWOLANE_ATTEMPT_BUDGET', `${lane} lane repair refused: its one repair is spent`);
  const { payload, diagnostics } = validateLanePayload(lane, raw, ctx, opts);
  const accepted = payload !== null;
  const outcome: SliceLaneOutcome = accepted
    ? isRepair
      ? 'ACCEPTED_REPAIRED'
      : opts.normalized === true
        ? 'ACCEPTED_NORMALIZED_FIRST_PASS'
        : 'ACCEPTED_CLEAN_FIRST_PASS'
    : isRepair
      ? 'TERMINAL_REJECTED'
      : 'REJECTED_FIRST_PASS';
  const next: SliceRunState = {
    ...state,
    lanes: {
      ...state.lanes,
      [lane]: {
        attempts: laneState.attempts + 1,
        accepted,
        repairCredit: isRepair ? laneState.repairCredit - 1 : laneState.repairCredit,
        outcome,
        diagnostics: [...laneState.diagnostics, ...diagnostics],
      },
    },
  };
  return { state: next, accepted, payload, diagnostics };
}

// ---------------------------------------------------------------------------
// Deterministic merge — content identity and per-lane citation provenance.
// ---------------------------------------------------------------------------

export interface MergedItem {
  /** Content-derived: lane + sha16(kind|text|file|relatedFiles) — input-order free. */
  id: string;
  lane: Lane;
  kind: 'finding' | 'question';
  text: string;
  file: string | null;
  /** Bounded causal context paths authored for a forensic finding. */
  relatedFiles: string[];
  severity: 'CRITICAL' | 'CAUTION' | 'REVIEW' | 'INFO';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Per-lane citation provenance — survives folding. */
  citationsByLane: Record<Lane, string[]>;
  foldedWith: Lane[] | null;
}

export interface LedgerDispositionRow {
  id: string;
  kind: string;
  status: string;
  message: string;
  flagOnly: boolean;
  disposition:
    | 'ACKNOWLEDGED_BY_ACCOUNT'
    | 'ACKNOWLEDGED_BY_FORENSIC'
    | 'ACKNOWLEDGED_BY_BOTH'
    | 'OUTSTANDING';
}

export interface SliceMergeResult {
  items: MergedItem[];
  mustDecide: MergedItem[];
  dispositions: LedgerDispositionRow[];
  /** The accepted account Story, echoed for the renderer (null when absent). */
  story: AccountPayload | null;
}

const SEV_RANK: Record<string, number> = { CRITICAL: 4, CAUTION: 3, REVIEW: 2, INFO: 1 };
const normalizeText = (t: string): string => t.trim().replace(/\s+/g, ' ');
const sha16 = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 16);

export function mergeLanes(input: {
  account: AccountPayload | null;
  forensic: ForensicPayload | null;
  projection: AccountProjection;
  fileScores?: ReadonlyMap<string, number>;
}): SliceMergeResult {
  const items: MergedItem[] = [];
  if (input.forensic) {
    for (const f of input.forensic.findings) {
      const relatedFiles = [...f.related_files].sort(codePointCompare);
      items.push({
        id: `forensic:${sha16(
          `finding|${normalizeText(f.claim)}|${f.file}|${relatedFiles.join('|')}`
        )}`,
        lane: 'forensic',
        kind: 'finding',
        text: f.claim,
        file: f.file,
        relatedFiles,
        severity: f.severity,
        confidence: f.confidence,
        citationsByLane: { account: [], forensic: [] },
        foldedWith: null,
      });
    }
    for (const q of input.forensic.questions) {
      const text = typeof q === 'string' ? q : q.text;
      const file = typeof q === 'string' ? null : (q.file ?? null);
      items.push({
        id: `forensic:${sha16(`question|${normalizeText(text)}|${file ?? ''}`)}`,
        lane: 'forensic',
        kind: 'question',
        text,
        file,
        relatedFiles: [],
        severity: 'REVIEW',
        confidence: null,
        citationsByLane: { account: [], forensic: [] },
        foldedWith: null,
      });
    }
  }
  // The account lane no longer emits file-anchored findings (the Story asserts
  // no code): it contributes only judgment-call QUESTIONS. Every completed
  // checkpoint's Part interpretation is rendered from `story`, and Part/question
  // citations drive ledger dispositions below.
  const accountCitedIds = new Set<string>();
  if (input.account) {
    for (const p of input.account.parts) for (const c of p.citations) accountCitedIds.add(c);
    for (const q of input.account.questions) {
      const text = typeof q === 'string' ? q : q.text;
      const citations =
        typeof q === 'string' ? [] : [...(q.citations ?? [])].sort(codePointCompare);
      for (const c of citations) accountCitedIds.add(c);
      items.push({
        id: `account:${sha16(`question|${normalizeText(text)}|`)}`,
        lane: 'account',
        kind: 'question',
        text,
        file: null,
        relatedFiles: [],
        severity: 'REVIEW',
        confidence: null,
        citationsByLane: { account: citations, forensic: [] },
        foldedWith: null,
      });
    }
  }

  // Canonical order BEFORE any pairing: content ids make the merge
  // independent of payload array order.
  items.sort((a, b) => codePointCompare(a.id, b.id));

  // The lane-intersection machinery (POTENTIAL_CONFLICT / OVERLAP) is GONE.
  // It was not merely unreachable on the routine path — it was provably always
  // empty on EVERY path. `mergeLanes` is its sole producer, and the only account
  // items it can build are hardcoded `kind:'question'`, `file:null` above,
  // while `storyPayloadSchema` is `.strict()` with no `file` to supply.
  // Conflict detection required an account item that was a `finding` with a
  // `file`; overlap required an account item with a `file`. Neither can exist,
  // so both sets were empty in every run.
  //
  // Real cross-lane opposition needs hunk-grain anchoring the Story contract
  // deliberately does not give the account lane. Rebuilding it is platform work;
  // shipping the empty shell of it as if it worked is what this removes.

  // Fold exact duplicates (normalized text + file), ANY lane combination;
  // provenance and citations preserved per lane.
  const byFingerprint = new Map<string, MergedItem>();
  const folded: MergedItem[] = [];
  for (const item of items) {
    const fp = `${item.kind}\0${normalizeText(item.text)}\0${item.file ?? ''}\0${item.relatedFiles.join('\0')}`;
    const existing = byFingerprint.get(fp);
    if (existing) {
      existing.foldedWith = [...(existing.foldedWith ?? []), item.lane];
      for (const lane of ['account', 'forensic'] as const) {
        existing.citationsByLane[lane] = [
          ...new Set([...existing.citationsByLane[lane], ...item.citationsByLane[lane]]),
        ].sort(codePointCompare);
      }
      if ((SEV_RANK[item.severity] ?? 0) > (SEV_RANK[existing.severity] ?? 0))
        existing.severity = item.severity;
      continue;
    }
    byFingerprint.set(fp, item);
    folded.push(item);
  }

  const ledgerIdSet = new Set(input.projection.accountCore.ledger.map((r) => r.id));
  const ledgerLinks = (x: MergedItem): number =>
    x.citationsByLane.account.filter((c) => ledgerIdSet.has(c)).length +
    x.citationsByLane.forensic.filter((c) => ledgerIdSet.has(c)).length;
  const riskOf = (x: MergedItem): number => (x.file ? (input.fileScores?.get(x.file) ?? 0) : -1);
  folded.sort(
    (a, b) =>
      (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) ||
      ledgerLinks(b) - ledgerLinks(a) ||
      riskOf(b) - riskOf(a) ||
      (a.kind === b.kind ? 0 : a.kind === 'finding' ? -1 : 1) ||
      codePointCompare(a.file ?? '', b.file ?? '') ||
      codePointCompare(a.id, b.id)
  );

  const mustDecide = folded.slice(0, 5);

  const dispositions: LedgerDispositionRow[] = input.projection.accountCore.ledger.map((row) => {
    // Account acknowledgement now flows from the Story: any Part or judgment
    // question that cites the ledger row.
    const byAccount = accountCitedIds.has(row.id);
    const byForensic = folded.some((x) => x.citationsByLane.forensic.includes(row.id));
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      message: row.message,
      flagOnly: row.flagOnly === true,
      disposition:
        byAccount && byForensic
          ? 'ACKNOWLEDGED_BY_BOTH'
          : byAccount
            ? 'ACKNOWLEDGED_BY_ACCOUNT'
            : byForensic
              ? 'ACKNOWLEDGED_BY_FORENSIC'
              : 'OUTSTANDING',
    };
  });

  return {
    items: folded,
    mustDecide,
    dispositions,
    story: input.account,
  };
}

// ---------------------------------------------------------------------------
// composeStory — the finalization composition. Folds the accepted
// Story's topology + the floor's persisted attribution coverage into Part
// ownership, attaches EVERY claim-ledger row to a Part or a residue with a
// disposition (no orphan rows), exposes each captured uncertainty with its
// thread/checkpoint position, and labels the two never-conflated degraded
// states. It deliberately performs no free-text resolution inference. Pure and
// model-free; the output is a clean serializable structure the install path
// consumes.
// ---------------------------------------------------------------------------

export type OwnershipLabel = 'DERIVED' | 'DEGRADED_ATTRIBUTION' | 'CODE_ONLY';

export interface UncertaintyState {
  citationId: string;
  /** Thread (artifact alias) the uncertainty was captured on. */
  artifact: string;
  /** Checkpoint position within the thread. */
  cp: number;
  text: string;
  /** The Part whose member owns this checkpoint, or null (residue/degraded). */
  partId: string | null;
  /**
   * A SINGLE-MEMBER union, deliberately. The capture format records no explicit
   * resolution link, so there is no honest mechanical path to "resolved" — and
   * the previous two-member version was reached by a lexical heuristic, which is
   * the defect this schema version exists to remove.
   *
   * The field is kept rather than dropped because the single-member union is
   * what makes that invariant TYPE-enforced: there is no adjudicated value to
   * assign, so restoring the capability means widening this union deliberately
   * and bumping the schema version. A resolved state belongs here only once the
   * capture format can actually witness a resolution.
   */
  state: 'UNADJUDICATED';
}

/** One claim-ledger row, structurally attached to a Part or a residue. */
export interface LedgerAttachment {
  id: string;
  kind: string;
  status: string;
  message: string;
  flagOnly: boolean;
  attachment:
    | { kind: 'part'; partId: string }
    | { kind: 'residue'; residue: 'unattributed' | 'floor' };
  disposition:
    | 'ACKNOWLEDGED_BY_ACCOUNT'
    | 'ACKNOWLEDGED_BY_FORENSIC'
    | 'ACKNOWLEDGED_BY_BOTH'
    | 'OUTSTANDING';
}

export interface OwnershipResidue {
  /** Reviewable changed rows that landed in residue (0 when coverage is absent). */
  reviewableRows: number;
  /** Files contributing residue rows, code-point sorted. */
  files: string[];
}

export interface OwnershipView {
  label: OwnershipLabel;
  /** One-line human banner; rendered in review.md and brief.json. */
  banner: string;
  /** Derived Part ownership — [] unless label is DERIVED. */
  parts: PartOwnership[];
  contested: ContestedEntry[];
  unattributed: UnattributedEntry[];
  residue: OwnershipResidue;
  metrics: CaptureQualityMetrics;
  /**
   * Checkpoints excluded from attribution because a boundary snapshot is
   * missing. Reported ALONGSIDE the unattributed row total and never divided
   * into it: the engine knows both numbers, and knows nothing about the
   * relationship between them, because the missing snapshot is exactly what
   * would have established it.
   */
  missingBoundaryCheckpoints: number;
}

export interface ComposedStory {
  schema_version: typeof SLICE_SCHEMA_VERSION;
  branch: string;
  floor_input_hash: string;
  ownership: OwnershipView;
  /** Every claim-ledger row, structurally attached — no orphan rows. */
  ledger: LedgerAttachment[];
  /** Captured uncertainties, exposed with position + reconciliation state. */
  uncertainties: UncertaintyState[];
  /** The deterministic lane merge (findings/questions/conflicts/dispositions). */
  merge: SliceMergeResult;
  /** The accepted account Story (null in a code-only review). */
  story: AccountPayload | null;
}

const zeroMetrics = (reviewableRows: number): CaptureQualityMetrics => ({
  reviewableRows,
  attributedRows: 0,
  attributedPct: 0,
  ambiguousRows: 0,
  contestedRows: 0,
  unattributedRows: reviewableRows,
  contributingThreads: 0,
  contributingCheckpoints: 0,
});

export function composeStory(input: {
  account: AccountPayload | null;
  forensic: ForensicPayload | null;
  projection: AccountProjection;
  dossier: DossierV1;
  /** The floor's persisted attribution coverage; null = attribution unusable. */
  coverage: CoverageInput | null;
  fileScores?: ReadonlyMap<string, number>;
}): ComposedStory {
  const { account, forensic, projection, dossier, coverage, fileScores } = input;
  const merge = mergeLanes({ account, forensic, projection, fileScores });

  const checkpoints = projection.accountCore.checkpoints;
  const hasThreads = checkpoints.length > 0;
  const hasStory = account !== null && account.parts.length > 0;

  // Membership + citation → checkpoint indices (all ids in projection/aliased
  // space). Used by ledger attachment and uncertainty exposure.
  const partByRef = new Map<string, string>();
  if (account !== null)
    for (const p of account.parts) for (const ref of p.checkpoint_refs) partByRef.set(ref, p.id);
  const citationToRef = new Map<string, string>();
  for (const cp of checkpoints) {
    const ref = `${cp.artifact}:cp${cp.cp}`;
    for (const d of cp.decisions) {
      citationToRef.set(d.citationId, ref);
      for (const a of d.alternatives) citationToRef.set(a.citationId, ref);
    }
    for (const u of cp.uncertainty) citationToRef.set(u.citationId, ref);
  }

  // Every captured uncertainty is exposed with its position, and NOTHING here
  // resolves one. The deleted version read a SUPERSESSION_CANDIDATE ledger row
  // as an "explicit machine link" and promoted the cited uncertainty to
  // RECONCILED — but that row was produced by token overlap, so the promotion
  // asserted a resolution the engine had no way to know about. The capture
  // format records no explicit resolution link, so there is no honest
  // mechanical path to "resolved" and the state stays open by construction.
  const uncertainties: UncertaintyState[] = checkpoints.flatMap((cp) =>
    cp.uncertainty.map(
      (u): UncertaintyState => ({
        citationId: u.citationId,
        artifact: cp.artifact,
        cp: cp.cp,
        text: u.text,
        partId: partByRef.get(`${cp.artifact}:cp${cp.cp}`) ?? null,
        state: 'UNADJUDICATED',
      })
    )
  );

  // Ownership. The ONLY path that runs the fold is a healthy full one; its
  // exactly-once invariant fails CLOSED (throws) rather than silently degrade.
  // Coverage owners are translated uuid→alias first (the fold compares refs
  // against the story contract's alias space); a floor thread the projection
  // never served makes the topology demand unsatisfiable BY CONSTRUCTION, so
  // that case degrades honestly instead of dead-ending the run.
  let ownership: OwnershipView;
  // Reported beside the residue total, never divided into it (see OwnershipView).
  // NOT defaulted: a dossier without this field would otherwise report "0
  // checkpoints missing boundaries" when the truth is unknown — which is the
  // species of quiet false certainty this whole change exists to remove. The
  // dossier schema version was bumped instead, and production rebuilds the
  // dossier from the floor on every routine-start, so nothing reads a stale one.
  const missingBoundaryCheckpoints = dossier.missing_boundary_checkpoints;
  const aliased = coverage !== null ? aliasCoverage(coverage, projection.artifactAliases) : null;
  const unknownArtifacts = aliased?.unknownArtifacts ?? [];
  const unservedThreads = unknownArtifacts.length > 0;
  if (hasStory && hasThreads && aliased !== null && !unservedThreads) {
    const derived = derivePartOwnership(aliased.coverage, storyTopology(account));
    const files = [...new Set(derived.unattributed.map((u) => u.file))].sort(codePointCompare);
    ownership = {
      label: 'DERIVED',
      banner:
        derived.metrics.contributingThreads > 0
          ? `Ownership derived from ${derived.metrics.contributingThreads} contributing thread(s); ${derived.metrics.attributedPct.toFixed(0)}% of reviewable rows attributed.`
          : 'Ownership derived; no rows attributed to a captured thread.',
      parts: derived.parts,
      contested: derived.contested,
      unattributed: derived.unattributed,
      residue: { reviewableRows: derived.metrics.unattributedRows, files },
      metrics: derived.metrics,
      missingBoundaryCheckpoints,
    };
  } else {
    // Two degraded states, never conflated. All code becomes unattributed
    // residue; the reviewable-row total is honest when coverage is present.
    const residueFiles = coverage
      ? [...new Set(coverage.items.map((i) => i.file))].sort(codePointCompare)
      : [
          ...new Set(
            dossier.file_index
              .filter((f) => !f.capture)
              .map((f) => f.newPath ?? f.oldPath ?? f.path)
          ),
        ].sort(codePointCompare);
    const reviewableRows = coverage ? coverage.summary.reviewable_rows : 0;
    const residue: OwnershipResidue = { reviewableRows, files: residueFiles };
    const metrics = zeroMetrics(reviewableRows);
    if (hasStory && hasThreads) {
      ownership = {
        label: 'DEGRADED_ATTRIBUTION',
        banner: unservedThreads
          ? `DEGRADED OWNERSHIP: the account story is retained, but the floor attributed rows to thread(s) the account projection did not serve (${unknownArtifacts.join(', ')}) — all code lands in unattributed residue.`
          : 'DEGRADED OWNERSHIP: the account story is retained, but attribution coverage was unavailable — all code lands in unattributed residue.',
        parts: [],
        contested: [],
        unattributed: [],
        residue,
        metrics,
        missingBoundaryCheckpoints,
      };
    } else {
      ownership = {
        label: 'CODE_ONLY',
        banner: hasThreads
          ? 'CODE-ONLY REVIEW: no account story was accepted — code is reviewed on its own; every row is unattributed residue.'
          : 'CODE-ONLY REVIEW: no captured threads on the floor — forensic findings over the entire diff as unattributed residue. No topology.',
        parts: [],
        contested: [],
        unattributed: [],
        residue,
        metrics,
        missingBoundaryCheckpoints,
      };
    }
  }

  // Ledger attachment: EVERY row lands on a Part or a residue, with a
  // disposition. No orphan rows (asserted by the caller's tests).
  const dispositionById = new Map(merge.dispositions.map((d) => [d.id, d.disposition]));
  const ledger: LedgerAttachment[] = projection.accountCore.ledger.map((row): LedgerAttachment => {
    const parts = new Set<string>();
    for (const anchor of row.anchors) {
      const p = partByRef.get(anchor);
      if (p !== undefined) parts.add(p);
    }
    for (const cit of row.citations) {
      const ref = citationToRef.get(cit);
      const p = ref !== undefined ? partByRef.get(ref) : undefined;
      if (p !== undefined) parts.add(p);
    }
    const attachment: LedgerAttachment['attachment'] =
      parts.size > 0
        ? { kind: 'part', partId: [...parts].sort(codePointCompare)[0]! }
        : {
            kind: 'residue',
            residue: row.kind === 'COVERAGE_GAP' ? 'unattributed' : 'floor',
          };
    // Every row carries the disposition the lane merge gave it, or OUTSTANDING.
    // No row can disposition itself: the deleted branch let a SUPERSESSION row
    // declare itself RECONCILED, which is a heuristic marking its own homework.
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      message: row.message,
      flagOnly: row.flagOnly === true,
      attachment,
      disposition: dispositionById.get(row.id) ?? 'OUTSTANDING',
    };
  });

  return {
    schema_version: SLICE_SCHEMA_VERSION,
    branch: dossier.branch,
    floor_input_hash: dossier.floor_input_hash,
    ownership,
    ledger,
    uncertainties,
    merge,
    story: account,
  };
}

// ---------------------------------------------------------------------------
// Standalone render — theory-led composition. NO install.
// ---------------------------------------------------------------------------

export interface SliceBrief {
  schema_version: typeof SLICE_SCHEMA_VERSION;
  branch: string;
  floor_input_hash: string;
  laneCounts: Record<Lane, { findings: number; questions: number } | null>;
  mustDecide: {
    id: string;
    lane: Lane;
    severity: string;
    text: string;
    file: string | null;
    relatedFiles: string[];
  }[];
  dispositions: LedgerDispositionRow[];
  /** Account Story topology counts (null when no story was accepted). */
  story: { acts: number; parts: number; questions: number } | null;
  /**
   * Files held out of the forensic diff by the explicit `review.stub_paths`
   * policy, enumerated with per-file counts. Empty when no policy is configured
   * or no changed file matched. Their rows land in the unattributed residue
   * (floor attribution is unchanged); marked here so they are not read as
   * capture failures.
   */
  policyStubs: { path: string; adds: number; dels: number; bytes: number; reason: string }[];
  /**
   * Composition ownership block — residues + capture-quality metrics.
   */
  ownership: {
    label: OwnershipLabel;
    banner: string;
    metrics: CaptureQualityMetrics;
    /** Per-Part row counts (segment identities live in composed-story-v2.json). */
    parts: { partId: string; changedRows: number; ambiguousRows: number; segments: number }[];
    contested: { file: string; hunkKey: string; lines: number; partIds: string[] }[];
    residue: OwnershipResidue;
    uncertainties: { unadjudicated: number };
    ledger: { attachedToPart: number; residue: number };
  };
}

export function renderSlice(input: {
  dossier: DossierV1;
  projection: AccountProjection;
  merge: SliceMergeResult;
  accountPresent: boolean;
  forensicPresent: boolean;
  /** The composition — drives the ownership banner/section and brief block. */
  composed: ComposedStory;
  /**
   * Files stubbed by the explicit `review.stub_paths` policy (from the forensic
   * input). Enumerated in review.md/brief.json; residue entries for these paths
   * are marked so they read as policy stubs, not capture failures. Default [].
   */
  policyStubs?: readonly PolicyStub[];
}): { markdown: string; brief: SliceBrief } {
  const { dossier, projection, merge, composed } = input;
  const policyStubs = input.policyStubs ?? [];
  const stubbedPaths = new Set(policyStubs.map((s) => s.path));
  const lines: string[] = [];
  const clip = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, n)}…`);
  const md = (t: string): string => t.replace(/\r?\n/g, ' ').replace(/`/g, '\\`');
  const code = (t: string): string => t.replace(/`/g, '');
  const renderRelatedFiles = (item: MergedItem): string =>
    item.relatedFiles.length === 0
      ? ''
      : ` · related: ${item.relatedFiles.map((file) => `\`${code(file)}\``).join(', ')}`;

  lines.push(`# Two-lane review — ${md(dossier.branch)}`);
  lines.push('');
  lines.push(
    `Floor \`${dossier.floor_input_hash.slice(0, 12)}\` · standalone slice output (no narrative install) · lanes: account ${input.accountPresent ? '✓' : '✗'} forensic ${input.forensicPresent ? '✓' : '✗'}`
  );
  lines.push('');
  lines.push(
    '_Findings reflect the payload-time head: lane payloads were produced against the floor above, not necessarily the current worktree._'
  );
  lines.push('');
  // Degradation banner — CODE-ONLY / DEGRADED ownership is stated loudly and
  // never conflated with a healthy derived review.
  if (composed.ownership.label !== 'DERIVED') {
    lines.push(`> **${md(composed.ownership.banner)}**`);
    lines.push('');
  }

  const story = merge.story;
  if (story !== null) {
    lines.push('## Overview');
    lines.push('');
    lines.push(md(story.overview.text));
    lines.push('');
  }

  // 1. Causal story — the account lane's topology + interpretation, led with.
  //    The model authored membership and interpretation only; code ownership is
  //    engine-derived (storyOwnership.ts) and not rendered inline here.
  lines.push('## Causal story');
  lines.push('');
  if (story === null || story.parts.length === 0) {
    lines.push('_(No causal story was produced by the account lane.)_');
    lines.push('');
  } else {
    const partsByAct = new Map<string, typeof story.parts>();
    const noAct: typeof story.parts = [];
    // A Part whose act no Act declares belongs with the ungrouped ones. The
    // alternative is silent loss: this bucketing is walked via `story.acts`
    // below, so a bucket no Act names is rendered by neither pass while the
    // Part still counts toward the brief's totals.
    const declaredActs = new Set(story.acts.map((a) => a.id));
    for (const p of story.parts) {
      if (!declaredActs.has(p.act)) noAct.push(p);
      else partsByAct.set(p.act, [...(partsByAct.get(p.act) ?? []), p]);
    }
    const renderPart = (p: (typeof story.parts)[number]) => {
      lines.push(
        `- **${md(p.title)}** (${p.checkpoint_refs.map((r) => `\`${code(r)}\``).join(', ')}) — ${md(clip(p.interpretation, 600))}`
      );
    };
    for (const act of story.acts) {
      lines.push(`### ${md(act.title)}`);
      if (act.interpretation !== undefined) lines.push(md(act.interpretation));
      for (const p of partsByAct.get(act.id) ?? []) renderPart(p);
      lines.push('');
    }
    if (noAct.length > 0) {
      if (story.acts.length > 0) lines.push('### (ungrouped)');
      for (const p of noAct) renderPart(p);
      lines.push('');
    }
  }

  // 1b. Ownership — derived Part segments, residues, and capture-quality metrics.
  const o = composed.ownership;
  lines.push(`## Ownership (${o.label})`);
  lines.push('');
  lines.push(md(o.banner));
  lines.push('');
  const m = o.metrics;
  lines.push(
    `${m.reviewableRows} reviewable row(s) · ${m.attributedRows} attributed (${m.attributedPct.toFixed(0)}%) · ${m.ambiguousRows} same-Part ambiguous · ${m.contestedRows} contested · ${m.unattributedRows} unattributed · ${m.contributingThreads} thread(s) / ${m.contributingCheckpoints} checkpoint(s)`
  );
  lines.push('');
  if (o.parts.length > 0) {
    for (const p of o.parts) {
      lines.push(
        `- **${md(p.partId)}** — ${p.changedRows} attributed row(s), ${p.segments.length} segment(s)${p.ambiguousRows > 0 ? `, ${p.ambiguousRows} ambiguous row(s)` : ''}`
      );
      // Segment identities are NOT enumerated here. Every one already lives
      // — richer, with ranges the TUI can navigate — in the story review
      // model. What a reader needs from this line is the shape of the Part,
      // so: the files it touches.
      if (p.segments.length === 0) {
        lines.push('  - _(context-only Part — owns no surviving code)_');
      } else {
        const files = [...new Set(p.segments.map((s) => s.file))].sort(codePointCompare);
        const shown = files.slice(0, 5).map((f) => `\`${code(f)}\``);
        lines.push(
          `  - ${shown.join(', ')}${files.length > shown.length ? ` + ${files.length - shown.length} more file(s)` : ''} — full segment ranges in ${STORY_MODEL_REF}`
        );
      }
    }
    lines.push('');
  }
  if (o.contested.length > 0) {
    lines.push(`### Contested (${o.contested.length})`);
    for (const c of o.contested)
      lines.push(
        `- \`${code(c.file)}\` — ${c.lines} row(s) claimed by ${c.partIds.map((p) => md(p)).join(', ')}`
      );
    lines.push('');
  }
  if (o.residue.files.length > 0) {
    // TWO INDEPENDENT MEASUREMENTS, never a causal split between them.
    //
    // The engine knows how many rows went unattributed, and it knows which
    // checkpoints were excluded for missing boundary snapshots. It does NOT
    // know how many of those rows each missing checkpoint would have owned —
    // that is precisely the information the missing snapshot destroyed. An
    // earlier draft of this section claimed exactly that split, which is the
    // same species of unearned assertion this whole change exists to remove.
    const stubbed = o.residue.files.filter((f) => stubbedPaths.has(f)).length;
    lines.push(
      `_Unattributed residue: ${o.residue.reviewableRows} row(s) across ${o.residue.files.length} file(s)${stubbed > 0 ? `, ${stubbed} of them policy-stubbed (expected — floor attribution is unchanged, not a capture failure)` : ''}. Files enumerated in ${BRIEF_REF}._`
    );
    if (o.missingBoundaryCheckpoints > 0) {
      lines.push('');
      lines.push(
        `_${o.missingBoundaryCheckpoints} checkpoint(s) were excluded from attribution because their boundary snapshots are missing. The engine cannot determine how many of the unattributed rows above those checkpoints would have owned — that is what the missing snapshots lost._`
      );
    }
    lines.push('');
  }
  // Policy-stubbed inventory (review.stub_paths): concise per-file row/byte
  // counts. The bytes were held out of the transport ceiling; the rows are
  // accounted here so nothing reads as silently dropped.
  if (policyStubs.length > 0) {
    const rows = policyStubs.reduce((n, x) => n + x.adds + x.dels, 0);
    const bytes = policyStubs.reduce((n, x) => n + x.bytes, 0);
    lines.push(
      `_Policy-stubbed (review.stub_paths): ${policyStubs.length} file(s), ${rows} row(s) / ${bytes} byte(s) held out of the forensic diff. Per-file counts and the reason for each in ${BRIEF_REF}._`
    );
    lines.push('');
  }
  if (composed.uncertainties.length > 0) {
    lines.push(
      `_Uncertainties: ${composed.uncertainties.length} captured, all unadjudicated — the capture format records no explicit resolution, so nothing here is marked settled._`
    );
    lines.push('');
  }

  // 2. Must decide (excluded from the file-clustered list below).
  lines.push('## Must decide');
  lines.push('');
  for (const m of merge.mustDecide)
    lines.push(
      `- **[${m.severity}]** (${m.lane}) ${md(clip(m.text, 600))}${m.file ? ` — \`${code(m.file)}\`` : ''}` +
        renderRelatedFiles(m)
    );
  lines.push('');

  // 4. Remaining findings, clustered by file; must-decide not repeated.
  const inMustDecide = new Set(merge.mustDecide.map((m) => m.id));
  const rest = merge.items.filter((x) => !inMustDecide.has(x.id));
  if (rest.length > 0) {
    lines.push('## Further findings and questions');
    lines.push('');
    const byFile = new Map<string, MergedItem[]>();
    for (const m of rest) {
      const key = m.file ?? '(unanchored)';
      const list = byFile.get(key);
      if (list) list.push(m);
      else byFile.set(key, [m]);
    }
    for (const [file, group] of [...byFile.entries()].sort((a, b) =>
      codePointCompare(a[0], b[0])
    )) {
      lines.push(`### \`${code(file)}\``);
      for (const m of group) {
        const fold = m.foldedWith ? ` _(also raised by ${m.foldedWith.join(', ')})_` : '';
        lines.push(
          `- [${m.severity}] (${m.lane} ${m.kind}) ${md(clip(m.text, 600))}${renderRelatedFiles(m)}${fold}`
        );
      }
      lines.push('');
    }
  }

  // 5. Ledger dispositions — counts by disposition and kind. The full rows,
  //    unclipped, are in brief.json AND the story model; enumerating them here
  //    a third time only bloats a review.md nobody could read by hand.
  lines.push(`## Claim ledger dispositions (${merge.dispositions.length})`);
  lines.push('');
  if (merge.dispositions.length === 0) {
    lines.push('_No ledger rows._');
  } else {
    const tally = (pick: (d: LedgerDispositionRow) => string): string => {
      const counts = new Map<string, number>();
      for (const d of merge.dispositions) counts.set(pick(d), (counts.get(pick(d)) ?? 0) + 1);
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || codePointCompare(a[0], b[0]))
        .map(([k, n]) => `${k} ${n}`)
        .join(' · ');
    };
    lines.push(`by disposition: ${tally((d) => d.disposition)}`);
    lines.push('');
    lines.push(`by kind: ${tally((d) => d.kind)}`);
    lines.push('');
    // OUTSTANDING rows are the ones a reader must actually face, so they are the
    // only ones named — and still capped, with the remainder counted.
    const outstanding = merge.dispositions.filter((d) => d.disposition === 'OUTSTANDING');
    if (outstanding.length > 0) {
      lines.push(`outstanding (${outstanding.length}), first ${Math.min(5, outstanding.length)}:`);
      for (const d of outstanding.slice(0, 5))
        lines.push(`- ${d.kind} [${d.status}]: ${md(clip(d.message, 200))}`);
      if (outstanding.length > 5)
        lines.push(`- _+${outstanding.length - 5} more — all rows, unclipped, in ${BRIEF_REF}._`);
    }
  }
  lines.push('');

  // 6. Account summary — counts, not a dump.
  const c = projection.accountCore;
  const decisionCount = c.checkpoints.reduce((n, cp) => n + cp.decisions.length, 0);
  const uncertaintyCount = c.checkpoints.reduce((n, cp) => n + cp.uncertainty.length, 0);
  lines.push('## Captured account (summary)');
  lines.push('');
  lines.push(
    `${c.planSteps.length} plan step(s) · ${c.checkpoints.length} checkpoint(s) · ${decisionCount} decision(s) · ${uncertaintyCount} uncertainty item(s) · ${c.nonGoals.length} non-goal(s) — full record in dossier-v1.json`
  );
  lines.push('');

  const brief: SliceBrief = {
    schema_version: SLICE_SCHEMA_VERSION,
    branch: dossier.branch,
    floor_input_hash: dossier.floor_input_hash,
    laneCounts: {
      account: input.accountPresent
        ? {
            findings: merge.items.filter((x) => x.lane === 'account' && x.kind === 'finding')
              .length,
            questions: merge.items.filter((x) => x.lane === 'account' && x.kind === 'question')
              .length,
          }
        : null,
      forensic: input.forensicPresent
        ? {
            findings: merge.items.filter((x) => x.lane === 'forensic' && x.kind === 'finding')
              .length,
            questions: merge.items.filter((x) => x.lane === 'forensic' && x.kind === 'question')
              .length,
          }
        : null,
    },
    mustDecide: merge.mustDecide.map((m) => ({
      id: m.id,
      lane: m.lane,
      severity: m.severity,
      text: m.text,
      file: m.file,
      relatedFiles: [...m.relatedFiles],
    })),
    dispositions: merge.dispositions,
    story: merge.story
      ? {
          acts: merge.story.acts.length,
          parts: merge.story.parts.length,
          questions: merge.story.questions.length,
        }
      : null,
    policyStubs: policyStubs.map((s) => ({
      path: s.path,
      adds: s.adds,
      dels: s.dels,
      bytes: s.bytes,
      reason: s.reason,
    })),
    ownership: {
      label: composed.ownership.label,
      banner: composed.ownership.banner,
      metrics: composed.ownership.metrics,
      parts: composed.ownership.parts.map((p) => ({
        partId: p.partId,
        changedRows: p.changedRows,
        ambiguousRows: p.ambiguousRows,
        segments: p.segments.length,
      })),
      contested: composed.ownership.contested.map((c) => ({
        file: c.file,
        hunkKey: c.hunkKey,
        lines: c.lines,
        partIds: c.partIds,
      })),
      residue: composed.ownership.residue,
      uncertainties: { unadjudicated: composed.uncertainties.length },
      ledger: {
        attachedToPart: composed.ledger.filter((l) => l.attachment.kind === 'part').length,
        residue: composed.ledger.filter((l) => l.attachment.kind === 'residue').length,
      },
    },
  };
  return { markdown: lines.join('\n'), brief };
}

/**
 * The single canonical citation universe behind the prompt's globally unique
 * `c#` aliases. Alias generation and compilation both consume this set, so a
 * model cannot author an unmapped canonical citation id.
 */
export type AccountEvaluatorRun = AccountProjection['accountCore']['evaluatorRuns'][number];

export interface AccountEvaluatorPartition<T extends AccountEvaluatorRun = AccountEvaluatorRun> {
  /** Routine outcomes represented by artifact-local counts, never aliases. */
  summarized: T[];
  /** Exception rows rendered individually with aliases. */
  expanded: T[];
}

/**
 * Partition evaluator rows without interpreting their prose. Only explicit
 * routine outcomes with no disposition may collapse into a count. Every
 * anomalous or semantically material row stays expanded.
 */
export function partitionAccountEvaluatorRuns<T extends AccountEvaluatorRun>(
  runs: readonly T[]
): AccountEvaluatorPartition<T> {
  const summarized: T[] = [];
  const expanded: T[] = [];
  for (const run of runs) {
    const metadata = run.evaluator;
    const routineCompleted =
      metadata.run_status === 'completed' &&
      (metadata.verdict === 'pass' || metadata.verdict === 'info') &&
      metadata.disposition === null;
    const benignSkipped =
      metadata.run_status === 'skipped' &&
      metadata.verdict === null &&
      metadata.severity !== 'block' &&
      metadata.disposition === null;
    (routineCompleted || benignSkipped ? summarized : expanded).push(run);
  }
  return { summarized, expanded };
}

/** Collect the account id universe, optionally including summarized evaluators. */
function collectAccountCitationIds(
  projection: AccountProjection,
  includeSummarizedEvaluatorRuns: boolean
): Set<string> {
  const ids = new Set<string>();
  const c = projection.accountCore;
  for (const cp of c.checkpoints) {
    for (const d of cp.decisions) {
      ids.add(d.citationId);
      for (const a of d.alternatives) ids.add(a.citationId);
    }
    for (const u of cp.uncertainty) ids.add(u.citationId);
  }
  // Plan decisions carry their rejected alternatives nested, exactly as
  // checkpoint decisions do, and the renderer brackets both.
  for (const d of c.planDecisions) {
    ids.add(d.citationId);
    for (const a of d.alternatives) ids.add(a.citationId);
  }
  for (const list of [
    c.planSteps,
    c.nonGoals,
    c.acceptanceCriteria,
    c.criterionEvidence,
    c.verification,
  ])
    for (const i of list) ids.add(i.citationId);
  const evaluatorRuns = c.evaluatorRuns;
  const visibleEvaluatorRuns = includeSummarizedEvaluatorRuns
    ? evaluatorRuns
    : partitionAccountEvaluatorRuns(evaluatorRuns).expanded;
  for (const run of visibleEvaluatorRuns) ids.add(run.citationId);
  // The criterion an evidence record evidences is itself rendered [bracketed]
  // above the nested evidence. In a healthy build every parent is already an
  // `acceptanceCriteria` id; adding it explicitly keeps bracketed-iff-citable
  // true even if a parent ever names something else.
  for (const e of c.criterionEvidence) if (e.parent !== undefined) ids.add(e.parent);
  for (const row of c.ledger) {
    ids.add(row.id);
    // Served cited-text ids carry their evidence verbatim — citable.
    for (const cid of Object.keys(row.citedFallback)) ids.add(cid);
  }
  return ids;
}

export function accountCitableIds(projection: AccountProjection): Set<string> {
  return collectAccountCitationIds(projection, false);
}

export interface AccountPromptAliases {
  checkpoints: Array<{
    alias: string;
    canonical: string;
  }>;
  citations: Array<{ alias: string; canonical: string }>;
}

/** Deterministic, globally unique aliases for one account prompt. */
export function buildAccountPromptAliases(projection: AccountProjection): AccountPromptAliases {
  const completed = projection.accountCore.checkpoints.map(
    (checkpoint) => `${checkpoint.artifact}:cp${checkpoint.cp}`
  );
  const visibleCitations = accountCitableIds(projection);
  // Assign ordinals across the complete stored universe, THEN withhold hidden
  // evaluator rows. This leaves deliberate gaps (c7, c9, ...), but keeps every
  // visible alias stable and makes a formerly-known hidden alias reject as
  // unknown instead of silently shifting onto a different record.
  const citations = [...collectAccountCitationIds(projection, true)]
    .sort(codePointCompare)
    .map((canonical, index) => ({ alias: `c${index + 1}`, canonical }))
    .filter((entry) => visibleCitations.has(entry.canonical));
  return {
    checkpoints: completed.map((canonical, index) => ({
      alias: `k${index + 1}`,
      canonical,
    })),
    citations,
  };
}

export function sliceContext(
  dossier: DossierV1,
  projection: AccountProjection,
  lane: Lane
): SliceValidationContext {
  const diffFiles = new Set<string>();
  for (const f of dossier.file_index) {
    if (lane === 'forensic' && f.capture) continue;
    if (f.oldPath !== null) diffFiles.add(f.oldPath);
    if (f.newPath !== null) diffFiles.add(f.newPath);
  }
  // The projection's checkpoints are exactly the in-scope completed
  // checkpoints; the outline carries closed checkpoints only.
  const completedCheckpointRefs =
    lane === 'account'
      ? new Set(projection.accountCore.checkpoints.map((cp) => `${cp.artifact}:cp${cp.cp}`))
      : new Set<string>();
  const aliases =
    lane === 'account' ? buildAccountPromptAliases(projection) : { checkpoints: [], citations: [] };
  return {
    diffFiles,
    completedCheckpointRefs,
    checkpointAliases: new Map(aliases.checkpoints.map((entry) => [entry.alias, entry.canonical])),
    citationAliases: new Map(aliases.citations.map((entry) => [entry.alias, entry.canonical])),
  };
}
