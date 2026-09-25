import { vi } from 'vitest';

import type { CredentialStore, OrcaCloudClient } from '@orcaops/sdk';

import type { DatabaseCloudSessionDependencies } from '../../src/lib/database-cloud-session.js';

const unexpected = vi.fn(() => Promise.reject(new Error('unexpected SDK call')));

export function databaseCloudClient(
  options: {
    target?: { server_url: string; org_id: string; account_id: string };
    fail?: ReadonlySet<string>;
    failOnce?: ReadonlySet<string>;
    connectionError?: Error & { code?: string };
    afterQualification?: () => void | Promise<void>;
  } = {}
) {
  const target =
    options.target ??
    ({
      server_url: 'https://cloud.example',
      org_id: 'authenticated-org',
      account_id: 'authenticated-account',
    } as const);
  const calls: { method: string; input: unknown }[] = [];
  const failed = new Set<string>();
  const qualifiedRequirements: string[][] = [];
  const invoke = async <T>(method: string, input: unknown, result: T): Promise<T> => {
    calls.push({ method, input });
    if (options.fail?.has(method) || (options.failOnce?.has(method) && !failed.has(method))) {
      failed.add(method);
      throw Object.assign(new Error(`${method} failed`), { code: method });
    }
    return result;
  };
  const client: OrcaCloudClient = {
    cli: { ping: unexpected },
    user: { me: unexpected },
    repo: { upsertByRemote: unexpected },
    captureThread: {
      start: (input) =>
        invoke('captureThread.start', input, { commandId: 'command', status: 'accepted' }),
      update: unexpected,
      complete: unexpected,
      attachPlan: (input) => invoke('captureThread.attachPlan', input, { id: 'plan' }),
      attachPlanRevision: (input) =>
        invoke('captureThread.attachPlanRevision', input, { id: 'plan-revision' }),
      attachCheckpointOpened: (input) =>
        invoke('captureThread.attachCheckpointOpened', input, { id: 'checkpoint-opened' }),
      attachCheckpoint: (input) =>
        invoke('captureThread.attachCheckpoint', input, { id: 'checkpoint' }),
      attachSummary: (input) => invoke('captureThread.attachSummary', input, { id: 'summary' }),
      attachEvaluators: (input) => invoke('captureThread.attachEvaluators', input, []),
      attachCodingSessionsUsage: (input) =>
        invoke('captureThread.attachCodingSessionsUsage', input, []),
    },
    sourcePlan: {
      attachPin: (input) => invoke('sourcePlan.attachPin', input, { id: 'source-plan' }),
      create: unexpected,
      getApproved: unexpected,
      get: (input) =>
        invoke('sourcePlan.get', input, {
          externalId: input.slugOrExternalId,
          slug: input.slugOrExternalId,
          title: 'Approved plan',
          status: 'APPROVED',
          approvedVersionNumber: 3,
          webUrl: `https://cloud.example/plans/${input.slugOrExternalId}`,
          captureThread: null,
        }),
      reviewPull: unexpected,
      reviewPush: unexpected,
      reviewRequest: unexpected,
      reviewPropose: unexpected,
      reviewComment: unexpected,
      list: unexpected,
      reviewDetail: unexpected,
      setReviewerVerdict: unexpected,
      declineProposal: unexpected,
      listReviewers: unexpected,
    },
    review: {
      status: unexpected,
      pull: unexpected,
      reply: unexpected,
      resolve: unexpected,
    },
  };
  const credentialStore: CredentialStore = {
    kind: 'file',
    read: vi.fn(async () => ({
      v: 1 as const,
      loginMethod: 'oauth' as const,
      baseUrl: target.server_url,
      userId: target.account_id,
      orgId: target.org_id,
      orgName: 'Test',
      orgSlug: 'test',
      email: 'test@example.test',
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: 4102444800,
    })),
    write: unexpected,
    clear: unexpected,
  };
  const createCanonicalClient: NonNullable<
    NonNullable<DatabaseCloudSessionDependencies['connection']>['createCanonicalClient']
  > = vi.fn(async (input) => {
    if (options.connectionError) throw options.connectionError;
    const requires =
      typeof input.requires === 'function' ? input.requires(target) : [...input.requires];
    qualifiedRequirements.push([...requires]);
    await options.afterQualification?.();
    return { client, target, credentialStore };
  });
  const dependencies: DatabaseCloudSessionDependencies = {
    resolveCredentials: () => credentialStore,
    connection: { createCanonicalClient },
  };
  return {
    calls,
    client,
    credentialStore,
    createCanonicalClient,
    dependencies,
    qualifiedRequirements,
    target,
  };
}
