import { canonicalJson } from '@orcaops/storage';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

import { createCanonicalCredentialGuard } from './canonical-credentials.js';
import { createCloudClient, type CreateCloudClientOptions } from './client.js';
import { assertCloudSupports, type OrcaopsCapability } from './handshake.js';

export async function createCanonicalCloudClient(
  input: CreateCloudClientOptions & {
    requires:
      | readonly OrcaopsCapability[]
      | ((target: Readonly<RemoteTarget>) => readonly OrcaopsCapability[]);
    operation: string;
    target?: RemoteTarget;
  }
) {
  const options = {
    ...input,
    target: input.target ? canonicalRemoteTarget(input.target) : undefined,
  };
  options.signal?.throwIfAborted();
  const guard = createCanonicalCredentialGuard(options.store, options.baseUrl);
  const handle = await createCloudClient({
    baseUrl: options.baseUrl,
    store: guard.store,
    cliVersion: options.cliVersion,
    signal: options.signal,
  });
  const credentials = structuredClone(handle.credentials);
  const ping = await handle.client.cli.ping();
  const target = Object.freeze(
    canonicalRemoteTarget({
      server_url: options.baseUrl,
      org_id: ping.orgId,
      account_id: ping.userId,
    })
  );
  const requires =
    typeof options.requires === 'function' ? options.requires(target) : [...options.requires];
  assertCloudSupports(ping, requires, options.operation, { cliVersion: options.cliVersion });
  if (options.target && canonicalJson(target) !== canonicalJson(options.target))
    throw Object.assign(
      new Error('Authenticated cloud target differs from the selected authority'),
      { code: 'CONFLICT' }
    );
  guard.bind(target, credentials);
  if (!(await guard.store.read(options.baseUrl)))
    throw Object.assign(new Error('Cloud credentials disappeared during target qualification'), {
      code: 'CLOUD_TARGET_CHANGED',
    });
  return Object.freeze({
    client: handle.client,
    target,
    credentialStore: guard.store,
  });
}
