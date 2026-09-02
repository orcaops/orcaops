// GUARD: every command the CLI tells a user to run must actually exist.
//
// Remediation strings are prose, so typecheck cannot see them, and the check
// that emits one usually needs a specific broken state to fire at all. That
// makes a mechanical command rename the perfect way to ship a dead reference,
// and dead references are unreachable by behavior tests.
//
// Scope is the CLI's own source (commands, lib, cli) minus tests, compared
// against the commands actually registered on the program at runtime — so
// subcommand groups and argument-bearing declarations like
// `.command('why <target>')` all resolve correctly.

import type { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';

import { buildProgram } from '../../src/cli/program.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const SCANNED_DIRS = ['commands', 'lib', 'cli'];

/**
 * Backtick-quoted `orcaops <verb>` mentions, first token only — flags and
 * arguments are dropped, so `` `orcaops resync --force` `` yields `resync`.
 * A subcommand path reduces to its group (`orcaops plan pull` → `plan`), which
 * is the right granularity: the group is what a rename would break.
 */
const COMMAND_REF_RE = /`orcaops ([a-z][a-z0-9-]*)/g;

/**
 * English prose that happens to follow the product name. `init.ts` explains
 * that "orcaops anchors .orcaops to the git worktree root" — a verb, not a
 * command. Extend this only for genuine prose; a dead command reference must
 * be fixed, never allowlisted.
 */
const PROSE_NOT_COMMANDS = new Set(['anchors']);

/** Every command name the CLI registers, at any nesting depth. */
function registeredCommandNames(cmd: Command, into = new Set<string>()): Set<string> {
  for (const sub of cmd.commands) {
    into.add(sub.name());
    registeredCommandNames(sub, into);
  }
  return into;
}

/**
 * The whole rule, isolated so it can be tested against a synthetic bad ref
 * below. A guard nobody has watched fail is a guard nobody has tested.
 */
export const unknownCommandRefs = (source: string, known: ReadonlySet<string>): string[] =>
  [...new Set([...source.matchAll(COMMAND_REF_RE)].map((m) => m[1]))]
    .filter((name) => !known.has(name) && !PROSE_NOT_COMMANDS.has(name))
    .sort();

/** Non-test `.ts` sources under the scanned directories. */
async function scannedSources(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const entries = await readdir(path.join(SRC, dir), { recursive: true });
    for (const entry of entries) {
      if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(path.join(SRC, dir, entry));
      }
    }
  }
  return files;
}

describe('every `orcaops <cmd>` the CLI prints names a real command', () => {
  it('no source references a command absent from the program', async () => {
    const known = registeredCommandNames(buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL }));
    const files = await scannedSources();
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    let matched = 0;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      matched += [...source.matchAll(COMMAND_REF_RE)].length;
      for (const bad of unknownCommandRefs(source, known)) {
        offenders.push(`${path.relative(SRC, file)}: orcaops ${bad}`);
      }
    }

    // Sanity: the regex still matches something. A refactor that reshapes the
    // remediation strings must not silently turn this into a no-op guard.
    expect(matched).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('the rule catches a command that does not exist', () => {
    const source = 'Run `orcaops lineage-status` or `orcaops resync --force` to retry.';
    expect(unknownCommandRefs(source, new Set(['resync', 'push-status']))).toEqual([
      'lineage-status',
    ]);
  });

  it('the rule ignores flags and reduces a subcommand path to its group', () => {
    const source = 'Try `orcaops resync --force`, then `orcaops plan pull`.';
    expect(unknownCommandRefs(source, new Set(['resync', 'plan']))).toEqual([]);
  });
});
