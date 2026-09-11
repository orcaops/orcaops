import { Repo } from '@orcaops/core';
import { discoverEvaluators } from '@orcaops/evaluator-runner';
import type { DatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import type { Config } from '@orcaops/storage';

import { CLI_VERSION } from './cli-version.js';
import { CLI_ROOT } from './evaluators-config.js';
import { detectInstallDrift, type InstallDrift } from './install-drift.js';
import { buildAcknowledgeByRef } from './next-actions.js';
import { resolveSkillGates } from './skill-set.js';

export async function readTaskAdvisories(
  context: { scope: DatabaseHistoryScope; config: Config },
  env: NodeJS.ProcessEnv
) {
  const git = context.scope.gitContext && structuredClone(context.scope.gitContext);
  let drift: InstallDrift | null = null;
  let index: { state: 'available'; unmerged_paths: string[] } | { state: 'unavailable' } = {
    state: 'unavailable',
  };
  let acknowledgeByRef: (ref: string) => boolean = () => false;
  if (git) {
    try {
      drift = await detectInstallDrift(
        git.worktreeRoot,
        context.config,
        CLI_VERSION,
        resolveSkillGates(env)
      );
    } catch {
      /* Installation hints do not establish task authority. */
    }
    try {
      const repo = new Repo(git.worktreeRoot, {
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
        },
      });
      const paths = await repo.listUnmergedPaths();
      if (paths !== null) index = { state: 'available', unmerged_paths: paths };
    } catch {
      /* Unavailable Git inspection remains explicit. */
    }
    try {
      const { evaluators } = await discoverEvaluators(git.worktreeRoot, {
        cliRoot: CLI_ROOT,
        onError() {},
      });
      acknowledgeByRef = buildAcknowledgeByRef(evaluators);
    } catch {
      /* Broken evaluator configuration never grants acknowledgment eligibility. */
    }
  }
  return { drift, index, acknowledgeByRef };
}
