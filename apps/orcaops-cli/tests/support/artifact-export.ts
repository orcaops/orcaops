import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { InProcessAgent } from '@orcaops/test-harness';

export async function readArtifactExport(
  agent: InProcessAgent,
  artifactId: string,
  flags: string[] = []
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'artifact-export-test-'));
  try {
    const destination = path.join(directory, 'artifact.json');
    const result = await agent.runRaw([
      'show',
      artifactId,
      ...flags,
      '--output',
      destination,
      '--json',
    ]);
    if (result.exitCode !== 0) return result;
    return { ...result, stdout: await readFile(destination, 'utf8') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
