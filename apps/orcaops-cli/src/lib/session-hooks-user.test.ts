import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  CODEX_TOML_MARKER_END,
  CODEX_TOML_MARKER_START,
  codexTomlSnippet,
  planCodexTomlInstall,
  planCodexTomlRemoval,
} from './session-hooks-user.js';
import { canonicalSessionHookCommand } from './session-hooks.js';

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
