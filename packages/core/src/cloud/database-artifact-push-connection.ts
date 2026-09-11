import { realpath } from 'node:fs/promises';

import type { CredentialStore, OrcaCloudClient } from '@orcaops/sdk';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { createCanonicalCloudClient } from './canonical-client.js';
import { createArtifactPushClient } from './database-artifact-push-transport.js';
import { MissingGitRemoteError, RepoUrlTooLongError } from './errors.js';
import { type OrcaopsCapability } from './handshake.js';
import { canonicalizeRemoteUrl, type HostResolver, normalizeRepoUrl } from './repo-url.js';
import type { ArtifactPushClient } from '../history/sync/dispatch.js';

export interface CreateDatabaseArtifactPushConnectionInput {
  readonly baseUrl: string;
  readonly credentialStore: CredentialStore;
  readonly cliVersion: string;
  readonly rawRepoUrl: string;
  readonly workingDir: string;
  readonly signal?: AbortSignal;
  readonly target?: RemoteTarget;
  readonly resolveHost?: HostResolver;
  readonly requires?:
    | readonly OrcaopsCapability[]
    | ((target: Readonly<RemoteTarget>) => readonly OrcaopsCapability[]);
  readonly operation?: string;
}

export interface DatabaseArtifactPushConnection {
  readonly cloudClient: OrcaCloudClient;
  readonly artifactPushClient: ArtifactPushClient;
  readonly target: RemoteTarget;
  readonly wireRepoUrl: string;
  readonly sessionRepoUrl: string;
  readonly workingDir: string;
}

export interface DatabaseArtifactPushConnectionDependencies {
  readonly createCanonicalClient?: typeof createCanonicalCloudClient;
}

export async function createDatabaseArtifactPushConnection(
  input: CreateDatabaseArtifactPushConnectionInput,
  dependencies: DatabaseArtifactPushConnectionDependencies = {}
): Promise<DatabaseArtifactPushConnection> {
  input.signal?.throwIfAborted();
  if (input.rawRepoUrl.trim().length === 0) throw new MissingGitRemoteError();
  const wireRepoUrl = await canonicalizeRemoteUrl(input.rawRepoUrl, input.resolveHost);
  if (wireRepoUrl.length > 2048) throw new RepoUrlTooLongError(wireRepoUrl.length, 2048);
  const workingDir = await realpath(input.workingDir);
  input.signal?.throwIfAborted();
  const connected = await (dependencies.createCanonicalClient ?? createCanonicalCloudClient)({
    baseUrl: input.baseUrl,
    store: input.credentialStore,
    cliVersion: input.cliVersion,
    signal: input.signal,
    target: input.target,
    requires: input.requires ?? [],
    operation: input.operation ?? 'project database artifact push',
  });
  return Object.freeze({
    cloudClient: connected.client,
    artifactPushClient: createArtifactPushClient(connected.client),
    target: connected.target,
    wireRepoUrl,
    sessionRepoUrl: normalizeRepoUrl(input.rawRepoUrl),
    workingDir,
  });
}
