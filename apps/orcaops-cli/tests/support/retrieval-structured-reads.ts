import type { RetrievalCorpus } from './retrieval-corpus.js';
import {
  fieldFamilies,
  type FieldFamily,
  type RetrievalCase,
} from '../fixtures/retrieval-corpus/cases.js';

export const structuredReads = ['decisions', 'loose-ends', 'step brief'] as const;
export type StructuredRead = (typeof structuredReads)[number];

export interface StructuredReadMeasurement {
  /** Distinct texts each read returned over the whole corpus; none of them takes a query. */
  volume: Record<StructuredRead, { calls: number; texts: number }>;
  /** Expected records of the family's cases whose wording a read returned for the artifact. */
  coverage: Record<
    FieldFamily,
    { expectedRecords: number; present: Record<StructuredRead, number> }
  >;
}

interface DecisionsOutput {
  results: Array<{
    artifact_id: string;
    records: Array<{
      decision: string;
      reason: string | null;
      alternatives_considered?: Array<{ option: string; rejected_because: string }>;
    }>;
  }>;
}
interface LooseEndsOutput {
  results: Array<{
    artifact_id: string;
    open_items: Array<{ text: string }>;
    deferred_decisions: Array<{ text: string }>;
    uncertainty: Array<{ entries: string[] }>;
  }>;
}
interface StepBriefOutput {
  artifact_id: string;
  step: { acceptance_criteria: Array<{ text: string }> };
  guardrails: { non_goals: Array<{ text: string; rationale: string }> };
}

async function read<T>(corpus: RetrievalCorpus, args: string[]): Promise<T> {
  const raw = await corpus.agent.runRaw([...args, '--json']);
  if (raw.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${raw.stdout}${raw.stderr}`);
  return JSON.parse(raw.stdout) as T;
}

const textKey = (artifactId: string, text: string) => `${artifactId}\n${text}`;

export async function measureStructuredReads(
  corpus: RetrievalCorpus,
  cases: readonly RetrievalCase[]
): Promise<StructuredReadMeasurement> {
  const scope = ['--scope', 'project', '--origin', 'captured'];
  const decisions = await read<DecisionsOutput>(corpus, ['decisions', ...scope]);
  const looseEnds = await read<LooseEndsOutput>(corpus, ['loose-ends', ...scope]);
  const stepIds = Object.values(corpus.artifacts).flatMap((artifact) => {
    const standingPlan = artifact.events.find(
      (event) => event.type.startsWith('plan_') && event.supersededBy === null
    );
    const steps = (standingPlan?.payload.plan_steps ?? []) as Array<{ step_id: string }>;
    return steps.map((step) => ({ artifactId: artifact.artifactId, stepId: step.step_id }));
  });
  const briefs: StepBriefOutput[] = [];
  for (const { artifactId, stepId } of stepIds)
    briefs.push(
      await read<StepBriefOutput>(corpus, ['step', 'brief', stepId, '--artifact', artifactId])
    );

  const texts: Record<StructuredRead, Set<string>> = {
    decisions: new Set(
      decisions.results.flatMap((artifact) =>
        artifact.records.flatMap((record) =>
          [
            record.decision,
            record.reason,
            ...(record.alternatives_considered ?? []).flatMap((alternative) => [
              alternative.option,
              alternative.rejected_because,
            ]),
          ].flatMap((text) => (text === null ? [] : [textKey(artifact.artifact_id, text)]))
        )
      )
    ),
    'loose-ends': new Set(
      looseEnds.results.flatMap((artifact) =>
        [
          ...artifact.open_items.map((item) => item.text),
          ...artifact.deferred_decisions.map((item) => item.text),
          ...artifact.uncertainty.flatMap((checkpoint) => checkpoint.entries),
        ].map((text) => textKey(artifact.artifact_id, text))
      )
    ),
    'step brief': new Set(
      briefs.flatMap((brief) =>
        [
          ...brief.step.acceptance_criteria.map((criterion) => criterion.text),
          ...brief.guardrails.non_goals.flatMap((nonGoal) => [nonGoal.text, nonGoal.rationale]),
        ].map((text) => textKey(brief.artifact_id, text))
      )
    ),
  };

  const coverage = {} as StructuredReadMeasurement['coverage'];
  for (const family of Object.keys(fieldFamilies) as FieldFamily[]) {
    const records = new Map(
      cases
        .filter((retrievalCase) => retrievalCase.family === family)
        .flatMap((retrievalCase) => retrievalCase.expected)
        .map((record) => [`${record.artifact} ${record.event} ${record.path}`, record])
    );
    const present = (command: StructuredRead) =>
      [...records.values()].filter((record) =>
        texts[command].has(textKey(corpus.resolve(record).artifactId, record.wording))
      ).length;
    coverage[family] = {
      expectedRecords: records.size,
      present: {
        decisions: present('decisions'),
        'loose-ends': present('loose-ends'),
        'step brief': present('step brief'),
      },
    };
  }
  return {
    volume: {
      decisions: { calls: 1, texts: texts.decisions.size },
      'loose-ends': { calls: 1, texts: texts['loose-ends'].size },
      'step brief': { calls: briefs.length, texts: texts['step brief'].size },
    },
    coverage,
  };
}
