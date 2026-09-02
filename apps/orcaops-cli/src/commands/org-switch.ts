import { loginAction } from './login.js';

export interface OrgSwitchOptions {
  baseUrl?: string;
  json?: boolean;
}

/**
 * Force the OAuth flow with reauth=true so the cloud's consent page
 * shows the org picker even for single-org users. Implemented as a
 * thin alias of `login --reauth` — every flag the user might want
 * (--force-consent, --json) flows through loginAction.
 */
export async function orgSwitchAction(opts: OrgSwitchOptions): Promise<void> {
  await loginAction({
    baseUrl: opts.baseUrl,
    reauth: true,
    json: opts.json,
  });
}
