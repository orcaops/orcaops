import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const docsRoot = join(repoRoot, 'apps/docs');
const contentRoot = join(docsRoot, 'content');

const readRepo = (path) => readFile(join(repoRoot, path), 'utf8');
const readDocs = (path) => readFile(join(docsRoot, path), 'utf8');

function fail(message) {
  throw new Error(`Documentation fact check failed: ${message}`);
}

function sourceConstant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = ['"]?(\\d+)`));
  if (!match) fail(`could not read ${name} from source`);
  return Number(match[1]);
}

function sameValues(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${label} drifted\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`
    );
  }
}

async function checkSkillCatalog() {
  const registry = await readRepo('packages/adapters/src/skills/index.ts');
  const registryBody = registry.slice(
    registry.indexOf('export const SKILL_TEMPLATES'),
    registry.indexOf('\n];', registry.indexOf('export const SKILL_TEMPLATES'))
  );
  const registeredNames = [...new Set(registryBody.match(/orcaops[A-Z][A-Za-z]+Skill/g) ?? [])];
  const imports = new Map(
    [...registry.matchAll(/import \{ (orcaops[A-Za-z]+Skill) \} from '\.\/(.+)\.js';/g)].map(
      (match) => [match[1], match[2]]
    )
  );
  const requirementLabels = new Map([
    ['cloud', 'Cloud'],
    ['snapshot-checkout', 'Snapshot checkout'],
    ['matcher', 'Matcher'],
  ]);

  const expected = [];
  for (const name of registeredNames) {
    const module = imports.get(name);
    if (!module) fail(`could not resolve the source module for ${name}`);
    const source = await readRepo(`packages/adapters/src/skills/${module}.ts`);
    const id = source.match(/\bid: '([^']+)'/)?.[1];
    if (!id) fail(`could not read the skill id from ${module}.ts`);
    const requirement = source.match(/\brequires: \['([^']+)'\]/)?.[1];
    expected.push({
      id,
      state: source.includes('defaultEnabled: false') ? 'Opt-in' : 'Default',
      requirement: requirement ? requirementLabels.get(requirement) : 'None',
    });
  }

  const skills = await readDocs('content/skills.md');
  const catalog = skills.slice(
    skills.indexOf('## Complete skill index'),
    skills.indexOf('## If a skill does not trigger')
  );
  const actual = [
    ...catalog.matchAll(/^\| `orcaops-([^`]+)`\s+\|\s+(Default|Opt-in)\s+\|\s+([^|]+?)\s+\|/gm),
  ].map((match) => ({ id: match[1], state: match[2], requirement: match[3].trim() }));
  sameValues(actual, expected, 'the canonical skill index');
}

async function checkCliOutputMarkers() {
  const examples = new Map([
    ['content/getting-started.md', ['init-summary']],
    ['content/seed.md', ['seed-preview']],
    ['content/evaluators.md', ['eval-empty']],
    ['content/troubleshooting.md', ['doctor-seed-warning']],
  ]);

  for (const [file, ids] of examples) {
    const content = await readDocs(file);
    for (const id of ids) {
      const start = `<!-- cli-output:${id}:start -->`;
      const end = `<!-- cli-output:${id}:end -->`;
      if (content.split(start).length !== 2 || content.split(end).length !== 2) {
        fail(`${file} must contain exactly one ${id} CLI-output marker pair`);
      }
      const body = content.slice(content.indexOf(start) + start.length, content.indexOf(end));
      if (!/^\s*```text\n[\s\S]+\n```\s*$/u.test(body)) {
        fail(`${file} must keep ${id} in one fenced text block`);
      }
    }
  }
}

async function checkSupportedAgents() {
  const configSource = await readRepo('packages/storage/src/schema/config.ts');
  const array = configSource.match(/SUPPORTED_AGENT_IDS = \[([\s\S]*?)\] as const/)?.[1];
  if (!array) fail('could not read SUPPORTED_AGENT_IDS');
  const expected = [...array.matchAll(/'([^']+)'/g)].map((match) => match[1]);

  const guide = await readDocs('content/agent-integrations.md');
  const paragraph = guide.slice(
    guide.indexOf('Supported install targets are'),
    guide.indexOf('. Codex, Cursor', guide.indexOf('Supported install targets are'))
  );
  const actual = [...paragraph.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  sameValues(actual, expected, 'the supported install-target list');
}

async function checkVersionedFacts() {
  const configSource = await readRepo('packages/storage/src/schema/config.ts');
  const configVersion = sourceConstant(configSource, 'CONFIG_SCHEMA_VERSION');
  const configGuide = await readDocs('content/configuration.md');
  if (!configGuide.includes(`"schema_version": ${configVersion}`)) {
    fail(`the configuration example does not use CONFIG_SCHEMA_VERSION ${configVersion}`);
  }

  const sources = {
    run: await readRepo('packages/review-engine/src/twolaneRunFile.ts'),
    slice: await readRepo('packages/review-engine/src/twolaneSlice.ts'),
    model: await readRepo('packages/review-engine/src/storyReviewModel.ts'),
    pointer: await readRepo('packages/review-engine/src/currentStory.ts'),
    state: await readRepo('packages/review-engine/src/reviewState.ts'),
    floor: await readRepo('packages/review-engine/src/floor.ts'),
  };
  const expected =
    `Current routine contract versions are run schema ${sourceConstant(sources.run, 'TWOLANE_RUN_SCHEMA_VERSION')}, ` +
    `slice state schema ${sourceConstant(sources.slice, 'SLICE_SCHEMA_VERSION')}, Story review model schema ` +
    `${sourceConstant(sources.model, 'STORY_REVIEW_MODEL_SCHEMA_VERSION')}, current Story pointer schema ` +
    `${sourceConstant(sources.pointer, 'CURRENT_STORY_POINTER_SCHEMA_VERSION')}, durable review-state version ` +
    `${sourceConstant(sources.state, 'REVIEW_STATE_VERSION')}, and floor producer version ` +
    `${sourceConstant(sources.floor, 'FLOOR_PRODUCER_VERSION')}.`;
  const protocol = (await readDocs('content/task-review-protocol.md')).replace(/\s+/g, ' ');
  if (!protocol.includes(expected))
    fail(`the Task Review contract versions do not match source\nexpected: ${expected}`);
}

async function checkCommandReference() {
  const cli = await readRepo('apps/orcaops-cli/src/cli/program.ts');
  const guide = await readDocs('content/command-reference.md');
  for (const command of ['show <ref>', 'schema <kind>', 'remove-pack <pack-id>']) {
    if (!cli.includes(`.command('${command}')`))
      fail(`eval ${command} is not registered by the CLI`);
    if (!guide.includes(`orcaops eval ${command}`))
      fail(`eval ${command} is missing from the command reference`);
  }
}

async function checkPageCatalog() {
  const files = (await readdir(contentRoot)).filter((file) => file.endsWith('.md')).sort();
  const descriptions = [];
  for (const file of files) {
    const source = await readFile(join(contentRoot, file), 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const description = frontmatter.match(/^description: ['"](.+?)['"]$/m)?.[1];
    if (!description) fail(`${file} has no frontmatter description`);
    descriptions.push(description);
  }
  if (new Set(descriptions).size !== descriptions.length) fail('page descriptions must be unique');

  const config = await readDocs('docs.config.mjs');
  const configured = [...config.matchAll(/slug: '([^']+)'/g)]
    .map((match) => `${match[1]}.md`)
    .sort();
  const guides = files.filter((file) => file !== 'index.md');
  sameValues(configured, guides, 'the VitePress page catalog');
}

await checkSkillCatalog();
await checkCliOutputMarkers();
await checkSupportedAgents();
await checkVersionedFacts();
await checkCommandReference();
await checkPageCatalog();
process.stdout.write('Documentation facts match source.\n');
