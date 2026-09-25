// `why` says which checkpoint wrote a line. It now also says what that line is answerable to.
//
// The two are different clocks, so they take different flags: `--at` resolves the code target at a
// Git revision, `--at-boundary` reads the record at a write sequence of this project history. One
// flag for both would answer at a boundary nobody named.
import { describe, expect, it } from 'vitest';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  replaceRequirement,
  writeSequenceOf,
} from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const ORIGINAL = 'Retained implementations name the boundary they were read at.';
const REPLACEMENT = 'Retained implementations name the boundary and the mode they were read at.';

interface Block {
  obligations: {
    id: string;
    accounts: { revision_id: string; standing: string; applicability: string }[];
  }[];
}

async function why(f: Fixture, target: string, flags: string[] = []) {
  const raw = await makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  }).runRaw(['why', target, ...flags, '--json']);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return JSON.parse(raw.stdout) as {
    knowledge: Block;
    context: { historical_boundary: number; mode: string };
    diagnostics: { later_annotations: unknown[]; processing: { statement: string } };
  };
}

describe('what a provenance answer says stands', { timeout: 120_000 }, () => {
  it('names the governing revision at now, and the earlier one at an earlier boundary', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture(undefined, { cwd: f.linked });
    const closeRef = await commitFile(
      f,
      'src/retained.ts',
      'export const retainedImplementation = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/retained.ts'],
      openRef,
      closeRef,
      summary: 'Implemented the approved design',
    });
    await git(f.main, ['worktree', 'remove', '--force', f.linked]);

    const projectId = f.authority.projectId;
    const adopted = await adoptedRequirement(f.writer, { projectId, statement: ORIGINAL });
    const adoptedBoundary = writeSequenceOf(f.writer);
    const replaced = await replaceRequirement(f.writer, {
      projectId,
      adopted,
      statement: REPLACEMENT,
    });
    const key = `requirement:${adopted.requirementId}`;
    const before = await inventory(f.temporary);

    const now = await why(f, 'src/retained.ts:1');
    expect(now.context.mode).toBe('current');
    expect(now.knowledge.obligations.map((entry) => entry.id)).toContain(key);
    expect(
      now.knowledge.obligations
        .find((entry) => entry.id === key)!
        .accounts.filter(
          (account) => account.standing === 'adopted' && account.applicability !== 'does_not_apply'
        )
        .map((account) => account.revision_id)
    ).toEqual([replaced.revisionId]);
    expect(now.diagnostics.processing.statement).toContain('claims no completeness');

    const past = await why(f, 'src/retained.ts:1', ['--at-boundary', String(adoptedBoundary)]);
    expect(past.context).toMatchObject({
      historical_boundary: adoptedBoundary,
      mode: 'historical',
    });
    expect(
      past.knowledge.obligations
        .find((entry) => entry.id === key)!
        .accounts.filter(
          (account) => account.standing === 'adopted' && account.applicability !== 'does_not_apply'
        )
        .map((account) => account.revision_id)
    ).toEqual([adopted.revisionId]);
    expect(past.diagnostics.later_annotations.length).toBeGreaterThan(0);

    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('refuses a boundary that is not a write sequence', async () => {
    const f = await fixture();
    await f.capture();
    await commitFile(f, 'src/retained.ts', 'export const retained = true;\n');

    const raw = await makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    }).runRaw(['why', 'src/retained.ts:1', '--at-boundary', 'HEAD~1', '--json']);

    expect(raw.exitCode).not.toBe(0);
    expect(JSON.parse(raw.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });
});
