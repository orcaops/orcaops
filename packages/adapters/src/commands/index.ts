import type { CommandTemplate } from '../types.js';
import { digestCommand } from './digest.js';
import { doctorCommand } from './doctor.js';
import { listCommand } from './list.js';
import { resumeCommand } from './resume.js';
import { searchCommand } from './search.js';
import { showCommand } from './show.js';
import { statusCommand } from './status.js';
import { whyCommand } from './why.js';

/**
 * User-facing slash command templates. Read-only by design — capture
 * commands are agent-driven via skills (no user slash equivalent).
 *
 * Coverage mirrors the read-only CLI surface:
 *   - artifact thread inspection: status / list / show
 *   - reviewer-facing rendering: digest
 *   - file:line attribution:     why
 *   - "where was I":             resume
 *   - cross-artifact search:     search
 *   - install diagnostics:       doctor
 *
 * Eval-author tooling (eval list/show/run/test) and one-shot maintenance
 * (init / update / rebuild) are intentionally NOT slashed — those run
 * from a terminal, not from inside an agent session.
 */
export const COMMAND_TEMPLATES: ReadonlyArray<CommandTemplate> = [
  statusCommand,
  listCommand,
  showCommand,
  digestCommand,
  whyCommand,
  resumeCommand,
  searchCommand,
  doctorCommand,
];

export {
  digestCommand,
  doctorCommand,
  listCommand,
  resumeCommand,
  searchCommand,
  showCommand,
  statusCommand,
  whyCommand,
};
