import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type Config, getDefaultConfig, type SupportedAgentId } from '@orcaops/storage';

import {
  canonicalSessionHookCommand,
  configSelectsProjectHook,
  documentCoversSessionHook,
  documentHasManagedSessionHook,
  hasMachineSessionHookSurface,
  isSemanticallyEmpty,
  type JsonObject,
  machineSessionHookRequired,
  machineSessionHookRequiredAgents,
  reconcileDocument,
  sessionHookMatcherCoverage,
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

function configWith(overrides: {
  scope?: Config['install']['scope'];
  agents?: SupportedAgentId[];
  enabled?: boolean;
  entries?: Config['session_hooks']['entries'];
}): Config {
  const config = getDefaultConfig();
  config.install.scope = overrides.scope ?? 'project';
  config.install.agents = overrides.agents ?? ['claude-code'];
  config.session_hooks.enabled = overrides.enabled ?? true;
  config.session_hooks.entries = overrides.entries ?? 'project';
  return config;
}

describe('machine session-hook requirement policy', () => {
  it('selects a project hook only under project scope with entries enabled', () => {
    expect(configSelectsProjectHook(configWith({}), 'claude-code')).toBe(true);
    expect(configSelectsProjectHook(configWith({ entries: 'none' }), 'claude-code')).toBe(false);
    expect(configSelectsProjectHook(configWith({ scope: 'global' }), 'claude-code')).toBe(false);
    expect(configSelectsProjectHook(configWith({ scope: 'personal' }), 'claude-code')).toBe(false);
    expect(configSelectsProjectHook(configWith({ enabled: false }), 'claude-code')).toBe(false);
  });

  it('never selects a project hook for a machine-config agent', () => {
    expect(configSelectsProjectHook(configWith({ agents: ['codex'] }), 'codex')).toBe(false);
  });

  it('knows which agents carry a machine surface', () => {
    expect(hasMachineSessionHookSurface('claude-code')).toBe(true);
    expect(hasMachineSessionHookSurface('codex')).toBe(true);
    // Cursor's hooks.json is a project file; it declares no machine surface.
    expect(hasMachineSessionHookSurface('cursor')).toBe(false);
  });

  it('requires machine coverage for codex under project scope while claude-code uses its project hook', () => {
    const config = configWith({ agents: ['claude-code', 'codex'] });
    expect(machineSessionHookRequired(config, 'claude-code')).toBe(false);
    expect(machineSessionHookRequired(config, 'codex')).toBe(true);
    expect(machineSessionHookRequiredAgents(config)).toEqual(['codex']);
  });

  it('requires machine coverage for every machine-capable agent when project entries are disabled', () => {
    const config = configWith({ agents: ['claude-code', 'codex'], entries: 'none' });
    expect(machineSessionHookRequiredAgents(config)).toEqual(['claude-code', 'codex']);
  });

  it('requires machine coverage under personal and global scope', () => {
    for (const scope of ['personal', 'global'] as const) {
      const config = configWith({ agents: ['claude-code', 'codex'], scope });
      expect(machineSessionHookRequiredAgents(config)).toEqual(['claude-code', 'codex']);
    }
  });

  it('requires nothing when hooks are disabled, the install set is empty, or the agent has no machine surface', () => {
    expect(machineSessionHookRequiredAgents(configWith({ enabled: false }))).toEqual([]);
    expect(machineSessionHookRequiredAgents(configWith({ agents: [] }))).toEqual([]);
    expect(
      machineSessionHookRequiredAgents(configWith({ agents: ['cursor'], entries: 'none' }))
    ).toEqual([]);
  });

  it('does not require machine coverage for an agent outside the install set', () => {
    const config = configWith({ agents: ['claude-code'], entries: 'none' });
    expect(machineSessionHookRequired(config, 'codex')).toBe(false);
  });
});

describe('session-hook coverage validation', () => {
  const claudeSpec = (): SettingsSpec => {
    const spec = userJsonSpecs().find((s) => s.agent === 'claude-code');
    if (!spec) throw new Error('claude-code user spec missing');
    return spec;
  };

  const groupedDocument = (group: JsonObject): JsonObject => ({
    hooks: { SessionStart: [group] },
  });

  const canonicalGroup = (overrides: { matcher?: unknown; type?: unknown } = {}): JsonObject => {
    const spec = claudeSpec();
    const hook: JsonObject = {
      type: 'type' in overrides ? overrides.type : 'command',
      command: specCommand(spec),
    };
    if (hook.type === undefined) delete hook.type;
    const group: JsonObject = { hooks: [hook] };
    const matcher = 'matcher' in overrides ? overrides.matcher : spec.desired.matcher;
    if (matcher !== undefined) group.matcher = matcher;
    return group;
  };

  it('verifies the canonical registration each spec installs', () => {
    for (const spec of [...settingsSpecs(), ...userJsonSpecs()]) {
      const document =
        spec.schema === 'flat'
          ? { hooks: { [spec.eventKey]: [spec.desired] } }
          : { hooks: { [spec.eventKey]: [spec.desired] } };
      expect(
        documentCoversSessionHook(document as JsonObject, spec),
        `${spec.agent} must pass its own validator`
      ).toBe('covered');
    }
  });

  it('rejects a canonical command carrying a non-command hook type', () => {
    expect(
      documentCoversSessionHook(groupedDocument(canonicalGroup({ type: 'prompt' })), claudeSpec())
    ).toBe('uncovered');
  });

  it('rejects a canonical command with no hook type at all', () => {
    // `type` is required by the schema, so an entry without one does not run.
    // Ownership still claims it, which is what keeps uninstall able to strip it.
    const document = groupedDocument(canonicalGroup({ type: undefined }));
    expect(documentCoversSessionHook(document, claudeSpec())).toBe('uncovered');
    expect(documentHasManagedSessionHook(document, claudeSpec())).toBe(true);
  });

  it('rejects a matcher that cannot fire for the canonical alternatives', () => {
    expect(
      documentCoversSessionHook(
        groupedDocument(canonicalGroup({ matcher: 'never-match-a-session' })),
        claudeSpec()
      )
    ).toBe('uncovered');
  });

  it('rejects a literal alternation missing one canonical alternative', () => {
    // claude-code's canonical matcher is startup|resume|clear.
    expect(
      documentCoversSessionHook(
        groupedDocument(canonicalGroup({ matcher: 'startup|resume' })),
        claudeSpec()
      )
    ).toBe('uncovered');
  });

  it('accepts a literal alternation broader than the canonical matcher', () => {
    expect(
      documentCoversSessionHook(
        groupedDocument(canonicalGroup({ matcher: 'startup|resume|clear|compact' })),
        claudeSpec()
      )
    ).toBe('covered');
  });

  it('leaves an unsupported matcher form unverifiable rather than covered', () => {
    for (const matcher of ['start.*', '(startup|resume)', 'startup|resume|', 42]) {
      expect(
        documentCoversSessionHook(groupedDocument(canonicalGroup({ matcher })), claudeSpec()),
        `matcher ${JSON.stringify(matcher)}`
      ).toBe('unverifiable');
    }
  });

  it('treats an omitted matcher as covering only where the agent declares that default', () => {
    const claude = claudeSpec();
    expect(claude.matcherDefaultCoversAll).toBe(true);
    expect(
      documentCoversSessionHook(groupedDocument(canonicalGroup({ matcher: undefined })), claude)
    ).toBe('covered');

    const codex = userJsonSpecs().find((s) => s.agent === 'codex');
    if (!codex) throw new Error('codex user spec missing');
    expect(codex.matcherDefaultCoversAll).toBeUndefined();
    const codexHook = { type: 'command', command: specCommand(codex) };
    expect(
      documentCoversSessionHook({ hooks: { SessionStart: [{ hooks: [codexHook] }] } }, codex)
    ).toBe('unverifiable');
  });

  it('does not count command text outside the expected event or structure', () => {
    const spec = claudeSpec();
    const command = specCommand(spec);
    const cases: JsonObject[] = [
      // Wrong event.
      { hooks: { SessionEnd: [canonicalGroup()] } },
      // Unrelated field carrying the command text.
      { description: command, hooks: { SessionStart: [] } },
      // Group without a hooks array.
      { hooks: { SessionStart: [{ matcher: spec.desired.matcher, command }] } },
      // Event value that is not an array.
      { hooks: { SessionStart: { matcher: spec.desired.matcher } } },
      // No hooks object at all.
      { version: 1 },
    ];
    for (const document of cases) {
      expect(documentCoversSessionHook(document, spec), JSON.stringify(document)).toBe('uncovered');
    }
  });

  it('is covered when one valid entry sits beside an invalid one', () => {
    const spec = claudeSpec();
    const document = {
      hooks: {
        SessionStart: [canonicalGroup({ type: 'prompt' }), canonicalGroup()],
      },
    };
    expect(documentCoversSessionHook(document as JsonObject, spec)).toBe('covered');
  });

  it('keeps ownership broader than coverage', () => {
    const spec = claudeSpec();
    // The same entry the coverage validator rejects is still ours to reconcile
    // and remove — tightening isOrcaopsHook would orphan it on uninstall.
    const document = groupedDocument(canonicalGroup({ type: 'prompt' }));
    expect(documentCoversSessionHook(document, spec)).toBe('uncovered');
    expect(documentHasManagedSessionHook(document, spec)).toBe(true);
  });

  // The same matrix against every JSON surface we register into, rather than
  // claude-code standing in for all of them: codex's hooks.json carries a
  // different canonical matcher and its own command.
  it('applies one matcher and type rule to every JSON surface', () => {
    for (const spec of userJsonSpecs()) {
      const canonical = spec.desired.matcher as string | undefined;
      if (canonical === undefined) continue;
      const command = specCommand(spec);
      const build = (matcher: unknown, type: unknown): JsonObject => {
        const hook: JsonObject = { command };
        if (type !== undefined) hook.type = type;
        const group: JsonObject = { hooks: [hook] };
        if (matcher !== undefined) group.matcher = matcher;
        return { hooks: { [spec.eventKey]: [group] } };
      };
      const label = `${spec.agent} (${canonical})`;

      expect(
        documentCoversSessionHook(build(canonical, 'command'), spec),
        `${label} canonical`
      ).toBe('covered');
      expect(
        documentCoversSessionHook(build(`${canonical}|extra-source`, 'command'), spec),
        `${label} superset`
      ).toBe('covered');
      expect(
        documentCoversSessionHook(build(canonical.split('|')[0], 'command'), spec),
        `${label} missing an alternative`
      ).toBe('uncovered');
      expect(
        documentCoversSessionHook(build(canonical, 'prompt'), spec),
        `${label} wrong type`
      ).toBe('uncovered');
      expect(documentCoversSessionHook(build(canonical, undefined), spec), `${label} no type`).toBe(
        'uncovered'
      );
      expect(
        documentCoversSessionHook(build('start.*', 'command'), spec),
        `${label} unsupported matcher`
      ).toBe('unverifiable');
    }
  });

  it('matches matcher breadth independently of any document', () => {
    expect(sessionHookMatcherCoverage('startup|resume', 'startup|resume')).toBe('covered');
    expect(sessionHookMatcherCoverage('resume|startup', 'startup|resume')).toBe('covered');
    expect(sessionHookMatcherCoverage('startup', 'startup|resume')).toBe('uncovered');
    expect(sessionHookMatcherCoverage('startup|*', 'startup|resume')).toBe('unverifiable');
    expect(sessionHookMatcherCoverage(undefined, undefined)).toBe('covered');
    expect(sessionHookMatcherCoverage(undefined, 'startup')).toBe('unverifiable');
    expect(sessionHookMatcherCoverage(undefined, 'startup', { defaultCoversAll: true })).toBe(
      'covered'
    );
  });
});

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
