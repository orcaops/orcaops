import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

interface DoctorReport {
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; summary: string }>;
}

function check(report: DoctorReport, name: string) {
  const value = report.checks.find((entry) => entry.name === name);
  if (!value) throw new Error(`Missing doctor check ${name}`);
  return value;
}

describe('orcaops doctor — retired archive mirror', () => {
  it('ignores legacy archive files and leaves them unchanged', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-archive-retirement',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    expect((await agent.runRaw(['init', '--scope', 'project', '--no-llm'])).exitCode).toBe(0);
    const archiveFile = path.join(f.temporary, 'legacy-archive', 'events.ndjson');
    await mkdir(path.dirname(archiveFile), { recursive: true });
    await writeFile(archiveFile, 'retired archive bytes\n', 'utf8');
    const before = await inventory(f.temporary);

    const result = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(check(report, 'history-database').status).toBe('pass');
    expect(report.checks.some((entry) => entry.name.startsWith('archive'))).toBe(false);
    expect(await readFile(archiveFile, 'utf8')).toBe('retired archive bytes\n');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
