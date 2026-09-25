import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { fixture } from './database-history.js';
import { makeAgent } from '../support/test-agent.js';

export type ConsequenceProject = Awaited<ReturnType<typeof fixture>>;

/** `llm.tool: none` keeps passive reads from probing for provider binaries. */
export async function consequenceProject(
  options: { configure?: boolean } = {}
): Promise<ConsequenceProject> {
  const project = await fixture();
  if (options.configure !== false) {
    await mkdir(path.join(project.main, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(project.main, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
      'utf8'
    );
  }
  return project;
}

const agent = (project: ConsequenceProject, session: string) =>
  makeAgent({
    cwd: project.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: project.main,
      ORCAOPS_DATA_DIR: project.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: session,
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: project.temporary + '/unused-state',
    },
  });

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown>;
}

export async function orcaops(
  project: ConsequenceProject,
  args: readonly string[],
  session = 'consequences-session'
): Promise<CommandResult> {
  const raw = await agent(project, session).runRaw([...args]);
  const trimmed = raw.stdout.trimStart();
  return {
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    payload: trimmed.startsWith('{') ? (JSON.parse(trimmed) as Record<string, unknown>) : {},
  };
}

let documents = 0;

// `inputFile` adds an idempotency key, which strict knowledge documents do not accept.
export async function orcaopsWithDocument(
  project: ConsequenceProject,
  args: readonly string[],
  document: unknown,
  session?: string
): Promise<CommandResult> {
  const at = path.join(project.temporary, `document-${(documents += 1)}.json`);
  await writeFile(at, JSON.stringify(document), 'utf8');
  return orcaops(project, [...args, '--input', at], session);
}

export const rowCounts = (writer: ProjectDatabase): Record<string, number> =>
  writer.read((view) =>
    Object.fromEntries(
      view
        .all<{
          name: string;
        }>(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .map(({ name }) => [
          name,
          view.get<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`)!.n,
        ])
    )
  ).value;

// Quoted SQL values keep retained blobs comparable without crossing the read boundary.
export const tableRows = (
  writer: ProjectDatabase,
  tables: readonly string[]
): Record<string, string> =>
  writer.read((view) =>
    Object.fromEntries(
      tables.map((table) => {
        const columns = view
          .all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table)
          .map(({ name }) => `typeof("${name}") || ':' || quote("${name}") AS "${name}"`);
        return [
          table,
          JSON.stringify(
            view
              .all(`SELECT ${columns.join(',')} FROM "${table}"`)
              .map((row) => JSON.stringify(row))
              .sort()
          ),
        ];
      })
    )
  ).value;
