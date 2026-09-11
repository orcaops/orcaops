import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { digest, DigestSchema } from '../event-integrity.js';
import { ProjectDatabaseError } from './errors.js';

const text = z.string().min(1);
const target = z.strictObject({ server_url: text, org_id: text, account_id: text });
export const SessionBranchKeySchema = z.strictObject({ target, repoUrl: text, workingDir: text });
export const SessionBranchSelectionSchema = z.strictObject({
  revisionId: UuidV7Schema,
  version: z.number().int().positive().safe(),
});
export const SessionBranchStateSchema = z.strictObject({
  schema_version: z.literal(1),
  target,
  repo_url: text,
  working_dir: text,
  current_branch: text,
  branch_history: z.array(text),
  base_commit_sha: z.string().nullable(),
  last_acked_at: z.string().nullable(),
});
export type SessionBranchState = z.infer<typeof SessionBranchStateSchema>;

function canonicalTarget(key: z.infer<typeof SessionBranchKeySchema>): boolean {
  let url: URL;
  try {
    url = new URL(key.target.server_url);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    canonicalizeBaseUrl(key.target.server_url) === key.target.server_url
  );
}
export function parseSessionBranchKey(input: unknown): z.infer<typeof SessionBranchKeySchema> {
  const result = SessionBranchKeySchema.safeParse(input);
  if (!result.success || !canonicalTarget(result.data))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact known canonical session account, repository and checkout scope',
      {
        cause: result.success ? undefined : result.error,
      }
    );
  Object.freeze(result.data.target);
  return Object.freeze(result.data);
}
export function decodeRetainedSessionBranch(input: {
  readonly key: unknown;
  readonly stateBytes: Uint8Array;
  readonly stateSha256: string;
}): {
  readonly state: Readonly<SessionBranchState>;
  readonly stateBase64: string;
  readonly stateSha256: string;
} {
  try {
    const key = parseSessionBranchKey(input.key);
    if (
      !(input.stateBytes instanceof Uint8Array) ||
      !DigestSchema.safeParse(input.stateSha256).success
    )
      throw new Error('Invalid retained byte or hash representation');
    const bytes = Buffer.from(input.stateBytes);
    if (digest(bytes) !== input.stateSha256)
      throw new Error('Retained session bytes do not match their comparison hash');
    const state = SessionBranchStateSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    if (
      canonicalJson(state.target) !== canonicalJson(key.target) ||
      state.repo_url !== key.repoUrl ||
      state.working_dir !== key.workingDir
    )
      throw new Error('Retained session state belongs to another scope');
    Object.freeze(state.target);
    Object.freeze(state.branch_history);
    Object.freeze(state);
    return Object.freeze({
      state,
      stateBase64: bytes.toString('base64'),
      stateSha256: input.stateSha256,
    });
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original session state is missing or inconsistent; preserve it for explicit repair',
      { cause }
    );
  }
}
