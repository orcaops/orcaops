import type { CredentialStore, StoredCredentials } from '@orcaops/sdk';
import { canonicalizeBaseUrl } from '@orcaops/storage';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

export function createCanonicalCredentialGuard(source: CredentialStore, baseUrl: string) {
  const server = canonicalizeBaseUrl(baseUrl);
  let target: RemoteTarget | null = null;
  let envToken: string | null = null;
  let latest: StoredCredentials | null = null;
  let first: StoredCredentials | null = null;
  const refuse = () => {
    throw Object.assign(
      new Error('Cloud credentials changed from the qualified operation target'),
      { code: 'CLOUD_TARGET_CHANGED' }
    );
  };
  function validate(value: StoredCredentials | null): void {
    if (!value) return;
    if (canonicalizeBaseUrl(value.baseUrl) !== server) refuse();
    if (!target) {
      if (!first) return;
      if (first.orgId && first.userId) {
        if (value.orgId !== first.orgId || value.userId !== first.userId) refuse();
      } else if (
        first.loginMethod !== 'env' ||
        value.loginMethod !== 'env' ||
        value.accessToken !== first.accessToken ||
        (first.orgId && value.orgId !== first.orgId) ||
        (first.userId && value.userId !== first.userId)
      )
        refuse();
      return;
    }
    if (value.orgId && value.userId) {
      if (value.orgId !== target.org_id || value.userId !== target.account_id) refuse();
    } else if (
      value.loginMethod !== 'env' ||
      envToken === null ||
      value.accessToken !== envToken ||
      (value.orgId && value.orgId !== target.org_id) ||
      (value.userId && value.userId !== target.account_id)
    )
      refuse();
  }
  const store: CredentialStore = {
    kind: source.kind,
    read: async (url) => {
      if (canonicalizeBaseUrl(url) !== server) refuse();
      const value = await source.read(url);
      validate(value);
      if (!first && value) first = structuredClone(value);
      latest = value ? structuredClone(value) : null;
      return value ? structuredClone(value) : null;
    },
    write: async (url, value) => {
      if (canonicalizeBaseUrl(url) !== server) refuse();
      validate(value);
      const current = await source.read(url);
      if ((target || first) && current === null) refuse();
      validate(current);
      await source.write(url, structuredClone(value));
    },
    clear: async (url) => {
      if (canonicalizeBaseUrl(url) !== server) refuse();
      validate(await source.read(url));
      await source.clear(url);
    },
    ...(source.withRefreshLock
      ? {
          withRefreshLock: <T>(url: string, fn: () => Promise<T>) =>
            source.withRefreshLock!(url, fn),
        }
      : {}),
  };
  return {
    store,
    bind(qualified: RemoteTarget, original: StoredCredentials): void {
      if (target) refuse();
      target = canonicalRemoteTarget(qualified);
      if (target.server_url !== server) refuse();
      if (original.loginMethod === 'env' && (!original.orgId || !original.userId))
        envToken = original.accessToken;
      validate(original);
      if (latest) validate(latest);
    },
  };
}
