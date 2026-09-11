import { z } from 'zod';

import type {
  SourcePlanReviewCommentResponse,
  SourcePlanReviewDeclineResponse,
  SourcePlanReviewProposeResponse,
  SourcePlanReviewPushResponse,
  SourcePlanReviewVerdictResponse,
} from '@orcaops/sdk';
import {
  OssSourcePlanPublishConflict,
  OssSourcePlanReviewComment,
  OssSourcePlanReviewDecline,
  OssSourcePlanReviewPropose,
  OssSourcePlanReviewPush,
  OssSourcePlanReviewVerdict,
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

import {
  type DatabasePlanReviewPublicationAdmission,
  ensureDatabasePlanReviewPublicationAdmission,
} from './database-source-plan-review.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const text = z.string().min(1);
const returned = z.strictObject({ evaluation: z.literal('returned'), value: z.unknown() });
const thrown = z.strictObject({
  evaluation: z.literal('threw'),
  error: z.strictObject({ message: z.string(), data: z.record(z.string(), z.unknown()) }),
});
const retainedResponse = z.discriminatedUnion('evaluation', [returned, thrown]);
const pushResponse = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('published'),
      externalId: text,
      candidateVersionId: text.nullable(),
      candidateVersionNumber: z.number().int().nullable(),
      contentHash: text,
    })
    .passthrough(),
  z.object({ status: z.literal('conflict'), conflict: OssSourcePlanPublishConflict }).passthrough(),
]);
const proposeResponse = z
  .object({ externalId: text, proposalId: text, baseVersionId: text, needsRebase: z.boolean() })
  .passthrough();
const commentResponse = z.object({ externalId: text, commentId: text }).passthrough();
const verdictResponse = z
  .object({
    externalId: text,
    reviewer: z.string(),
    state: z.string(),
    note: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .passthrough();
const declineResponse = z
  .object({
    externalId: text,
    proposalId: text,
    state: z.string(),
    reason: z.string().nullable(),
  })
  .passthrough();

export interface DatabaseSourcePlanReviewMutationOptions {
  reader: ProjectDatabase;
  openWriter(): Promise<ProjectDatabase>;
  openSettlementWriter?(): Promise<ProjectDatabase>;
  client: SourcePlanReviewMutationCloudClient;
  target: RemoteTarget;
  command: Readonly<Record<string, unknown>>;
  secretAllow: readonly string[];
  now(): string;
  publicationAt?: string;
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
}

export interface SourcePlanReviewMutationCloudClient {
  sourcePlan: {
    reviewPush(input: OssSourcePlanReviewPush): Promise<SourcePlanReviewPushResponse>;
    reviewPropose(input: OssSourcePlanReviewPropose): Promise<SourcePlanReviewProposeResponse>;
    reviewComment(input: OssSourcePlanReviewComment): Promise<SourcePlanReviewCommentResponse>;
    setReviewerVerdict(input: OssSourcePlanReviewVerdict): Promise<SourcePlanReviewVerdictResponse>;
    declineProposal(input: OssSourcePlanReviewDecline): Promise<SourcePlanReviewDeclineResponse>;
  };
}

function derivedId(projectId: string, family: string, value: unknown): string {
  return artifactOperationId(projectId, canonicalJson(value), family);
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Source Plan review command cancelled');
}

function unknownReviewMutation(externalId: string): never {
  throw new OrcaopsError(
    ErrorCodes.CLOUD_ERROR,
    `The Source Plan review response was not acknowledged. The original mutation may have reached the cloud and will not be resent. Run \`orcaops plan review status\`, then \`orcaops plan review view ${externalId}\` to inspect current cloud state. These reads cannot prove remote absence; report the retained unknown mutation before authoring another command.`
  );
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

function parseRequest<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained Source Plan review request payload is invalid',
      { cause }
    );
  }
}

export function createDatabaseSourcePlanReviewMutationClient(
  raw: DatabaseSourcePlanReviewMutationOptions
) {
  const input = {
    ...raw,
    openSettlementWriter: raw.openSettlementWriter ?? raw.openWriter,
    target: canonicalRemoteTarget(raw.target),
    command: structuredClone(raw.command),
    secretAllow: [...raw.secretAllow],
  };
  const projectId = input.reader.authority.projectId;
  const commandKey = derivedId(projectId, 'source_plan.review.command', {
    target: input.target,
    command: input.command,
  });
  let callOrdinal = 0;
  let dispatched = false;
  let publicationAdmission: DatabasePlanReviewPublicationAdmission | null = null;

  assertNoSecretsInPayload({ target: input.target, command: input.command }, input.secretAllow);

  function requestIdentity(ordinal: number, method: RemoteTransportScope['method']) {
    return { target: input.target, commandKey, ordinal, method };
  }

  function requestId(identity: ReturnType<typeof requestIdentity>) {
    return derivedId(projectId, 'source_plan.review.request', identity);
  }

  function requestOperationId(identity: ReturnType<typeof requestIdentity>) {
    return derivedId(projectId, 'source_plan.review.request.operation', identity);
  }

  function requestConflict(): never {
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The retained Source Plan review request belongs to different original input'
    );
  }

  async function dispatch<TRequest extends object, TResponse>(args: {
    method: RemoteTransportScope['method'];
    externalId: string;
    payload: TRequest;
    requestSchema: z.ZodType<TRequest>;
    responseSchema: z.ZodType<TResponse>;
    publishesReviewRecord?: boolean;
    following?(
      payload: TRequest,
      response: TResponse
    ): readonly {
      ordinal: number;
      method: RemoteTransportScope['method'];
      externalId: string;
      payload: object;
    }[];
    send(payload: TRequest): Promise<TResponse>;
  }): Promise<TResponse> {
    const ordinal = callOrdinal++;
    const callIdentity = requestIdentity(ordinal, args.method);
    const originalRequestId = requestId(callIdentity);
    const scope: RemoteTransportScope = {
      target: input.target,
      artifactId: null,
      method: args.method,
      targetExternalId: args.externalId,
      idempotencyKey: commandKey,
    };
    const options = { signal: input.signal, onWait: input.onWait };
    const refusal = { secretAllow: input.secretAllow };
    let writer: ProjectDatabase | undefined;

    const ensureRequest = async (
      retainedScope: RemoteTransportScope,
      identity: ReturnType<typeof requestIdentity>,
      payload: object,
      requireExactPayload: boolean,
      operationOptions: ProjectOperationOptions = options,
      openWriter = input.openWriter
    ) => {
      const retainedRequestId = requestId(identity);
      const retainedOperationId = requestOperationId(identity);
      const payloadBytes = Buffer.from(canonicalJson(payload));
      let remote = readProjectRemoteRequest(input.reader, retainedRequestId).value;
      const validate = (comparePayload: boolean) => {
        if (
          !remote ||
          remote.request.requestId !== retainedRequestId ||
          remote.request.operationId !== retainedOperationId ||
          canonicalJson(remote.request.scope) !== canonicalJson(retainedScope) ||
          (comparePayload && !remote.request.payloadBytes.equals(payloadBytes))
        )
          requestConflict();
      };
      if (remote) {
        validate(requireExactPayload);
        return remote;
      }
      assertNoSecretsInPayload({ scope: retainedScope, payload }, input.secretAllow);
      writer ??= await openWriter();
      try {
        await retainProjectRemoteRequest(
          writer,
          {
            operationId: retainedOperationId,
            requestId: retainedRequestId,
            scope: retainedScope,
            expectedSelection:
              readProjectRemoteCurrent(input.reader, retainedScope).value?.current ?? null,
            payloadBytes,
            preparedAt: input.now(),
          },
          refusal,
          operationOptions
        );
      } catch (cause) {
        remote = readProjectRemoteRequest(input.reader, retainedRequestId).value;
        if (!remote) throw cause;
        validate(true);
        return remote;
      }
      remote = readProjectRemoteRequest(input.reader, retainedRequestId).value;
      validate(true);
      return remote!;
    };

    try {
      const remote = await ensureRequest(scope, callIdentity, args.payload, false);
      const retainedPayload = parseRequest(remote.request.payloadBytes, args.requestSchema);
      if (args.publishesReviewRecord) {
        if (args.method !== 'sourcePlan.reviewPush' && args.method !== 'sourcePlan.reviewPropose')
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'Only Source Plan push and proposal requests can own review publication'
          );
        if (input.publicationAt === undefined)
          throw new ProjectDatabaseError(
            'INVALID_INPUT',
            'Source Plan review publication requires its original observation time'
          );
        publicationAdmission = await ensureDatabasePlanReviewPublicationAdmission({
          reader: input.reader,
          getWriter: async () => (writer ??= await input.openWriter()),
          operationId: derivedId(
            projectId,
            'source_plan.review.publication.admission',
            callIdentity
          ),
          commandKey,
          target: input.target,
          method: args.method,
          externalId: args.externalId,
          command: input.command,
          request: retainedPayload,
          publicationAt: input.publicationAt,
          secretAllow: input.secretAllow,
          signal: input.signal,
          onWait: input.onWait,
        });
      }
      const ensureFollowing = async (response: TResponse) => {
        for (const following of args.following?.(retainedPayload, response) ?? []) {
          const followingIdentity = requestIdentity(following.ordinal, following.method);
          await ensureRequest(
            {
              target: input.target,
              artifactId: null,
              method: following.method,
              targetExternalId: following.externalId,
              idempotencyKey: commandKey,
            },
            followingIdentity,
            following.payload,
            true,
            { onWait: input.onWait },
            input.openSettlementWriter
          );
        }
      };
      const replay = () => {
        const outcome = remote.outcomes.at(-1);
        if (outcome?.kind === 'acknowledged') {
          if (outcome.responseBytes === null)
            throw new ProjectDatabaseError(
              'HISTORY_INTEGRITY_REQUIRED',
              'The acknowledged Source Plan review response is missing'
            );
          return parseStored(outcome.responseBytes, args.responseSchema);
        }
        if (remote.attempt) unknownReviewMutation(args.externalId);
        return null;
      };
      const settled = replay();
      if (settled !== null) {
        await ensureFollowing(settled);
        return settled;
      }

      writer ??= await input.openWriter();
      cancelled(input.signal);
      const attemptId = derivedId(projectId, 'source_plan.review.attempt', callIdentity);
      const admitted = await admitProjectRemoteAttempt(
        writer,
        {
          operationId: derivedId(projectId, 'source_plan.review.attempt.operation', callIdentity),
          requestId: originalRequestId,
          attemptId,
          scope,
          expectedSelection: remote.current,
          attemptedAt: input.now(),
        },
        refusal,
        options
      );
      if (!admitted.sendAllowed) unknownReviewMutation(args.externalId);
      cancelled(input.signal);
      let envelope: z.infer<typeof retainedResponse>;
      let response: TResponse | undefined;
      let acknowledgedError: TrpcRequestError | undefined;
      try {
        dispatched = true;
        response = args.responseSchema.parse(await args.send(retainedPayload));
        envelope = { evaluation: 'returned', value: response };
      } catch (cause) {
        if (!(cause instanceof TrpcRequestError)) {
          await recordProjectRemoteOutcome(
            writer,
            {
              operationId: derivedId(
                projectId,
                'source_plan.review.outcome.operation',
                callIdentity
              ),
              requestId: originalRequestId,
              attemptId,
              outcomeId: derivedId(projectId, 'source_plan.review.outcome', callIdentity),
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
          unknownReviewMutation(args.externalId);
        }
        acknowledgedError = cause;
        envelope = {
          evaluation: 'threw',
          error: { message: cause.message, data: trpcData(cause) },
        };
      }
      await recordProjectRemoteOutcome(
        writer,
        {
          operationId: derivedId(projectId, 'source_plan.review.outcome.operation', callIdentity),
          requestId: originalRequestId,
          attemptId,
          outcomeId: derivedId(projectId, 'source_plan.review.outcome', callIdentity),
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
      if (acknowledgedError) throw acknowledgedError;
      if (response === undefined)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The acknowledged Source Plan review result is missing'
        );
      await ensureFollowing(response);
      return response;
    } finally {
      writer?.close();
    }
  }

  return {
    commandKey,
    didDispatch: () => dispatched,
    publicationAdmission: () => publicationAdmission,
    sourcePlan: {
      reviewPush: (raw: OssSourcePlanReviewPush): Promise<SourcePlanReviewPushResponse> => {
        const payload = OssSourcePlanReviewPush.parse(raw);
        return dispatch({
          method: 'sourcePlan.reviewPush',
          externalId: payload.external_id,
          payload,
          requestSchema: OssSourcePlanReviewPush,
          responseSchema: pushResponse,
          publishesReviewRecord: true,
          following: (original, response) =>
            original.on_conflict === 'propose' && response.status === 'conflict'
              ? [
                  {
                    ordinal: 1,
                    method: 'sourcePlan.reviewPropose' as const,
                    externalId: original.external_id,
                    payload: OssSourcePlanReviewPropose.parse({
                      schema_version: 1,
                      external_id: original.external_id,
                      body: original.body,
                      content_hash: original.content_hash,
                      base_version_id: original.expected_candidate_version_id,
                      supersedes_proposal_id: null,
                      summary: null,
                      source_ref: null,
                      baseline: original.baseline,
                    }),
                  },
                ]
              : [],
          send: (original) => input.client.sourcePlan.reviewPush(original),
        });
      },
      reviewPropose: (
        raw: OssSourcePlanReviewPropose
      ): Promise<SourcePlanReviewProposeResponse> => {
        const payload = OssSourcePlanReviewPropose.parse(raw);
        return dispatch({
          method: 'sourcePlan.reviewPropose',
          externalId: payload.external_id,
          payload,
          requestSchema: OssSourcePlanReviewPropose,
          responseSchema: proposeResponse,
          publishesReviewRecord: true,
          send: (original) => input.client.sourcePlan.reviewPropose(original),
        });
      },
      reviewComment: (
        raw: OssSourcePlanReviewComment
      ): Promise<SourcePlanReviewCommentResponse> => {
        const payload = OssSourcePlanReviewComment.parse(raw);
        return dispatch({
          method: 'sourcePlan.reviewComment',
          externalId: payload.external_id,
          payload,
          requestSchema: OssSourcePlanReviewComment,
          responseSchema: commentResponse,
          send: (original) => input.client.sourcePlan.reviewComment(original),
        });
      },
      setReviewerVerdict: (
        raw: OssSourcePlanReviewVerdict
      ): Promise<SourcePlanReviewVerdictResponse> => {
        const payload = OssSourcePlanReviewVerdict.parse(raw);
        return dispatch({
          method: 'sourcePlan.setReviewerVerdict',
          externalId: payload.external_id,
          payload,
          requestSchema: OssSourcePlanReviewVerdict,
          responseSchema: verdictResponse,
          send: (original) => input.client.sourcePlan.setReviewerVerdict(original),
        });
      },
      declineProposal: (
        raw: OssSourcePlanReviewDecline
      ): Promise<SourcePlanReviewDeclineResponse> => {
        const payload = OssSourcePlanReviewDecline.parse(raw);
        return dispatch({
          method: 'sourcePlan.declineProposal',
          externalId: payload.external_id,
          payload,
          requestSchema: OssSourcePlanReviewDecline,
          responseSchema: declineResponse,
          send: (original) => input.client.sourcePlan.declineProposal(original),
        });
      },
    },
  };
}
