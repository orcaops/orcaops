import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { readArtifactExport } from '../support/artifact-export.js';
import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

describe('show: strict lineage-name filter', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(task: string): Promise<{ artifact_id: string }> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task,
          plan_steps: [
            { text: 's', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
          ],
        })
      ),
    ]);
    return JSON.parse(planRes.stdout) as { artifact_id: string };
  }

  describe('show', () => {
    it('emits lineage_sha_drift: null when current HEAD matches the lineage entry', async () => {
      const plan = await capturePlan('t');
      const showRes = await readArtifactExport(agent, plan.artifact_id);
      expect(showRes.exitCode).toBe(0);
      const show = JSON.parse(showRes.stdout) as {
        artifact: { lineage_sha_drift: unknown; branch_lineage: Array<{ branch: string }> };
      };
      expect(show.artifact.lineage_sha_drift).toBeNull();
      expect(show.artifact.branch_lineage[0].branch).toBe('main');
    });

    it('emits lineage_sha_drift when HEAD has moved past the recorded entry', async () => {
      const plan = await capturePlan('t');
      await commitFile(repo.path, 'b.ts', 'b\n', 'after artifact');

      const showRes = await readArtifactExport(agent, plan.artifact_id);
      const show = JSON.parse(showRes.stdout) as {
        artifact: {
          lineage_sha_drift: { branch: string; recorded_sha: string; current_sha: string } | null;
        };
      };
      expect(show.artifact.lineage_sha_drift).not.toBeNull();
      expect(show.artifact.lineage_sha_drift?.branch).toBe('main');
      expect(show.artifact.lineage_sha_drift?.recorded_sha).not.toBe(
        show.artifact.lineage_sha_drift?.current_sha
      );
    });

    it('emits lineage_sha_drift: null when the current branch is not in the lineage at all', async () => {
      const plan = await capturePlan('on main');
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/y');
      const showRes = await readArtifactExport(agent, plan.artifact_id);
      const show = JSON.parse(showRes.stdout) as {
        artifact: { lineage_sha_drift: unknown };
      };
      expect(show.artifact.lineage_sha_drift).toBeNull();
    });
  });
});
