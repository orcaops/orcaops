import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * How `orcaops watch` finds and launches the Task Review UI.
 *
 * A released CLI carries the four `@orcaops/watch-<os>-<cpu>` platform
 * packages as exact optional dependencies; npm installs the one matching the
 * host. The UI is a compiled executable that needs a Node sidecar and the
 * proprietary packages from THIS CLI's node_modules, so the launcher assigns
 * every hand-off variable itself rather than filling gaps an environment left.
 *
 * Only a workspace or test build (no platform pins in its own manifest) may
 * run something else: an explicit `ORCAOPS_WATCH_BIN`, or the interpreted app
 * under Bun. A pinned CLI refuses both — the environment never picks the UI a
 * release runs.
 */

export interface WatchPlatform {
  package: string;
  os: NodeJS.Platform;
  cpu: string;
  libc?: 'glibc';
}

// Mirrors apps/orcaops-watch/platforms.json (a unit test keeps them equal); the
// CLI cannot read another workspace's file at run time.
export const WATCH_PLATFORMS: readonly WatchPlatform[] = [
  { package: '@orcaops/watch-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { package: '@orcaops/watch-darwin-x64', os: 'darwin', cpu: 'x64' },
  { package: '@orcaops/watch-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { package: '@orcaops/watch-linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
];

export const HEADLESS_WATCH_FLAGS = ['--probe', '--selfcheck', '--version'] as const;

export interface CompanionManifest {
  name?: string;
  version?: string;
  optionalDependencies?: Record<string, string>;
}

export interface CompanionInputs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  /** True on a musl libc host (Alpine): no platform package exists for it. */
  musl: boolean;
  /** This CLI's own manifest and package root. */
  cliManifest: CompanionManifest;
  cliRoot: string;
  /** Resolves a bare specifier the way this CLI's module graph would. */
  requireResolve: (specifier: string) => string;
  /** The running Node binary; the Bun binary when the CLI runs under Bun. */
  execPath: string;
  runningUnderBun: boolean;
  homeDir: string;
}

export type CompanionLaunch =
  | {
      kind: 'launch';
      tier: 'override' | 'platform' | 'dev';
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      companion: { name: string; version: string; root: string } | null;
      exe: string | null;
    }
  | {
      kind: 'refuse';
      tier: 'refused-override' | 'unsupported' | 'absent' | 'broken';
      message: string;
      exitCode: number;
    };

const PLATFORM_PIN_PREFIX = '@orcaops/watch-';

export function expectedPlatformPins(manifest: CompanionManifest): Map<string, string> {
  const pins = new Map<string, string>();
  for (const [name, version] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (name.startsWith(PLATFORM_PIN_PREFIX)) pins.set(name, version);
  }
  return pins;
}

export function platformFor(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean
): WatchPlatform | null {
  const match = WATCH_PLATFORMS.find((p) => p.os === platform && p.cpu === arch) ?? null;
  if (match === null) return null;
  if (match.libc === 'glibc' && musl) return null;
  return match;
}

export function reinstallCommand(version: string | undefined): string {
  return version === undefined ? 'npm i -g @orcaops/cli' : `npm i -g @orcaops/cli@${version}`;
}

/** The headless modes never need a terminal; everything else renders. */
export function needsTerminal(args: readonly string[]): boolean {
  return !args.some((arg) => (HEADLESS_WATCH_FLAGS as readonly string[]).includes(arg));
}

export const INTERACTIVE_TERMINAL_MESSAGE =
  'orcaops watch needs an interactive terminal (use --probe for a one-shot snapshot)';

export function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * isFile matters: a directory satisfies X_OK, so without it a companion whose
 * `orcaopsWatch.exe` names a directory passes the gate and the spawn's EACCES
 * is then misreported to the user as a noexec mount.
 */
function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun extracts the UI's embedded native library to a temp dir at start-up, so
 * the executable needs one it can write. Prefer what the user set, then the
 * per-user runtime dir, then a private dir under the orcaops global root.
 */
export function chooseTmpDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const candidates = [env.TMPDIR, env.XDG_RUNTIME_DIR].filter(
    (dir): dir is string => dir !== undefined && dir !== ''
  );
  for (const dir of candidates) if (isWritableDir(dir)) return dir;
  const privateDir = path.join(env.ORCAOPS_GLOBAL_ROOT ?? path.join(homeDir, '.orcaops'), 'tmp');
  if (isPrivateWritableDir(privateDir)) return privateDir;
  // Reaching here means every candidate above failed its writability check, so
  // handing `env.TMPDIR` back would hand back a directory we just proved is
  // unusable and the UI would die extracting its native library. The system
  // temp dir is the last thing worth trying — on a locked-down home it is
  // routinely the only writable place left.
  const systemTmp = tmpdir();
  if (isWritableDir(systemTmp)) return systemTmp;
  return privateDir;
}

/**
 * The executable extracts and dlopens its native library from here, so the
 * directory must be ours alone: created 0700, and an existing one is tightened
 * or refused rather than trusted.
 */
function isPrivateWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory()) return false;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
    if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return isWritableDir(dir);
  } catch {
    return false;
  }
}

function scrubBunEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // Standalone Bun executables honour every BUN_* knob — BUN_OPTIONS
    // (including --preload) and BUN_BE_BUN, which turns the executable into a
    // general bun CLI — and OpenTUI loads a worker from its own path variable.
    // The UI must run what it was built as.
    if (key.startsWith('BUN_') || key === 'OTUI_TREE_SITTER_WORKER_PATH') continue;
    out[key] = value;
  }
  return out;
}

function nodeForSidecar(inputs: CompanionInputs): string | null {
  if (!inputs.runningUnderBun) return inputs.execPath;
  return findOnPath('node', inputs.env);
}

function readManifest(file: string): CompanionManifest | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CompanionManifest;
  } catch {
    return null;
  }
}

/** The sidecar this CLI ships, or the workspace package's build in a checkout. */
function sidecarPath(inputs: CompanionInputs): string | null {
  const shipped = path.join(inputs.cliRoot, 'dist', 'watch-sidecar.js');
  if (existsSync(shipped)) return shipped;
  try {
    return inputs.requireResolve('@orcaops/watch-data/sidecar');
  } catch {
    return null;
  }
}

function handoffEnv(inputs: CompanionInputs, sidecar: string, node: string): NodeJS.ProcessEnv {
  return {
    ...scrubBunEnv(inputs.env),
    ORCAOPS_WATCH_SIDECAR: sidecar,
    ORCAOPS_WATCH_NODE: node,
    ORCAOPS_WATCH_DEPS_ROOT: inputs.cliRoot,
    TMPDIR: chooseTmpDir(inputs.env, inputs.homeDir),
  };
}

export function resolveWatchCompanion(inputs: CompanionInputs): CompanionLaunch {
  const pins = expectedPlatformPins(inputs.cliManifest);
  const pinned = pins.size > 0;
  const version = inputs.cliManifest.version;
  const override = inputs.env.ORCAOPS_WATCH_BIN;

  if (override !== undefined && override !== '') {
    if (pinned) {
      return {
        kind: 'refuse',
        tier: 'refused-override',
        exitCode: 127,
        message:
          'orcaops watch: ORCAOPS_WATCH_BIN is not supported by released builds; unset it ' +
          'and run the Task Review companion this CLI installed.',
      };
    }
    return {
      kind: 'launch',
      tier: 'override',
      command: override,
      args: [],
      // A test hook still never inherits Bun's runtime knobs.
      env: scrubBunEnv(inputs.env),
      companion: null,
      exe: override,
    };
  }

  const platform = platformFor(inputs.platform, inputs.arch, inputs.musl);
  if (platform === null) {
    const host = `${inputs.platform}-${inputs.arch}${inputs.musl ? '-musl' : ''}`;
    return {
      kind: 'refuse',
      tier: 'unsupported',
      exitCode: 127,
      message:
        `orcaops watch: no compiled Task Review build for ${host}; supported: darwin/linux × ` +
        'arm64/x64 (glibc); Windows via WSL2.',
    };
  }

  let companionManifestPath: string | null = null;
  try {
    companionManifestPath = inputs.requireResolve(`${platform.package}/package.json`);
  } catch {
    companionManifestPath = null;
  }

  if (companionManifestPath === null) {
    if (!pinned) {
      const dev = devLaunch(inputs);
      if (dev !== null) return dev;
    }
    return {
      kind: 'refuse',
      tier: 'absent',
      exitCode: 127,
      message:
        `orcaops watch: the Task Review companion (${platform.package}) was not installed; ` +
        `reinstall: ${reinstallCommand(version)}`,
    };
  }

  const companionRoot = path.dirname(companionManifestPath);
  const manifest = readManifest(companionManifestPath);
  const expected = pins.get(platform.package) ?? version;
  if (manifest === null || manifest.version !== expected) {
    return {
      kind: 'refuse',
      tier: 'broken',
      exitCode: 127,
      message:
        `orcaops watch: ${platform.package} is ${manifest?.version ?? 'unreadable'} but this CLI ` +
        `needs ${expected ?? 'a matching version'}; reinstall: ${reinstallCommand(version)}`,
    };
  }

  const exeRelative =
    (manifest as { orcaopsWatch?: { exe?: string } }).orcaopsWatch?.exe ?? 'bin/orcaops-watch-ui';
  const exe = path.join(companionRoot, exeRelative);
  if (!existsSync(exe) || !isExecutableFile(exe)) {
    return {
      kind: 'refuse',
      tier: 'broken',
      exitCode: 127,
      message:
        `orcaops watch: ${platform.package} is installed but its executable is missing or not ` +
        `executable at ${exe}; reinstall: ${reinstallCommand(version)}`,
    };
  }

  const sidecar = sidecarPath(inputs);
  if (sidecar === null) {
    return {
      kind: 'refuse',
      tier: 'broken',
      exitCode: 127,
      message:
        'orcaops watch: this CLI install is missing dist/watch-sidecar.js; ' +
        `reinstall: ${reinstallCommand(version)}`,
    };
  }
  const node = nodeForSidecar(inputs);
  if (node === null) {
    return {
      kind: 'refuse',
      tier: 'broken',
      exitCode: 127,
      message:
        'orcaops watch: running under Bun, and no `node` is on PATH for the Task Review data ' +
        'sidecar; install Node 22+ or run orcaops with Node.',
    };
  }

  return {
    kind: 'launch',
    tier: 'platform',
    command: exe,
    args: [],
    env: handoffEnv(inputs, sidecar, node),
    companion: {
      name: platform.package,
      version: manifest.version ?? expected ?? '',
      root: companionRoot,
    },
    exe,
  };
}

/**
 * The workspace app, interpreted under Bun. Only reachable without platform
 * pins, so a released CLI can never fall back to a stray `@orcaops/watch`.
 */
function devLaunch(inputs: CompanionInputs): CompanionLaunch | null {
  let appManifest: string;
  try {
    appManifest = inputs.requireResolve('@orcaops/watch/package.json');
  } catch {
    return null;
  }
  const appRoot = path.dirname(appManifest);
  const main = path.join(appRoot, 'dist', 'main.js');
  if (!existsSync(main)) return null;
  const sidecar = path.join(appRoot, 'dist', 'sidecar.js');
  const node = nodeForSidecar(inputs) ?? 'node';
  return {
    kind: 'launch',
    tier: 'dev',
    command: inputs.env.ORCAOPS_WATCH_BUN ?? 'bun',
    args: [main],
    env: handoffEnv(inputs, sidecar, node),
    companion: null,
    exe: main,
  };
}

export interface CompanionDoctorSummary {
  status: 'pass' | 'warn';
  summary: string;
  details: string[];
}

/**
 * What `orcaops doctor` says about a resolution, before any live probe. An
 * absent or broken companion warns with the remedy; an unsupported host and a
 * workspace build pass, because there is nothing to fix.
 */
export function companionDoctorSummary(launch: CompanionLaunch): CompanionDoctorSummary {
  if (launch.kind === 'refuse') {
    const remedy = launch.message.replace(/^orcaops watch: /, '');
    if (launch.tier === 'unsupported') {
      return {
        status: 'pass',
        summary: 'Task Review has no build for this host',
        details: [`  - ${remedy}`],
      };
    }
    const summary =
      launch.tier === 'absent'
        ? 'Task Review companion not installed'
        : launch.tier === 'broken'
          ? 'Task Review companion unusable'
          : 'ORCAOPS_WATCH_BIN is set on a released CLI';
    return { status: 'warn', summary, details: [`  - ${remedy}`] };
  }
  // Workspace-only tiers pass with a bare summary: details on a passing check
  // print in the human report, and a checkout has nothing a user should act on.
  if (launch.tier === 'override') {
    return {
      status: 'pass',
      summary: `Task Review override active (ORCAOPS_WATCH_BIN=${launch.command})`,
      details: [],
    };
  }
  if (launch.tier === 'dev') {
    return {
      status: 'pass',
      summary: 'Task Review runs the workspace build under Bun',
      details: [],
    };
  }
  const companion = launch.companion;
  return {
    status: 'pass',
    summary: `Task Review ready (${companion?.name ?? 'companion'}@${companion?.version ?? '?'})`,
    details: [
      `  - tier=platform companion=${companion?.name ?? ''}@${companion?.version ?? ''}`,
      `  - exe=${launch.exe ?? ''}`,
      `  - node=${launch.env.ORCAOPS_WATCH_NODE ?? ''} sidecar=${launch.env.ORCAOPS_WATCH_SIDECAR ?? ''}`,
      `  - deps_root=${launch.env.ORCAOPS_WATCH_DEPS_ROOT ?? ''}`,
    ],
  };
}

const require = createRequire(import.meta.url);

/** The live CLI: its own manifest (kept unbundled by the release build) and root. */
export function liveCompanionInputs(env: NodeJS.ProcessEnv): CompanionInputs {
  const manifestPath = require.resolve('../../package.json');
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    // Lazy: a diagnostic report is expensive and only a linux lookup needs it.
    get musl() {
      return isMuslHost();
    },
    cliManifest: require(manifestPath) as CompanionManifest,
    cliRoot: path.dirname(manifestPath),
    requireResolve: (specifier) => require.resolve(specifier),
    execPath: process.execPath,
    runningUnderBun: typeof process.versions.bun === 'string',
    homeDir: homedir(),
  };
}

let muslMemo: boolean | null = null;

/**
 * musl only when a diagnostic report exists and names no glibc runtime: a
 * runtime without reports must not be mistaken for Alpine.
 */
function isMuslHost(): boolean {
  if (process.platform !== 'linux') return false;
  if (muslMemo !== null) return muslMemo;
  try {
    const reporting = (
      process as unknown as {
        report?: {
          excludeNetwork?: boolean;
          getReport?: () => { header?: { glibcVersionRuntime?: string } };
        };
      }
    ).report;
    if (reporting?.getReport === undefined) return (muslMemo = false);
    if ('excludeNetwork' in reporting) reporting.excludeNetwork = true;
    const report = reporting.getReport();
    muslMemo = report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
  } catch {
    muslMemo = false;
  }
  return muslMemo;
}
