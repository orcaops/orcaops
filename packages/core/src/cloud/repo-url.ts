import { spawn } from 'node:child_process';

import { stripHttpUserinfo } from '../git/remote-url.js';

/**
 * Canonicalize a git remote URL into a single string suitable for use as an
 * identity key. Folds the common protocol and suffix variants so two clones
 * of the same repo configured with slightly different remote URLs key to the
 * same value.
 *
 * Forms collapsed (case-insensitive host comparison preserved by Postgres on
 * the cloud side; CLI just normalizes the structural variants):
 *
 *   https://host/org/repo            ─┐
 *   https://host/org/repo.git        ─┤
 *   http://host/org/repo             ─┤→ https://host/org/repo
 *   user@host:org/repo.git           ─┤
 *   user@host:org/repo               ─┘
 *
 * Unrecognized shapes (e.g. file:// URIs, custom SSH paths) pass through with
 * only whitespace + trailing `.git` stripped — the caller still gets a
 * stable key, just one that may not collapse all peer variants. Cloud-side
 * `repo.upsertByRemote` keeps its own normalization; this helper is for the
 * CLI's SQLite `(repoUrl, workingDir)` PK only.
 */
export function normalizeRepoUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;

  // SSH form: `user@host:path` — collapsed to `https://host/path` so a clone
  // switched between SSH and HTTPS keeps the same identity key.
  const scp = parseScpLikeSsh(trimmed);
  if (scp) {
    const path = stripLeadingSlashes(scp.path);
    return `https://${scp.host}/${stripDotGit(path)}`;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    // Belt and braces: `getRemoteUrl` already strips this, but the identity
    // key must never carry a credential regardless of who supplies the URL.
    const bare = stripHttpUserinfo(trimmed);
    const rest = stripDotGit(stripTrailingSlashes(bare.slice(bare.indexOf('://') + 3)));
    return `https://${rest}`;
  }

  return stripDotGit(stripTrailingSlashes(trimmed));
}

interface ScpLikeSsh {
  user: string;
  host: string;
  path: string;
}

/**
 * Parse an scp-like SSH remote (`user@host:path`) into its parts, or return
 * null for any other shape (`https://`, `ssh://`, `file://`, plain paths).
 *
 * Shared by `normalizeRepoUrl` (which rewrites to https for the local PK) and
 * `canonicalizeRemoteUrl` (which resolves SSH host aliases for the wire) so the
 * two stay in lockstep on what counts as scp-like. The `slashSlash > colon`
 * guard is what keeps scheme URLs like `ssh://user@host/path` out of this
 * branch. `path` is returned verbatim (leading slashes and trailing `.git`
 * intact) — callers strip as they need.
 */
function parseScpLikeSsh(trimmed: string): ScpLikeSsh | null {
  const at = trimmed.indexOf('@');
  const colon = trimmed.indexOf(':');
  const slashSlash = trimmed.indexOf('://');
  const isSsh = at > 0 && colon > at && (slashSlash === -1 || slashSlash > colon);
  if (!isSsh) return null;
  return {
    user: trimmed.slice(0, at),
    host: trimmed.slice(at + 1, colon),
    path: trimmed.slice(colon + 1),
  };
}

interface SshUrl {
  user: string | null;
  host: string;
  port: string | null;
  path: string;
}

/**
 * Parse an `ssh://[user@]host[:port]/path` scheme URL into its parts, or null
 * for any non-ssh:// shape. Lets `canonicalizeRemoteUrl` resolve SSH aliases
 * written in URL form (`ssh://git@github.com-work/org/repo.git`) the same way
 * as scp-like remotes. IPv6 literal hosts (rare for git ssh:// remotes) don't
 * match and fall through to a raw passthrough.
 */
function parseSshUrl(trimmed: string): SshUrl | null {
  const m = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/i.exec(trimmed);
  if (!m) return null;
  return { user: m[1] ?? null, host: m[2]!, port: m[3] ?? null, path: m[4] ?? '' };
}

/**
 * Resolve a (possibly aliased) SSH host to its real hostname, or null when
 * resolution isn't possible. Injected into `canonicalizeRemoteUrl` so the pure
 * URL logic stays unit-testable without spawning a process.
 */
export type HostResolver = (host: string) => Promise<string | null>;

/**
 * Canonicalize a git remote URL for the cloud wire by resolving SSH host
 * aliases to their real hostname.
 *
 * Multi-account setups alias a host in `~/.ssh/config` (e.g. `Host
 * github.com-work` → `HostName github.com`) and clone via the alias, so the
 * remote reads `git@github.com-work:org/repo.git`. The cloud keys repos on the
 * host and only knows the real ones, so it rejects the alias outright. We run
 * `ssh -G` to resolve the alias and swap the real host back in.
 *
 * Surgical by design: handles both scp-like (`git@host:path`) and `ssh://`
 * scheme remotes, and only rewrites when the host actually resolves to a
 * *different* host — and then only the host token changes (SSH user, port, and
 * path, including any trailing `.git`, are preserved), so a rewritten alias is
 * byte-identical to the equivalent non-aliased clone. Everything else (https,
 * file://, non-aliased SSH) is returned unchanged. If resolution fails for any
 * reason — missing `ssh`, non-zero exit, timeout, no `hostname` line — the raw
 * URL is returned and the cloud stays the host-validation backstop; this never
 * throws on a resolution failure.
 *
 * Unlike `normalizeRepoUrl` (pure/sync, used for the local SQLite PK) this is
 * async because it shells out to `ssh -G`.
 */
export async function canonicalizeRemoteUrl(
  raw: string,
  resolveHost: HostResolver = defaultResolveHost
): Promise<string> {
  const trimmed = raw.trim();
  const scp = parseScpLikeSsh(trimmed);
  const ssh = scp ? null : parseSshUrl(trimmed);
  const aliasHost = scp?.host ?? ssh?.host;
  if (aliasHost === undefined) return stripHttpUserinfo(raw);

  let host = aliasHost;
  let resolved = false;
  try {
    const r = await resolveHost(aliasHost);
    if (r !== null && r.length > 0) {
      host = r;
      resolved = true;
    }
  } catch {
    // Degrade: a resolver failure must never block the push. Ship the raw URL;
    // the cloud remains the host-validation backstop.
  }

  if (!resolved || host === aliasHost) return raw;
  if (scp) return `${scp.user}@${host}:${scp.path}`;
  // ssh:// scheme — swap only the host, preserving user, port, and path.
  const userPart = ssh!.user !== null ? `${ssh!.user}@` : '';
  const portPart = ssh!.port !== null ? `:${ssh!.port}` : '';
  return `ssh://${userPart}${host}${portPart}${ssh!.path}`;
}

/**
 * Extract the resolved hostname from `ssh -G <host>` output. The command prints
 * one `key value` pair per line with lowercased keys; the `hostname` line
 * carries the real host the alias maps to. Returns null when absent.
 *
 * Exported as the pure, unit-testable seam of `defaultResolveHost` so we don't
 * have to spawn a real `ssh` to cover the parse.
 */
export function parseSshHostnameLine(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('hostname ')) {
      const value = trimmed.slice('hostname '.length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

const SSH_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Resolve an SSH host alias via `ssh -G <host>`, which reads `~/.ssh/config`
 * and prints the effective config (including the real `hostname`) without
 * opening a connection. Returns null — never throws — when `ssh` is missing,
 * exits non-zero, times out, or omits a `hostname` line, so a flaky or absent
 * `ssh` degrades to "ship the raw URL" instead of failing the push.
 */
function defaultResolveHost(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // `--` terminates ssh option parsing, so an option-looking host token (e.g.
    // a remote whose host is `-F<file>` or `-oProxyCommand=...`) is treated as a
    // destination rather than ssh flags. ssh then rejects it as an invalid
    // hostname (non-zero exit) and we degrade to the raw URL.
    const child = spawn('ssh', ['-G', '--', host], { stdio: ['ignore', 'pipe', 'ignore'] });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, SSH_RESOLVE_TIMEOUT_MS);
    timer.unref();

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? parseSshHostnameLine(stdout) : null);
    });
  });
}

function stripDotGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

function stripLeadingSlashes(s: string): string {
  return s.replace(/^\/+/, '');
}
