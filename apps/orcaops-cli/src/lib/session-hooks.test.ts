import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalSessionHookCommand,
  reconcileDocument,
  type SettingsSpec,
  settingsSpecs,
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
