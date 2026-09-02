/** Where one static command is eligible to be projected. */
export type CommandPlacement = 'help' | 'footer' | 'menu' | 'palette';

/** Renderer-agnostic command metadata. Callbacks stay in the owning surface. */
export interface CommandPresentation<Id extends string = string> {
  id: Id;
  gestures: readonly string[];
  label: string;
  shortLabel: string;
  helpLabel: string;
  placements: readonly CommandPlacement[];
  visible: boolean;
  enabled: boolean;
}

export interface CommandInvocation<Id extends string = string> {
  id: Id;
  gesture?: string;
}

export interface KeyGestureLike {
  name?: string;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

const NAMED_GESTURES: Readonly<Record<string, string>> = {
  enter: '↵',
  return: '↵',
  escape: 'esc',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'pgup',
  pagedown: 'pgdn',
  space: 'space',
};

/**
 * Canonical identity for one terminal gesture.
 *
 * Printable sequences win over names because OpenTUI reports shifted letters as
 * their printable value (`G`, not `S-g`). Named navigation keys retain explicit
 * modifiers (`S-←`) so advertising and dispatch can share the same vocabulary.
 */
export function normalizeCommandGesture(key: KeyGestureLike): string {
  const printable = key.sequence;
  const named = key.name?.toLowerCase();
  const base =
    printable === ' '
      ? 'space'
      : printable !== undefined && printable.length === 1 && printable >= ' '
        ? printable
        : named === 'f10' || printable === '\u001b[21~'
          ? 'F10'
          : named === undefined
            ? (printable ?? '')
            : (NAMED_GESTURES[named] ?? key.name ?? '');
  const modifiers = [
    key.ctrl === true ? 'C' : null,
    key.meta === true ? 'M' : null,
    key.shift === true && (printable === undefined || printable.length !== 1) ? 'S' : null,
  ].filter((modifier): modifier is string => modifier !== null);
  return modifiers.length === 0 ? base : `${modifiers.join('-')}-${base}`;
}

export function hasPlacement(
  command: Pick<CommandPresentation, 'placements'>,
  placement: CommandPlacement
): boolean {
  return command.placements.includes(placement);
}

/**
 * Help can execute an unambiguous parameterless command directly.
 *
 * Multi-gesture rows encode a direction or action variant, so selecting the
 * label alone would be ambiguous. Those remain discoverable but not runnable
 * until a richer parameter picker exists.
 */
export function executableHelpInvocation<Id extends string>(
  command: CommandPresentation<Id>
): CommandInvocation<Id> | null {
  if (
    !command.visible ||
    !command.enabled ||
    !hasPlacement(command, 'palette') ||
    command.gestures.length > 1
  ) {
    return null;
  }
  const gesture = command.gestures[0];
  return gesture === undefined ? { id: command.id } : { id: command.id, gesture };
}

/** Context-local collision audit used by every surface registry test. */
export function commandGestureCollisions(
  commands: readonly Pick<CommandPresentation, 'id' | 'gestures' | 'visible'>[]
): Array<{ gesture: string; commandIds: string[] }> {
  const byGesture = new Map<string, string[]>();
  for (const command of commands) {
    if (!command.visible) continue;
    for (const gesture of command.gestures) {
      const ids = byGesture.get(gesture) ?? [];
      if (!ids.includes(command.id)) ids.push(command.id);
      byGesture.set(gesture, ids);
    }
  }
  return [...byGesture.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([gesture, commandIds]) => ({ gesture, commandIds }));
}
