import { resolveCloudTarget, resolveCredentialStore } from '@orcaops/core';
import { type AuthState, getAuthState } from '@orcaops/sdk';

export type StatusAuthKind = AuthState['kind'] | 'unknown';

export async function readStatusAuthKind(): Promise<StatusAuthKind> {
  try {
    return (await getAuthState(resolveCredentialStore(), resolveCloudTarget())).kind;
  } catch {
    // Unreadable credentials do not establish logout or invalidate local history.
    return 'unknown';
  }
}
