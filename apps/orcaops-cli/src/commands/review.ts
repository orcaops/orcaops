import { reviewRuntimeDescriptorFromModule, runReview } from '@orcaops/review-engine';

import { CliExit } from '../io/exit.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

/**
 * `orcaops review <data|journal|comments|comment|anchor> …`
 * — the Task Review data layer, IN-PROCESS. This is the public agent-facing
 * surface for the review verbs (the comment loop runs headless, no TUI
 * involved); the watch app's sidecar routes its internal `review …` argv
 * to the same `runReview`, so the engine has exactly one implementation.
 *
 * The verbs own their argv contract (`--branch`, `--json`, …) and print their
 * own JSON — commander passes the raw args through. `--root` is the one flag
 * commander consumes (addRootOptionRecursively); re-append it so the engine's
 * `--root → ORCAOPS_ROOT → git-toplevel` resolution sees it.
 */
export async function reviewAction(
  passThroughArgs: string[],
  root: string | undefined
): Promise<void> {
  const argv = ['review', ...passThroughArgs];
  if (root !== undefined && root !== '') argv.push('--root', root);
  const runtime = await reviewRuntimeDescriptorFromModule(import.meta.url);
  const code = await runReview(argv, getInvocationEnv(), undefined, runtime);
  if (code !== 0) throw new CliExit(code);
}
