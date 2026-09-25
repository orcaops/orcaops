// Publishing an observation: what a tool or a person recorded about identified inputs, and on
// what basis. An agent-reported command and a runner-established execution are distinct facts,
// and only an execution that consumed exactly the inputs the observation names supports a
// snapshot-bound claim — a checkpoint number, repository HEAD or equal before and after hashes do
// not, which is why the table holds that rule rather than this writer alone.
//
// The table's rule is about the shape of a record, and a caller satisfies it by writing one array
// twice. What a runner established is not a shape, so it is not something a caller may state:
// `publishProjectObservation` refuses `runner_established` outright, and
// `publishProjectObservedRun` builds it from a run `runObservedProcess` returned and from nothing
// else. That second entry point is deliberately absent from this directory's barrel; the runner is
// the only way to reach it, and the evaluator settlement reaches `insertObservation` directly.
//
// An observation changes nothing that stands, so it moves the write sequence and leaves the
// intent counter alone, whoever published it.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { type ObservedRun, runnerEstablished } from './knowledge-observed-run.js';
import {
  actingField,
  authoredRecord,
  composedRecord,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  requireRetainedSources,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  type Observation,
  ObservationSchema,
} from '../../schema/knowledge-contract.js';

export type InputIdentity = Observation['known_inputs'][number];

/**
 * The lookup copy the table compares. Input identities are a set, so the copy is sorted: the
 * schema decides "consumed exactly what it knows" by comparing these two strings, and that is
 * only the contract's own member comparison if the order a caller happened to write them in is
 * gone first.
 */
const inputKey = (input: InputIdentity) => JSON.stringify([input.kind, input.identity]);

// A plain code-unit comparison, three-way: a comparator that never returns 0 is inconsistent, and
// `localeCompare` would order the same inputs differently under different locale data, so the same
// set could be stored as two different strings.
const byKey = (left: InputIdentity, right: InputIdentity): number => {
  const [a, b] = [inputKey(left), inputKey(right)];
  return a < b ? -1 : a > b ? 1 : 0;
};

export const canonicalInputs = (inputs: readonly InputIdentity[]): string =>
  canonicalJson([...inputs].sort(byKey));

export interface PublishObservation {
  readonly operationId: string;
  /** The observation as authored, without `observer`. */
  readonly observation: unknown;
  /** Who observed it, which a publishing session will own once storage has one. */
  readonly observedBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ObservationPublication = {
  observationId: string;
  recordSha256: string;
};

/**
 * The columns an observation row carries, written from one parsed record. The materializer of an
 * evaluator run's observation writes through here too, which is what keeps a run's observation and
 * a published one the same shape.
 */
export function insertObservation(
  transaction: ProjectSettlement,
  observation: Observation,
  record: { bytes: Buffer; sha256: string },
  operationId: string,
  evaluatorRunId: string | null
): void {
  const execution = observation.execution;
  transaction.run(
    `INSERT INTO knowledge_observations (observation_id, source_id, observed_by, observed_by_basis,
       method_name, method_configuration_sha256, execution_kind, runner, consumed_inputs_json,
       input_basis, known_inputs_json, outcome, started_at, finished_at, evaluator_run_id,
       record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    observation.observation_id,
    observation.source_id,
    observation.observer.identity,
    observation.observer.basis,
    observation.method.name,
    observation.method.configuration_sha256,
    execution.kind,
    execution.kind === 'runner_established' ? execution.runner : null,
    execution.kind === 'runner_established' ? canonicalInputs(execution.consumed_inputs) : null,
    observation.input_basis,
    canonicalInputs(observation.known_inputs),
    observation.outcome,
    observation.started_at,
    observation.finished_at,
    evaluatorRunId,
    record.bytes,
    record.sha256,
    operationId
  );
}

/**
 * What somebody recorded. `runner_established` is refused: a caller states what it saw, and what a
 * runner established about the inputs a process consumed is not a thing to state.
 */
export async function publishProjectObservation(
  handle: ProjectDatabase,
  input: PublishObservation,
  options: ProjectOperationOptions = {}
) {
  return publish(handle, input, options, false);
}

async function publish(
  handle: ProjectDatabase,
  input: PublishObservation,
  options: ProjectOperationOptions,
  fromRunner: boolean
) {
  const operationId = operationIdentity(input.operationId);
  const observation = parsed(
    ObservationSchema,
    actingField(input.observation, 'observer', input.observedBy),
    'An observation'
  );
  if (!fromRunner && observation.execution.kind === 'runner_established')
    invalid(
      'A recorded observation is agent-reported or a human observation: what a runner established ' +
        'about the inputs a process consumed is not something a caller states'
    );
  const record = authoredRecord(observation, secretAllowList(input.secretAllow));
  const op = {
    operationId,
    kind: 'knowledge.observation.publish',
    target: { observationId: observation.observation_id },
    payload: { record: record.sha256 },
    expectedState: null,
    // An observation establishes nothing about a requirement or a decision, so it is not a change
    // of intent and never makes an earlier assessment eligible again.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const check = (view: ProjectReadView) => {
    if (
      view.get(
        'SELECT observation_id FROM knowledge_observations WHERE observation_id=?',
        observation.observation_id
      )
    )
      taken('That observation ID already belongs to retained history');
    requireRetainedSources(view, [observation.source_id]);
  };
  handle.read((view) => {
    check(view);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): ObservationPublication => {
      check(transaction);
      // An observation a caller publishes names no evaluator run: the run's own observation is
      // written by the settlement that retains the run, and a second one naming it would be a
      // second account of one execution.
      insertObservation(transaction, observation, record, operationId, null);
      return { observationId: observation.observation_id, recordSha256: record.sha256 };
    },
    options
  );
}

export interface PublishObservedRun {
  readonly operationId: string;
  /** The identity, the source and the method; the run supplies everything it established. */
  readonly observation: unknown;
  /** Who ran it, which a publishing session will own once storage has one. */
  readonly observedBy: Actor;
  /** The run, as {@link runObservedProcess} returned it. */
  readonly run: ObservedRun;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

/**
 * Publishing what a runner established. Deliberately not exported from this directory's barrel: a
 * caller reaches it through `runObservedProcess`, whose result is the only thing it accepts, and
 * the execution, the basis and the input identities come from that run rather than from the
 * caller's record.
 */
export async function publishProjectObservedRun(
  handle: ProjectDatabase,
  input: PublishObservedRun,
  options: ProjectOperationOptions = {}
) {
  // An object shaped like a run is not a run: only what this runner produced is in its set.
  if (
    input.run === null ||
    typeof input.run !== 'object' ||
    !runnerEstablished(input.run as ObservedRun)
  )
    invalid('A runner-established observation is published from a run this runner established');
  return publish(
    handle,
    {
      operationId: input.operationId,
      // The run supplies every field it established, and a caller that names one of them is
      // refused, so the two can never disagree about what ran.
      observation: composedRecord(input.observation, { ...input.run.observation }),
      observedBy: input.observedBy,
      secretAllow: input.secretAllow,
    },
    options,
    true
  );
}

/** Every observation the record names that this history does not hold. */
export function unretainedObservations(
  view: ProjectReadView,
  observationIds: readonly string[]
): string[] {
  return observationIds.filter(
    (observationId) =>
      !view.get(
        'SELECT observation_id FROM knowledge_observations WHERE observation_id=?',
        observationId
      )
  );
}

export function requireRetainedObservations(
  view: ProjectReadView,
  observationIds: readonly string[]
): void {
  if (unretainedObservations(view, observationIds).length)
    missing('The record rests on an observation this history does not hold');
}

export interface ProjectObservationRow {
  readonly observationId: string;
  readonly sourceId: string;
  readonly observedBy: string | null;
  readonly observedByBasis: string;
  readonly method: { name: string; configurationSha256: string | null };
  readonly executionKind: string;
  readonly runner: string | null;
  /** The identities the execution consumed, sorted; null unless a runner established them. */
  readonly consumedInputs: InputIdentity[] | null;
  readonly inputBasis: string;
  readonly knownInputs: InputIdentity[];
  readonly outcome: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The evaluator run this observation is of, when a run's settlement wrote it. */
  readonly evaluatorRunId: string | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

interface ObservationSelection {
  observation_id: string;
  source_id: string;
  observed_by: string | null;
  observed_by_basis: string;
  method_name: string;
  method_configuration_sha256: string | null;
  execution_kind: string;
  runner: string | null;
  consumed_inputs_json: string | null;
  input_basis: string;
  known_inputs_json: string;
  outcome: string;
  started_at: string | null;
  finished_at: string | null;
  evaluator_run_id: string | null;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const observationColumns = (from: string): string =>
  `${from}.observation_id, ${from}.source_id, ${from}.observed_by, ${from}.observed_by_basis,
  ${from}.method_name, ${from}.method_configuration_sha256, ${from}.execution_kind, ${from}.runner,
  ${from}.consumed_inputs_json, ${from}.input_basis, ${from}.known_inputs_json, ${from}.outcome,
  ${from}.started_at, ${from}.finished_at, ${from}.evaluator_run_id,
  hex(${from}.record_bytes) AS record_hex, ${from}.record_sha256, ${from}.operation_id`;

const decodeObservation = (row: ObservationSelection): ProjectObservationRow => ({
  observationId: row.observation_id,
  sourceId: row.source_id,
  observedBy: row.observed_by,
  observedByBasis: row.observed_by_basis,
  method: { name: row.method_name, configurationSha256: row.method_configuration_sha256 },
  executionKind: row.execution_kind,
  runner: row.runner,
  consumedInputs:
    row.consumed_inputs_json === null
      ? null
      : (JSON.parse(row.consumed_inputs_json) as InputIdentity[]),
  inputBasis: row.input_basis,
  knownInputs: JSON.parse(row.known_inputs_json) as InputIdentity[],
  outcome: row.outcome,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  evaluatorRunId: row.evaluator_run_id,
  recordHex: row.record_hex,
  recordSha256: row.record_sha256,
  operationId: row.operation_id,
});

export function readProjectObservation(
  view: ProjectReadView,
  observationId: string
): ProjectObservationRow | null {
  const row = view.get<ObservationSelection>(
    `SELECT ${observationColumns('o')} FROM knowledge_observations o WHERE o.observation_id=?`,
    observationId
  );
  return row ? decodeObservation(row) : null;
}

/**
 * The observations a claim revision rests on, in the order it named them. A revision that names
 * none returns none; a revision this history does not hold is indistinguishable from one that
 * rests on nothing here, which is what its own reader is for.
 */
export function listProjectClaimRevisionObservations(
  view: ProjectReadView,
  revisionId: string
): ProjectObservationRow[] {
  return view
    .all<ObservationSelection>(
      `SELECT ${observationColumns('o')} FROM knowledge_observations o
         JOIN claim_revision_observations c ON c.observation_id=o.observation_id
        WHERE c.revision_id=? ORDER BY c.position`,
      revisionId
    )
    .map(decodeObservation);
}
