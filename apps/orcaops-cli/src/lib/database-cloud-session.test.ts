import { describe, expect, it, vi } from 'vitest';

import type { CredentialStore, OrcaCloudClient } from '@orcaops/sdk';
import { sha256Hex } from '@orcaops/storage';
import { readProjectSessionBranch } from '@orcaops/storage/history/database/session-branch';

import {
  type DatabaseCloudSessionDependencies,
  openDatabaseCloudSession,
} from './database-cloud-session.js';
import { runInInvocationContext } from './invocation-context.js';
import { fixture, git, inventory } from '../../tests/helpers/database-history.js';

const unavailable = vi.fn(() => Promise.reject(new Error('unexpected SDK call')));
const credentials: CredentialStore = {
  kind: 'file',
  read: unavailable,
  write: unavailable,
  clear: unavailable,
};

function cloudClient(): OrcaCloudClient {
  return {
    cli: { ping: unavailable },
    user: { me: unavailable },
    repo: { upsertByRemote: unavailable },
    captureThread: {
      start: unavailable,
      update: unavailable,
      complete: unavailable,
      attachPlan: unavailable,
      attachPlanRevision: unavailable,
      attachCheckpointOpened: unavailable,
      attachCheckpoint: unavailable,
      attachSummary: unavailable,
      attachEvaluators: unavailable,
      attachCodingSessionsUsage: unavailable,
    },
    sourcePlan: {
      attachPin: unavailable,
      create: unavailable,
      getApproved: unavailable,
      get: unavailable,
      reviewPull: unavailable,
      reviewPush: unavailable,
      reviewPropose: unavailable,
      reviewComment: unavailable,
      list: unavailable,
      reviewDetail: unavailable,
      setReviewerVerdict: unavailable,
      declineProposal: unavailable,
      listReviewers: unavailable,
    },
    review: {
      status: unavailable,
      pull: unavailable,
      reply: unavailable,
      resolve: unavailable,
    },
  };
}

function invocation(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'database-cloud-session',
    },
    cloudBaseUrl: 'https://cloud.example',
  };
}

describe('database cloud session', { timeout: 120_000 }, () => {
  it('qualifies a pinned artifact and observes its exact normalized session', async () => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'git@github.com:team/repo.git']);
    const content = '# Approved plan';
    const artifactId = await f.capture(undefined, {
      sourcePlan: {
        source_ref: {
          kind: 'cloud',
          locator: 'approved-plan',
          version: '3',
          base_url: 'https://cloud.example',
          org_id: 'authenticated-org',
        },
        content,
        hash: sha256Hex(content),
        baseline: null,
      },
    });
    const target = {
      server_url: 'https://cloud.example',
      org_id: 'authenticated-org',
      account_id: 'authenticated-account',
    };
    const createCanonicalClient = vi.fn<
      NonNullable<
        NonNullable<DatabaseCloudSessionDependencies['connection']>['createCanonicalClient']
      >
    >(async (input) => {
      expect(
        typeof input.requires === 'function' ? input.requires(target) : input.requires
      ).toEqual(['source-plan-owner-ref/v1']);
      return { client: cloudClient(), target, credentialStore: credentials };
    });

    const session = await runInInvocationContext(invocation(f), () =>
      openDatabaseCloudSession(
        { selection: { kind: 'artifact', artifactId } },
        {
          resolveCredentials: () => credentials,
          connection: { createCanonicalClient },
        }
      )
    );
    try {
      expect(createCanonicalClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: target.server_url,
          requires: expect.any(Function),
          operation: 'project database artifact push',
        })
      );
      expect(session).toMatchObject({
        target,
        wireRepoUrl: 'git@github.com:team/repo.git',
        sessionRepoUrl: 'https://github.com/team/repo',
        workingDir: f.main,
      });
      expect(
        readProjectSessionBranch(session.handle, {
          target,
          repoUrl: session.sessionRepoUrl,
          workingDir: session.workingDir,
        })?.state
      ).toMatchObject({ current_branch: 'main', branch_history: [] });
      expect(unavailable).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it('refuses a secret-bearing branch before credentials or opening a writer', async () => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
    const artifactId = await f.capture();
    await git(f.main, ['branch', '-m', `ghp_${'A'.repeat(36)}`]);
    const resolveCredentials = vi.fn(() => credentials);
    const createCanonicalClient = vi.fn();
    const openWriter = vi.fn();

    await expect(
      runInInvocationContext(invocation(f), () =>
        openDatabaseCloudSession(
          { selection: { kind: 'artifact', artifactId } },
          { resolveCredentials, openWriter, connection: { createCanonicalClient } }
        )
      )
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(openWriter).not.toHaveBeenCalled();
    expect(createCanonicalClient).not.toHaveBeenCalled();
  });

  it('stops a pre-aborted session before credentials or cloud qualification', async () => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
    const artifactId = await f.capture();
    const stop = new AbortController();
    stop.abort();
    const resolveCredentials = vi.fn(() => credentials);
    const createCanonicalClient = vi.fn();

    await expect(
      runInInvocationContext(invocation(f), () =>
        openDatabaseCloudSession(
          { selection: { kind: 'artifact', artifactId }, signal: stop.signal },
          { resolveCredentials, connection: { createCanonicalClient } }
        )
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(createCanonicalClient).not.toHaveBeenCalled();
  });

  it('observes an ABA branch sequence and replays an unchanged observation', async () => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
    const artifactId = await f.capture();
    const target = {
      server_url: 'https://cloud.example',
      org_id: 'authenticated-org',
      account_id: 'authenticated-account',
    };
    const createCanonicalClient = vi.fn(async () => ({
      client: cloudClient(),
      target,
      credentialStore: credentials,
    }));
    const open = () =>
      runInInvocationContext(invocation(f), () =>
        openDatabaseCloudSession(
          { selection: { kind: 'artifact' as const, artifactId } },
          { resolveCredentials: () => credentials, connection: { createCanonicalClient } }
        )
      );
    const read = () =>
      readProjectSessionBranch(f.writer, {
        target,
        repoUrl: 'https://github.com/team/repo',
        workingDir: f.main,
      });

    (await open()).close();
    expect(read()).toMatchObject({ selection: { version: 1 }, state: { current_branch: 'main' } });
    const beforeRetry = await inventory(f.root);
    (await open()).close();
    expect(await inventory(f.root)).toEqual(beforeRetry);

    await git(f.main, ['switch', '-c', 'feature']);
    (await open()).close();
    expect(read()).toMatchObject({
      selection: { version: 2 },
      state: { current_branch: 'feature' },
    });
    await git(f.main, ['switch', 'main']);
    (await open()).close();
    expect(read()).toMatchObject({ selection: { version: 3 }, state: { current_branch: 'main' } });
  });
});
