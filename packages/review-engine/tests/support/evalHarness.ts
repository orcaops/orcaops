// Test-only evaluation harness. Rows are emitted by code
// from mechanical inputs — the harness's own clock and the workflow
// journal's per-agent records — never self-reported. One population rule;
// nearest-rank percentiles; blinded forms for adjudication. The probe
// manifest is the frozen registration.

import { z } from 'zod';

export const HARNESS_ROW_SCHEMA_VERSION = 1;

export const harnessRowSchema = z
  .object({
    schema_version: z.literal(HARNESS_ROW_SCHEMA_VERSION),
    runId: z.string().min(1),
    arm: z.enum(['two-lane', 'two-lane-induced-repair', 'baseline']),
    subject: z.string().min(1),
    /** Harness clock, ms since epoch — dossier build start / rendered end. */
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    phases: z.object({
      dossierMs: z.number().nonnegative(),
      laneWallMs: z.number().nonnegative(),
      mergeRenderMs: z.number().nonnegative(),
    }),
    lanes: z.object({
      account: z
        .object({ tokens: z.number().int().nonnegative(), durationMs: z.number().nonnegative() })
        .nullable(),
      forensic: z
        .object({ tokens: z.number().int().nonnegative(), durationMs: z.number().nonnegative() })
        .nullable(),
    }),
    repairs: z.number().int().nonnegative(),
    repairPenaltyMs: z.number().nonnegative(),
    outcome: z.enum(['FULL', 'DEGRADED', 'FAILED']),
    /** ALL calls of the run — initial + repair + failed (cost contract). */
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.endedAtMs < r.startedAtMs)
      ctx.addIssue({ code: 'custom', message: 'endedAtMs before startedAtMs' });
    const laneCount = (r.lanes.account ? 1 : 0) + (r.lanes.forensic ? 1 : 0);
    if (r.arm !== 'baseline') {
      if (r.outcome === 'FULL' && laneCount !== 2)
        ctx.addIssue({ code: 'custom', message: 'FULL requires both lanes present' });
      if (r.outcome === 'DEGRADED' && laneCount !== 1)
        ctx.addIssue({ code: 'custom', message: 'DEGRADED requires exactly one lane' });
    }
    if (r.repairs > 1)
      ctx.addIssue({ code: 'custom', message: 'repairs exceed the single global credit' });
    const phaseSum = r.phases.dossierMs + r.phases.laneWallMs + r.phases.mergeRenderMs;
    if (phaseSum > (r.endedAtMs - r.startedAtMs) * 1.05 + 50)
      ctx.addIssue({ code: 'custom', message: 'phase totals exceed elapsed wall clock' });
    const laneTokens = (r.lanes.account?.tokens ?? 0) + (r.lanes.forensic?.tokens ?? 0);
    if (r.totalTokens < laneTokens)
      ctx.addIssue({
        code: 'custom',
        message: 'totalTokens below per-lane sum (must count every call)',
      });
  });

export type HarnessRow = z.infer<typeof harnessRowSchema>;

export class HarnessRowError extends Error {}

/** Validate a mechanically-assembled row; throws loudly on any shape drift. */
export function finalizeRow(row: unknown): HarnessRow {
  const parsed = harnessRowSchema.safeParse(row);
  if (!parsed.success)
    throw new HarnessRowError(
      `harness row invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  return parsed.data;
}

/** Nearest-rank percentile as registered in the probe manifest. */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface PopulationReport {
  populationSize: number;
  outputProducing: number;
  failedRate: number;
  degradedRate: number;
  endToEndMs: { p50: number; p95: number };
  perReviewTokens: { p50: number; p95: number };
  repairFrequency: number;
  meanRepairPenaltyMs: number;
}

/**
 * ONE population rule (registered): every attempted run is the population;
 * latency/token percentiles are over output-producing runs (degraded
 * included); failure and degraded rates use the full population.
 */
export function aggregate(rows: readonly HarnessRow[]): PopulationReport {
  const population = rows.length;
  const producing = rows.filter((r) => r.outcome !== 'FAILED');
  const lat = producing.map((r) => r.endedAtMs - r.startedAtMs).sort((a, b) => a - b);
  const tok = producing.map((r) => r.totalTokens).sort((a, b) => a - b);
  const repairs = rows.reduce((n, r) => n + r.repairs, 0);
  const penalties = rows.filter((r) => r.repairs > 0).map((r) => r.repairPenaltyMs);
  return {
    populationSize: population,
    outputProducing: producing.length,
    failedRate:
      population === 0 ? 0 : rows.filter((r) => r.outcome === 'FAILED').length / population,
    degradedRate:
      population === 0 ? 0 : rows.filter((r) => r.outcome === 'DEGRADED').length / population,
    endToEndMs: { p50: nearestRank(lat, 50), p95: nearestRank(lat, 95) },
    perReviewTokens: { p50: nearestRank(tok, 50), p95: nearestRank(tok, 95) },
    repairFrequency: population === 0 ? 0 : repairs / population,
    meanRepairPenaltyMs:
      penalties.length === 0 ? 0 : penalties.reduce((a, b) => a + b, 0) / penalties.length,
  };
}

export interface GateVerdict {
  verdict: 'COMPETITIVE' | 'PAUSE_AND_OPTIMIZE';
  relativeLatency: number;
  absoluteP50Ms: number;
  perReviewTokensP50: number;
  perReviewTokensP95: number;
  maxRunTokens: number;
  failedHappyPath: number;
  fullRate: number;
  repairRecoveries: { recovered: number; attempted: number };
  laneValueEvidenced: boolean;
  reasons: string[];
  thresholds: {
    relativeLatencyMax: number;
    absoluteP50MsMax: number;
    tokensP50Max: number;
    perRunTokenCeiling: number;
    minFullRate: number;
  };
}

export interface GateExtras {
  /** Every row, so reliability terms see failures the percentiles exclude. */
  twoLaneRows: readonly HarnessRow[];
  inducedRepairRows: readonly HarnessRow[];
  /** Adjudicated: both lanes contributed unique real findings. */
  laneValueEvidenced: boolean;
}

/**
 * Gate v2: ALL terms or pause — relative AND absolute
 * latency, all-calls p50 tokens, the 130k per-run ceiling, reliability
 * (failures are part of the verdict, not just the report), repair
 * recovery, and adjudicated lane value.
 */
export function platformGate(
  twoLane: PopulationReport,
  baseline: PopulationReport,
  extras: GateExtras
): GateVerdict {
  const thresholds = {
    relativeLatencyMax: 2.0,
    absoluteP50MsMax: 180_000,
    tokensP50Max: 70_000,
    perRunTokenCeiling: 130_000,
    minFullRate: 0.95,
  };
  const relativeLatency = twoLane.endToEndMs.p50 / baseline.endToEndMs.p50;
  const failedHappyPath = extras.twoLaneRows.filter((r) => r.outcome === 'FAILED').length;
  const fullRate =
    extras.twoLaneRows.length === 0
      ? 0
      : extras.twoLaneRows.filter((r) => r.outcome === 'FULL').length / extras.twoLaneRows.length;
  const maxRunTokens = Math.max(
    0,
    ...extras.twoLaneRows.map((r) => r.totalTokens),
    ...extras.inducedRepairRows.map((r) => r.totalTokens)
  );
  const recovered = extras.inducedRepairRows.filter(
    (r) => r.outcome === 'FULL' && r.repairs <= 1
  ).length;
  const reasons: string[] = [];
  if (!(relativeLatency <= thresholds.relativeLatencyMax))
    reasons.push(
      `relative latency ${relativeLatency.toFixed(2)} > ${thresholds.relativeLatencyMax}`
    );
  if (!(twoLane.endToEndMs.p50 <= thresholds.absoluteP50MsMax))
    reasons.push(`absolute p50 ${twoLane.endToEndMs.p50}ms > ${thresholds.absoluteP50MsMax}ms`);
  if (!(twoLane.perReviewTokens.p50 <= thresholds.tokensP50Max))
    reasons.push(`p50 tokens ${twoLane.perReviewTokens.p50} > ${thresholds.tokensP50Max}`);
  if (!(maxRunTokens <= thresholds.perRunTokenCeiling))
    reasons.push(`per-run ceiling breached: ${maxRunTokens} > ${thresholds.perRunTokenCeiling}`);
  if (failedHappyPath > 0) reasons.push(`${failedHappyPath} failed happy-path run(s)`);
  if (!(fullRate >= thresholds.minFullRate))
    reasons.push(`FULL rate ${(fullRate * 100).toFixed(0)}% < ${thresholds.minFullRate * 100}%`);
  if (recovered < extras.inducedRepairRows.length)
    reasons.push(`repairs recovered ${recovered}/${extras.inducedRepairRows.length}`);
  if (!extras.laneValueEvidenced) reasons.push('lane value not evidenced by adjudication');
  return {
    verdict: reasons.length === 0 ? 'COMPETITIVE' : 'PAUSE_AND_OPTIMIZE',
    relativeLatency,
    absoluteP50Ms: twoLane.endToEndMs.p50,
    perReviewTokensP50: twoLane.perReviewTokens.p50,
    perReviewTokensP95: twoLane.perReviewTokens.p95,
    maxRunTokens,
    failedHappyPath,
    fullRate,
    repairRecoveries: { recovered, attempted: extras.inducedRepairRows.length },
    laneValueEvidenced: extras.laneValueEvidenced,
    reasons,
    thresholds,
  };
}

// ---------------------------------------------------------------------------
// Workflow-journal extraction: per-agent tokens/durations, mechanically.
// ---------------------------------------------------------------------------

export interface JournalAgent {
  agentId: string;
  result: unknown;
}

export function parseJournal(journalJsonl: string): JournalAgent[] {
  const agents: JournalAgent[] = [];
  for (const line of journalJsonl.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as { type?: string; agentId?: string; result?: unknown };
    if (record.type === 'result' && typeof record.agentId === 'string')
      agents.push({ agentId: record.agentId, result: record.result });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Blinded forms: strip arm/lane identity for adjudication.
// ---------------------------------------------------------------------------

export interface BlindedFinding {
  /** Stable content key for the score matrix. */
  key: string;
  claim: string;
  file: string | null;
  severity: string;
}

export interface BlindedForm {
  /** Opaque form id — carries NO arm/subject/lane identity. */
  formId: string;
  findings: BlindedFinding[];
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/**
 * Deterministic blinding: content-keyed findings, form ids derived from a
 * salt + content so the mapping is reproducible by the harness (which keeps
 * the key file) while the adjudicator sees no identities.
 */
export function blindForm(
  salt: string,
  findings: readonly { claim: string; file?: string | null; severity: string }[]
): BlindedForm {
  const blinded = findings
    .map((f) => ({
      key: fnv(`${f.claim}|${f.file ?? ''}`),
      claim: f.claim,
      file: f.file ?? null,
      severity: f.severity,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { formId: fnv(`${salt}|${blinded.map((b) => b.key).join(',')}`), findings: blinded };
}
