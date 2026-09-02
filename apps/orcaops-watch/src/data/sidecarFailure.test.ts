import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createStreamSource } from './streamSource.js';
import { makeArchiveFixture } from '../../tests/support/fixture-archive.js';

const PROJECT_ID = '019fc200-0000-7000-8000-00000000aaa1';
const ARTIFACT_ID = '01999999-9999-7000-8000-0000000000e0';

describe('watch data sidecar failure propagation', () => {
  it('reports a fatal stream error when a live hot artifacts root becomes a symlink', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJECT_ID);
      await hot.seed({ artifactId: ARTIFACT_ID, stepCount: 2, closedSteps: 1 });

      const source = createStreamSource({
        sidecarPath: fileURLToPath(new URL('../../dist/sidecar.js', import.meta.url)),
        root: hot.repoPath,
        env: {
          ...process.env,
          ...fx.env,
          NODE_OPTIONS: '--unhandled-rejections=warn',
        },
        restartDelayMs: 60_000,
      });

      const error = await new Promise<Error>((resolve, reject) => {
        let poisoning = false;
        let stop = (): void => undefined;
        // fs.watch may drop the rename notification; the production fallback
        // is a 10-second heartbeat, so the discriminator must outlast it.
        const timeout = setTimeout(() => {
          stop();
          reject(new Error('sidecar stayed connected after its tick failed'));
        }, 15_000);
        stop = source.start({
          onSnapshot: (snapshot) => {
            if (poisoning) return;
            poisoning = true;
            expect(snapshot.projects).toEqual(
              expect.arrayContaining([expect.objectContaining({ projectId: PROJECT_ID })])
            );
            void (async () => {
              const artifactsDir = path.join(hot.repoPath, hot.store.config.artifacts.path);
              const originalArtifacts = path.join(hot.repoPath, '.orcaops', 'artifacts-original');
              await rename(artifactsDir, originalArtifacts);
              const external = path.join(fx.base, 'external-artifacts');
              await mkdir(external);
              await symlink(external, artifactsDir);
              await writeFile(path.join(originalArtifacts, 'trigger-watch'), 'changed');
            })().catch((cause: unknown) => {
              clearTimeout(timeout);
              stop();
              reject(cause instanceof Error ? cause : new Error(String(cause)));
            });
          },
          onError: (cause) => {
            clearTimeout(timeout);
            stop();
            resolve(cause instanceof Error ? cause : new Error(String(cause)));
          },
        });
      });

      expect(error.message).toContain('watch sidecar exited (code 1)');
      expect(error.message).toContain('config artifacts.path');
    } finally {
      await fx.cleanup();
    }
  }, 35_000);
});
