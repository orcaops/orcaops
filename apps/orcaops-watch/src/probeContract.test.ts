// PROBE ENTRY-POINT CONTRACT: the probe scenes run a renderer on import
// (each ends in `void main()`), so this asserts on the manifest, the pty
// driver, and PROBES.md rather than importing them.
//
// The property that matters is REACHABILITY: two scenes previously had no
// entry point at all, which is how they became invisible to every tool that
// looks for dead code — and how they would have been deleted as unreachable.
// So the load-bearing assertion enumerates the scenes on disk and requires
// each to be named in an EXECUTING position, rather than hard-coding a list a
// new probe would quietly fall outside of.
//
// What this does NOT prove: that the enclosing shell function is ever called.
// A scene named in a `bun` invocation inside a function nothing invokes still
// passes. Closing that would mean executing the driver, which needs a TTY.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCENE_DIR = 'probes';

const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const probeScripts = Object.entries(manifest.scripts).filter(([name]) => name.startsWith('probe:'));
const ptyDriver = readFileSync(path.join(APP_ROOT, 'scripts', 'review-experience-pty.sh'), 'utf8');
const probesDocument = readFileSync(path.join(APP_ROOT, 'PROBES.md'), 'utf8');

function findProbeScenes(directory: string, root = APP_ROOT): string[] {
  const scenes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scenes.push(...findProbeScenes(entryPath, root));
    } else if (
      entry.isFile() &&
      /^probe.*\.tsx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/.test(entry.name)
    ) {
      scenes.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  }
  return scenes.sort();
}

function findDocumentedProbeScenes(document: string): string[] {
  return [
    ...new Set(
      [...document.matchAll(/`(probes\/(?:[^/`\r\n]+\/)*probe[^/`\r\n]*\.tsx?)`/g)].map(
        (match) => match[1]!
      )
    ),
  ].sort();
}

const scenes = findProbeScenes(path.join(APP_ROOT, SCENE_DIR));
const documentedScenes = findDocumentedProbeScenes(probesDocument);

/**
 * Is the scene handed to `bun` on a live line?
 *
 * The scanner recognizes the command forms used by package scripts and the pty
 * driver while keeping quoted operators and later shell commands separate from
 * the Bun argument list. It does not prove that an enclosing function is
 * dynamically called; the real pty test settles that for the current driver.
 */
function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: '"' | "'" | null = null;
  let comment = false;

  const endWord = () => {
    if (wordStarted) words.push(word);
    word = '';
    wordStarted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]!;
    if (comment) {
      if (character === '\n') {
        comment = false;
        endCommand();
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && quote === '"' && text[i + 1] !== undefined) {
        word += text[i + 1]!;
        wordStarted = true;
        i += 1;
      } else {
        word += character;
        wordStarted = true;
      }
      continue;
    }
    if (character === '#' && !wordStarted) {
      comment = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      wordStarted = true;
    } else if (character === '\\') {
      if (text[i + 1] === undefined) return [];
      word += text[i + 1]!;
      wordStarted = true;
      i += 1;
    } else if (character === '<' || character === '>') {
      endWord();
      words.push(character);
      if (text[i + 1] === character) i += 1;
    } else if (character === '\n' || ';|&{}'.includes(character)) {
      endCommand();
    } else if (/\s/u.test(character)) {
      endWord();
    } else {
      word += character;
      wordStarted = true;
    }
  }
  if (quote !== null) return [];
  endCommand();
  return commands;
}

const BUN_SCENE_FLAGS = new Set(['--smol']);

function commandInvokesScene(words: string[], scene: string, depth = 0): boolean {
  let commandIndex = 0;
  if (words[commandIndex] === 'env') {
    commandIndex += 1;
    if (words[commandIndex]?.startsWith('-')) return false;
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex] ?? '')) commandIndex += 1;
  if (words[commandIndex] === 'exec') commandIndex += 1;

  const command = words[commandIndex];
  if (command === 'bun') {
    for (const argument of words.slice(commandIndex + 1)) {
      if (argument === '<' || argument === '>') return false;
      if (argument.startsWith('-')) {
        if (!BUN_SCENE_FLAGS.has(argument)) return false;
        continue;
      }
      return argument.replace(/^\.\//, '') === scene;
    }
    return false;
  }
  if (command === 'run_pty' && depth === 0) {
    const nestedCommand = words.at(-1);
    return (
      nestedCommand !== undefined &&
      shellCommands(nestedCommand).some((nested) => commandInvokesScene(nested, scene, depth + 1))
    );
  }
  return false;
}

function isInvokedWithBun(scene: string, text: string): boolean {
  return shellCommands(text).some((command) => commandInvokesScene(command, scene));
}

/**
 * The scene a probe script runs.
 *
 * This is a SECOND parser, not a shared one: the matcher searches a whole
 * script for an invocation, while this extracts the target from one known
 * command. They only have to agree on quoting and a leading `./`, which is
 * what "reads the same target the matcher accepts" pins — and where they
 * previously disagreed, since a quoted command satisfied `isInvokedWithBun`
 * while this read a filename with quote characters still in it.
 */
function sceneTargetOf(command: string): string {
  return command
    .split(/\s+/)
    .at(-1)!
    .replace(/^["']|["']$/g, '')
    .replace(/^\.\//, '');
}

describe('probe entry points', () => {
  it('finds the scenes it claims to check', () => {
    expect(scenes.length, 'no probe scenes found — has the directory moved?').toBeGreaterThan(0);
  });

  it('discovers nested TypeScript scenes without treating test files as scenes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orcaops-probes-'));
    try {
      mkdirSync(path.join(root, 'nested'));
      writeFileSync(path.join(root, 'probeRoot.ts'), '');
      writeFileSync(path.join(root, 'nested', 'probeNested.tsx'), '');
      writeFileSync(path.join(root, 'nested', 'probe.keyboard.tsx'), '');
      writeFileSync(path.join(root, 'probeIgnored.test.ts'), '');

      expect(findProbeScenes(root, root)).toEqual([
        'nested/probe.keyboard.tsx',
        'nested/probeNested.tsx',
        'probeRoot.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(scenes)('%s is handed to bun by a script or the pty driver', (scene) => {
    const viaScript = probeScripts.some(([, command]) => isInvokedWithBun(scene, command));
    expect(
      viaScript || isInvokedWithBun(scene, ptyDriver),
      `${scene} has no entry point: add a probe:* script or run it from review-experience-pty.sh`
    ).toBe(true);
  });

  it('keeps PROBES.md scene references equal to the filesystem inventory', () => {
    expect(documentedScenes).toEqual(scenes);
  });

  it.each(probeScripts)('%s points at a scene that exists', (_name, command) => {
    const target = sceneTargetOf(command);
    expect(target).not.toBe('');
    expect(() => readFileSync(path.join(APP_ROOT, target), 'utf8')).not.toThrow();
  });

  it('does not duplicate a pty-driven scene as a direct script', () => {
    // A direct alias bypasses the driver that supplies the scene's input, so
    // it would look supported while producing nothing useful.
    for (const [name, command] of probeScripts) {
      const target = sceneTargetOf(command);
      expect(isInvokedWithBun(target, ptyDriver), `${name} duplicates a pty-driven scene`).toBe(
        false
      );
    }
  });

  it('ignores commented-out invocations but accepts ordinary ones', () => {
    // Guards the matcher itself, in BOTH directions. Substring matching
    // counted a path in a comment as an entry point; an over-tight `bun <path>`
    // pattern then rejected every real variation of the invocation.
    const scene = scenes[0]!;
    for (const dead of [
      `# see ${scene} for the geometry probe`,
      `# bun ${scene}`,
      `  # bun ${scene}   # disabled`,
      `echo ${scene}`,
      `echo bun ${scene}`,
      `bun --version; echo ${scene}`,
      `echo '; bun ${scene}'`,
      `bun --version < ${scene}`,
      `bun --version ${scene}`,
      `bun -e ${scene}`,
      `bun '${scene}`,
      `bun < ${scene}`,
      `bun ${scene} \\`,
      `env -u bun ${scene}`,
      `env --version bun ${scene}`,
    ]) {
      expect(isInvokedWithBun(scene, dead), dead).toBe(false);
    }
    for (const live of [
      `bun ${scene}`,
      `bun --smol ${scene}`,
      `bun ./${scene}`,
      `bun "${scene}"`,
      `  bun ${scene}`,
      `PROBE_OUT=/tmp/probe.log bun ${scene}`,
      `env PROBE_OUT=/tmp/probe.log bun ${scene}`,
      `exec bun ${scene}`,
      `stty cols 80 2>/dev/null; bun ${scene}`,
      `run_pty "$2" "stty cols 80; bun ${scene}"`,
    ]) {
      expect(isInvokedWithBun(scene, live), live).toBe(true);
    }
  });

  it('reads the same target the matcher accepts', () => {
    // The two checks have to agree on what a command points at. They did not:
    // the matcher accepted a quoted path while this side kept the quotes and
    // tried to open a filename containing them.
    const scene = scenes[0]!;
    const commands = [`bun ${scene}`, `bun "${scene}"`, `bun './${scene}'`, `bun --smol ${scene}`];
    for (const command of commands) {
      expect(sceneTargetOf(command), command).toBe(scene);
      expect(isInvokedWithBun(scene, command), command).toBe(true);
    }
  });

  it('extracts only exact backtick-delimited documentation paths', () => {
    expect(
      findDocumentedProbeScenes(
        [
          '`probes/probe.ts`',
          '`probes/nested/probe.keyboard.tsx`',
          '`probes/probeIgnored.tsx.bak`',
          '`archive/probes/probePrefixed.tsx`',
        ].join('\n')
      )
    ).toEqual(['probes/nested/probe.keyboard.tsx', 'probes/probe.ts']);
  });
});
