import { z } from 'zod';

import type {
  OssReviewFeedbackReply as ReviewReply,
  OssReviewFeedbackReplyResponse as ReviewReplyResponse,
  OssReviewFeedbackResolve as ReviewResolve,
  OssReviewFeedbackResolveResponse as ReviewResolveResponse,
} from '@orcaops/sdk';
import {
  OssReviewFeedbackReply,
  OssReviewFeedbackReplyResponse,
  OssReviewFeedbackResolve,
  OssReviewFeedbackResolveResponse,
  TrpcRequestError,
} from '@orcaops/sdk';
import { assertNoSecretsInPayload, canonicalJson } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';
import {
  admitProjectRemoteAttempt,
  readProjectRemoteCurrent,
  readProjectRemoteRequest,
  recordProjectRemoteOutcome,
  type RemoteTransportScope,
  retainProjectRemoteRequest,
} from '@orcaops/storage/history/database/source-plan-upload';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const returned = z.strictObject({ evaluation: z.literal('returned'), value: z.unknown() });
const thrown = z.strictObject({
  evaluation: z.literal('threw'),
  error: z.strictObject({ message: z.string(), data: z.record(z.string(), z.unknown()) }),
});
const retainedResponse = z.discriminatedUnion('evaluation', [returned, thrown]);

type FeedbackMethod = 'review.reply' | 'review.resolve';

export interface DatabaseReviewFeedbackMutationOptions {
  reader: ProjectDatabase;
  openWriter(): Promise<ProjectDatabase>;
  client: ReviewFeedbackMutationCloudClient;
  target: RemoteTarget;
  idempotencyKey?: string;
  secretAllow: readonly string[];
  now(): string;
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
}

export interface ReviewFeedbackMutationCloudClient {
  review: {
    reply(input: ReviewReply): Promise<ReviewReplyResponse>;
    resolve(input: ReviewResolve): Promise<ReviewResolveResponse>;
  };
}

function derivedId(projectId: string, family: string, value: unknown): string {
  return artifactOperationId(projectId, canonicalJson(value), family);
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Review feedback mutation cancelled before send');
}

function trpcData(error: TrpcRequestError): Record<string, unknown> {
  return Object.fromEntries(Object.entries(error.data).filter(([, value]) => value !== undefined));
}

function parseStored<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  const envelope = retainedResponse.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (envelope.evaluation === 'threw')
    throw new TrpcRequestError(envelope.error.message, envelope.error.data);
  return schema.parse(envelope.value);
}

function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'The retained review feedback request belongs to different original input'
  );
}

function recovery(method: FeedbackMethod): never {
  const label = method === 'review.reply' ? 'reply' : 'resolution';
  throw new OrcaopsError(
    ErrorCodes.CLOUD_ERROR,
    `The original review ${label} may have reached the cloud and will not be resent. Run \`orcaops review status\`, then \`orcaops review pull --pr <pull_request_id>\` to inspect it. If it is confirmed absent, rerun with a new --idempotency-key to author a new operation.`
  );
}

export function createDatabaseReviewFeedbackMutationClient(
  raw: DatabaseReviewFeedbackMutationOptions
): ReviewFeedbackMutationCloudClient {
  const input = {
    ...raw,
    target: canonicalRemoteTarget(raw.target),
    secretAllow: [...raw.secretAllow],
  };
  const projectId = input.reader.authority.projectId;

  async function dispatch<TRequest extends { comment_id: string }, TResponse>(args: {
    method: FeedbackMethod;
    payload: TRequest;
    requestSchema: z.ZodType<TRequest>;
    responseSchema: z.ZodType<TResponse>;
    send(payload: TRequest): Promise<TResponse>;
  }): Promise<TResponse> {
    const payload = args.requestSchema.parse(structuredClone(args.payload));
    const idempotencyKey =
      input.idempotencyKey ??
      derivedId(projectId, 'review.feedback.command', {
        target: input.target,
        method: args.method,
        payload,
      });
    const scope: RemoteTransportScope = {
      target: input.target,
      artifactId: null,
      method: args.method,
      targetExternalId: payload.comment_id,
      idempotencyKey,
    };
    const identity = { scope };
    const requestId = derivedId(projectId, 'review.feedback.request', identity);
    const requestOperationId = derivedId(projectId, 'review.feedback.request.operation', identity);
    const payloadBytes = Buffer.from(canonicalJson(payload));
    const refusal = { secretAllow: input.secretAllow };
    const options = { signal: input.signal, onWait: input.onWait };
    let writer: ProjectDatabase | undefined;

    assertNoSecretsInPayload(
      { target: input.target, idempotencyKey, method: args.method, payload },
      input.secretAllow
    );

    const validateRequest = (
      remote: NonNullable<ReturnType<typeof readProjectRemoteRequest>['value']>
    ) => {
      if (
        remote.request.requestId !== requestId ||
        remote.request.operationId !== requestOperationId ||
        canonicalJson(remote.request.scope) !== canonicalJson(scope) ||
        !remote.request.payloadBytes.equals(payloadBytes)
      )
        conflict();
      return remote;
    };

    try {
      let remote = readProjectRemoteRequest(input.reader, requestId).value;
      if (remote === null) {
        writer = await input.openWriter();
        try {
          await retainProjectRemoteRequest(
            writer,
            {
              operationId: requestOperationId,
              requestId,
              scope,
              expectedSelection:
                readProjectRemoteCurrent(input.reader, scope).value?.current ?? null,
              payloadBytes,
              preparedAt: input.now(),
            },
            refusal,
            options
          );
        } catch (cause) {
          remote = readProjectRemoteRequest(input.reader, requestId).value;
          if (remote === null) throw cause;
        }
        remote = readProjectRemoteRequest(input.reader, requestId).value;
        if (remote === null)
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'The retained review feedback request is unavailable after admission'
          );
      }
      remote = validateRequest(remote);
      const originalPayload = args.requestSchema.parse(
        JSON.parse(remote.request.payloadBytes.toString('utf8'))
      );
      const outcome = remote.outcomes.at(-1);
      if (outcome?.kind === 'acknowledged') {
        if (outcome.responseBytes === null)
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'The acknowledged review feedback response is missing'
          );
        return parseStored(outcome.responseBytes, args.responseSchema);
      }
      if (remote.attempt !== null) recovery(args.method);

      writer ??= await input.openWriter();
      cancelled(input.signal);
      const attemptId = derivedId(projectId, 'review.feedback.attempt', identity);
      const admitted = await admitProjectRemoteAttempt(
        writer,
        {
          operationId: derivedId(projectId, 'review.feedback.attempt.operation', identity),
          requestId,
          attemptId,
          scope,
          expectedSelection: remote.current,
          attemptedAt: remote.request.preparedAt,
        },
        refusal,
        options
      );
      if (!admitted.sendAllowed) recovery(args.method);
      cancelled(input.signal);

      let envelope: z.infer<typeof retainedResponse>;
      let response: TResponse | undefined;
      let acknowledgedError: TrpcRequestError | undefined;
      const outcomeId = derivedId(projectId, 'review.feedback.outcome', identity);
      const outcomeOperationId = derivedId(
        projectId,
        'review.feedback.outcome.operation',
        identity
      );
      try {
        response = args.responseSchema.parse(await args.send(originalPayload));
        envelope = { evaluation: 'returned', value: response };
      } catch (cause) {
        if (!(cause instanceof TrpcRequestError)) {
          try {
            await recordProjectRemoteOutcome(
              writer,
              {
                operationId: outcomeOperationId,
                requestId,
                attemptId,
                outcomeId,
                scope,
                expectedSelection: admitted.value.selection,
                kind: 'ack_unknown',
                responseBytes: null,
                failure: {
                  kind: 'unknown',
                  message: cause instanceof Error ? cause.message : String(cause),
                },
                observedAt: input.now(),
              },
              refusal,
              { onWait: input.onWait }
            );
          } catch {
            readProjectRemoteRequest(input.reader, requestId);
          }
          recovery(args.method);
        }
        acknowledgedError = cause;
        envelope = {
          evaluation: 'threw',
          error: { message: cause.message, data: trpcData(cause) },
        };
      }
      try {
        await recordProjectRemoteOutcome(
          writer,
          {
            operationId: outcomeOperationId,
            requestId,
            attemptId,
            outcomeId,
            scope,
            expectedSelection: admitted.value.selection,
            kind: 'acknowledged',
            responseBytes: Buffer.from(canonicalJson(envelope)),
            failure: null,
            observedAt: input.now(),
          },
          refusal,
          { onWait: input.onWait }
        );
      } catch {
        const retained = readProjectRemoteRequest(input.reader, requestId).value;
        const retainedOutcome = retained?.outcomes.at(-1);
        if (
          retainedOutcome?.outcomeId === outcomeId &&
          retainedOutcome.kind === 'acknowledged' &&
          retainedOutcome.responseBytes !== null
        )
          return parseStored(retainedOutcome.responseBytes, args.responseSchema);
        recovery(args.method);
      }
      if (acknowledgedError) throw acknowledgedError;
      if (response === undefined)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The acknowledged review feedback result is missing'
        );
      return response;
    } finally {
      writer?.close();
    }
  }

  return {
    review: {
      reply: (value) =>
        dispatch({
          method: 'review.reply',
          payload: OssReviewFeedbackReply.parse(value),
          requestSchema: OssReviewFeedbackReply,
          responseSchema: OssReviewFeedbackReplyResponse,
          send: (original) => input.client.review.reply(original),
        }),
      resolve: (value) =>
        dispatch({
          method: 'review.resolve',
          payload: OssReviewFeedbackResolve.parse(value),
          requestSchema: OssReviewFeedbackResolve,
          responseSchema: OssReviewFeedbackResolveResponse,
          send: (original) => input.client.review.resolve(original),
        }),
    },
  };
}
