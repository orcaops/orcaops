import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface DoctorReport {
  overall: 'pass' | 'warn' | 'fail';
  checks: { name: string; status: string; summary: string; details?: string[] }[];
}
const check = (out: string): DoctorReport['checks'][number] => {
  const c = (JSON.parse(out) as DoctorReport).checks.find((x) => x.name === 'generated-files');
  if (!c) throw new Error('no generated-files check');
  return c;
};

/** Doctor recommends generated_files:ignore on committed-projection churn. */
describe('orcaops doctor — generated-files recommendation', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-genfiles' } });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('recommends ignore (info, never flips overall) when committed generated files are stale', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']); // commit mode (default)
    // Stale a committed skill (the projection churn commit mode is prone to).
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    const content = await readFile(skillPath, 'utf8');
    await writeFile(skillPath, content.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale'), 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const c = check(res.stdout);
    expect(c.status).toBe('pass'); // advisory only — doesn't flip overall to warn
    expect(c.summary).toMatch(/consider switching to "ignore"/);
    expect((c.details ?? []).join(' ')).toMatch(/generated_files/);
  });

  it('passes cleanly in ignore mode', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--generated-files', 'ignore', '--no-llm']);
    const res = await agent.runRaw(['doctor', '--json']);
    expect(check(res.stdout).summary).toMatch(/generated_files=ignore/);
  });

  it('passes in commit mode with no churn (no recommendation)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const res = await agent.runRaw(['doctor', '--json']);
    const c = check(res.stdout);
    expect(c.summary).toMatch(/no committed-projection churn/);
    expect(c.summary).not.toMatch(/ignore/);
  });
});
