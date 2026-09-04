import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalSessionHookCommand,
  isSemanticallyEmpty,
  type JsonObject,
  reconcileDocument,
  type SettingsSpec,
  settingsSpecs,
  userJsonSpecs,
} from './session-hooks.js';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function specCommand(spec: SettingsSpec): string {
  if (spec.schema === 'flat') return spec.desired.command as string;
  return (spec.desired.hooks as Array<{ command: string }>)[0].command;
}

function runShell(command: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe('canonical session-hook commands', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps project and machine flags inside the guarded invocation', () => {
    expect(canonicalSessionHookCommand('claude-code')).toBe(
      "sh -c 'command -v orcaops >/dev/null 2>&1 && orcaops hook session-start --agent claude-code || true'"
    );
    expect(canonicalSessionHookCommand('codex', { user: true })).toBe(
      "sh -c 'command -v orcaops >/dev/null 2>&1 && orcaops hook session-start --agent codex --user || true'"
    );
  });

  it('exits silently for every settings-json agent when orcaops is unavailable', async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-path-'));
    tempDirs.push(binDir);
    await symlink('/bin/sh', path.join(binDir, 'sh'));

    for (const spec of settingsSpecs()) {
      const result = await runShell(specCommand(spec), { PATH: binDir });
      expect(result, spec.agent).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    }
  });
});

describe('reconcileDocument — keys orcaops does not own', () => {
  const claudeSpec = (): SettingsSpec => {
    const spec = settingsSpecs().find((s) => s.agent === 'claude-code');
    if (!spec) throw new Error('claude-code settings spec missing');
    return spec;
  };

  it('leaves a user-authored empty array on another event untouched', () => {
    const spec = claudeSpec();
    for (const desired of [spec.desired, null]) {
      const root = { hooks: { PostToolUse: [] } } as Record<string, unknown>;
      expect(reconcileDocument(root, spec, desired)).toBe('ok');
      expect((root.hooks as Record<string, unknown>).PostToolUse).toEqual([]);
    }
  });

  it('never deletes a file whose only content is user-authored empty arrays', () => {
    const spec = claudeSpec();
    const root = { hooks: { PostToolUse: [], PreToolUse: [] } } as Record<string, unknown>;
    expect(reconcileDocument(root, spec, null)).toBe('ok');
    expect(root.hooks).toEqual({ PostToolUse: [], PreToolUse: [] });
  });

  it('still strips a lingering orcaops entry parked under another event', () => {
    const spec = claudeSpec();
    const root = { hooks: { PostToolUse: [structuredClone(spec.desired)] } } as Record<
      string,
      unknown
    >;
    expect(reconcileDocument(root, spec, null)).toBe('ok');
    expect(root.hooks).toBeUndefined();
  });

  it('keeps a user hook that shares an event with a lingering orcaops entry', () => {
    const spec = claudeSpec();
    const mine = { matcher: 'x', hooks: [{ type: 'command', command: 'echo mine' }] };
    const root = { hooks: { PostToolUse: [structuredClone(spec.desired), mine] } } as Record<
      string,
      unknown
    >;
    expect(reconcileDocument(root, spec, null)).toBe('ok');
    expect((root.hooks as Record<string, unknown>).PostToolUse).toEqual([mine]);
  });
});

describe('codex hooks.json spec', () => {
  const codexSpec = (): SettingsSpec => {
    const spec = userJsonSpecs().find((s) => s.agent === 'codex');
    if (!spec) throw new Error('codex user json spec missing');
    return spec;
  };

  const notify = (name: string): JsonObject => ({
    hooks: [{ type: 'command', command: `/Applications/Superset.app/${name}/notify.sh` }],
  });

  /** The shape Superset's writer leaves behind in ~/.codex/hooks.json. */
  const supersetDocument = (): JsonObject => ({
    hooks: {
      SessionStart: [notify('session-start')],
      UserPromptSubmit: [notify('prompt')],
      Stop: [notify('stop')],
    },
  });

  it('is a grouped SessionStart group with a matcher and no timeout', () => {
    const spec = codexSpec();
    expect(spec.schema).toBe('grouped');
    expect(spec.eventKey).toBe('SessionStart');
    expect(spec.seed).toEqual({});
    expect(spec.placement).toBe('prepend');
    expect(spec.desired).toEqual({
      matcher: 'startup|resume',
      hooks: [{ type: 'command', command: canonicalSessionHookCommand('codex') }],
    });
  });

  it('is offered to the user planner but never to the project planner', () => {
    expect(userJsonSpecs().map((s) => s.agent)).toContain('codex');
    expect(settingsSpecs().map((s) => s.agent)).not.toContain('codex');
  });

  it('puts our group first in SessionStart and leaves the other events alone', () => {
    const spec = codexSpec();
    const root = supersetDocument();
    expect(reconcileDocument(root, spec, spec.desired)).toBe('ok');
    const hooks = root.hooks as JsonObject;
    expect(hooks.SessionStart).toEqual([spec.desired, notify('session-start')]);
    expect(hooks.UserPromptSubmit).toEqual([notify('prompt')]);
    expect(hooks.Stop).toEqual([notify('stop')]);
  });

  it('changes nothing on a second reconcile', () => {
    const spec = codexSpec();
    const root = supersetDocument();
    reconcileDocument(root, spec, spec.desired);
    const once = structuredClone(root);
    expect(reconcileDocument(root, spec, spec.desired)).toBe('ok');
    expect(root).toEqual(once);
    expect((root.hooks as JsonObject).SessionStart).toEqual([
      spec.desired,
      notify('session-start'),
    ]);
  });

  it('leaves our group where a Superset rewrite moved it instead of duplicating it', () => {
    const spec = codexSpec();
    const root = supersetDocument();
    (root.hooks as JsonObject).SessionStart = [
      notify('session-start'),
      structuredClone(spec.desired),
    ];
    expect(reconcileDocument(root, spec, spec.desired)).toBe('ok');
    expect((root.hooks as JsonObject).SessionStart).toEqual([
      notify('session-start'),
      spec.desired,
    ]);
  });

  it('strips only our command and leaves their file intact', () => {
    const spec = codexSpec();
    const root = supersetDocument();
    reconcileDocument(root, spec, spec.desired);
    expect(reconcileDocument(root, spec, null)).toBe('ok');
    expect(root).toEqual(supersetDocument());
    expect(isSemanticallyEmpty(root, spec)).toBe(false);
  });
});
