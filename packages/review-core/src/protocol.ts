import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const nullableIdentityString = nonEmptyString.nullable();

export const executableIdentitySchema = z.strictObject({
  executablePath: nonEmptyString,
  entrypointPath: nonEmptyString,
  packageName: nonEmptyString,
  packageVersion: nonEmptyString,
  packageRoot: nonEmptyString,
  packageLinkTarget: nullableIdentityString,
  buildCommit: nullableIdentityString,
  buildTimestamp: z.iso.datetime().nullable(),
  buildDirty: z.boolean().nullable(),
  /** Hash of the resolved CLI entrypoint bytes, or null when it cannot be read. */
  entrypointSha256: nullableIdentityString,
  /** Path-independent hash of compiled runtime files in the internal package closure. */
  compiledRuntimeManifestSha256: nonEmptyString,
  /** Canonical path-independent hash over the build-bearing identity fields. */
  runtimeFingerprintSha256: nonEmptyString,
});
export type ExecutableIdentity = z.infer<typeof executableIdentitySchema>;
