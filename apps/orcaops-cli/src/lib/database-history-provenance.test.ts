import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orcaops/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/storage')>();
  return { ...actual, redactSecretsInObject: vi.fn(actual.redactSecretsInObject) };
});

import { ProvenanceRepository } from '@orcaops/core/history';
import { redactSecretsInObject } from '@orcaops/storage';
import { digest } from '@orcaops/storage/history/primitives';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { readDatabaseCanonicalWhy, readDatabaseProvenance } from './database-history-provenance.js';
import { projectProvenanceJson } from './provenance-json.js';
import { compactSourceVersions } from './provenance-output.js';
import {
  closeFingerprintedCheckpoint,
  commitFile,
} from '../../tests/helpers/database-fingerprint.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';

afterEach(() => vi.mocked(redactSecretsInObject).mockClear());

async function contextFor(value: Awaited<ReturnType<typeof fixture>>) {
  return resolveDatabaseHistoryCommandContext({
    profile: 'git-history',
    cwd: value.main,
    dataRoot: value.root,
  });
}

describe('database provenance reads', { timeout: 30_000 }, () => {
  it('distinguishes candidate budget omissions from paging and compact details', async () => {
    const f = await fixture();
    await commitFile(f, 'budget.ts', 'export const boundedHistory = true;\n');
    await f.capture();
    await f.capture();
    const context = await contextFor(f);
    try {
      for (const details of [false, true]) {
        const result = await readDatabaseCanonicalWhy(
          context,
          path.join(f.main, 'budget.ts'),
          { details, audit: details, all: true, limit: 1 },
          { maxArtifacts: 1 }
        );
        expect(result).toMatchObject({
          conclusion: 'incomplete',
          best: null,
          diagnostics: {
            candidate_selection: { omitted: 1, complete: false },
            completeness: { complete: true },
          },
          pagination: {
            total: 1,
            returned: 1,
            next_offset: null,
            total_basis: 'evaluated_matches',
          },
          representation: details ? 'details' : 'compact',
          output: { omitted_provenance: 0 },
        });
        if (!('diagnostics' in result)) throw new Error('Expected a rationale response');
        if (details)
          expect(result.diagnostics.candidate_selection).toMatchObject({
            indexed: 2,
            materialized: 1,
          });
        else expect(result.diagnostics.candidate_selection.materialized).toBeUndefined();
      }
    } finally {
      context.scope.close();
    }
  });

  it('retains every shared diagnostic in detail mode even without result rows', async () => {
    const f = await fixture();
    await commitFile(f, 'unavailable.ts', 'export const unavailableHistory = true;\n');
    const context = await contextFor(f);
    try {
      const raw = await readDatabaseProvenance(context, path.join(f.main, 'unavailable.ts'));
      const issues = Array.from({ length: 13 }, (_, i) => ({
        code: 'UNAVAILABLE',
        project_id: f.authority.projectId,
        artifact_id: `unavailable-${i}`,
        message: 'diagnostic '.repeat(100),
        count: 500,
      }));
      raw.completeness = { complete: false, issues };
      raw.project_coverage.issues = issues;
      const detailed = projectProvenanceJson(raw, true);
      const compact = projectProvenanceJson(raw, false);
      expect(compact.results).toEqual([]);
      expect(compact.completeness).toMatchObject({
        complete: false,
        issues: { total: 13, omitted: 3, code_counts: [{ code: 'UNAVAILABLE', count: 13 }] },
      });
      expect(compact.project_coverage.issues).toEqual(compact.completeness.issues);
      expect(detailed.completeness.issues).toEqual(issues);
      expect(detailed.project_coverage.issues).toEqual(issues);
    } finally {
      context.scope.close();
    }
  });

  it('attributes code from exact retained revisions without changing project history', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const sourcePlan = {
      source_ref: { kind: 'local' as const, locator: '/removed/source.md' },
      content: 'Preserve the original approval context.',
      hash: digest('Preserve the original approval context.'),
      baseline: null,
    };
    const artifactId = await f.capture(undefined, {
      sourcePlan,
      decisions: [
        {
          decision: 'Keep the retained implementation',
          reason: 'It preserves lineage',
          revision_n: 0,
        },
      ],
    });
    const closeRef = await commitFile(
      f,
      'src/retained.ts',
      'export const retainedImplementation = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/retained.ts'],
      openRef,
      closeRef,
      summary: 'Implemented the retained behavior',
    });
    const context = await contextFor(f);
    context.config.digest.redact_secrets = true;
    const before = await inventory(f.temporary);
    const blame = vi.spyOn(ProvenanceRepository.prototype, 'blame');
    try {
      const result = await readDatabaseProvenance(context, path.join(f.main, 'src/retained.ts:1'));
      expect(blame).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        schema_version: 3,
        code_revision: closeRef,
        target: { file: 'src/retained.ts', line: 1, blame: { sha: closeRef } },
        best: {
          artifact_id: artifactId,
          source_plan: sourcePlan,
          plan_support: {
            plan: {
              revision_n: 0,
              decisions: [
                {
                  decision: 'Keep the retained implementation',
                  reason: 'It preserves lineage',
                },
              ],
            },
          },
          confidence: 'exact',
        },
        integrity: { selection: 'metadata', candidates: 'verified' },
      });
      expect(result.source_versions).toEqual([
        expect.objectContaining({ artifact_id: artifactId }),
      ]);
      expect(redactSecretsInObject).toHaveBeenCalledTimes(1);
      expect(await inventory(f.temporary)).toEqual(before);
    } finally {
      context.scope.close();
    }
  });

  it('refuses a result assembled across different database write sequences', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture();
    const closeRef = await commitFile(
      f,
      'src/changing.ts',
      'export const changingHistory = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/changing.ts'],
      openRef,
      closeRef,
    });
    const context = await contextFor(f);
    const original = ProvenanceRepository.prototype.reachability;
    vi.spyOn(ProvenanceRepository.prototype, 'reachability').mockImplementationOnce(async function (
      this: ProvenanceRepository,
      ...args
    ) {
      await f.capture(undefined, { reason: 'legacy_unknown' });
      return original.apply(this, args);
    });
    try {
      await expect(
        readDatabaseProvenance(context, path.join(f.main, 'src/changing.ts:1'))
      ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    } finally {
      context.scope.close();
    }
  });

  it('includes support-only artifact versions in compact source change detection', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const owner = await f.capture();
    const sibling = await f.capture();
    const closeRef = await commitFile(f, 'src/owned.ts', 'export const ownedBehavior = true;\n');
    await f.recordFiles(sibling, ['src/sibling.ts'], closeRef);
    await closeFingerprintedCheckpoint(f, owner, {
      files: ['src/owned.ts'],
      openRef,
      closeRef,
      crossArtifactSiblings: [{ artifact_id: sibling, n: 1 }],
    });
    const read = async () => {
      const context = await contextFor(f);
      try {
        return await readDatabaseProvenance(context, path.join(f.main, 'src/owned.ts:1'));
      } finally {
        context.scope.close();
      }
    };
    const before = await read();
    expect(before.candidate_selection).toMatchObject({ materialized: 1, support_materialized: 1 });
    expect(before.results.every((row) => row.artifact_id === owner)).toBe(true);
    expect(before.source_versions.map((row) => row.artifact_id).sort()).toEqual(
      [owner, sibling].sort()
    );
    const compact = projectProvenanceJson(before, false);
    expect(compact.source_versions).toEqual(compactSourceVersions(before.source_versions));
    expect(projectProvenanceJson(before, true).source_versions).toEqual(before.source_versions);
    await f.recordFiles(sibling, ['src/sibling.ts'], closeRef);
    const after = await read();
    expect(after.source_versions.find((row) => row.artifact_id === owner)).toEqual(
      before.source_versions.find((row) => row.artifact_id === owner)
    );
    expect(projectProvenanceJson(after, false).source_versions).not.toEqual(
      compact.source_versions
    );
  });

  it('reports omitted overlap support instead of presenting a complete attribution', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const owner = await f.capture();
    const sibling = await f.capture();
    const closeRef = await commitFile(
      f,
      'src/overlapped.ts',
      'export const overlappedHistory = true;\n'
    );
    await f.recordFiles(sibling, ['src/sibling.ts'], closeRef);
    await closeFingerprintedCheckpoint(f, owner, {
      files: ['src/overlapped.ts'],
      openRef,
      closeRef,
      crossArtifactSiblings: [{ artifact_id: sibling, n: 1 }],
    });
    const context = await contextFor(f);
    try {
      const budgets = { maxSupportArtifacts: 0 };
      const pending = readDatabaseProvenance(
        context,
        path.join(f.main, 'src/overlapped.ts:1'),
        {},
        budgets
      );
      budgets.maxSupportArtifacts = -1;
      const result = await pending;
      expect(result.candidate_selection).toMatchObject({
        indexed: 1,
        materialized: 1,
        support_materialized: 0,
        support_omitted: 1,
      });
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PROVENANCE_SUPPORT_OMITTED' })])
      );
      const compact = projectProvenanceJson(result, false);
      const detailed = projectProvenanceJson(result, true);
      expect(compact).toMatchObject({
        completeness: { complete: false },
        candidate_selection: { support_omitted: 1, omitted: 0 },
      });
      expect(compact.conclusion).toBe(detailed.conclusion);
      expect(compact.best?.source_event_id).toEqual(detailed.best?.source_event_id);
      expect(detailed.completeness.issues).toEqual(result.completeness.issues);
    } finally {
      context.scope.close();
    }
  });
});
