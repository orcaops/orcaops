import { execFileSync } from 'node:child_process';
import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { artifactPathsFor, readEventLog } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { plantBlockViolation, withCleanSession } from '../support/test-helpers.js';

async function readPinDisplacedEvents(repoCwd: string, artifactId: string): Promise<unknown[]> {
  const config = await loadConfig(repoCwd);
  const paths = artifactPathsFor(repoCwd, config, artifactId);
  const result = await readEventLog({
    eventLogPath: paths.eventsNdjson,
    sidecarsDir: paths.sidecarsDir,
  });
  return result.events.filter((e) => e.type === 'pin_displaced');
}

interface PinJson {
  schema_version: number;
  artifact_id: string;
  branch: string;
  shell_key: { kind: string; value?: string };
  pinned_via: 'auto-on-capture-plan' | 'explicit-checkout';
}

async function readPinFile(file: string): Promise<PinJson> {
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw) as PinJson;
}

async function listPinFiles(xdgState: string): Promise<string[]> {
  const root = path.join(xdgState, 'orcaops', 'pins');
  try {
    await access(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const repoEntry of await readdir(root)) {
    const repoDir = path.join(root, repoEntry);
    for (const e of await readdir(repoDir)) {
      if (e.endsWith('.json')) out.push(path.join(repoDir, e));
    }
  }
  return out;
}

describe('pin auto-lifecycle', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-pin-life-xdg-'));
    const initAgent = makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: 'sess_test' }),
    });
    await initAgent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function agentForSession(sessionId = 'sess_test') {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: sessionId }),
    });
  }

  function agentHeadless() {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState }),
    });
  }

  async function planArtifact(
    agent: ReturnType<typeof makeAgent> = agentForSession()
  ): Promise<string> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    return plan.artifact_id;
  }

  async function captureCheckpoint(artifactId: string, n: number): Promise<void> {
    const agent = agentForSession();
    const showRes = await agent.runRaw(['show', artifactId, '--json']);
    const showJson = JSON.parse(showRes.stdout) as {
      artifact?: { plan?: { plan_steps?: Array<{ step_id: string }> } };
    };
    const stepIds = showJson.artifact?.plan?.plan_steps?.map((s) => s.step_id) ?? [];
    const openRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          declared_step_ids: [stepIds[n - 1]],
        })
      ),
    ]);
    expect(openRes.exitCode).toBe(0);
    const res = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n,
          summary: `cp-${n}`,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepIds[n - 1]],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
  }

  describe('capture plan: auto-pin', () => {
    it('writes a pin file with pinned_via=auto-on-capture-plan', async () => {
      const artifactId = await planArtifact();
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      const pin = await readPinFile(files[0]);
      expect(pin.artifact_id).toBe(artifactId);
      expect(pin.shell_key.kind).toBe('claude_session');
      expect(pin.pinned_via).toBe('auto-on-capture-plan');
    });

    it('headless shell (no session env) skips auto-pin silently', async () => {
      const artifactId = await planArtifact(agentHeadless());
      expect(artifactId).toMatch(/^[0-9a-f]{8}-/);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(0);
    });

    it('idempotent replay re-establishes the pin (same artifact, no displaced event)', async () => {
      const a = await planArtifact();
      const sessionAgent = agentForSession();
      const planRes = await sessionAgent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: 't',
            plan_steps: [{ text: 's', label: 's1' }],
            idempotency_key: 'fixed-key',
          })
        ),
      ]);
      const plan1 = JSON.parse(planRes.stdout) as { artifact_id: string };
      const planRes2 = await sessionAgent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: 't',
            plan_steps: [{ text: 's', label: 's1' }],
            idempotency_key: 'fixed-key',
          })
        ),
      ]);
      const plan2 = JSON.parse(planRes2.stdout) as {
        artifact_id: string;
        idempotency_status: string;
      };
      expect(plan2.artifact_id).toBe(plan1.artifact_id);
      expect(plan2.idempotency_status).toBe('replay');
      const events = await readPinDisplacedEvents(repo.path, plan1.artifact_id);
      expect(events).toHaveLength(0);
      const aEvents = await readPinDisplacedEvents(repo.path, a);
      expect(aEvents).toHaveLength(0);
    });

    it('plan-on-active overwrites a pin pointing at a different active artifact', async () => {
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      const b = await planArtifact();
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      const pin = await readPinFile(files[0]);
      expect(pin.artifact_id).toBe(b);
      const events = await readPinDisplacedEvents(repo.path, a);
      expect(events).toHaveLength(1);
    });
  });

  describe('capture plan: auto-pin containment of prior-artifact failures', () => {
    async function priorPaths(artifactId: string) {
      const config = await loadConfig(repo.path);
      return artifactPathsFor(repo.path, config, artifactId);
    }

    async function planExpectContained(priorId: string, expectedDetail: string): Promise<string> {
      const before = await readFile((await priorPaths(priorId)).eventsNdjson);
      const res = await agentForSession().runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't2', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toContain(`previously pinned artifact ${priorId}`);
      expect(res.stderr).toContain(expectedDetail);
      expect(res.stderr).toContain('without a pin_displaced event');
      const after = await readFile((await priorPaths(priorId)).eventsNdjson);
      expect(Buffer.compare(before, after)).toBe(0);
      return (JSON.parse(res.stdout) as { artifact_id: string }).artifact_id;
    }

    it('contains a corrupt-log append refusal: capture succeeds, pin moves, prior log untouched', async () => {
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      await appendFile((await priorPaths(a)).eventsNdjson, 'not-json corrupt line\n');
      const b = await planExpectContained(a, 'is unreadable (projection recovery refused)');
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      expect((await readPinFile(files[0])).artifact_id).toBe(b);
    });

    it('contains a crash-truncated tail on the prior log at the displacement append preflight', async () => {
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      // Append a NEW unterminated partial line: every real event stays
      // intact and terminated, so the state load returns current and the
      // failure fires in the append preflight — the ratified TOCTOU arm.
      await appendFile((await priorPaths(a)).eventsNdjson, '{"event_id":"partial');
      await planExpectContained(a, 'has a corrupt event log that refuses the displacement event');
    });

    it('contains a recovery refusal when the prior projection must rebuild from a lossy log', async () => {
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      const paths = await priorPaths(a);
      await appendFile(paths.eventsNdjson, 'not-json corrupt line\n');
      await rm(paths.artifactJson);
      await planExpectContained(a, 'is unreadable (projection recovery refused)');
    });

    it('contains a permission-class read failure on the prior artifact', async () => {
      if (process.getuid?.() === 0) return;
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      // File-scoped so only the displacement append's log read fails; a
      // dir-wide chmod would break readers outside the contained phase.
      const log = (await priorPaths(a)).eventsNdjson;
      const before = await readFile(log);
      await chmod(log, 0o000);
      try {
        const res = await agentForSession().runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(JSON.stringify({ task: 't2', plan_steps: [{ text: 's', label: 's1' }] })),
        ]);
        expect(res.exitCode).toBe(0);
        expect(res.stderr).toContain(`previously pinned artifact ${a}`);
        expect(res.stderr).toContain('could not be read (filesystem error)');
      } finally {
        await chmod(log, 0o644);
      }
      const after = await readFile(log);
      expect(Buffer.compare(before, after)).toBe(0);
    });

    it('replay arm contains a rotted prior pinned to a DIFFERENT artifact', async () => {
      const sessionAgent = agentForSession();
      const keyedPlan = () =>
        sessionAgent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              task: 'replay-target',
              plan_steps: [{ text: 's', label: 's1' }],
              idempotency_key: 'containment-replay-key',
              branch: 'replay-branch',
            })
          ),
        ]);
      const first = await keyedPlan();
      expect(first.exitCode).toBe(0);
      const b = (JSON.parse(first.stdout) as { artifact_id: string }).artifact_id;
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      await appendFile((await priorPaths(a)).eventsNdjson, 'not-json corrupt line\n');
      const priorBytes = await readFile((await priorPaths(a)).eventsNdjson);
      const replay = await keyedPlan();
      expect(replay.exitCode).toBe(0);
      expect(Buffer.compare(priorBytes, await readFile((await priorPaths(a)).eventsNdjson))).toBe(
        0
      );
      const parsed = JSON.parse(replay.stdout) as {
        artifact_id: string;
        idempotency_status: string;
      };
      expect(parsed.artifact_id).toBe(b);
      expect(parsed.idempotency_status).toBe('replay');
      expect(replay.stderr).toContain(`previously pinned artifact ${a}`);
      expect(replay.stderr).toContain('is unreadable (projection recovery refused)');
      const files = await listPinFiles(xdgState);
      expect((await readPinFile(files[0])).artifact_id).toBe(b);
      const displaced = await readPinDisplacedEvents(repo.path, a);
      expect(displaced).toHaveLength(0);
    });

    it('classifies exactly the contained shapes, phase-scoped, and nothing else', async () => {
      const { classifyPriorArtifactFailure } = await import('../../src/lib/pin-helpers.js');
      const { ArtifactLockTimeoutError, EventLogAppendRefusedError, RecoveryRefusedError } =
        await import('@orcaops/storage');
      for (const phase of ['read', 'write'] as const) {
        expect(classifyPriorArtifactFailure(new RecoveryRefusedError('m', 'a'), phase)).toBe(
          'unreadable'
        );
        expect(
          classifyPriorArtifactFailure(new EventLogAppendRefusedError('m', 'a', 'lossy'), phase)
        ).toBe('append_refused');
        expect(
          classifyPriorArtifactFailure(
            new EventLogAppendRefusedError('m', 'a', 'truncated_tail'),
            phase
          )
        ).toBe('append_refused');
        expect(
          classifyPriorArtifactFailure(
            new EventLogAppendRefusedError('m', 'a', 'unreadable'),
            phase
          )
        ).toBe('read_errno');
        expect(classifyPriorArtifactFailure(new ArtifactLockTimeoutError('a', 5), phase)).toBe(
          'lock_timeout'
        );
        expect(
          classifyPriorArtifactFailure(new Error('symlinked path escapes the root'), phase)
        ).toBeNull();
        expect(classifyPriorArtifactFailure('not-an-error', phase)).toBeNull();
      }
      const errno = Object.assign(new Error('EACCES: denied'), { errno: -13, code: 'EACCES' });
      expect(classifyPriorArtifactFailure(errno, 'read')).toBe('read_errno');
      // A raw errno DURING the displacement write may mean the line already
      // landed — never contained.
      expect(classifyPriorArtifactFailure(errno, 'write')).toBeNull();
    });

    it('a raw errno thrown mid-displacement-write stays loud even with containment on', async () => {
      const { replacePin } = await import('../../src/lib/pin-helpers.js');
      const { writePin } = await import('@orcaops/storage');
      const savedXdg = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = xdgState;
      onTestFinished(() => {
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = savedXdg;
      });
      const shellKey = { kind: 'claude_session', value: 'unit-sess' };
      const targets = { repoId: 'unit-repo', shellKey } as never;
      await writePin(
        {
          schema_version: 1,
          artifact_id: 'prior-artifact-id',
          branch: 'main',
          shell_key: shellKey,
          pinned_at: '2026-01-01T00:00:00.000Z',
          pinned_via: 'auto-on-capture-plan',
        } as never,
        { repoId: 'unit-repo', env: process.env }
      );
      const fsyncFailure = Object.assign(new Error('EIO: i/o error, fsync'), {
        errno: -5,
        code: 'EIO',
      });
      const stubCtx = {
        store: {
          readArtifact: async () => ({ state: 'active' }),
          writePinDisplaced: async () => {
            throw fsyncFailure;
          },
        },
      } as never;
      await expect(
        replacePin({
          ctx: stubCtx,
          artifactId: 'new-artifact-id',
          branch: 'main',
          pinnedAt: '2026-01-01T00:00:01.000Z',
          pinnedVia: 'auto-on-capture-plan',
          targets,
          containPriorArtifactFailure: true,
        })
      ).rejects.toThrow(/EIO/);
    });

    it('never contains a path-guard refusal: a symlinked prior log still fails the capture', async () => {
      const a = await planArtifact();
      await captureCheckpoint(a, 1);
      const paths = await priorPaths(a);
      const outside = path.join(xdgState, 'outside-log.ndjson');
      await writeFile(outside, '');
      await rm(paths.artifactJson);
      await rm(paths.eventsNdjson);
      await symlink(outside, paths.eventsNdjson);
      const res = await agentForSession().runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't2', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      expect(res.exitCode).not.toBe(0);
    });
  });

  describe('capture summary: auto-clear', () => {
    it('successful summary clears the pin for this shell', async () => {
      const artifactId = await planArtifact();
      const sum = await agentForSession().runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(0);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(0);
    });

    it("summary clears only this shell's pin, not other shells' pins", async () => {
      const a = await planArtifact(agentForSession('sess_a'));
      const b = await planArtifact(agentForSession('sess_b'));
      const sum = await agentForSession('sess_a').runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: a, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(0);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      const surviving = await readPinFile(files[0]);
      expect(surviving.artifact_id).toBe(b);
    });

    it('BLOCKED summary preserves the pin', async () => {
      const artifactId = await planArtifact();
      await plantBlockViolation({
        cwd: repo.path,
        artifactId,
        evaluatorRef: 'test-pack/api-stub',
      });
      const sum = await agentForSession().runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(1);
      const env = JSON.parse(sum.stdout) as { error: { code: string } };
      expect(env.error.code).toBe('BLOCKED');
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      const pin = await readPinFile(files[0]);
      expect(pin.artifact_id).toBe(artifactId);
    });

    it('summary clear is idempotent: a missing pin is a no-op', async () => {
      const artifactId = await planArtifact();
      const agent = agentForSession();
      await agent.runRaw(['checkout', '--clear', '--json']);
      const sum = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(0);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(0);
    });

    it('headless shell summary skips auto-clear silently', async () => {
      const artifactId = await planArtifact();
      const sum = await agentHeadless().runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(0);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
    });
  });

  describe('summary while pin points at a DIFFERENT artifact', () => {
    it("only clears when the pin's artifact_id matches", async () => {
      const a = await planArtifact();
      const b = await planArtifact();
      const agent = agentForSession();
      await agent.runRaw(['checkout', a, '--json']);
      const sum = await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: b, outcome: 'shipped' })),
      ]);
      expect(sum.exitCode).toBe(0);
      const files = await listPinFiles(xdgState);
      expect(files).toHaveLength(1);
      const pin = await readPinFile(files[0]);
      expect(pin.artifact_id).toBe(a);
    });
  });

  it('artifact dir contains pin events as expected on disk', async () => {
    const artifactId = await planArtifact();
    const config = await loadConfig(repo.path);
    const paths = artifactPathsFor(repo.path, config, artifactId);
    await expect(access(paths.eventsNdjson)).resolves.toBeUndefined();
  });
});

describe('repo identity is not minted by read-only verbs', () => {
  let repo: TempRepo;
  let xdgState: string;
  let agent: ReturnType<typeof makeAgent>;

  const projectId = (): string =>
    execFileSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim();

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-identity-xdg-'));
    agent = makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: 'sess_identity' }),
    });
    await agent.init({ noLlm: true });
    // The state a fresh clone or a new worktree starts in: the store exists
    // but this checkout's git-local config carries no identity yet.
    execFileSync('git', ['config', '--local', '--unset', 'orcaops.projectid'], { cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('leaves the identity unset through status, resume and a dry-run gc', async () => {
    for (const argv of [
      ['status', '--json'],
      ['resume', '--json'],
      ['gc', '--json'],
    ]) {
      const r = await agent.runRaw(argv);
      expect(r.exitCode, argv.join(' ')).toBe(0);
      expect(() => projectId(), argv.join(' ')).toThrow();
    }
  });

  it('leaves the identity unset when a capture payload fails validation, then mints on the valid retry', async () => {
    // A rejected write is not a write: payload validation must run before
    // the context mint, or a failed `capture plan` in a fresh clone stamps
    // an identity the user never consented to.
    const invalid = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: ['not-an-object'] })),
    ]);
    expect(invalid.exitCode).not.toBe(0);
    const envelope = JSON.parse(invalid.stdout) as { ok: boolean; error?: { code?: string } };
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(() => projectId()).toThrow();

    const valid = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(valid.exitCode).toBe(0);
    expect(projectId()).toMatch(/\S/);
  });

  it('leaves the identity unset through every other read verb, exit code aside', async () => {
    // The wider survey surface: some of these exit non-zero without inputs
    // (that is their business); the pinned contract is only that READING
    // never mints. The archive default is ON, so this also pins the
    // archive-wiring fail-open path for each verb.
    for (const argv of [
      ['list', '--json'],
      ['show', 'no-such-artifact', '--json'],
      ['digest', '--json'],
      ['why', 'README.md:1', '--json'],
      ['search', 'anything', '--json'],
      ['push-status', '--json'],
      ['lineage', '--json'],
      ['stats', '--json'],
      ['decisions', '--json'],
      ['usage', '--json'],
      ['loose-ends', '--json'],
      ['skills', 'list', '--json'],
      ['eval', 'list', '--json'],
      ['eval', 'show', 'core/checkpoint-scope-density', '--json'],
      ['archive', 'status', '--json'],
      ['diff', '--json'],
      ['export', '--json'],
      ['fingerprint', '--json'],
      ['snapshots', 'diff', '--json'],
      ['step', 'brief', 'no-such-step', '--json'],
    ]) {
      await agent.runRaw(argv);
      expect(() => projectId(), argv.join(' ')).toThrow();
    }
  });

  it('mints on the applying gc run, which writes the pin store', async () => {
    const r = await agent.runRaw(['gc', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    expect(projectId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
