import { describe, expect, it } from 'vitest';

import {
  commandGestureCollisions,
  type CommandPresentation,
  executableHelpInvocation,
  normalizeCommandGesture,
} from './commandRegistry';

describe('command gesture normalization', () => {
  const presentation = (
    gestures: readonly string[],
    enabled = true
  ): CommandPresentation<'test.command'> => ({
    id: 'test.command',
    gestures,
    label: 'Test command',
    shortLabel: 'Test',
    helpLabel: 'Run the test command',
    placements: ['help', 'palette'],
    visible: true,
    enabled,
  });

  it('normalizes named, shifted, printable, and F10 gestures once', () => {
    expect(normalizeCommandGesture({ name: 'return', sequence: '\r' })).toBe('↵');
    expect(normalizeCommandGesture({ name: 'space', sequence: ' ' })).toBe('space');
    expect(normalizeCommandGesture({ name: 'left', shift: true })).toBe('S-←');
    expect(normalizeCommandGesture({ name: 'g', sequence: 'G', shift: true })).toBe('G');
    expect(normalizeCommandGesture({ name: 'f10', sequence: '\u001b[21~' })).toBe('F10');
    expect(normalizeCommandGesture({ name: 'c', sequence: 'c', ctrl: true })).toBe('C-c');
  });

  it('reports only collisions between distinct visible command IDs', () => {
    expect(
      commandGestureCollisions([
        { id: 'one', gestures: ['g'], visible: true },
        { id: 'one', gestures: ['g'], visible: true },
        { id: 'hidden', gestures: ['g'], visible: false },
        { id: 'two', gestures: ['g'], visible: true },
      ])
    ).toEqual([{ gesture: 'g', commandIds: ['one', 'two'] }]);
  });

  it('makes only enabled unambiguous palette rows executable', () => {
    expect(executableHelpInvocation(presentation([]))).toEqual({ id: 'test.command' });
    expect(executableHelpInvocation(presentation(['t']))).toEqual({
      id: 'test.command',
      gesture: 't',
    });
    expect(executableHelpInvocation(presentation(['j', 'k']))).toBeNull();
    expect(executableHelpInvocation(presentation(['t'], false))).toBeNull();
  });
});
