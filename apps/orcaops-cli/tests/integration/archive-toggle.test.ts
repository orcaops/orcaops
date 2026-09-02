import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendUsageLedgerRecord, usageLedgerPath, usageSidecarsDir } from '@orcaops/storage';
import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Archive enablement. `orcaops archive enable|disable` (raw
 * config edit + first-enable backfill via the shared repair machinery),
 * the interactive init confirm, and the default-on behavior shared by
 * interactive, non-interactive, and `--yes` init.
 */

const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  confirm: vi.fn(async () => true),
  multiselect: vi.fn(async () => ['claude-code']),
  // Never used by these tests, but the customize-more branch destructures it
  // from the module — vitest throws on a missing export at that point.
  text: vi.fn(async () => 'orcaops'),
  // The session-hooks prompt is a three-way select (static / state-aware /
  // none); default to the recommended option like a user pressing enter.
  select: vi.fn(async () => 'static'),
  isCancel: (v: unknown) => v === CANCELLED,
}));

describe('orcaops archive enable/disable', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataDir: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataDir = await mkdtemp(path.join(tmpdir(), 'orcaops-arch-data-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
    });
    const init = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    expect(init.exitCode).toBe(0);
    const disable = await agent.runRaw(['archive', 'disable', '--json']);
    expect(disable.exitCode).toBe(0);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function archiveEnabled(): Promise<boolean> {
    const config = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { archive?: { enabled?: boolean } };
    return config.archive?.enabled === true;
  }

  async function seedPlanArtifact(): Promise<string> {
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'archive fixture',
          label: `arch-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
    return (JSON.parse(r.stdout) as { artifact_id: string }).artifact_id;
  }

  async function seedInvalidUsage(label: string): Promise<void> {
    await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-08-05T00:00:00.000Z',
        idempotency_key: label,
        payload: { malformed: true },
      },
      {
        ledgerPath: usageLedgerPath(repo.path),
        sidecarsDir: usageSidecarsDir(repo.path),
        containmentRoot: repo.path,
      }
    );
  }

  it('enable flips ONLY archive.enabled, runs the first-enable backfill, and is idempotent', async () => {
    await seedPlanArtifact();
    expect(await archiveEnabled()).toBe(false);
    const before = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;

    const r = await agent.runRaw(['archive', 'enable', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      enabled: boolean;
      already_enabled: boolean;
      replayed_events: number;
      remaining_missing: number;
    };
    expect(out.enabled).toBe(true);
    expect(out.already_enabled).toBe(false);
    expect(out.replayed_events).toBeGreaterThan(0); // the captured plan backfilled
    expect(out.remaining_missing).toBe(0);

    // Only archive.enabled changed in the config.
    const after = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(after.archive).toEqual({ ...(before.archive as object), enabled: true });
    expect({ ...after, archive: undefined }).toEqual({ ...before, archive: undefined });

    // Idempotent re-enable: nothing left to replay.
    const again = await agent.runRaw(['archive', 'enable', '--json']);
    expect(again.exitCode).toBe(0);
    const out2 = JSON.parse(again.stdout) as {
      already_enabled: boolean;
      replayed_events: number;
    };
    expect(out2.already_enabled).toBe(true);
    expect(out2.replayed_events).toBe(0);
  });

  it('strict enable leaves mirroring on but returns ARCHIVE_INCOMPLETE for a content block', async () => {
    const artifactId = await seedPlanArtifact();
    await appendFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      '{"truncated":',
      'utf8'
    );
    await seedInvalidUsage('blocked-enable-usage');

    const result = await agent.runRaw(['archive', 'enable', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'ARCHIVE_INCOMPLETE',
      },
    });
    expect(result.stdout).toContain('archive resolve');
    expect(result.stdout).toContain('1 invalid usage event(s) remain quarantined');
    expect(await archiveEnabled()).toBe(true);

    const repair = await agent.runRaw(['archive', 'repair']);
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toContain('quarantine:     1 invalid usage event(s)');
  });

  it('enables with invalid usage quarantined and explains the residual', async () => {
    await seedInvalidUsage('invalid-usage');

    const result = await agent.runRaw(['archive', 'enable', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      complete: true,
      remaining_missing: 0,
      blocked_missing: 0,
      usage_blocked_missing: 1,
      blocked_artifacts: 0,
    });

    const status = await agent.runRaw(['archive', 'status']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('quarantine:  1 invalid usage event(s)');
    expect(status.stdout).toContain('do not block archive activation');

    const doctor = await agent.runRaw(['doctor', '--json']);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; details?: string[] }>;
    };
    expect(
      report.checks.find((check) => check.name === 'archive-mirror-lag')?.details?.join('\n')
    ).toContain('1 invalid event(s) are quarantined');

    const enableHuman = await agent.runRaw(['archive', 'enable']);
    expect(enableHuman.exitCode).toBe(0);
    expect(enableHuman.stdout).toContain('quarantine: 1 invalid usage event(s)');
    expect(enableHuman.stdout).toContain('do not block archive activation');

    const repairHuman = await agent.runRaw(['archive', 'repair']);
    expect(repairHuman.exitCode).toBe(0);
    expect(repairHuman.stdout).toContain('quarantine:     1 invalid usage event(s)');
    expect(repairHuman.stdout).toContain('do not block archive activation');
  });

  it('disable flips the flag off and RETAINS archived data (prune is the only deletion path)', async () => {
    await seedPlanArtifact();
    await agent.runRaw(['archive', 'enable', '--json']);
    const status = await agent.runRaw(['archive', 'status', '--json']);
    const projectDirLine = JSON.parse(status.stdout) as { project_dir?: string };

    const r = await agent.runRaw(['archive', 'disable', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { enabled: boolean; note: string };
    expect(out.enabled).toBe(false);
    expect(out.note).toContain('prune');
    expect(await archiveEnabled()).toBe(false);

    // The archived data survives the disable.
    if (projectDirLine.project_dir) {
      await expect(stat(projectDirLine.project_dir)).resolves.toBeDefined();
    }
  });

  it('non-interactive init and --yes enable durable archiving', async () => {
    for (const extraArgs of [[], ['--yes']]) {
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', ...extraArgs, '--json', '--no-llm']);
        expect(r.exitCode).toBe(0);
        const config = JSON.parse(
          await readFile(path.join(fresh.path, '.orcaops', 'config.json'), 'utf8')
        ) as { archive?: { enabled?: boolean } };
        expect(config.archive?.enabled).toBe(true);
      } finally {
        await fresh.cleanup();
      }
    }
  });

  describe('interactive init confirm (mocked TTY + @clack)', () => {
    let hadTty: boolean | undefined;
    let hadCi: string | undefined;

    beforeEach(() => {
      hadTty = process.stdout.isTTY;
      hadCi = process.env.CI;
      // Simulate a real interactive terminal for isInteractiveInit.
      (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
      delete process.env.CI;
    });

    afterEach(() => {
      (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
      if (hadCi !== undefined) process.env.CI = hadCi;
    });

    async function initFresh(confirmAnswer: unknown): Promise<boolean> {
      const clack = await import('@clack/prompts');
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      confirmMock.mockReset();
      confirmMock.mockResolvedValueOnce(confirmAnswer); // archive
      confirmMock.mockImplementation(async () => false); // customize-more: declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
        expect(r.exitCode).toBe(0);
        expect(confirmMock).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ initialValue: true })
        );
        const config = JSON.parse(
          await readFile(path.join(fresh.path, '.orcaops', 'config.json'), 'utf8')
        ) as { archive?: { enabled?: boolean } };
        return config.archive?.enabled === true;
      } finally {
        await fresh.cleanup();
      }
    }

    it('offers durable archiving as the default', async () => {
      const clack = await import('@clack/prompts');
      expect(await initFresh(true)).toBe(true);
      expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
    });

    it('a preserving --force re-init asks nothing and keeps the stored archive choice', async () => {
      const clack = await import('@clack/prompts');
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        expect((await freshAgent.runRaw(['init', '--yes', '--json', '--no-llm'])).exitCode).toBe(0);
        // --yes enables the archive (default-on); disable so a re-ask would
        // provably clobber a STORED off choice.
        expect((await freshAgent.runRaw(['archive', 'disable', '--json'])).exitCode).toBe(0);

        confirmMock.mockClear();
        confirmMock.mockImplementation(async () => true);
        expect((await freshAgent.runRaw(['init', '--force', '--json', '--no-llm'])).exitCode).toBe(
          0
        );
        // --force alone reconciles files and re-asks NOTHING: no archive
        // prompt fires and the stored off choice survives the re-init.
        expect(
          confirmMock.mock.calls.find(([opts]) =>
            String((opts as { message?: string }).message).startsWith('Keep a backup')
          )
        ).toBeUndefined();
        const cfgRaw = JSON.parse(
          await readFile(path.join(fresh.path, '.orcaops', 'config.json'), 'utf8')
        ) as { archive?: { enabled?: boolean } };
        expect(cfgRaw.archive?.enabled).toBe(false);
      } finally {
        await fresh.cleanup();
      }
    });

    it('force re-init from disabled to enabled backfills existing history before succeeding', async () => {
      const artifactId = await seedPlanArtifact();
      const clack = await import('@clack/prompts');
      // YES to every confirm EXCEPT the customize-more branch: opening it
      // would feed this file's select/multiselect defaults into settings they
      // were never meant for. Message-matched so prompt order can't break it.
      (clack.confirm as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { message?: string }) =>
          !String(opts?.message ?? '').includes('Customize more')
      );

      const result = await agent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--json',
        '--no-llm',
      ]);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as {
        archive_backfill: {
          replayed_events: number;
          remaining_missing: number;
        } | null;
      };
      expect(output.archive_backfill?.replayed_events).toBeGreaterThan(0);
      expect(output.archive_backfill?.remaining_missing).toBe(0);

      const projectId = (
        await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
      ).trim();
      const hotLog = await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
        'utf8'
      );
      const archiveLog = await readFile(
        path.join(dataDir, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'),
        'utf8'
      );
      expect(archiveLog).toBe(hotLog);

      const status = await agent.runRaw(['archive', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      expect((JSON.parse(status.stdout) as { total_missing: number }).total_missing).toBe(0);
    });

    it('content-blocked activation returns the full init result with a resolution warning', async () => {
      await agent.runRaw(['archive', 'enable', '--json']);
      const artifactId = await seedPlanArtifact();
      await agent.runRaw(['archive', 'disable', '--json']);
      await appendFile(
        path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
        '{"truncated":',
        'utf8'
      );
      await seedInvalidUsage('blocked-init-usage');
      const clack = await import('@clack/prompts');
      // YES to every confirm EXCEPT the customize-more branch: opening it
      // would feed this file's select/multiselect defaults into settings they
      // were never meant for. Message-matched so prompt order can't break it.
      (clack.confirm as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { message?: string }) =>
          !String(opts?.message ?? '').includes('Customize more')
      );

      const result = await agent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--json',
        '--no-llm',
      ]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as {
        ok: boolean;
        repo_root: string;
        warnings: string[];
        archive_backfill: {
          complete: boolean;
          blocked_artifacts: number;
          blocked_missing: number;
          usage_blocked_missing: number;
          artifact_issues: Array<{ artifact_id: string; kind: string }>;
        };
      };
      expect(output.ok).toBe(true);
      expect(output.repo_root).toBe(await realpath(repo.path));
      expect(output.archive_backfill).toMatchObject({
        complete: false,
        blocked_artifacts: 1,
        blocked_missing: 0,
        usage_blocked_missing: 1,
        artifact_issues: [{ artifact_id: artifactId, kind: 'hot_log_corrupt' }],
      });
      expect(output.warnings).toContain(
        'Archive backfill quarantined 1 invalid usage event(s) in the hot ledger; they remain ' +
          'without archive-readable content and do not block archive activation.'
      );
      expect(output.warnings.join('\n')).toContain(
        `orcaops archive resolve --artifact ${artifactId} --source archive --apply`
      );
      expect(await archiveEnabled()).toBe(true);
    });

    it('content-blocked activation names no command when neither source validates', async () => {
      const artifactId = await seedPlanArtifact();
      await appendFile(
        path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
        '{"truncated":',
        'utf8'
      );
      const clack = await import('@clack/prompts');
      // YES to every confirm EXCEPT the customize-more branch: opening it
      // would feed this file's select/multiselect defaults into settings they
      // were never meant for. Message-matched so prompt order can't break it.
      (clack.confirm as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { message?: string }) =>
          !String(opts?.message ?? '').includes('Customize more')
      );

      const result = await agent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--json',
        '--no-llm',
      ]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as {
        warnings: string[];
        archive_backfill: { complete: boolean; artifact_issues: unknown[] };
      };
      expect(output.archive_backfill.complete).toBe(false);
      expect(output.warnings.join('\n')).toContain(
        'Neither source strictly reconstructs, so no automated resolution is safe'
      );
      expect(output.warnings.join('\n')).not.toContain(`archive resolve --artifact ${artifactId}`);
      expect(await archiveEnabled()).toBe(true);
    });

    it('wraps activation infrastructure failure without rolling back applied init', async () => {
      await seedPlanArtifact();
      const invalidDataRoot = path.join(dataDir, 'not-a-directory');
      await writeFile(invalidDataRoot, 'x', 'utf8');
      const clack = await import('@clack/prompts');
      // YES to every confirm EXCEPT the customize-more branch: opening it
      // would feed this file's select/multiselect defaults into settings they
      // were never meant for. Message-matched so prompt order can't break it.
      (clack.confirm as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { message?: string }) =>
          !String(opts?.message ?? '').includes('Customize more')
      );
      const failingAgent = makeAgent({
        cwd: repo.path,
        env: {
          ORCAOPS_DISABLE_DRAIN: '1',
          ORCAOPS_DATA_DIR: invalidDataRoot,
        },
      });

      const result = await failingAgent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--json',
        '--no-llm',
      ]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'INTERNAL',
          message: expect.stringContaining(
            'Archive activation failed after archive.enabled was applied'
          ),
        },
      });
      expect(result.stderr).not.toContain('Internal error:');
      expect(result.stderr).not.toContain('\n    at ');
      expect(await archiveEnabled()).toBe(true);

      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        archive: { enabled: boolean };
      };
      config.archive.enabled = false;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      const humanResult = await failingAgent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--no-llm',
      ]);
      expect(humanResult.exitCode).toBe(1);
      expect(humanResult.stderr).toContain(
        'Error: Archive activation failed after archive.enabled was applied'
      );
      expect(humanResult.stderr).not.toContain('Internal error:');
      expect(humanResult.stderr).not.toContain('\n    at ');
      expect(await archiveEnabled()).toBe(true);
    });

    it('dry-run and already-enabled re-init do not run activation again', async () => {
      const clack = await import('@clack/prompts');
      // YES to every confirm EXCEPT the customize-more branch: opening it
      // would feed this file's select/multiselect defaults into settings they
      // were never meant for. Message-matched so prompt order can't break it.
      (clack.confirm as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { message?: string }) =>
          !String(opts?.message ?? '').includes('Customize more')
      );

      const preview = await agent.runRaw([
        'init',
        '--force',
        '--reset-config',
        '--dry-run',
        '--json',
        '--no-llm',
      ]);
      expect(preview.exitCode).toBe(0);
      expect(
        (JSON.parse(preview.stdout) as { archive_backfill: unknown }).archive_backfill
      ).toBeNull();
      expect(await archiveEnabled()).toBe(false);

      expect((await agent.runRaw(['archive', 'enable', '--json'])).exitCode).toBe(0);
      const alreadyEnabled = await agent.runRaw(['init', '--force', '--json', '--no-llm']);
      expect(alreadyEnabled.exitCode).toBe(0);
      expect(
        (JSON.parse(alreadyEnabled.stdout) as { archive_backfill: unknown }).archive_backfill
      ).toBeNull();
    });

    it('answering no keeps the archive off', async () => {
      expect(await initFresh(false)).toBe(false);
    });

    it('cancelling the archive prompt aborts before initialization', async () => {
      const clack = await import('@clack/prompts');
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      confirmMock.mockReset();
      confirmMock.mockResolvedValueOnce(CANCELLED);
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const result = await freshAgent.runRaw([
          'init',
          '--scope',
          'project',
          '--json',
          '--no-llm',
        ]);
        expect(result.exitCode).toBe(1);
        await expect(access(path.join(fresh.path, '.orcaops'))).rejects.toThrow();
      } finally {
        await fresh.cleanup();
      }
    });

    it('offers the session-hooks select first; choosing state-aware persists it and demotes the section default (ladder)', async () => {
      // Interactive prompt order: session-hooks SELECT → instructions-section
      // SELECT → archive confirm. The install set is the mocked
      // ['claude-code'] multiselect — fully hook-capable — so picking any
      // hook mode makes the section redundant context: its select must
      // default to 'manual' while staying independently answerable.
      const clack = await import('@clack/prompts');
      const selectMock = clack.select as ReturnType<typeof vi.fn>;
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      // Per-test call positions: the shared mock's CALL HISTORY accumulates
      // across tests (only the once-queue self-consumes), so Nth assertions
      // need a clean slate.
      selectMock.mockReset();
      selectMock
        .mockResolvedValueOnce('state-aware') // session hooks
        .mockResolvedValueOnce('managed'); // instructions section: accept despite default-manual
      confirmMock.mockReset();
      confirmMock
        .mockResolvedValueOnce(false) // archive is independent
        .mockResolvedValueOnce(false); // customize-more: declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
        expect(r.exitCode).toBe(0);
        const config = JSON.parse(
          await readFile(path.join(fresh.path, '.orcaops', 'config.json'), 'utf8')
        ) as {
          bootstrap: string;
          session_hooks: { enabled: boolean; payload: string };
          archive?: { enabled?: boolean };
        };
        expect(config.session_hooks).toEqual({ enabled: true, payload: 'state-aware' });
        expect(config.bootstrap).toBe('managed');
        // Archive declined at its prompt → disabled.
        expect(config.archive?.enabled ?? false).toBe(false);
        // Session-hooks select (shared copy): static recommended, state-aware
        // experimental, off — defaulting to static on fresh setup.
        expect(selectMock).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            initialValue: 'static',
            options: expect.arrayContaining([
              expect.objectContaining({ value: 'static' }),
              expect.objectContaining({
                value: 'state-aware',
                label: expect.stringMatching(/experimental/i),
              }),
              expect.objectContaining({ value: 'off' }),
            ]),
          })
        );
        // Instructions-section select (shared copy), demoted by the ladder.
        expect(selectMock).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            initialValue: 'manual',
            options: expect.arrayContaining([
              expect.objectContaining({ value: 'managed' }),
              expect.objectContaining({ value: 'manual' }),
            ]),
          })
        );
      } finally {
        await fresh.cleanup();
      }
    });

    it('declining session hooks makes the section the top rung again (default managed)', async () => {
      const clack = await import('@clack/prompts');
      const selectMock = clack.select as ReturnType<typeof vi.fn>;
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      // Per-test call positions: the shared mock's CALL HISTORY accumulates
      // across tests (only the once-queue self-consumes), so Nth assertions
      // need a clean slate.
      selectMock.mockClear();
      selectMock
        .mockResolvedValueOnce('off') // session hooks: declined
        .mockResolvedValueOnce('managed'); // instructions section: the fallback rung engages
      confirmMock.mockReset();
      confirmMock
        .mockResolvedValueOnce(false) // archive
        .mockResolvedValueOnce(false); // customize-more: declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
        expect(r.exitCode).toBe(0);
        const config = JSON.parse(
          await readFile(path.join(fresh.path, '.orcaops', 'config.json'), 'utf8')
        ) as { bootstrap: string; session_hooks?: { enabled?: boolean } };
        // Minimal-delta config: declining hooks leaves the default (absent).
        expect(config.session_hooks?.enabled ?? false).toBe(false);
        expect(config.bootstrap).toBe('managed');
        expect(selectMock).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ initialValue: 'managed' })
        );
      } finally {
        await fresh.cleanup();
      }
    });

    it('cancelling the instructions-section select aborts before initialization', async () => {
      const clack = await import('@clack/prompts');
      const selectMock = clack.select as ReturnType<typeof vi.fn>;
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      // Per-test call positions: the shared mock's CALL HISTORY accumulates
      // across tests (only the once-queue self-consumes), so Nth assertions
      // need a clean slate.
      selectMock.mockClear();
      selectMock
        .mockResolvedValueOnce('off') // session hooks declined → section defaults managed
        .mockResolvedValueOnce(CANCELLED); // instructions section: ctrl-C
      confirmMock.mockReset();
      confirmMock
        .mockResolvedValueOnce(false) // archive prompt
        .mockResolvedValueOnce(false); // customize-more: declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
        expect(r.exitCode).toBe(1);
        await expect(access(path.join(fresh.path, '.orcaops'))).rejects.toThrow();
      } finally {
        await fresh.cleanup();
      }
    });

    it('cancelling the session-hooks select aborts before initialization', async () => {
      const clack = await import('@clack/prompts');
      const selectMock = clack.select as ReturnType<typeof vi.fn>;
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      // Per-test call positions: the shared mock's CALL HISTORY accumulates
      // across tests (only the once-queue self-consumes), so Nth assertions
      // need a clean slate.
      selectMock.mockClear();
      selectMock
        .mockResolvedValueOnce(CANCELLED) // session hooks: ctrl-C
        .mockResolvedValueOnce('manual'); // instructions section
      confirmMock.mockReset();
      confirmMock
        .mockResolvedValueOnce(false) // archive
        .mockResolvedValueOnce(false); // customize-more: declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        const r = await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
        expect(r.exitCode).toBe(1);
        await expect(access(path.join(fresh.path, '.orcaops'))).rejects.toThrow();
      } finally {
        await fresh.cleanup();
      }
    });

    it('cancelling a --reset-config re-interview aborts with the config byte-untouched', async () => {
      const clack = await import('@clack/prompts');
      const selectMock = clack.select as ReturnType<typeof vi.fn>;
      const confirmMock = clack.confirm as ReturnType<typeof vi.fn>;
      // Per-test call positions: the shared mock's CALL HISTORY accumulates
      // across tests (only the once-queue self-consumes), so Nth assertions
      // need a clean slate.
      selectMock.mockReset();
      selectMock
        .mockResolvedValueOnce('state-aware') // fresh: session hooks on
        .mockResolvedValueOnce('managed') // fresh: section managed
        .mockResolvedValueOnce(CANCELLED); // reset re-interview: session hooks ctrl-C
      confirmMock.mockReset();
      confirmMock
        .mockResolvedValueOnce(false) // fresh: archive
        .mockResolvedValueOnce(false); // fresh: customize-more declined
      const fresh = await createTempRepo({ initialBranch: 'main' });
      try {
        const freshAgent = makeAgent({
          cwd: fresh.path,
          env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
        });
        expect(
          (await freshAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm'])).exitCode
        ).toBe(0);
        const configPath = path.join(fresh.path, '.orcaops', 'config.json');
        const before = await readFile(configPath, 'utf8');
        // --force alone re-asks nothing; only the explicit reset re-opens the
        // interview, and cancelling it aborts before any mutation executes.
        const re = await freshAgent.runRaw([
          'init',
          '--scope',
          'project',
          '--json',
          '--no-llm',
          '--force',
          '--reset-config',
        ]);
        expect(re.exitCode).toBe(1);
        expect(await readFile(configPath, 'utf8')).toBe(before);
      } finally {
        await fresh.cleanup();
      }
    });
  });

  it('documents tolerant init versus strict explicit enable in command help', async () => {
    const initHelp = await agent.runRaw(['init', '--help']);
    const enableHelp = await agent.runRaw(['archive', 'enable', '--help']);

    expect(initHelp.stdout).toContain('archive content conflicts warn');
    expect(enableHelp.stdout).toMatch(/content conflicts keep it\s+enabled but exit nonzero/);
  });
});
