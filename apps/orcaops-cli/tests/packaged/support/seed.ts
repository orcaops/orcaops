import { fork } from 'node:child_process';
import { once } from 'node:events';

import { children as childScripts, compiled } from './paths.js';
import type { DisposableRoot } from './roots.js';

export type SeededProject = {
  projectId: string;
  resolvedRoot: string;
  storeInstanceId: string;
  repositoryInstanceId: string;
  databasePath: string;
  artifactIds: string[];
};

/**
 * Creates the disposable project store in its own process, so the test runner holds
 * no database handle while the packaged processes contend.
 */
export async function seedProject(
  root: DisposableRoot,
  options: { cwd?: string; artifacts?: number; projectId?: string; ts?: string } = {}
): Promise<SeededProject> {
  const child = fork(
    childScripts.seed,
    [
      JSON.stringify({
        cwd: options.cwd ?? root.repo,
        root: root.dataDir,
        projectId: options.projectId,
        artifacts: options.artifacts ?? 0,
        ts: options.ts,
        modules: compiled,
      }),
    ],
    { cwd: options.cwd ?? root.repo, env: root.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`Seed exited ${code} ${signal}: ${stderr}`);
  return JSON.parse(stdout) as SeededProject;
}
