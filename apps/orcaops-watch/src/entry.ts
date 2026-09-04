// The executable's entrypoint. It settles everything that must not depend on
// the application graph before loading it: `--version` has to answer inside a
// bare install (the proprietary run-time shims throw at module init without a
// deps root), and a render without a terminal has to be refused before OpenTUI
// touches stdin. Everything else is `main`, imported lazily.
import { interactiveTerminalProblem, parseArgs } from './cli';

const opts = parseArgs(process.argv.slice(2));

// The compile step inlines the build version as a literal, so a released
// executable reports what it was built for and no environment can change it.
if (opts.version) {
  process.stdout.write(`${process.env.ORCAOPS_WATCH_BUILD_VERSION ?? 'dev'}\n`);
  process.exit(0);
}

const problem = interactiveTerminalProblem(opts, {
  stdin: process.stdin.isTTY === true,
  stdout: process.stdout.isTTY === true,
});
if (problem !== null) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

const { main } = await import('./main');
await main(opts);
