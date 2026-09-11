import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Pin, pinFilePath, uuidv7 } from '@orcaops/storage';
import { gitClient } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { withCleanSession } from '../support/test-helpers.js';

interface DoctorReport {
  ok: true;
  overall: 'pass' | 'warn' | 'fail';
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    summary: string;
    details?: string[];
  }>;
}

function findCheck(report: DoctorReport, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`No check named "${name}" in report`);
  return found;
}

async function getRepoId(cwd: string): Promise<string> {
  // Pins key by the minted project identity verbatim.
  const git = gitClient(cwd);
  return (await git.raw(['config', '--local', '--get', 'orcaops.projectid'])).trim();
}

async function plantPin(opts: {
  cwd: string;
  xdgState: string;
  artifactId: string;
  shellKey: { kind: 'claude_session'; value: string };
  pinnedAt: string;
  pinnedVia?: 'auto-on-capture-plan' | 'explicit-checkout';
}): Promise<void> {
  const repoId = await getRepoId(opts.cwd);
  const file = pinFilePath(repoId, opts.shellKey, { XDG_STATE_HOME: opts.xdgState });
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pin: Pin = {
    schema_version: 1,
    artifact_id: opts.artifactId,
    branch: 'main',
    shell_key: opts.shellKey,
    pinned_at: opts.pinnedAt,
    pinned_via: opts.pinnedVia ?? 'auto-on-capture-plan',
  };
  await writeFile(file, JSON.stringify(pin), 'utf8');
}

describe('orcaops doctor — pin checks', () => {
  let history: Awaited<ReturnType<typeof fixture>>;
  let xdgState: string;

  beforeEach(async () => {
    history = await fixture();
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-xdg-'));
    const init = makeAgent({
      cwd: history.main,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, ORCAOPS_DATA_DIR: history.root }),
    });
    await init.runRaw(['init', '--no-llm']);
  });

  afterEach(async () => {
    await history.cleanup();
    await rm(xdgState, { recursive: true, force: true });
  });

  function agentHeadless() {
    return makeAgent({
      cwd: history.main,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, ORCAOPS_DATA_DIR: history.root }),
    });
  }

  function agentWithSession(sessionId = 'sess_test') {
    return makeAgent({
      cwd: history.main,
      env: withCleanSession({
        XDG_STATE_HOME: xdgState,
        ORCAOPS_DATA_DIR: history.root,
        CLAUDE_SESSION_ID: sessionId,
      }),
    });
  }

  async function planArtifactHeadless(agentSessionId: string | null = null): Promise<string> {
    return history.capture(undefined, { agentSessionId, task: 'Doctor pin fixture' });
  }

  async function captureCheckpointHeadless(artifactId: string, _n: number): Promise<void> {
    await history.recordFiles(artifactId, []);
  }

  async function summarizeArtifact(artifactId: string): Promise<void> {
    await history.mutate(artifactId, { outcome: 'shipped' }, (semantics) =>
      semantics.writeSummary({
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'shipped',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: history.registeredContext.binding!.git_context.head_sha!,
        ts: new Date().toISOString(),
      })
    );
  }

  describe('stale-pin', () => {
    it('passes when no pins exist', async () => {
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      expect(findCheck(r, 'stale-pin').status).toBe('pass');
    });

    it('warns when a pin points at a summarized artifact', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      // Plant a pin that the lifecycle won't auto-clear (different shell key).
      await plantPin({
        cwd: history.main,
        xdgState,
        artifactId: a,
        shellKey: { kind: 'claude_session', value: 'orphan-shell' },
        pinnedAt: new Date().toISOString(),
      });
      // Summarize a → pin's target is now summarized.
      await summarizeArtifact(a);
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'stale-pin');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/1 of \d+/);
    });

    it('warns when a pin points at a missing artifact id', async () => {
      await plantPin({
        cwd: history.main,
        xdgState,
        artifactId: 'never-existed',
        shellKey: { kind: 'claude_session', value: 'ghost' },
        pinnedAt: new Date().toISOString(),
      });
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'stale-pin');
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes('artifact missing'))).toBe(true);
    });
  });

  describe('shell-key', () => {
    it('warns when no shell-key env var is resolvable (auto-pin no-op)', async () => {
      // agentHeadless strips CLAUDE_SESSION_ID + CODEX_SESSION_ID + TMUX_PANE +
      // STY/WINDOW + TTY, so the doctor process can't resolve any kind.
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'shell-key');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/no shell-key resolvable/);
      expect(check.details?.some((d) => d.includes('CLAUDE_SESSION_ID'))).toBe(true);
    });

    it('passes when CLAUDE_SESSION_ID is set in the doctor process env', async () => {
      const res = await agentWithSession('sess_doctor_test').runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'shell-key');
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/claude_session resolvable/);
    });
  });

  describe('aged-pin', () => {
    it('passes when no pins are old', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      await plantPin({
        cwd: history.main,
        xdgState,
        artifactId: a,
        shellKey: { kind: 'claude_session', value: 'fresh' },
        pinnedAt: new Date().toISOString(),
      });
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      expect(findCheck(r, 'aged-pin').status).toBe('pass');
    });

    it('warns when a pin is >7d old on an active artifact', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      // Pin from 10 days ago.
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await plantPin({
        cwd: history.main,
        xdgState,
        artifactId: a,
        shellKey: { kind: 'claude_session', value: 'parked' },
        pinnedAt: tenDaysAgo,
      });
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'aged-pin');
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes(tenDaysAgo))).toBe(true);
    });
  });

  describe('pin-orphan (informational)', () => {
    it('passes (informational) when active artifacts have no pins', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1); // active, no pin
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'pin-orphan');
      // Informational: status stays 'pass' even when orphans exist.
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/1 of 1/);
    });

    it('passes when every active artifact has a pin', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      await plantPin({
        cwd: history.main,
        xdgState,
        artifactId: a,
        shellKey: { kind: 'claude_session', value: 'owner' },
        pinnedAt: new Date().toISOString(),
      });
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      expect(findCheck(r, 'pin-orphan').summary).toBe(
        '0 of 1 active artifact(s) have no ephemeral pin'
      );
    });
  });

  describe('same-session-multi-active (informational)', () => {
    it('passes when active artifacts come from distinct session_ids', async () => {
      // Two artifacts, no session_id → no flag.
      await planArtifactHeadless();
      const b = await planArtifactHeadless();
      await captureCheckpointHeadless(b, 1);
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      expect(findCheck(r, 'same-session-multi-active').status).toBe('pass');
    });

    it('flags (informational, status=pass) two actives sharing a session_id', async () => {
      const a1 = await planArtifactHeadless('sess_shared');
      await captureCheckpointHeadless(a1, 1);
      const a2 = await planArtifactHeadless('sess_shared');
      await captureCheckpointHeadless(a2, 1);
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'same-session-multi-active');
      // Informational: status stays 'pass'; surfaces grouping in details.
      expect(check.status).toBe('pass');
      expect(check.summary).toBe(
        '1 branch and authoring-session group(s) have multiple active artifacts'
      );
    });
  });

  describe('pin-displaced', () => {
    it('passes when no active artifacts have pin_displaced events', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      expect(findCheck(r, 'pin-displaced').status).toBe('pass');
    });

    it('warns when an active artifact has a pin_displaced event', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1); // a is now active
      const b = await planArtifactHeadless();
      await history.mutate(a, { displacedBy: b }, (semantics) =>
        semantics.writePinDisplaced(a, {
          displaced_by_artifact_id: b,
          shell_key: { kind: 'claude_session', value: 'sess_test' },
          reason: 'explicit-checkout',
        })
      );
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'pin-displaced');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/1 active artifact\(s\)/);
      expect(check.details?.some((d) => d.includes(a))).toBe(true);
    });

    it('does not flag pin_displaced events on summarized artifacts', async () => {
      const a = await planArtifactHeadless();
      await captureCheckpointHeadless(a, 1);
      const b = await planArtifactHeadless();
      await history.mutate(a, { displacedBy: b }, (semantics) =>
        semantics.writePinDisplaced(a, {
          displaced_by_artifact_id: b,
          shell_key: { kind: 'claude_session', value: uuidv7() },
          reason: 'explicit-checkout',
        })
      );
      // Summarize a — once summarized, we no longer flag a's displaced event.
      await summarizeArtifact(a);
      const res = await agentHeadless().runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'pin-displaced');
      // Only b is active; b has no pin_displaced events.
      expect(check.status).toBe('pass');
    });
  });
});
