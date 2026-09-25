import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';

import {
  InteractiveConsentConfirmation,
  type ProcessingGrantTerms,
} from './knowledge-processing-grants.js';
import { writeTerminalSafeStderr } from '../io/output.js';

/**
 * The person at the terminal, as the enable flow sees them. Tests replace it
 * to drive the flow's decisions without a terminal; what they cannot replace is
 * what {@link InteractiveConsentConfirmation} itself demands, which is this
 * process's own standard input and output being a terminal.
 *
 * There is no non-interactive member on purpose: consent to send captured
 * content to a provider has no `--yes`, no environment variable and no flag.
 */
export interface ConsentTerminal {
  isInteractive(): boolean;
  /** Asks on stderr and returns exactly what was typed. */
  ask(question: string): Promise<string>;
  confirm(terms: ProcessingGrantTerms): InteractiveConsentConfirmation;
}

async function askOnStderr(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    return await new Promise<string>((resolve) => {
      writeTerminalSafeStderr(question);
      rl.once('line', resolve);
      rl.once('close', () => resolve(''));
    });
  } finally {
    rl.close();
  }
}

export const consentTerminal: ConsentTerminal = {
  // The terms and the question are written to standard error, so it has to be a terminal too: a
  // person whose standard error is redirected would be asked to accept terms they never saw.
  isInteractive: () => isatty(0) && isatty(1) && isatty(2),
  ask: askOnStderr,
  confirm: (terms) => InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms),
};
