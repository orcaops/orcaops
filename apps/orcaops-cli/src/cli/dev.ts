import { developmentEnvironment, parseDevelopmentLaunchArgs } from './dev-runtime.js';
import { buildProgram } from './program.js';
import { runCli } from './run.js';
import { writeTerminalSafeStderr } from '../io/output.js';

let launch;
try {
  launch = parseDevelopmentLaunchArgs(process.argv.slice(2));
} catch (err) {
  writeTerminalSafeStderr(`${(err as Error).message}\n`);
  process.exitCode = 2;
}

if (launch) {
  const env = developmentEnvironment(launch.dataRoot, process.env);
  Object.assign(process.env, env);
  delete process.env.ORCAOPS_TOKEN;

  process.exitCode = await runCli(buildProgram({ cloudBaseUrl: launch.cloudBaseUrl }), {
    argv: launch.cliArgs,
    cwd: process.cwd(),
    env,
    cloudBaseUrl: launch.cloudBaseUrl,
  });
}
