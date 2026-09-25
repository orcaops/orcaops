import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialStore, OrcaCloudClient } from '@orcaops/sdk';

vi.mock('./canonical-client.js', () => ({ createCanonicalCloudClient: vi.fn() }));

import { createCanonicalCloudClient } from './canonical-client.js';
import { createDatabaseArtifactPushConnection } from './database-artifact-push-connection.js';

const unexpectedSdkCall = vi.fn(() => Promise.reject(new Error('unexpected SDK call')));

function cloudClient(
  start: OrcaCloudClient['captureThread']['start'] = unexpectedSdkCall
): OrcaCloudClient {
  return {
    cli: { ping: unexpectedSdkCall },
    user: { me: unexpectedSdkCall },
    repo: { upsertByRemote: unexpectedSdkCall },
    captureThread: {
      start,
      update: unexpectedSdkCall,
      complete: unexpectedSdkCall,
      attachPlan: unexpectedSdkCall,
      attachPlanRevision: unexpectedSdkCall,
      attachCheckpointOpened: unexpectedSdkCall,
      attachCheckpoint: unexpectedSdkCall,
      attachSummary: unexpectedSdkCall,
      attachEvaluators: unexpectedSdkCall,
      attachCodingSessionsUsage: unexpectedSdkCall,
    },
    sourcePlan: {
      attachPin: unexpectedSdkCall,
      create: unexpectedSdkCall,
      getApproved: unexpectedSdkCall,
      get: unexpectedSdkCall,
      reviewPull: unexpectedSdkCall,
      reviewPush: unexpectedSdkCall,
      reviewRequest: unexpectedSdkCall,
      reviewPropose: unexpectedSdkCall,
      reviewComment: unexpectedSdkCall,
      list: unexpectedSdkCall,
      reviewDetail: unexpectedSdkCall,
      setReviewerVerdict: unexpectedSdkCall,
      declineProposal: unexpectedSdkCall,
      listReviewers: unexpectedSdkCall,
    },
    review: {
      status: unexpectedSdkCall,
      pull: unexpectedSdkCall,
      reply: unexpectedSdkCall,
      resolve: unexpectedSdkCall,
    },
  };
}

const credentialStore: CredentialStore = {
  kind: 'file',
  read: unexpectedSdkCall,
  write: unexpectedSdkCall,
  clear: unexpectedSdkCall,
};

afterEach(() => vi.clearAllMocks());

describe('createDatabaseArtifactPushConnection', () => {
  it('prepares both repository identities and returns the authenticated target', async () => {
    const client = cloudClient();
    const target = {
      server_url: 'https://cloud.example',
      org_id: 'ping-org',
      account_id: 'ping-account',
    };
    const createClient = vi.fn(async () => ({ client, target, credentialStore }));
    const cwd = await realpath(process.cwd());
    const connection = await createDatabaseArtifactPushConnection(
      {
        baseUrl: target.server_url,
        credentialStore,
        cliVersion: '0.2.0-rc.2',
        rawRepoUrl: 'git@work:team/repo.git',
        workingDir: process.cwd(),
        resolveHost: async () => 'github.com',
        requires: ['source-plan-owner-ref/v1'],
        operation: 'database push test',
      },
      { createCanonicalClient: createClient }
    );

    expect(createClient).toHaveBeenCalledWith({
      baseUrl: target.server_url,
      store: credentialStore,
      cliVersion: '0.2.0-rc.2',
      signal: undefined,
      requires: ['source-plan-owner-ref/v1'],
      operation: 'database push test',
    });
    expect(connection).toMatchObject({
      cloudClient: client,
      target,
      wireRepoUrl: 'git@github.com:team/repo.git',
      sessionRepoUrl: 'https://work/team/repo',
      workingDir: cwd,
    });
    expect(Object.keys(connection)).not.toContain('credentialStore');
  });

  it('uses the canonical client default through the mocked SDK boundary', async () => {
    const start = vi.fn(async () => ({ commandId: 'command-1', status: 'accepted' as const }));
    const client = cloudClient(start);
    const target = {
      server_url: 'https://cloud.example',
      org_id: 'authenticated-org',
      account_id: 'authenticated-account',
    };
    vi.mocked(createCanonicalCloudClient).mockResolvedValue({
      client,
      target,
      credentialStore,
    });

    const connection = await createDatabaseArtifactPushConnection({
      baseUrl: target.server_url,
      credentialStore,
      cliVersion: '0.2.0-rc.2',
      rawRepoUrl: 'https://user:secret@github.com/team/repo.git',
      workingDir: process.cwd(),
    });

    expect(createCanonicalCloudClient).toHaveBeenCalledOnce();
    expect(connection.target).toBe(target);
    expect(connection.wireRepoUrl).toBe('https://github.com/team/repo.git');
    expect(connection.sessionRepoUrl).toBe('https://github.com/team/repo');
    await expect(
      connection.artifactPushClient.captureThread.start(Buffer.from('{"externalId":"artifact"}'))
    ).resolves.toEqual(Buffer.from('{"commandId":"command-1","status":"accepted"}'));
    expect(start).toHaveBeenCalledWith({ externalId: 'artifact' });
  });

  it('rejects missing and oversized remotes before qualifying cloud credentials', async () => {
    await expect(
      createDatabaseArtifactPushConnection({
        baseUrl: 'https://cloud.example',
        credentialStore,
        cliVersion: '0.2.0-rc.2',
        rawRepoUrl: ' ',
        workingDir: process.cwd(),
      })
    ).rejects.toBeInstanceOf(Error);
    await expect(
      createDatabaseArtifactPushConnection({
        baseUrl: 'https://cloud.example',
        credentialStore,
        cliVersion: '0.2.0-rc.2',
        rawRepoUrl: `https://github.com/${'r'.repeat(2048)}`,
        workingDir: process.cwd(),
      })
    ).rejects.toBeInstanceOf(Error);
    expect(createCanonicalCloudClient).not.toHaveBeenCalled();
  });

  it('stops a pre-aborted connection before cloud qualification', async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(
      createDatabaseArtifactPushConnection({
        baseUrl: 'https://cloud.example',
        credentialStore,
        cliVersion: '0.2.0-rc.2',
        rawRepoUrl: 'https://github.com/team/repo.git',
        workingDir: process.cwd(),
        signal: stop.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createCanonicalCloudClient).not.toHaveBeenCalled();
    expect(unexpectedSdkCall).not.toHaveBeenCalled();
  });
});
