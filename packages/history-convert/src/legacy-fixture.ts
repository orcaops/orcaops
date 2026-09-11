import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { HistoryConversionError } from './errors.js';
import { LEGACY_PRODUCER_VERSION, LEGACY_SOURCE_REVISION } from './profile.js';

const execute = promisify(execFile);

export interface LegacyFixtureMember {
  readonly path: string;
  readonly sha256: string;
  readonly base64: string;
}
export interface LegacyFixture {
  readonly schema_version: 1;
  readonly producer: { readonly version: string; readonly source_revision: string };
  readonly generated_at: string;
  readonly project_id: string;
  readonly artifacts: { readonly one: string; readonly two: string; readonly three: string };
  readonly original_paths: { readonly repository: string; readonly data_root: string };
  readonly repository: {
    readonly head: string;
    readonly branch: string;
    readonly bundle_sha256: string;
    readonly bundle_base64: string;
    readonly refs: readonly { readonly ref: string; readonly oid: string }[];
  };
  readonly checkout_members: readonly LegacyFixtureMember[];
  readonly data_members: readonly LegacyFixtureMember[];
}
export interface MaterializedLegacyFixture {
  readonly fixture: LegacyFixture;
  readonly cwd: string;
  readonly root: string;
  readonly projectId: string;
  readonly env: NodeJS.ProcessEnv;
}

export const LEGACY_FIXTURE_LOCATION = new URL(
  '../fixtures/legacy-0.2.0-rc.2/fixture.json',
  import.meta.url
);

function integrity(message: string, resource?: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, resource);
}

export async function readLegacyFixture(): Promise<LegacyFixture> {
  const fixture = JSON.parse(await readFile(LEGACY_FIXTURE_LOCATION, 'utf8')) as LegacyFixture;
  if (
    fixture.schema_version !== 1 ||
    fixture.producer.version !== LEGACY_PRODUCER_VERSION ||
    fixture.producer.source_revision !== LEGACY_SOURCE_REVISION
  )
    integrity('The committed legacy fixture does not carry the frozen producer profile');
  for (const member of [...fixture.checkout_members, ...fixture.data_members]) {
    const digest = createHash('sha256').update(Buffer.from(member.base64, 'base64')).digest('hex');
    if (digest !== member.sha256)
      integrity('A committed legacy fixture member differs from its recorded hash', member.path);
  }
  const bundle = Buffer.from(fixture.repository.bundle_base64, 'base64');
  if (createHash('sha256').update(bundle).digest('hex') !== fixture.repository.bundle_sha256)
    integrity('The committed legacy fixture bundle differs from its recorded hash');
  return fixture;
}

function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (!key.startsWith('GIT_') && key !== 'ORCAOPS_DATA_DIR' && key !== 'ORCAOPS_ROOT')
      env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

async function writeMembers(root: string, members: readonly LegacyFixtureMember[]) {
  for (const member of members) {
    const parts = member.path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'))
      integrity('The committed legacy fixture names an unsafe member path', member.path);
    const file = path.join(root, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(member.base64, 'base64'));
  }
}

export async function materializeLegacyFixture(input: {
  directory: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MaterializedLegacyFixture> {
  const fixture = await readLegacyFixture();
  const directory = path.resolve(input.directory);
  const cwd = path.join(directory, 'repo');
  const root = path.join(directory, 'data');
  const env = gitEnvironment(input.env ?? process.env);
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  const bundle = path.join(directory, 'fixture.bundle');
  await writeFile(bundle, Buffer.from(fixture.repository.bundle_base64, 'base64'));
  const git = async (...args: string[]) =>
    (await execute('git', ['-C', cwd, ...args], { env })).stdout.trim();
  await git('init', '-qb', fixture.repository.branch);
  await git('fetch', '-q', '--update-head-ok', bundle, '+refs/*:refs/*');
  await git('reset', '-q', '--hard', fixture.repository.head);
  await git('config', '--local', 'orcaops.projectid', fixture.project_id);
  await writeMembers(cwd, fixture.checkout_members);
  await writeMembers(root, fixture.data_members);
  const refs = (await git('for-each-ref', '--format=%(refname) %(objectname)'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, oid] = line.split(' ');
      return { ref: ref!, oid: oid! };
    });
  const expected = [...fixture.repository.refs].sort((a, b) => a.ref.localeCompare(b.ref));
  refs.sort((a, b) => a.ref.localeCompare(b.ref));
  if (JSON.stringify(refs) !== JSON.stringify(expected))
    integrity('Materialized Git refs differ from the committed legacy fixture');
  return { fixture, cwd, root, projectId: fixture.project_id, env };
}
