// The honest automated test for the ^E hand-off: a real fake-$EDITOR script
// exercises editTextViaEditor's temp-buffer round-trip end to end (spawn,
// suspend/resume, buffer read-back) with no TTY and no OpenTUI renderer —
// the primitive takes an injectable env and a 3-method renderer stub.
// Imported directly (not via the package barrel): the barrel pulls the UI
// layer, whose `bun:` imports the node ESM loader cannot resolve.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEditorCommand,
  editTextViaEditor,
  openFileInEditor,
  type SuspendableRenderer,
} from './openInEditor.js';

let dir: string;

function stubRenderer(): SuspendableRenderer & { suspend: () => void; resume: () => void } {
  return { suspend: vi.fn(), resume: vi.fn(), isDestroyed: false };
}

async function fakeEditor(body: string): Promise<string> {
  const script = path.join(dir, 'fake-editor.sh');
  await writeFile(script, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orcaops-fake-editor-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('editTextViaEditor — fake-$EDITOR round-trip', () => {
  it('spawns the editor on a temp buffer and reads the edited text back', async () => {
    const script = await fakeEditor('printf "appended-line\\n" >> "$1"');
    const renderer = stubRenderer();

    const result = editTextViaEditor({
      initialText: 'draft\n',
      renderer,
      env: { EDITOR: script },
    });

    expect(result).toEqual({ text: 'draft\nappended-line\n', error: null });
    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });

  it('reports an unset $EDITOR without spawning or suspending', () => {
    const renderer = stubRenderer();
    const result = editTextViaEditor({ initialText: 'x', renderer, env: {} });
    expect(result).toEqual({ text: null, error: '$EDITOR is not set.' });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it('reports a nonzero editor exit as an error (buffer discarded)', async () => {
    const script = await fakeEditor('exit 1');
    const renderer = stubRenderer();
    const result = editTextViaEditor({ initialText: 'draft\n', renderer, env: { EDITOR: script } });
    expect(result).toEqual({ text: null, error: 'Editor exited with status 1.' });
    // Suspend/resume still bracket the failed spawn — degrade, not hang.
    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });

  it('rejects detaching GUI editors before suspending', () => {
    const renderer = stubRenderer();
    const result = editTextViaEditor({ initialText: 'x', renderer, env: { EDITOR: 'code' } });
    expect(result.text).toBeNull();
    expect(result.error).toContain('detaches (GUI editor)');
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it('does not resume a renderer destroyed while the editor was open', async () => {
    const script = await fakeEditor(':');
    const renderer = { suspend: vi.fn(), resume: vi.fn(), isDestroyed: true };
    const result = editTextViaEditor({ initialText: 'x\n', renderer, env: { EDITOR: script } });
    expect(result.error).toBeNull();
    expect(renderer.resume).not.toHaveBeenCalled();
  });
});

describe('openFileInEditor — file-at-line open (the walk `e` verb)', () => {
  it('opens a repo-relative file with the vi-style +LINE arg, suspending around it', async () => {
    // Name the fake script `vim` so buildEditorCommand takes the vi-style path.
    const argsFile = path.join(dir, 'args.txt');
    const script = path.join(dir, 'vim');
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`, 'utf8');
    await chmod(script, 0o755);
    const target = path.join(dir, 'src.ts');
    await writeFile(target, 'const x = 1;\n', 'utf8');
    const renderer = stubRenderer();

    const error = openFileInEditor({
      renderer,
      env: { EDITOR: script },
      root: dir,
      file: 'src.ts',
      line: 12,
    });

    expect(error).toBeNull();
    const args = (await import('node:fs/promises')).readFile(argsFile, 'utf8');
    await expect(args).resolves.toBe(`+12\n${target}\n`);
    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });

  it('reports a missing file without spawning or suspending', () => {
    const renderer = stubRenderer();
    const error = openFileInEditor({
      renderer,
      env: { EDITOR: 'vi' },
      root: dir,
      file: 'not-here.ts',
      line: 1,
    });
    expect(error).toContain('does not exist on disk');
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it('reports an unset $EDITOR', () => {
    const renderer = stubRenderer();
    const error = openFileInEditor({ renderer, env: {}, root: dir, file: 'x', line: 1 });
    expect(error).toBe('$EDITOR is not set.');
  });

  it('refuses an over-limit $EDITOR before launching it', async () => {
    await writeFile(path.join(dir, 'src.ts'), '', 'utf8');
    const renderer = stubRenderer();
    const error = openFileInEditor({
      renderer,
      env: { EDITOR: 'v'.repeat(1025) },
      root: dir,
      file: 'src.ts',
      line: 1,
    });

    expect(error).toBe('$EDITOR exceeds the 1024-character limit.');
    expect(renderer.suspend).not.toHaveBeenCalled();
  });
});

describe('editor tokenizing resource bounds', () => {
  it('rejects a maximum-length unclosed quote in bounded time', () => {
    const adversarial = `"${'a '.repeat(511)}a`;
    expect(adversarial).toHaveLength(1024);
    const start = performance.now();
    const result = editTextViaEditor({
      initialText: 'x',
      renderer: stubRenderer(),
      env: { EDITOR: adversarial },
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toEqual({
      text: null,
      error: '$EDITOR has an unterminated double quote.',
    });
  });

  it('accepts 1024 characters and refuses 1025 with a useful error', () => {
    const accepted = 'v'.repeat(1024);
    const refused = 'v'.repeat(1025);

    expect(buildEditorCommand({ editor: accepted, filePath: '/tmp/f', line: 1 })).toEqual({
      command: accepted,
      args: ['/tmp/f'],
    });
    expect(buildEditorCommand({ editor: refused, filePath: '/tmp/f', line: 1 })).toEqual({
      command: '',
      args: [],
      error: '$EDITOR exceeds the 1024-character limit.',
    });

    const renderer = stubRenderer();
    expect(editTextViaEditor({ initialText: 'x', renderer, env: { EDITOR: refused } })).toEqual({
      text: null,
      error: '$EDITOR exceeds the 1024-character limit.',
    });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it('still tokenizes a realistic long-but-sane editor command', () => {
    const editor = 'nvim -u NONE -c "set nowrap"';
    const built = buildEditorCommand({ editor, filePath: '/tmp/f', line: 3 });
    expect(built.command).toBe('nvim');
    expect(built.args).toEqual(['-u', 'NONE', '-c', 'set nowrap', '+3', '/tmp/f']);
  });

  it('preserves empty arguments and Windows path separators', () => {
    expect(
      buildEditorCommand({
        editor: String.raw`"C:\Program Files\Vim\vim.exe" --cmd ""`,
        filePath: 'C:\\repo\\file.ts',
        line: 4,
      })
    ).toEqual({
      command: String.raw`C:\Program Files\Vim\vim.exe`,
      args: ['--cmd', '', '+4', 'C:\\repo\\file.ts'],
    });
  });

  it('preserves quoted UNC editor paths', () => {
    const editor = String.raw`"\\server\tools\vim.exe"`;
    expect(buildEditorCommand({ editor, filePath: 'C:\\repo\\file.ts', line: 4 })).toEqual({
      command: String.raw`\\server\tools\vim.exe`,
      args: ['+4', 'C:\\repo\\file.ts'],
    });
  });

  it('reports malformed quoting before it creates or launches an editor buffer', () => {
    const renderer = stubRenderer();
    const result = editTextViaEditor({
      initialText: 'x',
      renderer,
      env: { EDITOR: 'nvim -c "set nowrap' },
    });

    expect(result).toEqual({
      text: null,
      error: '$EDITOR has an unterminated double quote.',
    });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });
});
