import {
  pauseProcessing,
  type ProcessingControl,
  resumeProcessing,
} from '@orcaops/storage/history/database';

import { knowledgeModelResumeAction, type KnowledgeModelResumeOptions } from './model-resume.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';
import {
  describeWakeUp,
  type ProcessingWakeUp,
  wakeProcessingWorkerForQueue,
} from '../../lib/knowledge-processing-wakeup.js';

export interface KnowledgePauseOptions {
  reason?: string;
  json?: boolean;
}

export interface KnowledgeResumeOptions extends KnowledgeModelResumeOptions {
  json?: boolean;
  /** Lift an invocation's no-model choice instead of the project-wide pause. */
  model?: boolean;
}

/**
 * `orcaops knowledge pause` and `orcaops knowledge resume` — the project-wide
 * stop, retained independently of any worker. Neither touches a job: a paused
 * project keeps every admitted job exactly as it stands, and resuming lets
 * claiming start again without reopening anything.
 */
export function knowledgePauseAction(opts: KnowledgePauseOptions = {}): Promise<void> {
  return setPause(true, (opts.reason ?? '').trim(), opts.json === true);
}

/**
 * Two acts under one verb, and they are not the same thing: without `--model`
 * this lifts the project pause and changes no job; with it, it lifts the
 * no-model choice one invocation made about named jobs, which is a consent
 * decision and is made at a terminal.
 */
export function knowledgeResumeAction(opts: KnowledgeResumeOptions = {}): Promise<void> {
  if (opts.model === true) return knowledgeModelResumeAction(opts);
  const json = opts.json === true;
  if ((opts.job ?? '').trim() !== '' || opts.all === true) {
    // Lifting the project pause changes no job, so a job named without
    // `--model` asked for something this act does not do.
    const refusal = new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Lifting the project-wide pause changes no job. To allow a model for a job captured ' +
        'without one, name it with `--model`: `orcaops knowledge resume --model <job>`, or ' +
        '`--model --all`.',
      'job'
    );
    if (json) emitError(refusal);
    writeErrorLine(refusal);
    throw new CliExit(1);
  }
  return setPause(false, null, json);
}

async function setPause(paused: boolean, reason: string | null, json: boolean): Promise<void> {
  try {
    if (paused && reason === '')
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Say why processing is being paused: `orcaops knowledge pause --reason "<text>"`.',
        'reason'
      );
    const actor = processingActor();
    const written = await withProcessingWriter({}, (handle) =>
      (paused ? pauseProcessing : resumeProcessing)(handle, {
        changedAt: new Date().toISOString(),
        changedBy: actor.changedBy,
        changedByBasis: actor.changedByBasis,
        reason,
      })
    );
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `Background processing cannot be ${paused ? 'paused' : 'resumed'} here: ` +
          written.problem.message
      );
    // Resuming is the moment held-back work can run again; pausing never wakes
    // anything. The wake-up never throws, so nothing here can fail the resume.
    const woken =
      paused || written.target === null ? null : wakeProcessingWorkerForQueue(written.target);
    if (json) {
      emitOk({ paused: written.value.paused, control: written.value, wake_up: woken });
      return;
    }
    writeTerminalSafeStdout(describe(written.value, woken));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function describe(control: ProcessingControl, woken: ProcessingWakeUp | null): string {
  const who = control.changedBy === null ? 'an unnamed local user' : control.changedBy;
  if (!control.paused) {
    return (
      `Background knowledge processing is no longer paused for this project (${who}, ` +
      `${control.changedByBasis}). No admitted job changed.\n` +
      `${describeWakeUp(woken)}\n`
    );
  }
  return (
    `Background knowledge processing is paused for this project (${who}, ` +
    `${control.changedByBasis}): ${control.reason}\n` +
    'Every admitted job stays exactly as it is. Run `orcaops knowledge resume` to lift it.\n'
  );
}
