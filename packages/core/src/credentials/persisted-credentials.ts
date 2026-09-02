import { z } from 'zod';

import { type StoredCredentials } from '@orcaops/sdk';

export const PersistedOAuthCredentialsSchema = z
  .object({
    v: z.literal(1),
    loginMethod: z.literal('oauth'),
    baseUrl: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string(),
    orgName: z.string().nullable(),
    orgSlug: z.string().nullable(),
    email: z.string(),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export function parsePersistedOAuthCredentials(value: unknown): StoredCredentials {
  return PersistedOAuthCredentialsSchema.parse(value);
}
