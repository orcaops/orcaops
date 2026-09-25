import { isatty } from 'node:tty';
import { afterEach, expect, it, vi } from 'vitest';

import { consentTerminal } from './knowledge-processing-terminal.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

afterEach(() => {
  vi.mocked(isatty).mockReset();
});

it.each([0, 1, 2])('is not interactive when file descriptor %i is not a terminal', (redirected) => {
  vi.mocked(isatty).mockImplementation((descriptor) => descriptor !== redirected);
  expect(consentTerminal.isInteractive()).toBe(false);
});

it('is interactive when standard input, output and error are all terminals', () => {
  vi.mocked(isatty).mockReturnValue(true);
  expect(consentTerminal.isInteractive()).toBe(true);
});
