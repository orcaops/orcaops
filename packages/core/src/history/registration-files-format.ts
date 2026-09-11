import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import { canonicalJson, isUuidV7 } from '@orcaops/storage';
import { HistoryError, historyRootKey } from '@orcaops/storage/history/authority';

const id = z.string().refine(isUuidV7);
const root = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const repositoryRegistrationBody = z
  .object({
    schema_version: z.literal(1),
    repository_instance_id: id,
    authority: z
      .object({
        resolved_root: root,
        root_key: hash,
        project_id: id,
        store_instance_id: id,
      })
      .strict()
      .refine((value) => historyRootKey(value.resolved_root) === value.root_key),
    initialization_operation_id: id,
  })
  .strict();

export const worktreeRegistrationBody = z
  .object({
    schema_version: z.literal(1),
    repository_instance_id: id,
    worktree_id: id,
  })
  .strict();

export const projectCatalogBody = z
  .object({
    schema_version: z.literal(1),
    project_id: id,
    creation: z
      .object({
        operation_id: id,
        created_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      })
      .strict(),
  })
  .strict();

export const repositoryRegistrationSchema = repositoryRegistrationBody.extend({ hash });
export const worktreeRegistrationSchema = worktreeRegistrationBody.extend({ hash });
export const projectCatalogSchema = projectCatalogBody.extend({ hash });

export type RepositoryRegistration = z.infer<typeof repositoryRegistrationSchema>;
export type WorktreeRegistration = z.infer<typeof worktreeRegistrationSchema>;
export type ProjectCatalogEntry = z.infer<typeof projectCatalogSchema>;

export function sealRegistration<T extends object>(body: T): T & { hash: string } {
  return { ...body, hash: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

export function registrationBytes(value: object): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

export function decodeRegistration<T extends { hash: string }>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  label: string
): T {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      value &&
      typeof value === 'object' &&
      'schema_version' in value &&
      typeof value.schema_version === 'number' &&
      value.schema_version !== 1
    ) {
      throw new HistoryError(
        'HISTORY_FORMAT_UNSUPPORTED',
        `${label} has an unsupported version; use a compatible release`
      );
    }
    const parsed = schema.parse(value);
    const { hash: actual, ...body } = parsed;
    if (
      sealRegistration(body).hash !== actual ||
      !registrationBytes(parsed).equals(Buffer.from(bytes))
    ) {
      throw new Error('Marker bytes or canonical hash differ');
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof HistoryError) throw cause;
    throw new HistoryError(
      'ACTIVATION_PENDING',
      `${label} is occupied but invalid or incomplete; preserve it for explicit repair`,
      { cause }
    );
  }
}
