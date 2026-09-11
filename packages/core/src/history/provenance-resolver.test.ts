import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDefaultSkippedSnapshotBoundary,
  ClosedCheckpointSchema,
  PlanSchema,
  uuidv7,
} from '@orcaops/storage';

import type { ProvenanceCandidate, ProvenanceCandidates } from './provenance-candidates.js';
import { resolveProvenance } from './provenance-resolver.js';
import { ProvenanceRepository } from './provenance-target.js';
import { buildDiffFingerprintManifest } from '../diff-fingerprint/adapter.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(root: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return (await exec('git', ['-C', root, ...args], { env })).stdout.trim();
}
const ts = '2026-09-05T10:00:00.000Z';
function sources(...candidates: ProvenanceCandidate[]): ProvenanceCandidates {
  return {
    candidates,
    completeness: { complete: true, issues: [] },
    source_versions: candidates.map((candidate) => ({
      artifact_id: candidate.artifact_id,
      version_token: candidate.version_token,
    })),
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'provenance-resolver-'));
  roots.push(root);
  await git(root, ['init', '-qb', 'main']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await writeFile(path.join(root, 'selected.ts'), 'const selected = "original";\n}\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'Original']);
  const base = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-qb', 'feature']);
  await writeFile(path.join(root, 'selected.ts'), 'const selected = "retained";\n}\n');
  await git(root, ['commit', '-qam', 'Retained']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  async function candidate(
    oid = head,
    options: { withoutFingerprint?: boolean; file?: string; base?: string } = {}
  ): Promise<ProvenanceCandidate> {
    const artifactId = uuidv7();
    const eventId = uuidv7();
    const planId = uuidv7();
    const openId = uuidv7();
    const start = options.base ?? base;
    const built = await buildDiffFingerprintManifest({
      artifactId,
      checkpointN: 1,
      openTreeSha: await git(root, ['rev-parse', `${start}^{tree}`]),
      closeTreeSha: await git(root, ['rev-parse', `${head}^{tree}`]),
      diffBytes: Buffer.from(
        (await git(root, ['diff', start, head, '--', options.file ?? 'selected.ts'])) + '\n'
      ),
      truncated: false,
      maxDiffBytes: 100_000,
    });
    const plan = PlanSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      source_event_id: planId,
      branch: 'feature',
      base_sha: start,
      agent: 'codex',
      agent_session_id: null,
      task: 'Retain original reasoning',
      label: 'Original reasoning',
      plan_steps: [
        { step_id: 'step', text: 'Retain evidence', label: 'Evidence', acceptance_criteria: [] },
      ],
      touched_scope: ['selected.ts'],
      non_goals: [],
      decisions: [{ decision: 'Keep evidence', reason: 'Support review', revision_n: 0 }],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    const checkpoint = ClosedCheckpointSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      n: 1,
      status: 'closed',
      declared_step_ids: ['step'],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: planId,
      opened_at: ts,
      open_head_sha: start,
      head_sha: oid,
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      closed_at: ts,
      closed_by_agent: 'codex',
      summary: 'Original evidence',
      files_changed: [options.file ?? 'selected.ts'],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: ['step'],
      diff_fingerprint_summary: built.summary,
      source_event_ids: { opened: openId, closed: eventId },
      source_event_id: eventId,
    });
    return {
      root_key: 'root',
      project_id: 'project',
      store_instance_id: 'store',
      artifact_id: artifactId,
      locator: `project/${artifactId}/${eventId}`,
      version_token: eventId,
      artifact_generation: 1,
      pending: false,
      origin: 'captured',
      kind: 'checkpoint',
      source_event_id: eventId,
      recorded_at: ts,
      plan_support: {
        anchor_event_id: planId,
        source_event_id: planId,
        content_event_id: planId,
        state: 'available',
        plan,
      },
      source_plan: null,
      checkpoint,
      fingerprint: {
        state: options.withoutFingerprint ? 'skipped' : 'available',
        manifest: options.withoutFingerprint ? null : built.manifest,
        truncated: false,
      },
      overlap: null,
      association: { worktree_ids: [], unknown: true, checkpoint_worktree_id: null },
      enrichment: null,
      issues: [],
    };
  }
  return { root, base, head, candidate, repository: new ProvenanceRepository(root) };
}

describe('revision-aware provenance ranking', { timeout: 30_000 }, () => {
  it('ranks reachable whole-file history ahead of a newer sibling without asserting current rationale', async () => {
    const f = await fixture();
    const related = await f.candidate();
    const original = await f.candidate(f.base);
    related.recorded_at = '2030-01-01T00:00:00.000Z';
    await git(f.root, ['checkout', '-q', 'main']);
    const blame = vi.spyOn(f.repository, 'blame');
    const target = await f.repository.resolveTarget({ file: 'selected.ts' });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(related, original),
    });
    expect(result.matches.map((match) => match.reachability)).toEqual(['reachable', 'unreachable']);
    expect(result.best?.candidate.artifact_id).toBe(original.artifact_id);
    expect(result.conclusion).toBe('related_history');
    expect(blame).not.toHaveBeenCalled();
    expect(result.uncertainty.join(' ')).toContain('does not establish');
  });

  it.each(['merge', 'squash', 'rebase'] as const)(
    'preserves content evidence and separate reachability through %s',
    async (mode) => {
      const f = await fixture();
      const candidate = await f.candidate();
      await git(f.root, ['checkout', '-q', 'main']);
      if (mode === 'merge')
        await git(f.root, ['merge', '--no-ff', '-qm', 'Merge evidence', 'feature']);
      if (mode === 'squash') {
        await git(f.root, ['merge', '--squash', 'feature']);
        await git(f.root, ['commit', '-qm', 'Squashed evidence']);
      }
      if (mode === 'rebase') {
        await writeFile(path.join(f.root, 'other.ts'), 'const unrelated = true;\n');
        await git(f.root, ['add', '.']);
        await git(f.root, ['commit', '-qm', 'Other change']);
        await git(f.root, ['checkout', '-q', 'feature']);
        await git(f.root, ['rebase', 'main']);
      }
      const blame = vi.spyOn(f.repository, 'blame');
      const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
      const result = await resolveProvenance({
        target,
        repository: f.repository,
        sources: sources(candidate),
      });
      expect(blame).toHaveBeenCalledTimes(1);
      expect(result.best).toMatchObject({
        confidence: 'exact',
        content_match: 'same_file',
        reachability: mode === 'merge' ? 'reachable' : 'unreachable',
        relationship: mode === 'merge' ? 'reachable_history' : 'rewrite_evidence',
      });
      expect(result.conclusion).toBe('supported');
      expect(result.best?.candidate.plan_support.plan?.decisions[0].decision).toBe('Keep evidence');
    }
  );

  it('labels surviving whole-file squash evidence without asserting ancestry or authorship', async () => {
    const f = await fixture();
    const candidate = await f.candidate();
    await git(f.root, ['checkout', '-q', 'main']);
    await git(f.root, ['merge', '--squash', 'feature']);
    await git(f.root, ['commit', '-qm', 'Squashed evidence']);
    const blame = vi.spyOn(f.repository, 'blame');
    const target = await f.repository.resolveTarget({ file: 'selected.ts' });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(result.best).toMatchObject({
      confidence: 'weak',
      reachability: 'unreachable',
      relationship: 'rewrite_evidence',
      content_match: 'same_file',
    });
    expect(result.conclusion).toBe('related_history');
    expect(blame).not.toHaveBeenCalled();
    const bounded = await resolveProvenance({
      target: {
        ...target,
        content:
          target.content +
          Array.from({ length: 4097 }, (_, n) => `const unique${n} = true;`).join('\n'),
      },
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(bounded.uncertainty.join(' ')).toContain('limited to 4096');
    expect(bounded.best?.confidence).toBe('weak');
  });

  it('shares one selected blame across candidates and does not choose tied reasoning by recording time or origin', async () => {
    const f = await fixture();
    const first = await f.candidate();
    const second = await f.candidate();
    first.origin = 'imported';
    second.recorded_at = '2030-01-01T00:00:00.000Z';
    const blame = vi.spyOn(f.repository, 'blame');
    const reach = vi.spyOn(f.repository, 'reachability');
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(first, second),
    });
    expect(blame).toHaveBeenCalledTimes(1);
    expect(reach).toHaveBeenCalledTimes(1);
    expect(result.best).toBeNull();
    expect(result.conclusion).toBe('ambiguous');
    expect(result.matches[0].candidate.origin).toBe('captured');
    expect(result.uncertainty.join(' ')).toContain('recording time does not decide');
  });

  it('keeps copied and repeated content weak despite exact hash membership', async () => {
    const f = await fixture();
    const candidate = await f.candidate();
    await writeFile(path.join(f.root, 'copy.ts'), await readFile(path.join(f.root, 'selected.ts')));
    await git(f.root, ['add', '.']);
    await git(f.root, ['commit', '-qm', 'Copied']);
    const copied = await f.repository.resolveTarget({ file: 'copy.ts', line: 1 });
    const copyResult = await resolveProvenance({
      target: copied,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(copyResult.best).toMatchObject({ confidence: 'weak', content_match: 'cross_file' });
    await writeFile(
      path.join(f.root, 'selected.ts'),
      'const selected = "retained";\nconst selected = "retained";\n'
    );
    await git(f.root, ['commit', '-qam', 'Repeated']);
    const repeated = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(
      (
        await resolveProvenance({
          target: repeated,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).best?.confidence
    ).toBe('weak');
  });

  it('keeps trivial and newly edited lines weak while retaining committed lines in a dirty file', async () => {
    const f = await fixture();
    const candidate = await f.candidate();
    const trivial = await f.repository.resolveTarget({ file: 'selected.ts', line: 2 });
    expect(
      (
        await resolveProvenance({
          target: trivial,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).best
    ).toMatchObject({ confidence: 'weak', content_match: 'trivial' });
    await git(f.root, ['checkout', '-q', 'main']);
    await writeFile(path.join(f.root, 'selected.ts'), 'const selected = "retained";\n}\n');
    const edited = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(edited.blame.status).toBe('uncommitted');
    expect(
      (
        await resolveProvenance({
          target: edited,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).best?.confidence
    ).toBe('weak');
    await git(f.root, ['checkout', '--', 'selected.ts']);
    await git(f.root, ['checkout', '-q', 'feature']);
    await writeFile(
      path.join(f.root, 'selected.ts'),
      'const selected = "retained";\nconst local = true;\n'
    );
    const retained = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(retained).toMatchObject({ dirty: true, blame: { status: 'committed' } });
    expect(
      (
        await resolveProvenance({
          target: retained,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).best?.confidence
    ).toBe('exact');
  });

  it('does not attribute later blame merely because the checkpoint head is an ancestor', async () => {
    const f = await fixture();
    const candidate = await f.candidate(f.base, { withoutFingerprint: true });
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(result.best).toMatchObject({ reachability: 'reachable', confidence: 'weak' });
  });

  it('does not claim a pre-existing line when the open and close share its blame commit', async () => {
    const f = await fixture();
    const candidate = await f.candidate(f.head, { withoutFingerprint: true });
    candidate.checkpoint!.open_head_sha = f.head;
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(result.best).toMatchObject({ reachability: 'reachable', confidence: 'weak' });
    expect(result.conclusion).toBe('related_history');
  });

  it('uses the recorded work interval for likely ancestry without inventing exact content', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'other.ts'), 'const later = true;\n');
    await git(f.root, ['add', '.']);
    await git(f.root, ['commit', '-qm', 'Later']);
    const candidate = await f.candidate(await git(f.root, ['rev-parse', 'HEAD']), {
      withoutFingerprint: true,
    });
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(
      (await resolveProvenance({ target, repository: f.repository, sources: sources(candidate) }))
        .best
    ).toMatchObject({ confidence: 'likely', content_match: 'none', reachability: 'reachable' });
  });

  it('uses the original plan base when the checkpoint open head is unavailable', async () => {
    const f = await fixture();
    const candidate = await f.candidate(f.head, { withoutFingerprint: true });
    delete candidate.checkpoint!.open_head_sha;
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(result.best).toMatchObject({
      confidence: 'exact',
      reasons: ['Verified checkpoint head is the selected line blame commit'],
      candidate: { plan_support: { plan: { base_sha: f.base } } },
    });
  });

  it.each(['reachable', 'unreachable'] as const)(
    'uses the supported plan base for %s plan context',
    async (reachability) => {
      const f = await fixture();
      const candidate = await f.candidate();
      candidate.kind = 'plan';
      candidate.checkpoint = null;
      candidate.fingerprint = { state: 'skipped', manifest: null, truncated: false };
      candidate.plan_support.plan!.base_sha = reachability === 'reachable' ? f.base : f.head;
      const target = await f.repository.resolveTarget({ file: 'selected.ts', at: f.base });
      const result = await resolveProvenance({
        target,
        repository: f.repository,
        sources: sources(candidate),
      });
      expect(result.best).toMatchObject({
        confidence: 'weak',
        reachability,
        reachability_basis: 'plan_base',
      });
      expect(result.conclusion).toBe('related_history');
    }
  );

  it('keeps missing objects unknown and deleted targets as related history', async () => {
    const f = await fixture();
    const candidate = await f.candidate('f'.repeat(40), { withoutFingerprint: true });
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(
      (await resolveProvenance({ target, repository: f.repository, sources: sources(candidate) }))
        .best
    ).toMatchObject({ reachability: 'unknown', confidence: 'weak' });
    await rm(path.join(f.root, 'selected.ts'));
    const absent = await f.repository.resolveTarget({ file: 'selected.ts' });
    expect(absent.state).toBe('deleted');
    expect(
      (
        await resolveProvenance({
          target: absent,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).conclusion
    ).toBe('related_history');
    const unavailable = await f.repository.resolveTarget({
      file: 'selected.ts',
      line: 1,
      at: 'missing-revision',
    });
    expect(
      (
        await resolveProvenance({
          target: unavailable,
          repository: f.repository,
          sources: sources(candidate),
        })
      ).best
    ).toMatchObject({ reachability: 'unknown', confidence: 'weak' });
  });

  it('keeps overlap, degradation, original-plan gaps and incomplete sources from definitive attribution', async () => {
    const f = await fixture();
    const candidate = await f.candidate();
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const overlap = {
      n: 1,
      ambiguous: [{ file_before: 'selected.ts', file_after: 'selected.ts' }],
      mixedSegment: [],
      ownClaimPending: [],
      dropped: [],
      segmentAttributed: [],
      finalized: true,
      unattributedInWindow: [],
      unreadableSiblingArtifacts: [],
    };
    for (const altered of [
      { ...candidate, overlap },
      {
        ...candidate,
        checkpoint: {
          ...candidate.checkpoint!,
          attribution_degraded: { unmerged_paths: ['selected.ts'] },
        },
      },
      {
        ...candidate,
        plan_support: { ...candidate.plan_support, state: 'unavailable' as const, plan: null },
      },
    ])
      expect(
        (await resolveProvenance({ target, repository: f.repository, sources: sources(altered) }))
          .best?.confidence
      ).toBe('weak');
    const pending = {
      ...candidate,
      overlap: {
        ...overlap,
        ambiguous: [],
        finalized: false,
        ownClaimPending: [{ file_before: 'selected.ts', file_after: 'selected.ts' }],
      },
    };
    expect(
      (await resolveProvenance({ target, repository: f.repository, sources: sources(pending) }))
        .conclusion
    ).toBe('related_history');
    const incomplete = sources(candidate);
    incomplete.completeness.complete = false;
    expect(
      (await resolveProvenance({ target, repository: f.repository, sources: incomplete }))
        .conclusion
    ).toBe('related_history');
  });

  it('retains plan-only context without interpreting evaluator categories as file claims', async () => {
    const f = await fixture();
    const candidate = await f.candidate();
    candidate.kind = 'plan';
    candidate.plan_support.plan!.touched_scope = ['unrelated-category'];
    candidate.checkpoint = null;
    candidate.fingerprint = { state: 'skipped', manifest: null, truncated: false };
    const target = await f.repository.resolveTarget({ file: 'selected.ts', line: 1 });
    const result = await resolveProvenance({
      target,
      repository: f.repository,
      sources: sources(candidate),
    });
    expect(result.best).toMatchObject({
      confidence: 'weak',
      reachability_basis: 'plan_base',
      candidate: { checkpoint: null },
    });
    expect(result.conclusion).toBe('related_history');
  });
});
