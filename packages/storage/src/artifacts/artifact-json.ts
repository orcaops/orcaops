import { atomicWriteFile } from './atomic-write.js';
import { type ArtifactJson, ArtifactJsonSchema } from '../schema/artifact-json.js';

/**
 * Atomically write the artifact.json projection to `targetPath`.
 *
 * Validates `input` against `ArtifactJsonSchema` before writing — a
 * malformed projection on disk is harder to debug than a thrown
 * exception at write time, and the projection is a load-bearing source
 * of truth for artifact-level metadata.
 *
 * Path discipline lives in `artifactPathsFor(...).artifactJson`;
 * callers compose the path themselves so this writer stays free of
 * the path-layout concern.
 */
export async function writeArtifactJson(
  targetPath: string,
  input: ArtifactJson,
  containmentRoot?: string
): Promise<void> {
  const validated = ArtifactJsonSchema.parse(input);
  await atomicWriteFile(targetPath, JSON.stringify(validated, null, 2) + '\n', containmentRoot);
}
