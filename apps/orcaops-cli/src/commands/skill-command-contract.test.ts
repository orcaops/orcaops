import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES, type SkillTemplate } from '@orcaops/adapters';
import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';

import { buildProgram } from '../cli/program.js';

const bodyOf = (skill: SkillTemplate): string =>
  typeof skill.body === 'function' ? skill.body('orcaops') : skill.body;

const commandAt = (root: Command, path: readonly string[]): Command => {
  let command = root;
  for (const name of path) {
    const next = command.commands.find((candidate) => candidate.name() === name);
    if (next === undefined) throw new Error(`missing command: ${path.join(' ')}`);
    command = next;
  }
  return command;
};

const examples = [
  {
    skill: 'checkpoint',
    text: 'orcaops capture checkpoint close --input - --invoked-by-agent <your-agent-id>',
    path: ['capture', 'checkpoint', 'close'],
    flags: ['--input', '--invoked-by-agent'],
  },
  {
    skill: 'timetravel',
    text: 'orcaops show <id> --json',
    path: ['show'],
    flags: ['--json'],
  },
  {
    skill: 'resume',
    text: 'orcaops resume --accept-default --no-pin',
    path: ['resume'],
    flags: ['--accept-default', '--no-pin'],
  },
  {
    skill: 'plan-critique',
    text: 'orcaops decisions --all-branches --json',
    path: ['decisions'],
    flags: ['--all-branches', '--json'],
  },
  {
    skill: 'digest',
    text: 'orcaops digest --branch-wide --base origin/main',
    path: ['digest'],
    flags: ['--branch-wide', '--base'],
  },
  {
    skill: 'digest',
    text: 'orcaops digest --out PR-DESCRIPTION.md',
    path: ['digest'],
    flags: ['--out'],
  },
] as const;

describe('commands shown in skill guidance', () => {
  it.each(examples)(
    '$skill uses the live $path command and flags',
    ({ skill, text, path, flags }) => {
      const template = SKILL_TEMPLATES.find((candidate) => candidate.id === skill);
      expect(template).toBeDefined();
      expect(bodyOf(template!)).toContain(text);

      const program = buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });
      const command = commandAt(program, path);
      const acceptedFlags = new Set(
        command.options.flatMap((option) => [option.short, option.long]).filter(Boolean)
      );
      for (const flag of flags) expect(acceptedFlags, flag).toContain(flag);
    }
  );
});
