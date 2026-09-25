// The observation a retained evaluator run is, and the source occurrence it was read from.
//
// The run's context record is what makes the basis nameable at all: the digest of the prepared
// input the runner handed the producer, and the base and head the run saw. Only the first is an
// input this record can say was consumed — the runner built it and handed it over — so the basis
// is `partial` and never snapshot-bound. The two commits are what the run saw, and a commit a run
// saw is not a commit anything establishes it read: that is exactly the claim §8 refuses.
//
// Both identities are derived from the run id rather than minted, because a settlement has no
// caller to name them and a replayed settlement has to write the same two rows.
import { type Observation, type SourceOccurrence } from '../../schema/knowledge-contract.js';

const RUNNER = 'orcaops-evaluator-runner';

/** The source and observation identity a run carries, so a reader can reach both from the run. */
export const evaluatorRunRecordId = (runId: string): string => `evaluator-run:${runId}`;

const NOBODY = { identity: null, basis: 'unknown' } as const;

export interface EvaluatorRunObservationInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly eventId: string;
  readonly fieldPath: string;
  readonly position: number;
  readonly evaluatorRef: string;
  readonly contextSha256: string;
  readonly baseSha: string | null;
  readonly headSha: string | null;
}

/** The source is always the capture field the run is stated at, which the settlement reads back. */
export type EvaluatorResultSource = SourceOccurrence & {
  occurrence: Extract<SourceOccurrence['occurrence'], { kind: 'capture_field' }>;
};

export interface EvaluatorRunObservationRecords {
  readonly source: EvaluatorResultSource;
  readonly observation: Observation;
}

export function evaluatorRunObservationRecords(
  input: EvaluatorRunObservationInput
): EvaluatorRunObservationRecords {
  const id = evaluatorRunRecordId(input.runId);
  const consumed: Observation['known_inputs'] = [
    { kind: 'evaluator_context', identity: input.contextSha256 },
  ];
  const seen: Observation['known_inputs'] = [
    ...(input.baseSha === null
      ? []
      : ([{ kind: 'git_commit', identity: input.baseSha }] as Observation['known_inputs'])),
    ...(input.headSha === null
      ? []
      : ([{ kind: 'git_commit', identity: input.headSha }] as Observation['known_inputs'])),
  ];
  return {
    source: {
      source_id: id,
      occurrence: {
        kind: 'capture_field',
        artifact_id: input.artifactId,
        event_id: input.eventId,
        field_path: input.fieldPath,
        position: input.position,
      },
      source_author: NOBODY,
      recorded_by: NOBODY,
      interpreted_by: null,
      access_restriction: null,
    },
    observation: {
      observation_id: id,
      // Nobody observed it: a runner is not a person, and the runner that established the
      // execution is named where an execution says who established it.
      observer: NOBODY,
      source_id: id,
      // The digest covers the prepared context together with the evaluator's own resolved
      // parameters, so it is this method's configuration and the input the producer consumed at
      // once. One value written in one place cannot disagree with itself.
      method: { name: input.evaluatorRef, configuration_sha256: input.contextSha256 },
      execution: { kind: 'runner_established', runner: RUNNER, consumed_inputs: consumed },
      input_basis: 'partial',
      known_inputs: [...consumed, ...seen],
      // The verdict belongs to the run event, which owns the run's identity fields; restating it
      // here would be a second place for it to disagree.
      outcome: 'observed',
      detail: null,
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits:
        seen.length === 0
          ? ['the run saw a working tree this record does not identify']
          : [
              'the base and head commits are what the run saw; nothing establishes which of that tree the producer read',
            ],
    },
  };
}
