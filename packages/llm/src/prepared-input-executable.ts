import { constants } from 'node:fs';
import { access, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LlmProvider } from './detect.js';

type ExecutableResolution = { argv: [string, ...string[]] } | { error: string };

const PROVIDERS = {
  codex: { override: 'ORCAOPS_CODEX_PATH', packageName: '@openai/codex' },
  claude: { override: 'ORCAOPS_CLAUDE_PATH', packageName: '@anthropic-ai/claude-code' },
} as const;

// These identify executable formats, not publisher authenticity. The installed CLI
// remains trusted; script launchers must not get to rewrite the restricted invocation.
const NATIVE_MAGIC = new Set([
  '7f454c46', // ELF
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe', // Mach-O
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca', // Universal Mach-O
]);

export async function resolvePreparedInputExecutable(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<ExecutableResolution> {
  const { override, packageName } = PROVIDERS[provider];
  const explicit = env[override];
  const command = explicit ?? provider;
  const hasPath = command.includes('/') || (process.platform === 'win32' && command.includes('\\'));
  const names =
    process.platform === 'win32' && !path.extname(command)
      ? [command + '.exe', command, command + '.cmd', command + '.ps1']
      : [command];
  const searchPath =
    process.platform === 'win32'
      ? Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1]
      : env.PATH;
  const candidates = hasPath
    ? names.map((name) => path.resolve(cwd, name))
    : (searchPath ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin'))
        .split(path.delimiter)
        .flatMap((directory) => names.map((name) => path.resolve(cwd, directory, name)));
  const rejected: string[] = [];

  for (const candidate of new Set(candidates)) {
    const file = await executableFile(candidate);
    if (file === null) continue;
    if (file.native) return { argv: [file.path] };
    const direct = await packageEntrypointFor(file.path, provider, packageName);
    if (direct !== null) return direct;

    // npm and pnpm can install shell/CMD shims instead of symlinks. Resolve the
    // adjacent package's declared bin without interpreting or executing the shim.
    if (explicit === undefined) {
      const directory = path.dirname(candidate);
      for (const modules of [path.join(directory, 'node_modules'), path.resolve(directory, '..')]) {
        const entrypoint = await packageEntrypoint(
          path.join(modules, packageName),
          provider,
          packageName
        );
        if (entrypoint !== null) return entrypoint;
      }
    }
    rejected.push(candidate);
    if (explicit !== undefined) break;
  }

  return {
    error:
      `${explicit === undefined ? provider : override + '=' + command}: ` +
      (rejected.length > 0
        ? `unsupported launcher script or executable (${rejected.slice(0, 3).join(', ')}). `
        : 'no executable was found. ') +
      `Prepared-input processing requires a native ${provider} CLI or the declared entrypoint of ${packageName}. ` +
      `Set ${override} to that entrypoint, or put a supported installation on PATH. No launcher was run.`,
  };
}

async function executableFile(
  candidate: string
): Promise<{ path: string; native: boolean } | null> {
  try {
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isFile()) return null;
    const file = await open(resolved, 'r');
    try {
      const prefix = Buffer.alloc(4);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      const native =
        bytesRead === 4 &&
        (NATIVE_MAGIC.has(prefix.toString('hex')) || prefix.subarray(0, 2).toString() === 'MZ');
      if (native) await access(resolved, constants.X_OK);
      return { path: resolved, native };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function packageEntrypointFor(
  executable: string,
  provider: LlmProvider,
  packageName: string
): Promise<{ argv: [string, ...string[]] } | null> {
  let directory = path.dirname(executable);
  for (;;) {
    const entrypoint = await packageEntrypoint(directory, provider, packageName);
    if (entrypoint !== null && entrypoint.argv.at(-1) === executable) return entrypoint;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function packageEntrypoint(
  directory: string,
  provider: LlmProvider,
  packageName: string
): Promise<{ argv: [string, ...string[]] } | null> {
  try {
    const manifestPath = path.join(directory, 'package.json');
    if ((await stat(manifestPath)).size > 64 * 1024) return null;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      name?: unknown;
      bin?: string | Record<string, unknown>;
    };
    if (manifest.name !== packageName) return null;
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[provider];
    if (typeof bin !== 'string' || path.isAbsolute(bin)) return null;
    const entry = path.resolve(directory, bin);
    if (path.relative(directory, entry).startsWith('..' + path.sep)) return null;
    const file = await executableFile(entry);
    if (file === null) return null;
    if (file.native) return { argv: [file.path] };
    if (!/\.(?:c|m)?js$/.test(file.path)) return null;
    // Use Orcaops' Node runtime so an `env node` shebang cannot select another shim.
    return { argv: [process.execPath, file.path] };
  } catch {
    return null;
  }
}
