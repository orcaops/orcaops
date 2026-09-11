import { rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from '@orcaops/adapters';

import {
  closeWithFindings,
  damageArtifact,
  insightFixture,
  parseOk,
  summarize,
} from '../helpers/database-insights.js';

describe('project history insight collections', { timeout: 30_000 }, () => {
  it('executes the project-wide commands advertised by opt-in insight skills', async () => {
    const f = await insightFixture();
    for (const [skillId, command] of [
      ['decisions', 'decisions'],
      ['loose-ends', 'loose-ends'],
      ['estimate', 'list'],
    ]) {
      const skill = SKILL_TEMPLATES.find((candidate) => candidate.id === skillId)!;
      const body = typeof skill.body === 'function' ? skill.body('orcaops') : skill.body;
      const example = `orcaops ${command} --scope project --json`;
      expect(body).toContain(example);
      const result = parseOk(await f.agent.runRaw(example.split(' ').slice(1)));
      expect(result.scope.kind).toBe('project');
      expect(result.results).toEqual(
        expect.arrayContaining([expect.objectContaining({ artifact_id: f.id })])
      );
    }
  });

  it('reads retained projects after their checkout disappears and qualifies every result', async () => {
    const f = await insightFixture();
    const other = await insightFixture(f.root);
    await summarize(other);
    await rename(other.main, path.join(other.temporary, 'former-checkout'));
    for (const command of ['decisions', 'loose-ends']) {
      const result = parseOk(await f.agent.runRaw([command, '--scope', 'all-projects', '--json']));
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifact_id: f.id, project_id: f.authority.projectId }),
          expect.objectContaining({ artifact_id: other.id, project_id: other.authority.projectId }),
        ])
      );
      expect(result.completeness.complete).toBe(true);
    }
  });

  it('includes linked worktree records while retaining literal branch filters', async () => {
    const f = await insightFixture();
    const linked = await f.capture(undefined, {
      cwd: f.linked,
      decisions: [{ decision: 'Linked choice', reason: 'Retain linked evidence', revision_n: 0 }],
    });
    for (const command of ['decisions', 'loose-ends']) {
      const result = parseOk(
        await f.agent.runRaw([command, '--scope', 'all-projects', '--branch', 'linked', '--json'])
      );
      expect(result.results.map((row: { artifact_id: string }) => row.artifact_id)).toEqual([
        linked,
      ]);
      const local = parseOk(await f.agent.runRaw([command, '--scope', 'worktree', '--json']));
      expect(local.results.map((row: { artifact_id: string }) => row.artifact_id)).toEqual([f.id]);
    }
  });

  it('retains a healthy project when selected history in another project is damaged', async () => {
    const f = await insightFixture();
    const other = await insightFixture(f.root);
    await closeWithFindings(other, other.id, true);
    await summarize(other, other.id, true);
    damageArtifact(other);
    for (const command of ['decisions', 'loose-ends']) {
      const result = parseOk(await f.agent.runRaw([command, '--scope', 'all-projects', '--json']));
      expect(result.results.map((row: { artifact_id: string }) => row.artifact_id)).toEqual([f.id]);
      expect(result.completeness).toMatchObject({
        complete: false,
        issues: [expect.objectContaining({ project_id: other.authority.projectId })],
      });
    }
  });

  it('search filters recorded paths before merging projects and reports missing databases', async () => {
    const f = await insightFixture();
    const other = await insightFixture(f.root);
    await closeWithFindings(f);
    const first = parseOk(
      await f.agent.runRaw([
        'search',
        'retained',
        '--scope',
        'all-projects',
        '--touching',
        'src/retained.ts',
        '--json',
      ])
    );
    expect(first.results.length).toBeGreaterThan(0);
    expect(
      first.results.every((row: { project_id: string }) => row.project_id === f.authority.projectId)
    ).toBe(true);
    other.writer.close();
    await rename(other.writer.databasePath, other.writer.databasePath + '.unavailable');
    const second = parseOk(
      await f.agent.runRaw(['search', 'retained', '--scope', 'all-projects', '--json'])
    );
    expect(second.completeness.complete).toBe(false);
    expect(second.completeness.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project_id: other.authority.projectId, code: 'HISTORY_MISSING' }),
      ])
    );
    expect(
      second.results.every(
        (row: { project_id: string }) => row.project_id === f.authority.projectId
      )
    ).toBe(true);
  });

  it('rejects exact all-project combinations and retired flags while using the common envelope', async () => {
    const f = await insightFixture();
    for (const command of ['decisions', 'loose-ends']) {
      const exact = await f.agent.runRaw([
        command,
        '--scope',
        'all-projects',
        '--artifact',
        f.id,
        '--json',
      ]);
      expect(exact.exitCode).toBe(1);
      expect(JSON.parse(exact.stdout).error.code).toBe('SCOPE_CONFLICT');
      expect((await f.agent.runRaw([command, '--all-projects', '--json'])).exitCode).toBe(1);
      expect((await f.agent.runRaw([command, '--all-branches', '--json'])).exitCode).toBe(1);
      const result = parseOk(await f.agent.runRaw([command, '--json']));
      expect(result.scope.kind).toBe('project');
      expect(result).not.toHaveProperty('all_projects');
      expect(result).not.toHaveProperty('artifacts');
    }
  });
});
