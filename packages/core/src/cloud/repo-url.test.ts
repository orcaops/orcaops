import { describe, expect, it, vi } from 'vitest';

import { canonicalizeRemoteUrl, normalizeRepoUrl, parseSshHostnameLine } from './repo-url.js';
import { stripHttpUserinfo } from '../git/remote-url.js';

describe('normalizeRepoUrl', () => {
  it('collapses SSH and HTTPS variants of the same repo onto a single key', () => {
    const canonical = 'https://github.com/foo/bar';
    expect(normalizeRepoUrl('https://github.com/foo/bar')).toBe(canonical);
    expect(normalizeRepoUrl('https://github.com/foo/bar.git')).toBe(canonical);
    expect(normalizeRepoUrl('http://github.com/foo/bar')).toBe(canonical);
    expect(normalizeRepoUrl('git@github.com:foo/bar.git')).toBe(canonical);
    expect(normalizeRepoUrl('git@github.com:foo/bar')).toBe(canonical);
  });

  it('strips trailing slashes', () => {
    expect(normalizeRepoUrl('https://github.com/foo/bar/')).toBe('https://github.com/foo/bar');
    expect(normalizeRepoUrl('https://github.com/foo/bar.git/')).toBe('https://github.com/foo/bar');
  });

  it('trims whitespace', () => {
    expect(normalizeRepoUrl('  https://github.com/foo/bar  ')).toBe('https://github.com/foo/bar');
  });

  it('handles SSH user prefixes other than `git`', () => {
    // GitLab self-hosted often uses other SSH usernames.
    expect(normalizeRepoUrl('deploy@gitlab.example.com:team/repo.git')).toBe(
      'https://gitlab.example.com/team/repo'
    );
  });

  it('does not strip .git from path segments that only contain it as a substring', () => {
    expect(normalizeRepoUrl('https://github.com/foo/bargit')).toBe('https://github.com/foo/bargit');
  });

  it('returns the empty string for empty / whitespace-only input', () => {
    expect(normalizeRepoUrl('')).toBe('');
    expect(normalizeRepoUrl('   ')).toBe('');
  });

  it('passes through unrecognized shapes with only whitespace + .git trim', () => {
    // file:// and ssh:// URIs aren't collapsed but should still yield stable keys.
    expect(normalizeRepoUrl('file:///srv/repos/foo.git')).toBe('file:///srv/repos/foo');
    expect(normalizeRepoUrl('ssh://user@host/srv/repo.git')).toBe('ssh://user@host/srv/repo');
  });
});

describe('canonicalizeRemoteUrl', () => {
  it('swaps a resolved SSH alias host for its real host, preserving path and .git', async () => {
    const out = await canonicalizeRemoteUrl(
      'git@github.com-alex:orcaops/orcaops.git',
      async () => 'github.com'
    );
    expect(out).toBe('git@github.com:orcaops/orcaops.git');
  });

  it('preserves an SSH user other than `git`', async () => {
    const out = await canonicalizeRemoteUrl(
      'deploy@gitlab.com-alias:team/repo.git',
      async () => 'gitlab.com'
    );
    expect(out).toBe('deploy@gitlab.com:team/repo.git');
  });

  it('returns the raw URL when resolution yields null (e.g. ssh missing)', async () => {
    const raw = 'git@github.com-alex:orcaops/orcaops.git';
    expect(await canonicalizeRemoteUrl(raw, async () => null)).toBe(raw);
  });

  it('returns the raw URL when resolution yields an empty host', async () => {
    const raw = 'git@github.com-alex:orcaops/orcaops.git';
    expect(await canonicalizeRemoteUrl(raw, async () => '')).toBe(raw);
  });

  it('passes an option-looking host to the resolver as data and degrades to raw', async () => {
    // Argv-injection guard: the host token is handed to the resolver verbatim as
    // a single value (defaultResolveHost runs `ssh -G -- <host>`, so ssh treats
    // it as a destination, never as flags). When it can't resolve, ship raw.
    const resolver = vi.fn(async () => null);
    const raw = 'git@-oProxyCommand=evil:org/repo.git';
    expect(await canonicalizeRemoteUrl(raw, resolver)).toBe(raw);
    expect(resolver).toHaveBeenCalledWith('-oProxyCommand=evil');
  });

  it('returns the raw URL when the resolver throws (degrades, never crashes)', async () => {
    const raw = 'git@github.com-alex:orcaops/orcaops.git';
    expect(
      await canonicalizeRemoteUrl(raw, async () => {
        throw new Error('ssh blew up');
      })
    ).toBe(raw);
  });

  it('returns the raw URL byte-for-byte when the host resolves to itself (no alias)', async () => {
    const raw = 'git@github.com:foo/bar.git';
    const out = await canonicalizeRemoteUrl(raw, async (host) => host);
    expect(out).toBe(raw);
  });

  it('does not invoke the resolver for non-SSH inputs', async () => {
    const resolver = vi.fn(async (host: string) => host);
    for (const raw of [
      'https://github.com/foo/bar.git',
      'http://github.com/foo/bar',
      'file:///srv/repos/foo.git',
    ]) {
      expect(await canonicalizeRemoteUrl(raw, resolver)).toBe(raw);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('resolves an ssh:// scheme alias host, preserving user and path', async () => {
    const out = await canonicalizeRemoteUrl(
      'ssh://git@github.com-work/org/repo.git',
      async () => 'github.com'
    );
    expect(out).toBe('ssh://git@github.com/org/repo.git');
  });

  it('preserves the port on an ssh:// scheme alias', async () => {
    const out = await canonicalizeRemoteUrl(
      'ssh://git@github.com-work:2222/org/repo.git',
      async () => 'github.com'
    );
    expect(out).toBe('ssh://git@github.com:2222/org/repo.git');
  });

  it('resolves an ssh:// alias with no user', async () => {
    const out = await canonicalizeRemoteUrl(
      'ssh://github.com-work/org/repo.git',
      async () => 'github.com'
    );
    expect(out).toBe('ssh://github.com/org/repo.git');
  });

  it('returns the raw ssh:// URL when the host resolves to itself', async () => {
    const raw = 'ssh://git@github.com/org/repo.git';
    expect(await canonicalizeRemoteUrl(raw, async (host) => host)).toBe(raw);
  });

  it('returns the raw ssh:// URL when resolution fails', async () => {
    const raw = 'ssh://git@github.com-work/org/repo.git';
    expect(await canonicalizeRemoteUrl(raw, async () => null)).toBe(raw);
  });
});

describe('parseSshHostnameLine', () => {
  // `ssh -G <host>` emits one lowercased `key value` pair per line.
  const sshGOutput = [
    'host github.com-alex',
    'user git',
    'hostname github.com',
    'port 22',
    'hostkeyalgorithms ssh-ed25519,rsa-sha2-512',
    'identityfile ~/.ssh/id_ed25519_alex',
  ].join('\n');

  it('extracts the host from the `hostname` line', () => {
    expect(parseSshHostnameLine(sshGOutput)).toBe('github.com');
  });

  it('does not match keys that merely start with `host`', () => {
    const noHostname = ['user git', 'hostkeyalgorithms ssh-ed25519', 'port 22'].join('\n');
    expect(parseSshHostnameLine(noHostname)).toBeNull();
  });

  it('returns null when there is no hostname line', () => {
    expect(parseSshHostnameLine('')).toBeNull();
    expect(parseSshHostnameLine('user git\nport 22')).toBeNull();
  });
});

describe('stripHttpUserinfo', () => {
  // A dead placeholder shaped like a GitHub token; never a live credential.
  const TOKEN = 'ghp_0000000000000000000000000000000000000';

  it('removes a credential from an http(s) remote', () => {
    expect(stripHttpUserinfo(`https://x-access-token:${TOKEN}@github.com/foo/bar.git`)).toBe(
      'https://github.com/foo/bar.git'
    );
    expect(stripHttpUserinfo('http://alice:pw@gitlab.com/foo/bar')).toBe(
      'http://gitlab.com/foo/bar'
    );
    expect(stripHttpUserinfo('https://alice@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar'
    );
  });

  it('leaves every other shape byte-identical', () => {
    for (const url of [
      'https://github.com/foo/bar.git',
      'git@github.com:foo/bar.git',
      'ssh://git@github.com:22/foo/bar.git',
      'file:///srv/git/repo.git',
      '/plain/local/path',
      '',
    ]) {
      expect(stripHttpUserinfo(url)).toBe(url);
    }
  });

  it('does not confuse an @ in a query or fragment with userinfo', () => {
    // The authority ends at the first `/`, `?` or `#`. Terminating on `/` alone
    // rewrote these onto the host after the `@` — a valid URL turned into a
    // different, attacker-named one, in both the identity key and the wire URL.
    expect(stripHttpUserinfo('https://real.example.com?x@evil.example.com')).toBe(
      'https://real.example.com?x@evil.example.com'
    );
    expect(stripHttpUserinfo('https://real.example.com:8443#f@evil.example.com')).toBe(
      'https://real.example.com:8443#f@evil.example.com'
    );
    expect(normalizeRepoUrl('https://real.example.com?x@evil.example.com')).toContain(
      'real.example.com'
    );
  });

  it('does not confuse an @ in the path with userinfo', () => {
    expect(stripHttpUserinfo('https://github.com/foo/bar@baz')).toBe(
      'https://github.com/foo/bar@baz'
    );
  });

  it('takes the last @ in the authority, as a URL parser does', () => {
    expect(stripHttpUserinfo('https://user:p@ss@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar'
    );
  });

  it('keeps a credential out of the identity key and the wire URL', async () => {
    const withCredential = `https://x-access-token:${TOKEN}@github.com/foo/bar.git`;
    expect(normalizeRepoUrl(withCredential)).toBe('https://github.com/foo/bar');
    await expect(canonicalizeRemoteUrl(withCredential)).resolves.toBe(
      'https://github.com/foo/bar.git'
    );
  });

  it('preserves the SSH username, which is not a credential', async () => {
    await expect(canonicalizeRemoteUrl('git@github.com:foo/bar.git')).resolves.toBe(
      'git@github.com:foo/bar.git'
    );
  });
});
