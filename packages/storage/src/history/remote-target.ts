import { z } from 'zod';

import { canonicalizeBaseUrl } from '../source-plan/canonical-base-url.js';

export const RemoteTargetSchema = z.strictObject({
  server_url: z.string().min(1),
  org_id: z.string().min(1),
  account_id: z.string().min(1),
});

export type RemoteTarget = z.infer<typeof RemoteTargetSchema>;

export function canonicalRemoteTarget(target: RemoteTarget): RemoteTarget {
  return RemoteTargetSchema.parse({
    ...target,
    server_url: canonicalizeBaseUrl(target.server_url),
  });
}
