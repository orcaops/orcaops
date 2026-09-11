import { describe, expect, it } from 'vitest';

import {
  INTERACTIVE_TERMINAL_MESSAGE,
  interactiveTerminalProblem,
  isHeadless,
  parseArgs,
} from './cli';

describe('parseArgs', () => {
  it('parses the headless flags independently of order', () => {
    expect(parseArgs(['--selfcheck', '--version'])).toMatchObject({
      version: true,
      selfcheck: true,
    });
    expect(parseArgs(['--probe', '--root', '/repo'])).toMatchObject({ probe: true, root: '/repo' });
  });

  it('refuses unknown arguments even in a headless mode', () => {
    for (const argv of [['--nope'], ['unexpected'], ['--probe', '--nope']])
      expect(() => parseArgs(argv)).toThrow('Unknown Watch argument');
  });

  it('requires an explicit root value and a finite positive interval', () => {
    for (const argv of [['--root'], ['--root', ''], ['--root', '--probe']])
      expect(() => parseArgs(argv)).toThrow('--root requires a path');
    for (const value of [undefined, '', '0', '-1', 'Infinity', 'not-a-number', '--probe'])
      expect(() => parseArgs(value === undefined ? ['--interval'] : ['--interval', value])).toThrow(
        '--interval requires a finite positive number'
      );
    expect(
      parseArgs(['--root', '/repo with spaces', '--interval', '500', '--probe'])
    ).toMatchObject({
      root: '/repo with spaces',
      intervalMs: 500,
      probe: true,
    });
  });
});

describe('interactiveTerminalProblem', () => {
  const noTty = { stdin: false, stdout: false };

  it('lets every headless mode run without a terminal', () => {
    for (const flag of ['--version', '--selfcheck', '--probe']) {
      const opts = parseArgs([flag]);
      expect(isHeadless(opts)).toBe(true);
      expect(interactiveTerminalProblem(opts, noTty)).toBeNull();
    }
  });

  it('refuses a render unless both stdin and stdout are terminals', () => {
    const opts = parseArgs([]);
    expect(interactiveTerminalProblem(opts, noTty)).toBe(INTERACTIVE_TERMINAL_MESSAGE);
    expect(interactiveTerminalProblem(opts, { stdin: true, stdout: false })).toBe(
      INTERACTIVE_TERMINAL_MESSAGE
    );
    expect(interactiveTerminalProblem(opts, { stdin: true, stdout: true })).toBeNull();
  });
});
