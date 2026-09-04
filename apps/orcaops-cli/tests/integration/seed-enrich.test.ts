import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, Repo } from '@orcaops/core';
import { artifactPathsFor, ArtifactStore, computeMemberShasHash, uuidv7 } from '@orcaops/storage';
import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import { withSeedRunLock } from '../../src/commands/seed/journal.js';
import { makeAgent } from '../support/test-agent.js';

interface EnrichmentTemplate {
  cluster_key: string;
  label: string;
  task: string;
  steps: Array<{ label: string; text: string }>;
  checkpoint_summaries: string[];
  outcome: string;
  decisions: Array<{
    decision: string;
    reason: string;
    alternatives_considered?: Array<{ option: string; rejected_because: string }>;
  }>;
  nomination_dispositions: Array<Record<string, string>>;
}

describe('orcaops seed enrich', () => {
  let repo: HistoryRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the service',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: stabilize the service',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function seedSkeleton(): Promise<string> {
    const result = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    return (JSON.parse(result.stdout) as { seeded: Array<{ artifactId: string }> }).seeded[0]!
      .artifactId;
  }

  async function seedEnriched(): Promise<string> {
    const previewResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    expect(previewResult.exitCode).toBe(0);
    const seedPreview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(seedPreview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { bundles: Array<{ filename: string }> };
    const generated = {
      bundle_directory: seedPreview.enrichment.bundle_directory,
      bundle_file: manifest.bundles[0]!.filename,
    };
    const template = await readTemplate(generated);
    template.decisions = [
      {
        decision: 'Keep a dedicated service health check.',
        reason:
          `The service needed stabilization (evidence: commit ${repo.shas.next!.slice(0, 7)} ` +
          '— "stabilize the service")',
      },
    ];
    await writeTemplate(generated, template);
    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      generated.bundle_directory,
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    return (JSON.parse(applied.stdout) as { seeded: Array<{ artifactId: string }> }).seeded[0]!
      .artifactId;
  }

  async function preview(artifactId: string, ...flags: string[]) {
    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
      ...flags,
    ]);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as {
      bundle_directory: string;
      bundle_file: string;
      ready: boolean;
      confirmation_required: boolean;
      totals: { amended: number; unchanged: number; invalid: number; failed: number };
    };
  }

  async function readTemplate(result: {
    bundle_directory: string;
    bundle_file: string;
  }): Promise<EnrichmentTemplate> {
    const bundle = await readFile(path.join(result.bundle_directory, result.bundle_file), 'utf8');
    return JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as EnrichmentTemplate;
  }

  async function writeTemplate(
    result: { bundle_directory: string },
    template: EnrichmentTemplate
  ): Promise<void> {
    await writeFile(
      path.join(result.bundle_directory, 'authored.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );
  }

  it('amends a skeleton import only after a validated preview and confirmation', async () => {
    const artifactId = await seedSkeleton();
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const beforePlan = (await store.readPlan(artifactId))!;
    const beforeCheckpoints = await store.readCheckpoints(artifactId);
    const beforeSummary = (await store.readSummary(artifactId))!;
    store.close();

    const generated = await preview(artifactId);
    expect(generated).toMatchObject({
      ready: false,
      confirmation_required: false,
      totals: { amended: 0, unchanged: 0, invalid: 0, failed: 0 },
    });
    const template = await readTemplate(generated);
    template.label = 'Stable service foundation';
    template.task = 'Preserve the service foundation and its health check.';
    template.steps = template.steps.map((step, index) => ({
      label: `Stable service checkpoint ${index + 1}`,
      text: `Land stable service checkpoint ${index + 1}.`,
    }));
    template.checkpoint_summaries = template.checkpoint_summaries.map(
      (_, index) => `Landed stable service checkpoint ${index + 1}.`
    );
    template.outcome = 'Shipped a stable service foundation.';
    await writeTemplate(generated, template);

    const validated = await preview(artifactId);
    expect(validated).toMatchObject({ ready: true, confirmation_required: true });
    const applied = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      totals: { amended: 1, unchanged: 0, invalid: 0, failed: 0 },
    });

    const amendedStore = new ArtifactStore({ repoRoot: repo.path, config });
    const afterPlan = (await amendedStore.readPlan(artifactId))!;
    const afterCheckpoints = await amendedStore.readCheckpoints(artifactId);
    const afterSummary = (await amendedStore.readSummary(artifactId))!;
    amendedStore.close();
    expect(afterPlan).toMatchObject({
      artifact_id: beforePlan.artifact_id,
      branch: beforePlan.branch,
      base_sha: beforePlan.base_sha,
      started_at: beforePlan.started_at,
      label: template.label,
      task: template.task,
      origin: {
        ...beforePlan.origin,
        enriched_at: expect.stringMatching(/^\d{4}-/u),
      },
    });
    expect(afterPlan.plan_steps.map((step) => step.step_id)).toEqual(
      beforePlan.plan_steps.map((step) => step.step_id)
    );
    const checkpointContent = (checkpoint: (typeof afterCheckpoints)[number]) => {
      if (checkpoint.status !== 'closed') throw new Error('expected a closed checkpoint');
      const { summary: _summary, source_event_id: _sourceEventId, ...content } = checkpoint;
      return content;
    };
    const checkpointSummary = (checkpoint: (typeof afterCheckpoints)[number]) => {
      if (checkpoint.status !== 'closed') throw new Error('expected a closed checkpoint');
      return checkpoint.summary;
    };
    expect(afterCheckpoints.map(checkpointContent)).toEqual(
      beforeCheckpoints.map(checkpointContent)
    );
    expect(afterCheckpoints.map(checkpointSummary)).toEqual(template.checkpoint_summaries);
    const { source_event_id: _beforeSourceEventId, ...beforeSummaryContent } = beforeSummary;
    const { source_event_id: _afterSourceEventId, ...afterSummaryContent } = afterSummary;
    expect({ ...afterSummaryContent, outcome: beforeSummary.outcome }).toEqual(
      beforeSummaryContent
    );
    expect(afterSummary.outcome).toBe(template.outcome);
  });

  it('amends import-time enrichment without restating decisions', async () => {
    const artifactId = await seedEnriched();
    const second = await preview(artifactId, '--preserve-decisions');
    const proseOnly = await readTemplate(second);
    expect(proseOnly.decisions).toHaveLength(1);
    proseOnly.label = 'Stable service foundation, clarified';
    await writeTemplate(second, proseOnly);
    expect((await preview(artifactId, '--preserve-decisions')).confirmation_required).toBe(true);
    const amended = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--preserve-decisions',
      '--yes',
      '--json',
    ]);
    expect(amended.exitCode).toBe(0);
    expect(JSON.parse(amended.stdout)).toMatchObject({ totals: { amended: 1 } });

    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const plan = await store.readPlan(artifactId);
    store.close();
    expect(plan?.label).toBe(proseOnly.label);
    expect(plan?.decisions).toEqual([
      expect.objectContaining({
        decision: 'Keep a dedicated service health check.',
        evidence: {
          kind: 'git-commit',
          commit_sha: repo.shas.next,
          quote: 'stabilize the service',
        },
      }),
    ]);
  });

  it('requires a matching dry-run before apply', async () => {
    const artifactId = await seedSkeleton();
    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--enrichment-dir',
      path.join(repo.path, 'missing-preview'),
      '--yes',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/dry-run.*first/iu) },
    });

    await preview(artifactId);
    const mismatchedMode = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--preserve-decisions',
      '--yes',
      '--json',
    ]);
    expect(mismatchedMode.exitCode).toBe(1);
    expect(JSON.parse(mismatchedMode.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/dry-run.*first/iu) },
    });
  });

  it('fails apply when the authored enrichment file is missing', async () => {
    const artifactId = await seedSkeleton();
    const generated = await preview(artifactId);

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--enrichment-dir',
      generated.bundle_directory,
      '--yes',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      totals: { amended: 0, unchanged: 0, invalid: 0, failed: 1 },
      failures: [expect.stringMatching(/no usable authored enrichment JSON matched artifact/iu)],
    });
  });

  it('reports an authored enrichment for a different cluster as unusable', async () => {
    const artifactId = await seedSkeleton();
    const generated = await preview(artifactId);
    const template = await readTemplate(generated);
    template.cluster_key = 'run:not-this-artifact';
    await writeTemplate(generated, template);

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--enrichment-dir',
      generated.bundle_directory,
      '--yes',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      totals: { amended: 0, unchanged: 0, invalid: 0, failed: 1 },
      failures: [expect.stringMatching(/no usable authored enrichment JSON matched artifact/iu)],
    });
  });

  it('reports invalid and unchanged authored bundles without writing', async () => {
    const artifactId = await seedSkeleton();
    const generated = await preview(artifactId);
    const template = await readTemplate(generated);
    await writeFile(path.join(generated.bundle_directory, 'authored.json'), '{}\n', 'utf8');

    const invalid = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ready: false,
      totals: { amended: 0, unchanged: 0, invalid: 1, failed: 0 },
    });

    await writeTemplate(generated, template);
    const unchanged = await preview(artifactId);
    expect(unchanged).toMatchObject({
      ready: true,
      confirmation_required: false,
      totals: { amended: 0, unchanged: 1, invalid: 0, failed: 0 },
    });
  });

  it('rejects a preview superseded by another amendment', async () => {
    const artifactId = await seedSkeleton();
    const firstDirectory = path.join(repo.path, 'first-amendment');
    const first = await preview(artifactId, '--enrichment-dir', firstDirectory);
    const firstTemplate = await readTemplate(first);
    firstTemplate.label = 'First proposed label';
    await writeTemplate(first, firstTemplate);
    await preview(artifactId, '--enrichment-dir', firstDirectory);

    const secondDirectory = path.join(repo.path, 'second-amendment');
    const second = await preview(artifactId, '--enrichment-dir', secondDirectory);
    const secondTemplate = await readTemplate(second);
    secondTemplate.label = 'Second applied label';
    await writeTemplate(second, secondTemplate);
    await preview(artifactId, '--enrichment-dir', secondDirectory);
    expect(
      (
        await agent.runRaw([
          'seed',
          'enrich',
          '--artifact',
          artifactId,
          '--enrichment-dir',
          secondDirectory,
          '--yes',
          '--json',
        ])
      ).exitCode
    ).toBe(0);

    const stale = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--enrichment-dir',
      firstDirectory,
      '--yes',
      '--json',
    ]);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/preview.*stale.*dry-run/iu) },
    });
  });

  it('rejects inconsistent stored member provenance before authoring', async () => {
    const artifactId = await seedSkeleton();
    const config = await loadConfig(repo.path);
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const plan = JSON.parse(await readFile(paths.planJson, 'utf8')) as {
      origin: { member_shas: string[] };
    };
    plan.origin.member_shas.push('f'.repeat(40));
    await writeFile(paths.planJson, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/inconsistent imported member provenance/iu) },
    });
  });

  it('rejects a summary head outside the imported member set', async () => {
    const artifactId = await seedSkeleton();
    const config = await loadConfig(repo.path);
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const summary = JSON.parse(await readFile(paths.summaryJson, 'utf8')) as {
      head_sha: string;
    };
    summary.head_sha = 'f'.repeat(40);
    await writeFile(paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/summary head.*not an imported member/iu) },
    });
  });

  it('reports a missing imported Git object with a recovery action', async () => {
    const artifactId = await seedSkeleton();
    const config = await loadConfig(repo.path);
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const plan = JSON.parse(await readFile(paths.planJson, 'utf8')) as {
      origin: { member_shas: string[]; member_shas_hash: string };
    };
    const missingSha = 'f'.repeat(40);
    plan.origin.member_shas = [missingSha];
    plan.origin.member_shas_hash = computeMemberShasHash(plan.origin.member_shas);
    await writeFile(paths.planJson, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: expect.stringMatching(/cannot read imported member commit.*restore.*retry/iu),
      },
    });
  });

  it('shares the project seed lock with ordinary seed runs', async () => {
    const env = { ...process.env, ORCAOPS_DISABLE_DRAIN: '1' };
    await withSeedRunLock(new Repo(repo.path), env, async () => {
      const result = await agent.runRaw([
        'seed',
        'enrich',
        '--artifact',
        uuidv7(),
        '--dry-run',
        '--json',
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/another orcaops seed run is active/iu) },
      });
    });
  });

  it('keeps legacy imports readable and refuses to enrich them', async () => {
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const artifactId = uuidv7();
    const stepId = uuidv7();
    const ts = '2026-01-01T00:00:00.000Z';
    const plan = await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'main',
      base_sha: repo.shas.root!,
      agent: 'other',
      agent_session_id: null,
      task: 'Imported legacy task',
      label: 'Imported legacy label',
      plan_steps: [
        {
          step_id: stepId,
          text: 'Land the legacy work',
          label: 'Land the legacy work',
          acceptance_criteria: [],
        },
      ],
      touched_scope: ['src/**'],
      non_goals: [],
      decisions: [],
      origin: {
        kind: 'git-import',
        imported_at: ts,
        tool_version: 'legacy-test',
        source_range: `${repo.shas.root}..${repo.shas.next}`,
        authors: ['test@orcaops.local'],
        enriched_at: null,
      },
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    await store.writeCheckpointOpened(
      {
        artifact_id: artifactId,
        declared_step_ids: [stepId],
        policy_exceptions: [],
        plan_revision_id: plan.event_id,
      },
      { headSha: repo.shas.root!, openedAt: ts, idempotencyKey: `${artifactId}:open` }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'Imported legacy checkpoint',
        files_changed: ['src/health.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [],
        completed_step_ids: [stepId],
        head_sha: repo.shas.next!,
      },
      { idempotencyKey: `${artifactId}:close` }
    );
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        agent: 'other',
        outcome: 'Imported legacy outcome',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: repo.shas.next!,
        ts,
      },
      { idempotencyKey: `${artifactId}:summary` }
    );
    expect((await store.readPlan(artifactId))?.label).toBe('Imported legacy label');
    store.close();

    const result = await agent.runRaw([
      'seed',
      'enrich',
      '--artifact',
      artifactId,
      '--dry-run',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/predates exact seed membership.*re-seed/iu) },
    });
  });
});
