import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInInvocationContext } from './invocation-context.js';
import {
  CODEX_HOOKS_JSON_MIN_VERSION,
  CODEX_TOML_MARKER_END,
  CODEX_TOML_MARKER_START,
  type CodexRepresentation,
  type CodexRepresentationSurface,
  codexTomlSnippet,
  type CodexTrustEditKeys,
  codexTrustKey,
  codexTrustShiftFor,
  type CodexVersionProbe,
  evaluateUserSessionHookSurfaces,
  planCodexTomlInstall,
  planCodexTomlRemoval,
  planCodexTrustEdit,
  resolveCodexRepresentation,
  userSettingsSpec,
} from './session-hooks-user.js';
import { canonicalSessionHookCommand, reconcileDocument } from './session-hooks.js';

const command = canonicalSessionHookCommand('codex', { user: true });
const fence = (inner: string): string =>
  `${CODEX_TOML_MARKER_START}\n${inner}\n${CODEX_TOML_MARKER_END}\n`;
const block = fence(codexTomlSnippet());
const ourElement = { matcher: 'startup|resume', hooks: [{ type: 'command', command }] };

describe('codex config.toml install planner', () => {
  it('writes the bare block into an absent or blank file', () => {
    for (const raw of [null, '', '  \n\n']) {
      expect(planCodexTomlInstall(raw)).toEqual({ outcome: 'written', next: block });
    }
    expect(block).not.toContain('[features]');
  });

  it('appends after existing content, separated by one blank line', () => {
    const raw = '[features]\nshell_snapshots = true\n';
    expect(planCodexTomlInstall(raw)).toEqual({ outcome: 'written', next: `${raw}\n${block}` });
    expect(planCodexTomlInstall('title = "mine"')).toEqual({
      outcome: 'written',
      next: `title = "mine"\n${block}`,
    });
  });

  it('is unchanged once the command is registered anywhere, whatever the fence holds', () => {
    const registered = [
      `${codexTomlSnippet()}\n`,
      `[features]\nhooks = true\n\n${codexTomlSnippet()}\n`,
      block,
      fence(
        `${codexTomlSnippet()}\n\n[hooks.state]\n\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "h"\nenabled = true`
      ),
      fence(`[features]\nhooks = true\nshell_snapshots = true\n\n${codexTomlSnippet()}`),
      `${codexTomlSnippet()}\n\n${block}`,
      `[hooks]\nSessionStart = [{ matcher = "startup|resume", hooks = [{ type = "command", command = "${command}" }] }]\n`,
    ];
    for (const raw of registered)
      expect(planCodexTomlInstall(raw)).toEqual({ outcome: 'unchanged' });
  });

  it('does not count a commented-out or non-canonical command as registered', () => {
    const commented = `${codexTomlSnippet()
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n')}\n`;
    expect(planCodexTomlInstall(commented)).toMatchObject({ outcome: 'written' });
    const bare = codexTomlSnippet().replace(
      command,
      'orcaops hook session-start --agent codex --user'
    );
    expect(planCodexTomlInstall(`${bare}\n`)).toMatchObject({ outcome: 'written' });
  });

  it('refuses invalid TOML outside the block, even when the block itself is fine', () => {
    expect(planCodexTomlInstall('features = {\n')).toEqual({ outcome: 'refused-invalid' });
    expect(planCodexTomlInstall(`broken = [\n${block}`)).toEqual({ outcome: 'refused-invalid' });
  });

  it('refuses a hooks shape the array-of-tables append cannot join', () => {
    for (const raw of ['hooks = []\n', 'hooks = 1\n', '[hooks]\nSessionStart = []\n']) {
      expect(planCodexTomlInstall(raw)).toEqual({ outcome: 'refused-hooks-shape' });
    }
  });

  it('appends beside a user SessionStart group and a hooks table with other keys', () => {
    const user =
      '[[hooks.SessionStart]]\nmatcher = "startup"\nhooks = [{ type = "command", command = "echo hi" }]\n';
    const plan = planCodexTomlInstall(user);
    expect(plan.outcome).toBe('written');
    if (plan.outcome !== 'written') return;
    expect(parseToml(plan.next)).toEqual({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] },
          ourElement,
        ],
      },
    });

    const table = planCodexTomlInstall('[hooks]\nfoo = 1\n');
    expect(table.outcome).toBe('written');
    if (table.outcome !== 'written') return;
    expect(parseToml(table.next)).toEqual({ hooks: { foo: 1, SessionStart: [ourElement] } });
  });

  it('matches the line endings of the file it appends to', () => {
    const raw = 'title = "mine"\r\n';
    const plan = planCodexTomlInstall(raw);
    expect(plan.outcome).toBe('written');
    if (plan.outcome !== 'written') return;
    expect(plan.next.startsWith(raw)).toBe(true);
    expect(plan.next.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parseToml(plan.next)).toEqual({ title: 'mine', hooks: { SessionStart: [ourElement] } });
  });

  it('repairs a stale or gutted fence around whatever Codex left inside it', () => {
    const trust =
      '[hooks.state]\n\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "h"\nenabled = true';
    const stale = fence(
      `${codexTomlSnippet().replace(command, 'orcaops hook session-start --agent codex --user')}\n\n${trust}`
    );
    const repaired = planCodexTomlInstall(stale);
    expect(repaired.outcome).toBe('written');
    if (repaired.outcome !== 'written') return;
    expect(parseToml(repaired.next)).toEqual({
      hooks: {
        state: { 'x:session_start:0:0': { trusted_hash: 'h', enabled: true } },
        SessionStart: [ourElement],
      },
    });

    const gutted = `note = 1\n\n${fence('[[hooks.SessionStart]]\nmatcher = "startup|resume"')}`;
    expect(planCodexTomlInstall(gutted)).toEqual({
      outcome: 'written',
      next: `note = 1\n\n${block}`,
    });
  });

  it('refuses to repair a fence holding lines it cannot prove are its own', () => {
    const stale = codexTomlSnippet().replace(
      command,
      'orcaops hook session-start --agent codex --user'
    );
    const foreign = fence(
      `${stale}\n\n[[hooks.SessionStart]]\nmatcher = "resume"\nhooks = [{ type = "command", command = "echo mine" }]`
    );
    expect(planCodexTomlInstall(foreign)).toEqual({ outcome: 'refused-fence' });
  });

  it('refuses malformed marker layouts before reading anything else', () => {
    expect(planCodexTomlInstall(`${CODEX_TOML_MARKER_END}\n${CODEX_TOML_MARKER_START}\n`)).toEqual({
      outcome: 'refused-markers',
    });
  });
});

describe('codex config.toml removal planner', () => {
  it('restores the original bytes when the block is the only thing that changed', () => {
    for (const existing of ['', 'title = "mine"\n\n\n\n[unrelated]\nvalue = true\n', 'a = 1\r\n']) {
      const plan = planCodexTomlInstall(existing);
      if (plan.outcome !== 'written') throw new Error(plan.outcome);
      expect(planCodexTomlRemoval(plan.next)).toEqual({
        outcome: 'removed',
        next: existing.trim() === '' ? '' : existing,
      });
    }
  });

  it('keeps a comment written inside the block', () => {
    const raw = `title = "mine"\n\n${fence(`# KEEP ME\n${codexTomlSnippet()}`)}`;
    expect(planCodexTomlRemoval(raw)).toEqual({
      outcome: 'removed',
      next: 'title = "mine"\n\n# KEEP ME\n',
    });

    const trailing = fence(`${codexTomlSnippet()}\n# KEEP ME`);
    expect(planCodexTomlRemoval(trailing)).toEqual({ outcome: 'removed', next: '# KEEP ME\n' });
  });

  it('keeps CRLF line endings when the block sits before another table', () => {
    const crlfFence = fence(codexTomlSnippet()).replace(/\n/g, '\r\n');
    const raw = `title = "mine"\r\n\r\n${crlfFence}\r\n[other]\r\nvalue = 1\r\n`;
    const plan = planCodexTomlRemoval(raw);
    expect(plan).toEqual({
      outcome: 'removed',
      next: 'title = "mine"\r\n\r\n[other]\r\nvalue = 1\r\n',
    });
    if (plan.outcome !== 'removed') return;
    expect(plan.next.replace(/\r\n/g, '')).not.toContain('\n');

    const commented = `title = "mine"\r\n\r\n${fence(`# KEEP ME\n${codexTomlSnippet()}`).replace(/\n/g, '\r\n')}`;
    expect(planCodexTomlRemoval(commented)).toEqual({
      outcome: 'removed',
      next: 'title = "mine"\r\n\r\n# KEEP ME\r\n',
    });
  });

  it('treats a variant of its own command inside the block as its own', () => {
    const variant = `title = "mine"\n\n${fence(
      `[[hooks.SessionStart]]\nmatcher = "startup|resume"\nhooks = [{ type = "command", command = "${command} --verbose" }]`
    )}`;
    expect(planCodexTomlInstall(variant).outcome).toBe('written');
    expect(planCodexTomlRemoval(variant)).toEqual({ outcome: 'removed', next: 'title = "mine"\n' });
  });

  it('removes a legacy block together with its own [features] pair', () => {
    const legacy = `title = "mine"\n\n${fence(`[features]\nhooks = true\n\n${codexTomlSnippet()}`)}`;
    expect(planCodexTomlRemoval(legacy)).toEqual({ outcome: 'removed', next: 'title = "mine"\n' });
  });

  it('keeps Codex trust tables that were written inside the fence', () => {
    const trust =
      '[hooks.state]\n\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "h"\nenabled = true';
    const raw = `[features]\nshell_snapshots = true\n\n${fence(`${codexTomlSnippet()}\n\n${trust}`)}`;
    const plan = planCodexTomlRemoval(raw);
    expect(plan.outcome).toBe('removed');
    if (plan.outcome !== 'removed') return;
    expect(plan.next).not.toContain(CODEX_TOML_MARKER_START);
    expect(plan.next).not.toContain(CODEX_TOML_MARKER_END);
    expect(parseToml(plan.next)).toEqual({
      features: { shell_snapshots: true },
      hooks: { state: { 'x:session_start:0:0': { trusted_hash: 'h', enabled: true } } },
    });
  });

  it('keeps a toggle Codex appended under a legacy [features] header', () => {
    const raw = fence(`[features]\nhooks = true\nshell_snapshots = true\n\n${codexTomlSnippet()}`);
    const plan = planCodexTomlRemoval(raw);
    expect(plan.outcome).toBe('removed');
    if (plan.outcome !== 'removed') return;
    expect(parseToml(plan.next)).toEqual({ features: { shell_snapshots: true } });

    const off = fence(`[features]\nhooks = false\n\n${codexTomlSnippet()}`);
    const kept = planCodexTomlRemoval(off);
    expect(kept.outcome).toBe('removed');
    if (kept.outcome !== 'removed') return;
    expect(parseToml(kept.next)).toEqual({ features: { hooks: false } });
  });

  it('removes only the fenced copy when a manual paste sits beside it', () => {
    const paste = `${codexTomlSnippet()}\n`;
    expect(planCodexTomlRemoval(`${paste}\n${block}`)).toEqual({ outcome: 'removed', next: paste });
    expect(planCodexTomlRemoval(paste)).toEqual({ outcome: 'manual-content' });
  });

  it('never removes a user element that shares the fence', () => {
    const shared = fence(
      `${codexTomlSnippet()}\n\n[[hooks.SessionStart]]\nmatcher = "resume"\nhooks = [{ type = "command", command = "echo mine" }]`
    );
    expect(planCodexTomlRemoval(shared)).toEqual({ outcome: 'refused-fence' });
  });

  it('reports invalid TOML outside the block and absent registrations', () => {
    expect(planCodexTomlRemoval(`broken = [\n${block}`)).toEqual({ outcome: 'refused-invalid' });
    expect(planCodexTomlRemoval('title = "mine"\n')).toEqual({ outcome: 'absent' });
    expect(
      planCodexTomlRemoval(`${CODEX_TOML_MARKER_START}\n${CODEX_TOML_MARKER_START}\n`)
    ).toEqual({
      outcome: 'refused-markers',
    });
  });
});

describe('codex representation resolver', () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-representation-'));
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  const reports =
    (version: string): CodexVersionProbe =>
    async () =>
      `codex-cli ${version}\n`;
  const supported = reports('0.147.0');

  const resolve = (
    probe: CodexVersionProbe,
    override?: CodexRepresentationSurface
  ): Promise<CodexRepresentation> =>
    runInInvocationContext({ env: { ...process.env, CODEX_HOME: codexHome } }, () =>
      resolveCodexRepresentation(override, probe)
    );

  const writeHooksJson = (content: string): Promise<void> =>
    writeFile(path.join(codexHome, 'hooks.json'), content, 'utf8');
  const writeConfigToml = (content: string): Promise<void> =>
    writeFile(path.join(codexHome, 'config.toml'), content, 'utf8');

  it('reports both codex paths under the invocation CODEX_HOME', async () => {
    expect(await resolve(supported)).toMatchObject({
      hooksJsonPath: path.join(codexHome, 'hooks.json'),
      tomlPath: path.join(codexHome, 'config.toml'),
    });
  });

  it('creates hooks.json when neither file claims the layer', async () => {
    expect(await resolve(supported)).toMatchObject({
      surface: 'hooks-json',
      reason: 'default',
      versionGate: 'supported',
    });
  });

  it('joins a hooks.json that holds a JSON object', async () => {
    await writeHooksJson('{"hooks":{"SessionStart":[]}}\n');
    expect(await resolve(supported)).toMatchObject({
      surface: 'hooks-json',
      reason: 'existing-hooks-json',
    });
  });

  it('does not join a hooks.json that is a directory, invalid, or not an object', async () => {
    await mkdir(path.join(codexHome, 'hooks.json'));
    expect(await resolve(supported)).toMatchObject({ surface: 'hooks-json', reason: 'default' });
    await rm(path.join(codexHome, 'hooks.json'), { recursive: true });

    for (const content of ['{ not json', '[]\n', '"text"\n']) {
      await writeHooksJson(content);
      expect(await resolve(supported)).toMatchObject({ surface: 'hooks-json', reason: 'default' });
    }
  });

  it('stays in config.toml when it carries hooks that are not ours', async () => {
    await writeConfigToml(
      '[[hooks.SessionStart]]\nmatcher = "startup"\nhooks = [{ type = "command", command = "echo hi" }]\n'
    );
    expect(await resolve(supported)).toMatchObject({
      surface: 'config-toml',
      reason: 'existing-toml-hooks',
    });
  });

  it('leaves config.toml for hooks.json when the only registration there is ours', async () => {
    await writeConfigToml(
      `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`
    );
    expect(await resolve(supported)).toMatchObject({ surface: 'hooks-json', reason: 'default' });
  });

  it('ignores the trust tables Codex writes into config.toml', async () => {
    await writeConfigToml(
      '[hooks.state."/x/config.toml:session_start:0:0"]\ntrusted_hash = "sha256:a"\n'
    );
    expect(await resolve(supported)).toMatchObject({ surface: 'hooks-json', reason: 'default' });
  });

  it('stays in a config.toml it cannot parse', async () => {
    await writeConfigToml('broken = [\n');
    expect(await resolve(supported)).toMatchObject({
      surface: 'config-toml',
      reason: 'toml-unreadable',
    });
  });

  it('stays in config.toml below the measured hooks.json floor', async () => {
    expect(await resolve(reports('0.145.9'))).toMatchObject({
      surface: 'config-toml',
      reason: 'version-unsupported',
      versionGate: 'unsupported',
    });
    expect(await resolve(reports(CODEX_HOOKS_JSON_MIN_VERSION))).toMatchObject({
      surface: 'hooks-json',
      versionGate: 'supported',
    });
  });

  it('stays in config.toml when the version cannot be read at all', async () => {
    const unreadable: CodexVersionProbe[] = [
      async () => null,
      async () => 'codex 0.147.0\n',
      async () => '',
      () => Promise.reject(new Error('spawn ENOENT')),
    ];
    for (const probe of unreadable) {
      expect(await resolve(probe)).toMatchObject({
        surface: 'config-toml',
        reason: 'version-unknown',
        versionGate: 'unknown',
      });
    }
  });

  it('an override answers directly and still reports the version gate', async () => {
    await writeHooksJson('{}\n');
    expect(await resolve(supported, 'config-toml')).toMatchObject({
      surface: 'config-toml',
      reason: 'override',
      versionGate: 'supported',
    });
    expect(await resolve(reports('0.120.0'), 'hooks-json')).toMatchObject({
      surface: 'hooks-json',
      reason: 'override',
      versionGate: 'unsupported',
    });
  });
});

describe('codex trust key', () => {
  const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
  const ours = { matcher: 'startup|resume', hooks: [{ type: 'command', command }] };

  it('reads the group and hook index our command actually sits at', () => {
    expect(codexTrustKey({ hooks: { SessionStart: [ours] } }, '/h/hooks.json')).toBe(
      '/h/hooks.json:session_start:0:0'
    );
    expect(codexTrustKey({ hooks: { SessionStart: [other, other, ours] } }, '/h/hooks.json')).toBe(
      '/h/hooks.json:session_start:2:0'
    );
    expect(
      codexTrustKey(
        { hooks: { SessionStart: [{ hooks: [other.hooks[0], ours.hooks[0]] }] } },
        '/h/hooks.json'
      )
    ).toBe('/h/hooks.json:session_start:0:1');
  });

  it('reads a parsed config.toml the same way as a hooks.json document', () => {
    const parsed = parseToml(`${codexTomlSnippet()}\n`);
    expect(codexTrustKey(parsed, '/h/config.toml')).toBe('/h/config.toml:session_start:0:0');
  });

  it('is null when our command is not registered', () => {
    expect(codexTrustKey({ hooks: { SessionStart: [other] } }, '/h/hooks.json')).toBeNull();
    expect(codexTrustKey({ hooks: {} }, '/h/hooks.json')).toBeNull();
    expect(codexTrustKey('not a document', '/h/hooks.json')).toBeNull();
  });
});

describe('codex trust carry planner', () => {
  const fromKey = '/h/config.toml:session_start:0:0';
  const toKey = '/h/hooks.json:session_start:0:0';
  const hash = 'sha256:9f2c';
  const carryOnly = { carry: { fromKey, toKey }, shift: null };
  const trust = (key: string, value: string): string =>
    `[hooks.state."${key}"]\ntrusted_hash = "${value}"\nenabled = true\n`;
  const appended = (key: string, value: string): string =>
    `\n[hooks.state."${key}"]\ntrusted_hash = "${value}"\n`;

  it('copies the hash and leaves every other byte where it was', () => {
    const raw = `title = "mine"\n\n${codexTomlSnippet()}\n\n${trust(fromKey, hash)}`;
    const plan = planCodexTrustEdit(raw, carryOnly);
    expect(plan).toMatchObject({ carry: 'present', moved: 0, skipped: [] });
    expect(plan.next?.startsWith(raw)).toBe(true);
    expect(plan.next?.slice(raw.length)).toBe(appended(toKey, hash));
    expect(parseToml(plan.next ?? '')).toEqual({
      ...parseToml(raw),
      hooks: {
        ...(parseToml(raw).hooks as object),
        state: {
          [fromKey]: { trusted_hash: hash, enabled: true },
          [toKey]: { trusted_hash: hash },
        },
      },
    });
  });

  it('appends after a trailing orcaops marker rather than inside the fence', () => {
    const raw = `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n\n${trust(fromKey, hash)}`;
    const plan = planCodexTrustEdit(raw, carryOnly);
    expect(plan.carry).toBe('present');
    const next = plan.next ?? '';
    expect(next.indexOf(toKey)).toBeGreaterThan(next.indexOf(CODEX_TOML_MARKER_END));
    expect(planCodexTomlRemoval(next).outcome).toBe('removed');
  });

  it('invents nothing when our key carries no usable hash', () => {
    for (const raw of [
      'title = "mine"\n',
      trust('/h/config.toml:session_start:3:0', hash),
      `[hooks.state."${fromKey}"]\ntrusted_hash = ""\n`,
      `[hooks.state."${fromKey}"]\nenabled = true\n`,
      'broken = [\n',
    ]) {
      expect(planCodexTrustEdit(raw, carryOnly)).toEqual({
        carry: 'absent',
        moved: 0,
        skipped: [],
        next: null,
      });
    }
  });

  it('is unchanged once the target key carries the same hash', () => {
    const raw = `${trust(fromKey, hash)}\n${trust(toKey, hash)}`;
    expect(planCodexTrustEdit(raw, carryOnly)).toEqual({
      carry: 'unchanged',
      moved: 0,
      skipped: [],
      next: null,
    });
  });

  it('refuses when the append would change anything else in the document', () => {
    const raw = `${trust(fromKey, hash)}\n${trust(toKey, 'sha256:stale')}`;
    expect(planCodexTrustEdit(raw, carryOnly)).toEqual({
      carry: 'refused',
      moved: 0,
      skipped: [],
      next: null,
    });
  });

  it('matches the line endings of the file it appends to', () => {
    const raw = `title = "mine"\r\n\r\n${trust(fromKey, hash).replace(/\n/g, '\r\n')}`;
    const plan = planCodexTrustEdit(raw, carryOnly);
    expect(plan.carry).toBe('present');
    expect(plan.next?.slice(raw.length)).toBe(appended(toKey, hash).replace(/\n/g, '\r\n'));
  });
});

describe('codex trust re-key across a reconciled hooks.json', () => {
  const hooksJson = '/h/hooks.json';
  const configToml = '/h/config.toml';
  const ourHash = 'sha256:ours';
  const fromKey = `${configToml}:session_start:0:0`;
  const groupKey = (group: number, hook = 0): string =>
    `${hooksJson}:session_start:${group}:${hook}`;
  const foreignGroup = (name: string): unknown => ({
    hooks: [{ type: 'command', command: name }],
  });
  // Our canonical group under the matcher a previous release wrote: the same
  // command, but a different hook definition, so the reconcile drops it.
  const staleOurs = { matcher: 'startup', hooks: [{ type: 'command', command }] };
  const shiftFor = (before: unknown[], after: unknown[]): CodexTrustEditKeys => ({
    carry: { fromKey, toKey: groupKey(0) },
    shift: codexTrustShiftFor(hooksJson, { before, after }),
  });
  const prependAhead = (count: number): CodexTrustEditKeys => {
    const before = Array.from({ length: count }, (_, i) => foreignGroup(`tool ${i}`));
    return shiftFor(before, [ourElement, ...before]);
  };
  const keys = prependAhead(1);
  const table = (key: string, body: string): string => `[hooks.state."${key}"]\n${body}\n`;
  const ourApproval = table(fromKey, `trusted_hash = "${ourHash}"`);
  const stateOf = (plan: { next: string | null }): Record<string, unknown> =>
    (parseToml(plan.next ?? '') as { hooks: { state: Record<string, unknown> } }).hooks.state;
  const ourHook = ourElement.hooks[0];
  const supersetHook = { type: 'command', command: 'superset notify' };
  // Drive the real reconcile, so the before/after arrays are the ones the
  // installer produces rather than a hand-built guess at them.
  const reconciled = (before: unknown[]): { after: unknown[]; keys: CodexTrustEditKeys } => {
    const spec = userSettingsSpec('codex', hooksJson);
    if (spec === null) throw new Error('codex has no user hooks.json spec');
    const root: Record<string, unknown> = { hooks: { SessionStart: structuredClone(before) } };
    expect(reconcileDocument(root, spec, spec.desired)).toBe('ok');
    const after = (root.hooks as { SessionStart: unknown[] }).SessionStart;
    return {
      after,
      keys: {
        carry: { fromKey, toKey: codexTrustKey(root, hooksJson) ?? '' },
        shift: codexTrustShiftFor(hooksJson, { before, after }),
      },
    };
  };

  it('moves the approval our entry displaced and lands ours on the freed key', () => {
    const raw =
      `model = "gpt-5"\n\n${ourApproval}\n` +
      table(groupKey(0), `trusted_hash = "sha256:theirs"\nenabled = true`);
    const plan = planCodexTrustEdit(raw, keys);
    expect(plan).toMatchObject({ carry: 'present', moved: 1, skipped: [] });
    expect(parseToml(plan.next ?? '')).toEqual({
      ...parseToml(raw),
      hooks: {
        state: {
          [fromKey]: { trusted_hash: ourHash },
          [groupKey(1)]: { trusted_hash: 'sha256:theirs', enabled: true },
          [groupKey(0)]: { trusted_hash: ourHash },
        },
      },
    });
    expect(plan.next).toContain('model = "gpt-5"');
  });

  it('shifts every trusted group the insertion pushed down', () => {
    const raw =
      ourApproval +
      table(groupKey(0), 'trusted_hash = "sha256:a"') +
      table(groupKey(1), 'trusted_hash = "sha256:b"');
    const plan = planCodexTrustEdit(raw, prependAhead(2));
    expect(plan).toMatchObject({ carry: 'present', moved: 2, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(0)]: { trusted_hash: ourHash },
      [groupKey(1)]: { trusted_hash: 'sha256:a' },
      [groupKey(2)]: { trusted_hash: 'sha256:b' },
    });
  });

  it('leaves approvals for another event or another source file where they are', () => {
    const otherEvent = `${hooksJson}:session_end:0:0`;
    const otherFile = '/other/hooks.json:session_start:0:0';
    const raw =
      ourApproval +
      table(otherEvent, 'trusted_hash = "sha256:end"') +
      table(otherFile, 'trusted_hash = "sha256:elsewhere"');
    const plan = planCodexTrustEdit(raw, keys);
    expect(plan).toMatchObject({ carry: 'present', moved: 0, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [otherEvent]: { trusted_hash: 'sha256:end' },
      [otherFile]: { trusted_hash: 'sha256:elsewhere' },
      [groupKey(0)]: { trusted_hash: ourHash },
    });
  });

  it('carries only ours when no other hook in the file was ever approved', () => {
    const plan = planCodexTrustEdit(ourApproval, keys);
    expect(plan).toMatchObject({ carry: 'present', moved: 0, skipped: [] });
    expect(plan.next?.startsWith(ourApproval)).toBe(true);
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(0)]: { trusted_hash: ourHash },
    });
  });

  it('skips a move onto a key another approval still holds, and the moves waiting on it', () => {
    // An approval written as an inline entry has no table to relocate, so it
    // stays where it is and blocks the move onto its key.
    const raw =
      `[hooks.state]\n"${groupKey(1)}" = { trusted_hash = "sha256:pinned" }\n\n` +
      ourApproval +
      table(groupKey(0), 'trusted_hash = "sha256:a"') +
      table(groupKey(2), 'trusted_hash = "sha256:c"');
    const plan = planCodexTrustEdit(raw, prependAhead(3));
    expect(plan).toMatchObject({
      carry: 'refused',
      moved: 1,
      skipped: [groupKey(0), groupKey(1)],
    });
    expect(stateOf(plan)).toEqual({
      [groupKey(1)]: { trusted_hash: 'sha256:pinned' },
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(0)]: { trusted_hash: 'sha256:a' },
      [groupKey(3)]: { trusted_hash: 'sha256:c' },
    });
  });

  it('writes nothing when the composed document would differ in any other way', () => {
    // A value whose continuation line opens with `[` reads as the next table,
    // so the cut cannot be proved and the whole edit is refused.
    const raw =
      ourApproval + table(groupKey(0), 'trusted_hash = "sha256:a"\nnotes = [\n  ["x"],\n]');
    expect(planCodexTrustEdit(raw, keys)).toEqual({
      carry: 'refused',
      moved: 0,
      skipped: [groupKey(0)],
      next: null,
    });
  });

  it('keeps a comment that heads the table after the one it moves', () => {
    const raw =
      ourApproval +
      table(groupKey(0), 'trusted_hash = "sha256:a"') +
      '\n# the model I use\n[model]\nname = "gpt-5"\n';
    const plan = planCodexTrustEdit(raw, keys);
    expect(plan).toMatchObject({ carry: 'present', moved: 1 });
    expect(plan.next).toContain('# the model I use\n[model]');
  });

  it('leaves a foreign group at the index a dropped stale entry of ours vacated', () => {
    const foreign = foreignGroup('superset notify');
    const dropped = shiftFor([staleOurs, foreign], [ourElement, foreign]);
    expect(dropped.shift?.moves).toEqual(new Map());
    expect(dropped.shift?.droppedGroups).toEqual(new Set([0]));
    const raw = ourApproval + table(groupKey(1), 'trusted_hash = "sha256:theirs"');
    const plan = planCodexTrustEdit(raw, dropped);
    expect(plan).toMatchObject({ carry: 'present', moved: 0, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(1)]: { trusted_hash: 'sha256:theirs' },
      [groupKey(0)]: { trusted_hash: ourHash },
    });
  });

  it('maps each survivor to its real new index when a drop and an insert both move groups', () => {
    const first = foreignGroup('a');
    const second = foreignGroup('b');
    const mixed = shiftFor([first, staleOurs, second], [ourElement, first, second]);
    expect(mixed.shift?.moves).toEqual(new Map([['0:0', { group: 1, hook: 0 }]]));
    const raw =
      ourApproval +
      table(groupKey(0), 'trusted_hash = "sha256:a"') +
      table(groupKey(2), 'trusted_hash = "sha256:b"');
    const plan = planCodexTrustEdit(raw, mixed);
    expect(plan).toMatchObject({ carry: 'present', moved: 1, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(1)]: { trusted_hash: 'sha256:a' },
      [groupKey(2)]: { trusted_hash: 'sha256:b' },
      [groupKey(0)]: { trusted_hash: ourHash },
    });
  });

  it('maps two identical foreign groups first to first', () => {
    const twin = foreignGroup('superset notify');
    const twins = shiftFor([twin, twin], [ourElement, twin, twin]);
    expect(twins.shift?.moves).toEqual(
      new Map([
        ['0:0', { group: 1, hook: 0 }],
        ['1:0', { group: 2, hook: 0 }],
      ])
    );
    const reordered = codexTrustShiftFor(hooksJson, {
      before: [twin, foreignGroup('other'), twin],
      after: [twin, twin],
    });
    expect(reordered?.moves).toEqual(new Map([['2:0', { group: 1, hook: 0 }]]));
  });

  it('retires the dead approval of a dropped group instead of blocking the move onto its key', () => {
    const foreign = foreignGroup('superset notify');
    const dropped = shiftFor([foreign, staleOurs], [ourElement, foreign]);
    expect(dropped.shift?.moves).toEqual(new Map([['0:0', { group: 1, hook: 0 }]]));
    expect(dropped.shift?.droppedGroups).toEqual(new Set([1]));
    const raw =
      ourApproval +
      table(groupKey(0), 'trusted_hash = "sha256:theirs"') +
      table(groupKey(1), 'trusted_hash = "sha256:stale-ours"');
    const plan = planCodexTrustEdit(raw, dropped);
    expect(plan).toMatchObject({ carry: 'present', moved: 1, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [fromKey]: { trusted_hash: ourHash },
      [groupKey(1)]: { trusted_hash: 'sha256:theirs' },
      [groupKey(0)]: { trusted_hash: ourHash },
    });
    expect(plan.next).not.toContain('sha256:stale-ours');
  });

  it('moves a survivor into the index a retired entry of ours vacated', () => {
    const first = foreignGroup('a');
    const second = foreignGroup('b');
    const mixed = shiftFor([first, staleOurs, second], [ourElement, first, second]);
    const raw =
      table(groupKey(0), 'trusted_hash = "sha256:a"') +
      table(groupKey(1), 'trusted_hash = "sha256:stale-ours"') +
      table(groupKey(2), 'trusted_hash = "sha256:b"');
    const plan = planCodexTrustEdit(raw, { ...mixed, carry: null });
    expect(plan).toMatchObject({ carry: 'absent', moved: 1, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [groupKey(1)]: { trusted_hash: 'sha256:a' },
      [groupKey(2)]: { trusted_hash: 'sha256:b' },
    });
  });

  it('keeps the approval of a foreign hook that shares a group with ours', () => {
    const { after, keys } = reconciled([{ hooks: [supersetHook, ourHook] }, foreignGroup('other')]);
    expect(after).toEqual([ourElement, { hooks: [supersetHook] }, foreignGroup('other')]);
    const raw =
      `model = "gpt-5"\n\n${ourApproval}` +
      table(groupKey(0), 'trusted_hash = "sha256:superset"') +
      table(groupKey(1), 'trusted_hash = "sha256:other"');
    const plan = planCodexTrustEdit(raw, keys);
    expect(plan).toMatchObject({ carry: 'present', moved: 2, skipped: [] });
    expect(parseToml(plan.next ?? '')).toEqual({
      model: 'gpt-5',
      hooks: {
        state: {
          [fromKey]: { trusted_hash: ourHash },
          [groupKey(1)]: { trusted_hash: 'sha256:superset' },
          [groupKey(2)]: { trusted_hash: 'sha256:other' },
          [groupKey(0)]: { trusted_hash: ourHash },
        },
      },
    });
  });

  it('shifts a foreign hook down inside its group when our entry sat ahead of it', () => {
    const { after, keys } = reconciled([ourElement, { hooks: [ourHook, supersetHook] }]);
    expect(after).toEqual([ourElement, { hooks: [supersetHook] }]);
    expect(keys.shift?.moves).toEqual(new Map([['1:1', { group: 1, hook: 0 }]]));
    const raw = table(groupKey(1, 1), 'trusted_hash = "sha256:superset"');
    const plan = planCodexTrustEdit(raw, { ...keys, carry: null });
    expect(plan).toMatchObject({ carry: 'absent', moved: 1, skipped: [] });
    expect(stateOf(plan)).toEqual({ [groupKey(1, 0)]: { trusted_hash: 'sha256:superset' } });
  });

  it('leaves a foreign hook keyed as it was when our entry sat behind it', () => {
    const { after, keys } = reconciled([ourElement, { hooks: [supersetHook, ourHook] }]);
    expect(after).toEqual([ourElement, { hooks: [supersetHook] }]);
    expect(keys.shift).toBeNull();
  });

  it('retires the approval of a group made only of our command', () => {
    const { after, keys } = reconciled([staleOurs, foreignGroup('other')]);
    expect(after).toEqual([ourElement, foreignGroup('other')]);
    expect(keys.shift?.droppedGroups).toEqual(new Set([0]));
    const raw =
      table(groupKey(0), 'trusted_hash = "sha256:stale-ours"') +
      table(groupKey(1), 'trusted_hash = "sha256:other"');
    const plan = planCodexTrustEdit(raw, { ...keys, carry: null });
    expect(plan).toMatchObject({ carry: 'absent', moved: 0, skipped: [] });
    expect(stateOf(plan)).toEqual({ [groupKey(1)]: { trusted_hash: 'sha256:other' } });
  });

  it('re-keys a shared group and retires a dropped one in the same file', () => {
    const { after, keys } = reconciled([
      { hooks: [supersetHook, ourHook] },
      staleOurs,
      foreignGroup('other'),
    ]);
    expect(after).toEqual([ourElement, { hooks: [supersetHook] }, foreignGroup('other')]);
    const raw =
      table(groupKey(0), 'trusted_hash = "sha256:superset"') +
      table(groupKey(1), 'trusted_hash = "sha256:stale-ours"') +
      table(groupKey(2), 'trusted_hash = "sha256:other"');
    const plan = planCodexTrustEdit(raw, { ...keys, carry: null });
    expect(plan).toMatchObject({ carry: 'absent', moved: 1, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [groupKey(1)]: { trusted_hash: 'sha256:superset' },
      [groupKey(2)]: { trusted_hash: 'sha256:other' },
    });
  });

  it('retires only our dead keys, never another event, source file or surviving group', () => {
    const foreign = foreignGroup('superset notify');
    const dropped = shiftFor([staleOurs, foreign], [ourElement, foreign]);
    const otherEvent = `${hooksJson}:session_end:0:0`;
    const otherFile = '/other/hooks.json:session_start:0:0';
    const raw =
      table(groupKey(0), 'trusted_hash = "sha256:stale-ours"') +
      table(groupKey(1), 'trusted_hash = "sha256:theirs"') +
      table(otherEvent, 'trusted_hash = "sha256:end"') +
      table(otherFile, 'trusted_hash = "sha256:elsewhere"');
    const plan = planCodexTrustEdit(raw, { ...dropped, carry: null });
    expect(plan).toMatchObject({ carry: 'absent', moved: 0, skipped: [] });
    expect(stateOf(plan)).toEqual({
      [groupKey(1)]: { trusted_hash: 'sha256:theirs' },
      [otherEvent]: { trusted_hash: 'sha256:end' },
      [otherFile]: { trusted_hash: 'sha256:elsewhere' },
    });
  });
});

describe('codex user-level JSON surface', () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-surfaces-'));
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  const inCodexHome = <T>(fn: () => Promise<T> | T): Promise<T> =>
    runInInvocationContext(
      { env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: codexHome } },
      fn
    );

  const hooksJsonRegistration = JSON.stringify({
    hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command }] }] },
  });

  it('gives codex a hooks.json spec that prepends the canonical user command', async () => {
    const spec = await inCodexHome(() => userSettingsSpec('codex'));
    expect(spec).toMatchObject({
      path: path.join(codexHome, 'hooks.json'),
      schema: 'grouped',
      eventKey: 'SessionStart',
      placement: 'prepend',
      seed: {},
      desired: { matcher: 'startup|resume', hooks: [{ type: 'command', command }] },
    });
  });

  it('reports both codex files, and supersedes config.toml once hooks.json carries the hook', async () => {
    await writeFile(path.join(codexHome, 'config.toml'), `${codexTomlSnippet()}\n`, 'utf8');
    await writeFile(path.join(codexHome, 'hooks.json'), hooksJsonRegistration, 'utf8');
    const representation: CodexRepresentation = {
      surface: 'hooks-json',
      reason: 'existing-hooks-json',
      hooksJsonPath: path.join(codexHome, 'hooks.json'),
      tomlPath: path.join(codexHome, 'config.toml'),
      versionGate: 'supported',
    };

    const rows = await inCodexHome(() => evaluateUserSessionHookSurfaces(null, representation));
    const toml = rows.find((row) => row.path === path.join(codexHome, 'config.toml'));
    const json = rows.find((row) => row.path === path.join(codexHome, 'hooks.json'));
    expect(json).toMatchObject({ agent: 'codex', state: 'installed' });
    expect(toml).toMatchObject({ agent: 'codex', state: 'superseded' });
    expect(toml?.remedy).toContain('session-hooks install --agents codex');
    expect(toml?.remedy).toContain(path.join(codexHome, 'hooks.json'));
  });

  it('leaves config.toml installed while it is the resolved representation', async () => {
    await writeFile(path.join(codexHome, 'config.toml'), `${codexTomlSnippet()}\n`, 'utf8');
    await writeFile(path.join(codexHome, 'hooks.json'), hooksJsonRegistration, 'utf8');
    const rows = await inCodexHome(() =>
      evaluateUserSessionHookSurfaces(null, {
        surface: 'config-toml',
        reason: 'version-unknown',
        hooksJsonPath: path.join(codexHome, 'hooks.json'),
        tomlPath: path.join(codexHome, 'config.toml'),
        versionGate: 'unknown',
      })
    );
    expect(rows.find((row) => row.path === path.join(codexHome, 'config.toml'))).toMatchObject({
      state: 'installed',
    });
  });

  it('leaves config.toml installed while hooks.json registers nothing of ours', async () => {
    await writeFile(path.join(codexHome, 'config.toml'), `${codexTomlSnippet()}\n`, 'utf8');
    await writeFile(path.join(codexHome, 'hooks.json'), '{"hooks":{}}\n', 'utf8');
    const rows = await inCodexHome(() =>
      evaluateUserSessionHookSurfaces(null, {
        surface: 'hooks-json',
        reason: 'existing-hooks-json',
        hooksJsonPath: path.join(codexHome, 'hooks.json'),
        tomlPath: path.join(codexHome, 'config.toml'),
        versionGate: 'supported',
      })
    );
    expect(rows.find((row) => row.path === path.join(codexHome, 'config.toml'))).toMatchObject({
      state: 'installed',
    });
    expect(rows.find((row) => row.path === path.join(codexHome, 'hooks.json'))).toMatchObject({
      state: 'absent',
    });
  });
});
