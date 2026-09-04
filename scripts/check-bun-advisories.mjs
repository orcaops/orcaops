#!/usr/bin/env node
// The weekly audit cannot see the Bun runtime: it is not a lockfile dependency,
// every compiled Watch executable embeds it, and JavaScriptCore/WebKit CVEs
// live outside the npm ecosystem entirely. This reports what can be checked —
// GitHub advisories against the npm `bun` package at the pinned version, and
// how far the pin trails Bun's latest release — and says plainly what cannot.
// It never fails the audit on its own: the signal lands in the job summary.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINORS_BEHIND_TO_WARN = 2;

const pinned = readFileSync(path.join(ROOT, '.bun-version'), 'utf8').trim();
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'orcaops-bun-advisory-check',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function github(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

const lines = [`Bun pinned by .bun-version: ${pinned}`];
let warn = false;
try {
  const advisories = await github(
    `/advisories?ecosystem=npm&affects=${encodeURIComponent(`bun@${pinned}`)}&per_page=100`
  );
  if (advisories.length === 0) {
    lines.push(`GitHub advisories affecting npm bun@${pinned}: none`);
  } else {
    warn = true;
    lines.push(`GitHub advisories affecting npm bun@${pinned}: ${advisories.length}`);
    for (const a of advisories) lines.push(`  - ${a.ghsa_id} (${a.severity}): ${a.summary}`);
  }

  const latest = await github('/repos/oven-sh/bun/releases/latest');
  const latestVersion = parseVersion(latest.tag_name ?? '');
  const pinnedVersion = parseVersion(pinned);
  if (latestVersion !== null && pinnedVersion !== null) {
    const behind =
      latestVersion.major !== pinnedVersion.major
        ? Number.POSITIVE_INFINITY
        : latestVersion.minor - pinnedVersion.minor;
    lines.push(
      `Latest Bun release: ${latest.tag_name} (${latest.published_at?.slice(0, 10) ?? 'date unknown'})`
    );
    if (behind > MINORS_BEHIND_TO_WARN) {
      warn = true;
      lines.push(
        `  - the pin trails the latest release by ${behind === Number.POSITIVE_INFINITY ? 'a major version' : `${behind} minor versions`}; review Bun's release notes for security fixes before the next release`
      );
    }
  }
} catch (error) {
  lines.push(
    `Could not query GitHub: ${error?.message ?? error} — re-run when the API is reachable`
  );
}
lines.push(
  'JavaScriptCore/WebKit advisories are not machine-checkable here: review Bun release notes when moving the pin.'
);

for (const line of lines) process.stdout.write(`${line}\n`);
if (warn)
  process.stdout.write('::warning::the pinned Bun runtime needs review — see the job summary\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '## Bun runtime (embedded in the Watch executables)',
      '',
      ...lines.map((l) => `- ${l.replace(/^  - /, '  - ')}`),
      '',
    ].join('\n')
  );
}
