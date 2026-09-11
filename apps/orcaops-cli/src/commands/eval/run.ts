import { run } from 'effection';

import { isBlockingEvaluatorFailure } from '@orcaops/evaluator-protocol';
import { createParamsValidator, dispatchOne } from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import { resolveDatabaseHistoryArtifact } from '@orcaops/project-scope/history/database';
import {
  assertNoSecretsInPayload,
  type EvaluatorRunPayload,
  prepareArtifactDraft,
  SecretInPayloadError,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  openProjectDatabase,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  queryProjectArtifacts,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import {
  createContextRevalidator,
  historyRepository,
  requireRepositoryScope,
} from '../../lib/database-branch-history.js';
import { databaseEvaluatorStore } from '../../lib/database-evaluators.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import {
  buildEvaluatorContext,
  type LifecycleEvaluatorContext,
} from '../../lib/evaluator-bridge.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { computePackTrustDecisions } from '../../lib/evaluator-grants.js';
import { CLI_ROOT } from '../../lib/evaluators-config.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { historyScopeCommandError } from '../../lib/history-scope-error.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface EvalRunOptions {
  /** Resolved evaluator ref `<pack>/<id>`. */
  ref: string;
  artifact?: string;
  checkpoint?: number;
  noLlm?: boolean;
  json?: boolean;
}

interface PreparedEvalRun {
  artifactId: string;
  authority: ProjectDatabaseAuthority;
  operationId: string;
  eventBytes: Buffer;
  sidecarPayloads: Array<{ eventId: string; bytes: Buffer }>;
  expectedRevision: ReturnType<typeof resolveDatabaseHistoryArtifact>['artifact']['revision'];
  secretAllow: readonly string[];
  stamped: EvaluatorRunPayload;
}

interface EvalRunDependencies {
  openWriter: typeof openProjectDatabase;
  append: typeof appendProjectArtifactEvents;
  dispatch: typeof dispatchOne;
  listenForInterrupt(listener: () => void): () => void;
}

function refuseEvaluatorRunSecrets(
  value: unknown,
  allow: readonly string[],
  stage: 'options' | 'result'
): void {
  try {
    assertNoSecretsInPayload(value, allow);
  } catch (cause) {
    if (cause instanceof SecretInPayloadError)
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        `Remove or redescribe refused evaluator ${stage} before recording the run; nothing was written`,
        { cause }
      );
    throw cause;
  }
}

async function prepareDatabaseEvalRun(
  opts: EvalRunOptions,
  signal: AbortSignal,
  dependencies: EvalRunDependencies
): Promise<PreparedEvalRun> {
  const context = await resolveDatabaseHistoryCommandContext({ profile: 'exact' });
  let prepared: PreparedEvalRun;
  try {
    const { git, database, authority } = requireRepositoryScope(context.scope);
    const revalidate = createContextRevalidator(context.scope);
    refuseEvaluatorRunSecrets(opts, context.config.redact.allow, 'options');

    const { evaluators, config, errors } = await discoverEvaluatorsForCli(git.worktreeRoot);
    const evaluator = evaluators.find((entry) => entry.ref === opts.ref);
    if (!evaluator) throw evaluatorNotFound(opts.ref, errors);
    const trust = await computePackTrustDecisions({
      packs: (config?.packages ?? [])
        .filter((entry) => entry.id === evaluator.package_id)
        .map((entry) => ({ packageId: entry.id, source: entry.source })),
      repoRoot: git.worktreeRoot,
      cliRoot: CLI_ROOT,
      warn: (message) => writeTerminalSafeStderr(`${message}\n`),
    });

    const requested =
      opts.artifact ??
      queryProjectArtifacts(database, { profile: 'versions', limit: 1 }).rows[0]?.artifactId;
    if (!requested)
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        'No artifact ID provided and no artifact found in the selected project.'
      );
    const selected = resolveDatabaseHistoryArtifact(context.scope, requested);

    const checkpointN = opts.checkpoint;
    if (
      (evaluator.phase === 'checkpoint-close' || evaluator.phase === 'checkpoint-open') &&
      checkpointN === undefined
    )
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Evaluator "${opts.ref}" fires at ${evaluator.phase}; pass --checkpoint <n>.`,
        'checkpoint'
      );

    const evaluatorContext: LifecycleEvaluatorContext = {
      repoRoot: git.worktreeRoot,
      repo: historyRepository(git.worktreeRoot),
      config: context.config,
      store: databaseEvaluatorStore(selected.artifact.thread),
    };
    const baseContext = await buildEvaluatorContext({
      ctx: evaluatorContext,
      artifactId: selected.artifactId,
      firesAt: evaluator.phase,
      ...(checkpointN !== undefined ? { checkpointN } : {}),
    });
    const llm = await run(function* () {
      return yield* buildLLMClient(context.config.llm, {
        ...(opts.noLlm !== undefined ? { noLlm: opts.noLlm } : {}),
        env: getInvocationEnv(),
      });
    });
    const validator = createParamsValidator();
    const runPayload = await dependencies.dispatch(
      evaluator,
      baseContext,
      llm,
      {
        trust,
        signal,
        validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
      },
      uuidv7
    );
    const stamped: EvaluatorRunPayload =
      checkpointN !== undefined &&
      (evaluator.phase === 'checkpoint-open' || evaluator.phase === 'checkpoint-close')
        ? { ...runPayload, checkpoint_n: checkpointN }
        : runPayload;
    refuseEvaluatorRunSecrets(stamped, context.config.redact.allow, 'result');
    const draft = await prepareArtifactDraft(
      {
        artifactId: selected.artifactId,
        priorEvents: selected.artifact.thread.events,
        authoredPayload: { options: opts, result: stamped },
        secretAllow: context.config.redact.allow,
        idempotencyBlocks: [],
      },
      (semantics) =>
        semantics.writeEvaluatorRunPayload(selected.artifactId, stamped, {
          idempotencyKey: uuidv7(),
        })
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    if (!draft.events.length)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Evaluator preparation produced no retained event; preserve the selected history for inspection'
      );
    if (signal.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Evaluator run cancelled before opening the history writer'
      );
    await revalidate();
    prepared = {
      artifactId: selected.artifactId,
      authority: { ...authority },
      operationId: uuidv7(),
      eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
      sidecarPayloads: draft.events.flatMap((event) =>
        event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
      ),
      expectedRevision: { ...selected.artifact.revision },
      secretAllow: [...context.config.redact.allow],
      stamped,
    };
  } catch (cause) {
    closeFailedHistoryRead(context.scope);
    throw cause;
  }
  context.scope.close();
  return prepared;
}

/** Run one configured evaluator and retain its result on the originally selected artifact. */
export function createDatabaseEvalRunAction(dependencies: EvalRunDependencies) {
  return async (received: EvalRunOptions): Promise<void> => {
    const opts = structuredClone(received);
    const json = opts.json === true;
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    const releaseInterrupt = dependencies.listenForInterrupt(interrupt);
    try {
      const prepared = await prepareDatabaseEvalRun(opts, controller.signal, dependencies);
      if (controller.signal.aborted)
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Evaluator run cancelled before opening the history writer'
        );
      const writer = await dependencies.openWriter({
        authority: prepared.authority,
        mode: 'writer',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        closeFailedHistoryRead(writer);
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Evaluator run cancelled while opening the history writer'
        );
      }
      let failed = false;
      try {
        let waiting = false;
        const operationOptions: ProjectOperationOptions = {
          signal: controller.signal,
          onWait: () => {
            if (waiting) return;
            waiting = true;
            writeTerminalSafeStderr(
              'Waiting to record the evaluator run on the selected project database; Ctrl-C cancels the wait.\n'
            );
          },
        };
        await dependencies.append(
          writer,
          {
            operationId: prepared.operationId,
            artifactId: prepared.artifactId,
            expectedRevision: prepared.expectedRevision,
            eventBytes: prepared.eventBytes,
            sidecarPayloads: prepared.sidecarPayloads,
            secretAllow: prepared.secretAllow,
          },
          operationOptions
        );
      } catch (cause) {
        failed = true;
        closeFailedHistoryRead(writer);
        throw cause;
      } finally {
        if (!failed) writer.close();
      }

      const blocking = isBlockingEvaluatorFailure(prepared.stamped);
      const output = {
        artifact_id: prepared.artifactId,
        evaluator_ref: prepared.stamped.evaluator_ref,
        run: prepared.stamped,
        blocking,
      };
      if (json) {
        emitOk(output);
        return;
      }
      const statusLine =
        prepared.stamped.run_status === 'completed'
          ? `${prepared.stamped.verdict}`
          : prepared.stamped.run_status === 'skipped'
            ? 'skipped'
            : `error: ${prepared.stamped.error?.code ?? 'unknown'}`;
      writeTerminalSafeStdout(
        `${prepared.stamped.evaluator_ref}: ${statusLine} (${prepared.stamped.severity})\n\n${prepared.stamped.body}\n` +
          (blocking ? '\n** BLOCKING **\n' : '')
      );
    } catch (cause) {
      if (cause instanceof CliExit) throw cause;
      const error = historyScopeCommandError(cause);
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    } finally {
      releaseInterrupt();
    }
  };
}

export const evalRunAction = createDatabaseEvalRunAction({
  openWriter: openProjectDatabase,
  append: appendProjectArtifactEvents,
  dispatch: dispatchOne,
  listenForInterrupt: (listener) => {
    process.on('SIGINT', listener);
    return () => process.off('SIGINT', listener);
  },
});
