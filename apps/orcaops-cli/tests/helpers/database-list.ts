import { expect } from 'vitest';

import type { readDatabaseList } from '../../src/lib/database-list.js';
import { makeAgent } from '../support/test-agent.js';

export function listAgent(f: { main: string; root: string }, cwd = f.main) {
  return makeAgent({ cwd, env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' } });
}
export async function readList(
  f: Parameters<typeof listAgent>[0],
  flags: string[] = [],
  cwd = f.main
) {
  const result = await listAgent(f, cwd).runRaw(['list', '--json', ...flags]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<typeof readDatabaseList>;
}
