import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

// Real-shape, semantically dead. Refuse-tier everywhere else in the codebase.
const FAKE_GH_TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';

/**
 * Seed redacts rather than refuses — see `redactSeedNarrative` for why. What
 * must still hold is that the credential does not survive into anything
 * durable, so these assert the persisted bytes, not the command's exit code.
 */
describe('seed redacts secrets carried in commit history', () => {
  let repo: HistoryRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: add the deploy script',
        files: { 'deploy.sh': 'echo deploying\n' },
      },
      {
        type: 'commit',
        label: 'leak',
        subject: `fix: remove ${FAKE_GH_TOKEN} from the deploy script`,
        files: { 'deploy.sh': 'echo deploying safely\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('keeps the token out of the event log while still seeding the commit', async () => {
    const applied = await agent.runRaw(['seed', '--yes', '--json']);
    expect(applied.exitCode).toBe(0);

    const orcaopsDir = path.join(repo.path, '.orcaops', 'artifacts');
    const { readdir } = await import('node:fs/promises');
    const artifacts = await readdir(orcaopsDir);
    expect(artifacts.length).toBeGreaterThan(0);

    let sawRedaction = false;
    for (const artifact of artifacts) {
      const log = path.join(orcaopsDir, artifact, 'events.ndjson');
      let contents: string;
      try {
        contents = await readFile(log, 'utf8');
      } catch {
        continue;
      }
      expect(contents).not.toContain(FAKE_GH_TOKEN);
      if (contents.includes('[REDACTED_SECRET]')) sawRedaction = true;
    }

    // Redaction, not omission: the commit is still seeded, with the token
    // replaced. A backfill that silently dropped the commit would also pass
    // the assertion above.
    expect(sawRedaction).toBe(true);
  });
});
