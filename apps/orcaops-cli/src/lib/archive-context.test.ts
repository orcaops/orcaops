import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Repo } from '@orcaops/core';
import { SECRET_POSITIVES } from '@orcaops/evaluator-protocol/secret-corpus';
import type { Config } from '@orcaops/storage';

import { buildArchiveContext } from './archive-context.js';
import { runInInvocationContext } from './invocation-context.js';

const PROJECT_ID = '019fc200-0000-7000-8000-00000000ccc1';

describe('buildArchiveContext error output', () => {
  it.each(SECRET_POSITIVES.map(({ name, sample }) => [name, sample] as const))(
    'redacts the shared %s shape when archive registry setup fails',
    async (_name, sample) => {
      const stateRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-archive-context-'));
      const written: string[] = [];
      const write = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        });
      const repo = {
        getLocalConfig: async () => PROJECT_ID,
        getCommonDirAbsolute: async () => {
          throw new Error('common directory unavailable');
        },
        getRemoteUrl: async () => {
          throw new Error(`remote lookup failed with ${sample}`);
        },
      } as unknown as Repo;
      const config = {
        archive: { enabled: true, redact_secrets: false },
      } as Config;

      try {
        await expect(
          runInInvocationContext(
            {
              env: {
                ORCAOPS_DATA_DIR: path.join(stateRoot, 'data'),
                XDG_CACHE_HOME: path.join(stateRoot, 'cache'),
              },
            },
            () => buildArchiveContext('/repo', config, repo)
          )
        ).resolves.toBeNull();
      } finally {
        write.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }

      const output = written.join('');
      expect(output).toContain('archive: disabled');
      expect(output).not.toContain(sample);
      expect(output).toContain('REDACTED');
    }
  );

  it('does not expose the cause of a project identity read failure', async () => {
    const written: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    const repo = {
      getLocalConfig: async () => {
        throw new Error('git failed with bearer secret-value');
      },
    } as unknown as Repo;
    const config = {
      archive: { enabled: true, redact_secrets: false },
    } as Config;

    try {
      await expect(buildArchiveContext('/repo', config, repo)).resolves.toBeNull();
    } finally {
      write.mockRestore();
    }

    const output = written.join('');
    expect(output).toContain('could not read git config orcaops.projectid');
    expect(output).not.toContain('secret-value');
  });
});
