import {
  knowledgeEquivalenceDispositionId,
  KnowledgeEquivalenceDispositionSchema,
} from '@orcaops/storage';
import { rejectProjectKnowledgeEquivalence } from '@orcaops/storage/history/database';

import { readEvidenceDocument } from './evidence-record.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';

export interface KnowledgeEquivalenceRejectOptions {
  input?: string;
  json?: boolean;
}

export async function knowledgeEquivalenceRejectAction(
  opts: KnowledgeEquivalenceRejectOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const { record, actor, operationId } = await readEvidenceDocument(opts.input, 'decided_by');
    const { disposition_id: suppliedId, ...withoutId } = record;
    const parsed = KnowledgeEquivalenceDispositionSchema.omit({ disposition_id: true }).safeParse({
      ...withoutId,
      decided_by: actor,
    });
    if (!parsed.success) throw new OrcaopsError(ErrorCodes.INVALID_INPUT, parsed.error.message);
    const { recorded_at: _recordedAt, ...identity } = parsed.data;
    const disposition = {
      ...record,
      disposition_id: suppliedId ?? knowledgeEquivalenceDispositionId(identity),
    };
    const written = await withProcessingWriter({}, (handle) =>
      rejectProjectKnowledgeEquivalence(handle, {
        operationId,
        disposition,
        decidedBy: actor,
        secretAllow: [],
      })
    );
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No proposed match can be rejected here: ${written.problem.message}`
      );
    const { value, counters } = written.value;
    if (json) {
      emitOk({
        disposition_id: value.dispositionId,
        interpretation_id: value.interpretationId,
        record_sha256: value.recordSha256,
        published: value.published,
        operation_id: operationId,
        counters,
      });
      return;
    }
    writeTerminalSafeStdout(
      `Rejected proposed match ${value.interpretationId}.\n` +
        'Its wording and evidence remain retained. No rule or authority changed.\n'
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
