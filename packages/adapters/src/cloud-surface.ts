/**
 * The cloud surface as a value, so the `--help` gate, the containment guard and
 * doctor's advice cannot disagree about what it means.
 */

/**
 * Commands `buildProgram` hides when the machine holds no cloud credentials.
 * Subcommands are spelled with their parent so a bare verb (`orcaops review
 * status` vs the ungated local review engine's own verbs) cannot collide.
 */
export const CLOUD_HIDDEN_COMMANDS = [
  'push-status',
  'logout',
  'whoami',
  'org',
  'auth-state',
  'push',
  'resync',
  'plan',
  'review status',
  'review pull',
  'review reply',
  'review resolve',
  'review watch',
] as const;

/**
 * The hidden commands plus `login`, which stays visible. Committed ungated
 * content may name NONE of these: an install that cannot buy the product
 * should not be told to sign in to it.
 */
export const CLOUD_SURFACE_COMMANDS = [...CLOUD_HIDDEN_COMMANDS, 'login'] as const;

/** The `--source-plan` pin scheme only a cloud plan can produce. */
export const CLOUD_PIN_SCHEME = 'cloud:';
