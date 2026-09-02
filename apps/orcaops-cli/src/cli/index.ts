import type { HookAgent } from '../commands/hook-session-start.js';
import { flushStdio, installPipeErrorHandling } from '../io/exit.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

/**
 * `orcaops hook session-start` fast path — argv is sniffed BEFORE
 * `./program.js` loads, because that import pulls the full ~90-command module
 * graph (commander tree, @orcaops/core, zod, …) and this command runs at
 * EVERY agent session start; the hook itself needs none of it. Only the
 * exact invocation the installed settings entries emit matches — any other
 * token (`--help`, `--root`, …) falls through to commander so help and
 * flag errors keep working.
 *
 * Two deliberate contract points, both serving the hook's never-banner rule:
 *  - an unknown `--agent` value degrades to plain-text output and exit 0
 *    (commander's `.choices()` would exit 1 — a mangled settings entry must
 *    not error every teammate's session start);
 *  - ANY failure here, including a broken module graph that would make the
 *    full CLI print "Internal error", still exits 0 with empty stdout.
 */
// Installed before the hook fast path so both entry paths are covered.
installPipeErrorHandling([process.stdout, process.stderr], (code) => process.exit(code));

const HOOK_AGENT_IDS: readonly string[] = ['claude-code', 'codex', 'cursor', 'opencode'];
const SESSION_HOOK_DEADLINE_MS = 5_000;

function parseHookFastPath(argv: string[]): {
  match: boolean;
  agent?: HookAgent;
  user?: boolean;
  silent?: boolean;
} {
  if (argv[0] !== 'hook' || argv[1] !== 'session-start') return { match: false };
  let agent: HookAgent | undefined;
  let user = false;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    // `--user` marks a machine-level registration's invocation — it MUST ride
    // the fast path too, or every session start on the machine pays the full
    // command-graph load.
    if (tok === '--user') {
      user = true;
      continue;
    }
    let value: string | undefined;
    if (tok === '--agent') {
      value = rest[++i];
      if (value === undefined || value.startsWith('--')) return { match: true, silent: true };
    } else if (tok.startsWith('--agent=')) {
      value = tok.slice('--agent='.length);
      if (value.length === 0) return { match: true, silent: true };
    } else {
      return { match: false }; // unexpected token → let commander handle it
    }
    if (HOOK_AGENT_IDS.includes(value)) agent = value as HookAgent;
  }
  return { match: true, agent, user };
}

const fastPath = parseHookFastPath(process.argv.slice(2));
if (fastPath.match) {
  if (!fastPath.silent) {
    const deadline = setTimeout(() => {
      // The deadline is a hard exit, so drain pending writes first —
      // process.exit does not flush Node's write queue and would truncate the
      // hook envelope on a slow pipe.
      void flushStdio().finally(() => process.exit(0));
    }, SESSION_HOOK_DEADLINE_MS);
    deadline.unref();
    try {
      const { hookSessionStartAction } = await import('../commands/hook-session-start.js');
      await runInInvocationContext({ cwd: process.cwd(), env: process.env }, () =>
        hookSessionStartAction({ agent: fastPath.agent, user: fastPath.user })
      );
    } catch {
      // Hard contract: silent. Empty stdout, exit 0.
    } finally {
      clearTimeout(deadline);
    }
  }
  process.exitCode = 0;
}

if (!fastPath.match) {
  // The program (and its command-module graph, incl. commander and
  // @orcaops/core) loads only on the normal path — the session-hook fast path
  // above must never pay for it. runCli owns the ALS invocation frame and
  // every exit path (CliExit flush, commander codes, scrubbed internal error).
  const [{ buildProgram }, { runCli }, { DEFAULT_CLOUD_BASE_URL }] = await Promise.all([
    import('./program.js'),
    import('./run.js'),
    import('@orcaops/core'),
  ]);
  process.exitCode = await runCli(buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL }), {
    cwd: process.cwd(),
    env: process.env,
    cloudBaseUrl: DEFAULT_CLOUD_BASE_URL,
  });
}
