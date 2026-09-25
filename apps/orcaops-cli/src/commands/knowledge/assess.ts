import {
  knowledgeBoundaryAt,
  publishProjectKnowledgeAssessment,
} from '@orcaops/storage/history/database';

import { readEvidenceDocument } from './evidence-record.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';

export interface KnowledgeAssessOptions {
  input?: string;
  json?: boolean;
}

/**
 * `orcaops knowledge assess --input -` — assess a selected release or build against exact
 * expectation revisions, with no task, artifact or pull request.
 *
 * The record names the expectation revisions and the exceptions in force, the software it
 * identified or its explicit absence, the evidence it weighed, one conclusion per expectation, and
 * what became of each check apart from every conclusion. With nothing identified it may conclude
 * unresolved or not assessed and never supported: the store refuses a satisfaction claim against
 * unidentified software, and nothing here substitutes the current checkout for one.
 *
 * The counters it observed are stamped from this store when the record does not state them, which
 * is what a later read judges its staleness against.
 */
export async function knowledgeAssessAction(opts: KnowledgeAssessOptions = {}): Promise<void> {
  const json = opts.json === true;
  try {
    const { record, actor, operationId } = await readEvidenceDocument(opts.input, 'assessed_by');
    const written = await withProcessingWriter({}, (handle) => {
      const observed = handle.read((view) => knowledgeBoundaryAt(view));
      return publishProjectKnowledgeAssessment(handle, {
        operationId,
        assessment: {
          observed_write_sequence: observed.value,
          observed_intent_counter: observed.counters.intentChangeCounter,
          ...record,
        },
        assessedBy: actor,
        secretAllow: [],
      });
    });
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No assessment can be recorded here: ${written.problem.message}`
      );
    const { value, counters } = written.value;
    if (json) {
      emitOk({
        assessment_id: value.assessmentId,
        record_sha256: value.recordSha256,
        operation_id: operationId,
        counters,
      });
      return;
    }
    writeTerminalSafeStdout(
      `Recorded assessment ${value.assessmentId}.\n` +
        'It concludes about the expectations it named and the software it identified, and about ' +
        'nothing else. The store checked that each expectation revision, exception and piece of ' +
        'evidence is retained here and that every selected input is named; that a name identifies ' +
        'real software is not something it can check.\n'
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
