import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { EnvLike } from '../source.js';

export interface ClaudeTranscriptLocation {
  sessionId: string;
  projectDir: string;
  transcriptPath: string;
}

export function claudeProjectBases(env: EnvLike = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const configured = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return dedupe(configured.map((entry) => projectsBase(entry, home)));
  }

  const xdgHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return dedupe([path.join(xdgHome, 'claude', 'projects'), path.join(home, '.claude', 'projects')]);
}

/**
 * Resolves Claude session anchors using ccusage-compatible root ordering.
 *
 * Roots and project directories are searched in order, and the first anchor
 * wins so every consumer selects the same copy of a session. A cwd-derived
 * project name is only an ordering hint because Claude's encoding is not a
 * reliable location contract; the `<sessionId>.jsonl` file is the anchor.
 */
export class ClaudeTranscriptLocator {
  constructor(private readonly env: EnvLike = process.env) {}

  async locateSession(sessionId: string, cwd?: string): Promise<ClaudeTranscriptLocation | null> {
    const normalized = normalizeSessionId(sessionId);
    if (normalized === null) return null;

    const located = await this.locateSessions(new Set([normalized]), cwd);
    return located.get(normalized) ?? null;
  }

  async locateSessions(
    sessionIds: ReadonlySet<string>,
    cwd?: string
  ): Promise<Map<string, ClaudeTranscriptLocation>> {
    const pending = new Set(
      [...sessionIds]
        .map((sessionId) => normalizeSessionId(sessionId))
        .filter((sessionId): sessionId is string => sessionId !== null)
    );
    const located = new Map<string, ClaudeTranscriptLocation>();
    if (pending.size === 0) return located;

    const preferredProjectDir = cwd?.trim() ? encodeCwd(cwd) : undefined;
    for (const base of claudeProjectBases(this.env)) {
      let projectDirs: string[];
      try {
        projectDirs = (await readdir(base)).sort();
      } catch {
        continue;
      }
      if (preferredProjectDir) {
        projectDirs = [
          preferredProjectDir,
          ...projectDirs.filter((entry) => entry !== preferredProjectDir),
        ];
      }

      for (const projectDirName of projectDirs) {
        const projectDir = path.join(base, projectDirName);
        for (const sessionId of [...pending]) {
          const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
          try {
            if (!(await stat(transcriptPath)).isFile()) continue;
          } catch {
            continue;
          }
          located.set(sessionId, { sessionId, projectDir, transcriptPath });
          pending.delete(sessionId);
        }
        if (pending.size === 0) return located;
      }
    }
    return located;
  }
}

function normalizeSessionId(sessionId: string): string | null {
  const normalized = sessionId.trim();
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    return null;
  }
  return normalized;
}

function projectsBase(raw: string, home: string): string {
  const expanded = expandHome(raw, home);
  return path.basename(expanded) === 'projects' ? expanded : path.join(expanded, 'projects');
}

function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
