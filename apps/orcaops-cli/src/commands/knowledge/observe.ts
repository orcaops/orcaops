import { publishProjectObservation } from '@orcaops/storage/history/database';

import { readEvidenceDocument } from './evidence-record.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';

export interface KnowledgeObserveOptions {
  input?: string;
  json?: boolean;
}

/**
 * `orcaops knowledge observe --input -` — record what somebody saw: a person's observation, or a
 * command an agent ran and its result.
 *
 * **It cannot record a runner-established execution.** A command line is told what happened; it
 * establishes nothing about which inputs a process consumed, and an execution recorded here on
 * that word would be exactly the snapshot-bound claim §8 refuses. Only a runner that hands the
 * inputs over and digests them can say so, and it does not go through here.
 */
export async function knowledgeObserveAction(opts: KnowledgeObserveOptions = {}): Promise<void> {
  const json = opts.json === true;
  try {
    const { record, actor, operationId } = await readEvidenceDocument(opts.input, 'observed_by');
    const execution = (record as { execution?: { kind?: unknown } }).execution;
    if (execution?.kind === 'runner_established')
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'A recorded observation is agent-reported or a human observation. Establishing which ' +
          'inputs an execution consumed takes a runner that hands them over, not a report of one.',
        'execution.kind'
      );
    const written = await withProcessingWriter({}, (handle) =>
      publishProjectObservation(handle, {
        operationId,
        observation: record,
        observedBy: actor,
        secretAllow: [],
      })
    );
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No observation can be recorded here: ${written.problem.message}`
      );
    const { value, counters } = written.value;
    if (json) {
      emitOk({
        observation_id: value.observationId,
        record_sha256: value.recordSha256,
        operation_id: operationId,
        counters,
      });
      return;
    }
    writeTerminalSafeStdout(
      `Recorded observation ${value.observationId}.\n` +
        'It says what was reported, not what any process is known to have read.\n'
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
