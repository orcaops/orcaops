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

  it('ignores unknown flags and keeps the defaults', () => {
    expect(parseArgs(['--nope'])).toEqual({
      intervalMs: 2000,
      version: false,
      selfcheck: false,
      probe: false,
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
