import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLinkedWorktree,
  createTempRepo,
  gitClient,
  type TempRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile, effectiveConfigPath } from '../support/test-helpers.js';

const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJicmFuY2gtZGlnZXN0In0.0000000000000000000000000000000000000000000';

describe('orcaops digest --branch-wide', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });
    await gitClient(repo.path).checkoutBranch('feature/digest', 'main');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function captureArtifact(input: {
    label: string;
    outcome: string;
    file: string;
    verification: Array<{
      command: string;
      exit_code: number;
      output_digest?: string;
    }>;
    openItems?: string[];
  }): Promise<string> {
    const plan = await agent.capturePlan(
      {
        task: input.label,
        label: input.label,
        plan_steps: [{ text: `Implement ${input.label}`, label: 'implement' }],
        touched_scope: [input.file],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        summary: `Completed ${input.label}`,
        files_changed: [input.file],
        verification: input.verification,
      },
      { noLlm: true }
    );
    await commitFile(
      repo.path,
      input.file,
      `export const value = '${input.label}';\n`,
      input.label
    );
    await agent.captureSummary({
      artifact_id: plan.artifact_id,
      outcome: input.outcome,
      open_items: input.openItems ?? [],
      tests_run: ['pnpm test'],
    });
    return plan.artifact_id;
  }

  it('combines a primary artifact and follow-up without writing artifact caches or search rows', async () => {
    const primary = await captureArtifact({
      label: 'Track live activity',
      outcome: 'Live activity now appears in watch.',
      file: 'src/activity.ts',
      verification: [
        {
          command: `env SESSION_TOKEN=${FAKE_JWT} pnpm test`,
          exit_code: 0,
          output_digest: '10 passed',
        },
      ],
      openItems: ['Document the activity states'],
    });
    const followUp = await captureArtifact({
      label: 'Cache absent rollout IDs',
      outcome: 'Missing rollout IDs are cached.',
      file: 'src/cache.ts',
      verification: [
        {
          command: `env SESSION_TOKEN=${FAKE_JWT} pnpm test`,
          exit_code: 0,
          output_digest: '12 passed',
        },
        { command: 'pnpm lint', exit_code: 1, output_digest: 'one warning remains' },
      ],
    });

    const cachedDigests = new Map(
      await Promise.all(
        [primary, followUp].map(
          async (artifactId) =>
            [
              artifactId,
              await readFile(
                path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'digest.md'),
                'utf8'
              ),
            ] as const
        )
      )
    );
    const searchBefore = await agent.runRaw([
      'search',
      'Track live activity',
      '--type',
      'digest',
      '--json',
    ]);

    await gitClient(repo.path).checkout('main');
    const result = await agent.runRaw([
      'digest',
      '--branch-wide',
      '--branch',
      'feature/digest',
      '--base',
      'main',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      data: {
        mode: string;
        branch: string;
        base: string;
        title: { text: string; source_artifact_id: string };
        artifacts: Array<{ id: string; role: string }>;
        changes: Array<{ source: { artifact_id: string } }>;
        open_items: Array<{ text: string; sources: Array<{ artifact_id: string }> }>;
        tests: Array<{ text: string; exit_code?: number; output_digest?: string }>;
      };
      markdown: string;
    };
    expect(output.data).toMatchObject({
      mode: 'branch-wide',
      branch: 'feature/digest',
      base: 'main',
      title: { text: 'Track live activity', source_artifact_id: primary },
    });
    expect(output.data.artifacts).toEqual([
      expect.objectContaining({ id: primary, role: 'primary' }),
      expect.objectContaining({ id: followUp, role: 'follow-up' }),
    ]);
    expect(output.data.changes.map((change) => change.source.artifact_id)).toEqual([
      primary,
      followUp,
    ]);
    expect(output.data.open_items).toContainEqual(
      expect.objectContaining({ text: 'Document the activity states' })
    );
    expect(output.data.tests.filter((test) => test.exit_code === 0)).toEqual([
      expect.objectContaining({ output_digest: '12 passed' }),
    ]);
    expect(output.data.tests).toContainEqual(
      expect.objectContaining({ text: 'pnpm lint', exit_code: 1 })
    );
    expect(JSON.stringify(output)).not.toContain(FAKE_JWT);
    expect(output.markdown).toContain('## what changed');
    expect(output.markdown).toContain('## open items');
    expect(output.markdown).toContain('## tests');
    expect(output.markdown).toContain(primary);
    expect(output.markdown).toContain(followUp);

    for (const artifactId of [primary, followUp]) {
      await expect(
        readFile(path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'digest.md'), 'utf8')
      ).resolves.toBe(cachedDigests.get(artifactId));
    }
    const searchAfter = await agent.runRaw([
      'search',
      'Track live activity',
      '--type',
      'digest',
      '--json',
    ]);
    expect(searchAfter.exitCode).toBe(0);
    expect(JSON.parse(searchAfter.stdout)).toEqual(JSON.parse(searchBefore.stdout));

    const narrower = await agent.runRaw([
      'digest',
      '--branch-wide',
      '--branch',
      'feature/digest',
      '--base',
      'feature/digest~1',
      '--json',
    ]);
    const narrowerData = JSON.parse(narrower.stdout) as {
      data: { base: string; artifacts: Array<{ id: string }> };
    };
    expect(narrowerData.data.base).toBe('feature/digest~1');
    expect(narrowerData.data.artifacts.map((artifact) => artifact.id)).toEqual([followUp]);

    const configPath = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.digest = { redact_secrets: false };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const unredacted = await agent.runRaw([
      'digest',
      '--branch-wide',
      '--branch',
      'feature/digest',
      '--base',
      'main',
      '--json',
    ]);
    expect(unredacted.stdout).toContain(FAKE_JWT);
  }, 45_000);

  it('supports one artifact, an explicit primary, and an explicit output file', async () => {
    const artifactId = await captureArtifact({
      label: 'One complete change',
      outcome: 'The change shipped.',
      file: 'src/one.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });
    const outputPath = path.join(repo.path, 'branch-digest.md');
    const result = await agent.runRaw([
      'digest',
      '--branch-wide',
      '--primary-artifact',
      artifactId,
      '--out',
      outputPath,
    ]);
    expect(result.exitCode).toBe(0);
    const markdown = await readFile(outputPath, 'utf8');
    expect(markdown).toContain('# One complete change');
    expect(markdown).toContain('explicit_primary_artifact');
  });

  it('includes work captured in a linked worktree from its archived thread', async () => {
    await gitClient(repo.path).checkout('main');
    const linked = await createLinkedWorktree(repo.path, { branch: 'feature/archive-digest' });
    try {
      // No init here: the main checkout's personal install lives in the git
      // common dir, so the linked worktree is already enabled.
      const linkedAgent = makeAgent({
        cwd: linked.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1' },
      });
      const plan = await linkedAgent.capturePlan(
        {
          task: 'Archived branch outcome',
          label: 'Archived branch outcome',
          plan_steps: [{ text: 'Implement archived work', label: 'implement' }],
          touched_scope: ['src/archived.ts'],
        },
        { noLlm: true }
      );
      await linkedAgent.captureCheckpoint(
        {
          artifact_id: plan.artifact_id,
          summary: 'Completed archived work',
          files_changed: ['src/archived.ts'],
          verification: [{ command: `env SESSION_TOKEN=${FAKE_JWT} pnpm test`, exit_code: 0 }],
        },
        { noLlm: true }
      );
      await commitFile(
        linked.path,
        'src/archived.ts',
        'export const archived = true;\n',
        'archived branch work'
      );
      await linkedAgent.captureSummary({
        artifact_id: plan.artifact_id,
        outcome: 'Archived work is included in branch digests.',
        tests_run: ['pnpm test'],
      });

      await expect(
        access(path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id))
      ).rejects.toThrow();
      const result = await agent.runRaw([
        'digest',
        '--branch-wide',
        '--branch',
        'feature/archive-digest',
        '--base',
        'main',
        '--json',
      ]);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as {
        data: {
          title: { text: string; source_artifact_id: string };
          artifacts: Array<{ id: string }>;
          outcome: string;
        };
      };
      expect(output.data.title).toMatchObject({
        text: 'Archived branch outcome',
        source_artifact_id: plan.artifact_id,
      });
      expect(output.data.artifacts.map(({ id }) => id)).toEqual([plan.artifact_id]);
      expect(output.data.outcome).toContain('Archived work is included in branch digests.');
      expect(result.stdout).not.toContain(FAKE_JWT);
    } finally {
      await linked.cleanup();
    }
  });

  it('rejects artifact selectors, missing branches, and invalid primary overrides', async () => {
    const artifactId = await captureArtifact({
      label: 'Valid artifact',
      outcome: 'Done.',
      file: 'src/valid.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });
    const selector = await agent.expectError([
      'digest',
      artifactId,
      '--branch-wide',
      '--base',
      'main',
      '--json',
    ]);
    expect(selector.error.code).toBe('INVALID_INPUT');
    expect(selector.error.message).toMatch(/artifact selector/);

    const missing = await agent.expectError([
      'digest',
      '--branch-wide',
      '--branch',
      'missing',
      '--base',
      'main',
      '--json',
    ]);
    expect(missing.error.code).toBe('INVALID_INPUT');

    const primary = await agent.expectError([
      'digest',
      '--branch-wide',
      '--base',
      'main',
      '--primary-artifact',
      'not-in-range',
      '--json',
    ]);
    expect(primary.error.code).toBe('INVALID_INPUT');
    expect(primary.error.message).toMatch(/included artifact with a captured summary/);
  });

  it('does not include older work just because it used the same branch name', async () => {
    const oldArtifact = await captureArtifact({
      label: 'Discarded branch attempt',
      outcome: 'This attempt was replaced.',
      file: 'src/old.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });
    await gitClient(repo.path).raw(['reset', '--hard', 'main']);
    const currentArtifact = await captureArtifact({
      label: 'Current branch work',
      outcome: 'The current approach shipped.',
      file: 'src/current.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });

    const result = await agent.runRaw(['digest', '--branch-wide', '--base', 'main', '--json']);
    expect(result.exitCode).toBe(0);
    const data = (
      JSON.parse(result.stdout) as {
        data: {
          artifacts: Array<{ id: string }>;
          excluded_artifacts: Array<{ id: string; reason: string }>;
        };
      }
    ).data;
    expect(data.artifacts.map((artifact) => artifact.id)).toEqual([currentArtifact]);
    expect(data.excluded_artifacts).toContainEqual({
      id: oldArtifact,
      reason: 'reachable_out_of_range',
    });
  });

  it('separates unreadable repository artifacts from branch exclusions', async () => {
    const unreadableArtifact = await captureArtifact({
      label: 'Old unreadable work',
      outcome: 'This work was replaced.',
      file: 'src/unreadable.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });
    await gitClient(repo.path).raw(['reset', '--hard', 'main']);
    const currentArtifact = await captureArtifact({
      label: 'Current readable work',
      outcome: 'The current work shipped.',
      file: 'src/readable.ts',
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    });
    const artifactDir = path.join(repo.path, '.orcaops', 'artifacts', unreadableArtifact);
    const eventLog = path.join(artifactDir, 'events.ndjson');
    const eventLines = (await readFile(eventLog, 'utf8')).split('\n');
    const planLine = eventLines.findIndex((line) => line.includes('"plan_captured"'));
    eventLines[planLine] = eventLines[planLine].replace(
      /"checksum":"[0-9a-f]{64}"/u,
      `"checksum":"${'0'.repeat(64)}"`
    );
    await writeFile(eventLog, eventLines.join('\n'), 'utf8');
    await rm(path.join(artifactDir, 'artifact.json'), { force: true });
    await rm(path.join(artifactDir, 'plan.json'), { force: true });

    const result = await agent.runRaw(['digest', '--branch-wide', '--base', 'main', '--json']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      data: {
        artifacts: Array<{ id: string }>;
        excluded_artifacts: Array<{ id: string }>;
        unreadable_artifacts: Array<{ id: string; reason: string }>;
      };
      markdown: string;
    };
    expect(output.data.artifacts.map((artifact) => artifact.id)).toEqual([currentArtifact]);
    expect(output.data.excluded_artifacts).not.toContainEqual(
      expect.objectContaining({ id: unreadableArtifact })
    );
    expect(output.data.unreadable_artifacts).toEqual([
      { id: unreadableArtifact, reason: 'unverifiable' },
    ]);
    expect(output.markdown).toContain('## unreadable artifacts');
    expect(output.markdown).toContain(unreadableArtifact);
  });

  it('includes incomplete work when only its pre-PR boundary is in range', async () => {
    const checkpointHead = (await gitClient(repo.path).revparse(['HEAD'])).trim();
    const plan = await agent.capturePlan(
      {
        task: 'Pre-PR anchored work',
        label: 'Pre-PR anchored work',
        plan_steps: [{ text: 'Implement pre-PR anchored work', label: 'implement' }],
        touched_scope: ['src/pre-pr.ts'],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        summary: 'Closed before the work commit',
        files_changed: ['src/pre-pr.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
      },
      { noLlm: true }
    );
    await commitFile(
      repo.path,
      'src/pre-pr.ts',
      'export const anchoredBeforePr = true;\n',
      'pre-PR anchored work'
    );
    const prePrHead = (await gitClient(repo.path).revparse(['HEAD'])).trim();
    const prePr = await agent.capturePrePrCheck({ artifact_id: plan.artifact_id }, { noLlm: true });
    expect(prePr.ok).toBe(true);

    const result = await agent.runRaw(['digest', '--branch-wide', '--base', 'main', '--json']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      data: {
        artifacts: Array<{
          id: string;
          is_complete: boolean;
          anchors: Array<{ source: string; n?: number; head_sha: string }>;
          matched_anchors: Array<{ source: string; n?: number; head_sha: string }>;
        }>;
      };
    };
    const artifact = output.data.artifacts.find(({ id }) => id === plan.artifact_id);
    expect(artifact).toMatchObject({ id: plan.artifact_id, is_complete: false });
    expect(artifact?.anchors).toEqual([
      { source: 'checkpoint', n: 1, head_sha: checkpointHead },
      { source: 'pre_pr', head_sha: prePrHead },
    ]);
    expect(artifact?.matched_anchors).toEqual([{ source: 'pre_pr', head_sha: prePrHead }]);
  });

  it('includes committed checkpoint work without a summary but never uses it as the title', async () => {
    const plan = await agent.capturePlan(
      {
        task: 'Incomplete work',
        label: 'Incomplete work',
        plan_steps: [{ text: 'Implement incomplete work', label: 'implement' }],
        touched_scope: ['src/incomplete.ts'],
      },
      { noLlm: true }
    );
    const opened = await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [plan.plan_steps[0].step_id] },
      { noLlm: true }
    );
    if (!opened.ok) throw new Error(opened.error.message);
    await commitFile(
      repo.path,
      'src/incomplete.ts',
      'export const incomplete = true;\n',
      'incomplete work'
    );
    await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: opened.n,
        summary: 'Checkpoint committed without a final summary',
        files_changed: ['src/incomplete.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
      },
      { noLlm: true }
    );

    const result = await agent.runRaw(['digest', '--branch-wide', '--base', 'main', '--json']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      data: {
        title: null;
        title_candidates: unknown[];
        incomplete_artifact_ids: string[];
        artifacts: Array<{ id: string; is_complete: boolean }>;
      };
      markdown: string;
    };
    expect(output.data.title).toBeNull();
    expect(output.data.title_candidates).toEqual([]);
    expect(output.data.incomplete_artifact_ids).toEqual([plan.artifact_id]);
    expect(output.data.artifacts).toContainEqual(
      expect.objectContaining({ id: plan.artifact_id, is_complete: false })
    );
    expect(output.markdown).toContain('Incomplete captured work');
  });
});
