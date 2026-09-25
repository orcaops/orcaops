import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

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
  const toolAccessVersion = sourceConstant(
    configSource,
    'KNOWLEDGE_PROCESSING_TOOL_ACCESS_CONFIG_VERSION'
  );
  const processingVersion = sourceConstant(configSource, 'KNOWLEDGE_PROCESSING_CONFIG_VERSION');
  const freshVersion = sourceConstant(configSource, 'FRESH_CONFIG_FILE_VERSION');
  const configGuide = await readDocs('content/configuration.md');
  if (!configGuide.includes(`"schema_version": ${freshVersion}`)) {
    fail(`the configuration example does not use FRESH_CONFIG_FILE_VERSION ${freshVersion}`);
  }
  const configProse = configGuide.replace(/\s+/g, ' ');
  if (!configProse.includes(`A new file gets \`${freshVersion}\``)) {
    fail(`the configuration guide does not say a new file is stamped ${freshVersion}`);
  }
  if (!configProse.includes(`The section needs \`schema_version\` ${processingVersion}.`)) {
    fail(`the configuration guide does not say knowledge_processing needs ${processingVersion}`);
  }
  if (
    !configProse.includes(`\`tool_access\` field requires \`schema_version: ${toolAccessVersion}\``)
  ) {
    fail(`the configuration guide does not say tool_access needs ${toolAccessVersion}`);
  }

  const sources = {
    run: await readRepo('packages/review-engine/src/twolaneRunFile.ts'),
    slice: await readRepo('packages/review-engine/src/twolaneSlice.ts'),
    model: await readRepo('packages/review-engine/src/storyReviewModel.ts'),
    floor: await readRepo('packages/review-engine/src/floor.ts'),
  };
  const expected =
    `Current routine contract versions are run schema ${sourceConstant(sources.run, 'TWOLANE_RUN_SCHEMA_VERSION')}, ` +
    `slice state schema ${sourceConstant(sources.slice, 'SLICE_SCHEMA_VERSION')}, Story review model schema ` +
    `${sourceConstant(sources.model, 'STORY_REVIEW_MODEL_SCHEMA_VERSION')}, and floor producer version ` +
    `${sourceConstant(sources.floor, 'FLOOR_PRODUCER_VERSION')}.`;
  const protocol = (await readDocs('content/task-review-protocol.md')).replace(/\s+/g, ' ');
  if (!protocol.includes(expected))
    fail(`the Task Review contract versions do not match source\nexpected: ${expected}`);
}

async function checkKnowledgeProcessingSettings() {
  const configSource = await readRepo('packages/storage/src/schema/config.ts');
  const schema = configSource.match(
    /const KnowledgeProcessingSchema = z\.strictObject\(\{\n([\s\S]*?)\n\}\);/
  )?.[1];
  const defaults = configSource.match(
    /const KNOWLEDGE_PROCESSING_DEFAULTS: KnowledgeProcessingConfig = \{\n([\s\S]*?)\n\};/
  )?.[1];
  if (!schema || !defaults) fail('could not read the knowledge_processing schema from source');
  const defaultByKey = new Map(
    [...defaults.matchAll(/^ {2}(\w+): (.+),$/gm)].map((match) => [
      match[1],
      match[2].replaceAll('_', '').replaceAll("'", '"'),
    ])
  );
  const expected = [...schema.matchAll(/^ {2}(\w+):/gm)].map((match) => [
    match[1],
    defaultByKey.has(match[1]) ? `\`${defaultByKey.get(match[1])}\`` : 'unset',
  ]);

  const guide = await readDocs('content/configuration.md');
  const section = guide.slice(
    guide.indexOf('## Background knowledge processing'),
    guide.indexOf('## Configuration guides')
  );
  const actual = [...section.matchAll(/^\| `(\w+)` +\| (\S+) +\|/gm)].map((match) => [
    match[1],
    match[2],
  ]);
  sameValues(actual, expected, 'the knowledge_processing settings and defaults');

  const minimumTimeout = configSource
    .match(/export const KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS = ([\d_]+);/)?.[1]
    ?.replaceAll('_', '');
  if (!minimumTimeout) fail('could not read KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS from source');
  if (!section.includes(`Time allowed for one call, ${minimumTimeout} to `)) {
    fail(`the timeout_ms row does not start its range at ${minimumTimeout}`);
  }
}

// The guide says in prose which provider can run knowledge processing and what
// each does with a dollar amount. Those sentences are true only for these
// capability values, so a change here has to come with a change to the guide.
async function checkKnowledgeProcessingProviderFacts() {
  const source = await readRepo('packages/llm/src/provider-capabilities.ts');
  const declared = (provider) => {
    const block = source.match(
      new RegExp(`\\b${provider}: Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`)
    )?.[1];
    if (!block) fail(`could not read the ${provider} capabilities from source`);
    return {
      enforcesNoToolExecution: block.match(/enforcesNoToolExecution: (\w+)/)?.[1],
      spendCap: block.match(/spendCap: '(\w+)'/)?.[1],
    };
  };
  sameValues(
    { claude: declared('claude'), codex: declared('codex') },
    {
      claude: { enforcesNoToolExecution: 'true', spendCap: 'stops_after_exceeded' },
      codex: { enforcesNoToolExecution: 'false', spendCap: 'none' },
    },
    'the provider capabilities the knowledge processing guide describes'
  );
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

  // The knowledge family is how a person turns paid processing on and off, so
  // the page has to carry every verb the CLI registers, and no verb it does not.
  // A verb registered hidden is not one of them: orcaops starts the worker
  // itself and nobody types it, so it is left out of the page as it is out of
  // help. Every other verb must appear, hidden or not is the only exemption.
  //
  // Matched on the group each verb is registered ON, so a verb of a verb —
  // `reconsider open` and its siblings — is checked against its own row below
  // rather than read as a verb of `knowledge` that the page never claimed.
  const knowledge = cli.slice(cli.indexOf('const knowledgeCmd'), cli.indexOf('// ── skills ─'));
  const verbsOf = (source, group) => [
    ...source.matchAll(
      new RegExp(
        `\\b${group}\\s*\\n\\s+\\.command\\('(\\w+)'(?<hidden>, \\{ hidden: true \\})?\\)`,
        'g'
      )
    ),
  ];
  const registered = verbsOf(knowledge, 'knowledgeCmd')
    .filter((match) => match.groups.hidden === undefined)
    .map((match) => match[1])
    .sort();
  if (registered.length === 0) fail('could not read the knowledge subcommands from the CLI');
  const documented = [...guide.matchAll(/`orcaops knowledge (\w+)`\s+\|/g)]
    .map((match) => match[1])
    .sort();
  sameValues(documented, registered, 'the documented orcaops knowledge verbs');

  const reconsider = verbsOf(knowledge, 'reconsiderCmd')
    .filter((match) => match.groups.hidden === undefined)
    .map((match) => match[1])
    .sort();
  if (reconsider.length === 0) fail('could not read the reconsider subcommands from the CLI');
  const documentedReconsider = [
    ...new Set(
      [...guide.matchAll(/`orcaops knowledge reconsider (\w+)[^`]*`/g)].map((match) => match[1])
    ),
  ].sort();
  sameValues(documentedReconsider, reconsider, 'the documented orcaops knowledge reconsider verbs');

  const assignment = verbsOf(knowledge, 'assignmentCmd')
    .filter((match) => match.groups.hidden === undefined)
    .map((match) => match[1])
    .sort();
  if (assignment.length === 0) fail('could not read the assignment subcommands from the CLI');
  const documentedAssignment = [
    ...new Set(
      [...guide.matchAll(/`orcaops knowledge assignment (\w+)[^`]*`/g)].map((match) => match[1])
    ),
  ].sort();
  sameValues(documentedAssignment, assignment, 'the documented orcaops knowledge assignment verbs');

  // Consent is interactive only. A non-interactive flag on this family would
  // change what the page promises, so it may not appear without one.
  for (const bypass of ['--yes', '--force', '--non-interactive']) {
    if (knowledge.includes(`'${bypass}`)) {
      fail(`orcaops knowledge registers ${bypass}, which the command reference rules out`);
    }
  }

  // The history family is how a person upgrades a project database and gets one
  // back, so the page has to carry every verb the CLI registers, and no verb it
  // does not.
  const history = cli.slice(
    cli.indexOf('const historyCmd'),
    cli.indexOf('// ── status / list / show ─')
  );
  const historyVerbs = [...history.matchAll(/^\s+\.command\('([\w-]+)(?: <[^']+>)?'\)$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'history') // the group itself, not one of its verbs
    .sort();
  if (historyVerbs.length === 0) fail('could not read the history subcommands from the CLI');
  const documentedHistory = [
    ...new Set(
      [...guide.matchAll(/`orcaops history ([\w-]+)(?: <[^`]+>)?`/g)].map((match) => match[1])
    ),
  ].sort();
  sameValues(documentedHistory, historyVerbs, 'the documented orcaops history verbs');

  // Upgrading and restoring preview by default; the page promises that nothing
  // happens without the explicit flag.
  for (const verb of ['upgrade', 'restore']) {
    if (
      !new RegExp(`\\.command\\('${verb}(?: <[^']+>)?'\\)[\\s\\S]*?\\.option\\(\\s*'--apply`).test(
        history
      )
    )
      fail(
        `orcaops history ${verb} does not register --apply, which the command reference promises`
      );
  }
}

// The authoring guide is the only place an external pack author learns the
// envelope literal, the SDK version line a stale pack must move to, and every
// bound a finding is held to. None of them is derivable from a shipped
// artifact, so each one is a promise that has to come from the source.
async function checkEvaluatorAuthoringFacts() {
  const envelopeSource = await readRepo(
    'packages/evaluator-protocol/src/schemas/result-envelope.ts'
  );
  const findingSource = await readRepo('packages/evaluator-protocol/src/schemas/finding.ts');
  const blockSource = await readRepo('packages/evaluator-protocol/src/findings-block.ts');
  const guide = await readDocs('content/authoring-evaluator-packs.md');
  const evaluatorGuide = await readDocs('content/evaluators.md');
  const knowledgeGuide = await readDocs('content/project-knowledge-reference.md');
  const guideProse = guide.replace(/\s+/g, ' ');

  const stringConstant = (source, name) => {
    const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
    if (!match) fail(`could not read ${name} from source`);
    return match[1];
  };

  for (const [name, source] of [
    ['CURRENT_RESULT_ENVELOPE_SCHEMA', envelopeSource],
    ['REQUIRED_EVALUATOR_SDK_VERSION_LINE', envelopeSource],
    ['FINDINGS_BLOCK_SCHEMA', findingSource],
    ['FINDINGS_BLOCK_INFO_STRING', blockSource],
  ]) {
    const value = stringConstant(source, name);
    if (!guide.includes(value)) {
      fail(`the authoring guide does not name ${name} ("${value}")`);
    }
  }

  for (const [name, source] of [
    ['CURRENT_RESULT_ENVELOPE_SCHEMA', envelopeSource],
    ['REQUIRED_EVALUATOR_SDK_VERSION_LINE', envelopeSource],
  ]) {
    const value = stringConstant(source, name);
    for (const [label, page] of [
      ['the evaluator guide', evaluatorGuide],
      ['the project knowledge guide', knowledgeGuide],
    ]) {
      if (!page.includes(value)) fail(`${label} does not name ${name} ("${value}")`);
    }
  }

  // The literal an old pack still emits: the guide has to name it, because
  // "change this one string" is the whole upgrade for a hand-written envelope.
  const supersededBlock = envelopeSource.match(
    /SUPERSEDED_RESULT_ENVELOPE_SCHEMAS[\s\S]*?\];/
  )?.[0];
  const superseded = [...(supersededBlock ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (superseded.length === 0) fail('could not read SUPERSEDED_RESULT_ENVELOPE_SCHEMAS');
  for (const literal of superseded) {
    if (!guide.includes(literal)) {
      fail(`the authoring guide does not tell an author to replace "${literal}"`);
    }
  }

  const bounds = [
    ['MAX_EVALUATOR_FINDINGS', (n) => `At most ${n} findings`],
    ['MAX_FINDING_TITLE_CHARS', (n) => `a \`title\` at ${n} characters`],
    ['MAX_FINDING_DETAIL_CHARS', (n) => `a \`detail\` at ${n}`],
    ['MAX_FINDING_LOCATIONS', (n) => `${n} locations per finding`],
    ['MAX_FINDING_KEY_CHARS', (n) => `at most ${n} characters of letters`],
  ];
  for (const [name, sentence] of bounds) {
    const expected = sentence(sourceConstant(findingSource, name));
    if (!guideProse.includes(expected)) {
      fail(`the authoring guide does not state ${name}\nexpected: ${expected}`);
    }
  }

  // A location kind or a conclusion the guide omits is one an author never
  // reaches: nothing else tells them the vocabulary is closed.
  const kinds = [...findingSource.matchAll(/kind: z\.literal\('([^']+)'\)/g)].map(
    (match) => match[1]
  );
  if (kinds.length === 0) fail('could not read the finding location kinds from source');
  const conclusions = [
    ...(
      findingSource.match(/EvaluatorFindingConclusionSchema = z\.enum\(\[([^\]]*)\]/)?.[1] ?? ''
    ).matchAll(/'([^']+)'/g),
  ].map((match) => match[1]);
  if (conclusions.length === 0) fail('could not read the finding conclusions from source');
  for (const term of [...kinds, ...conclusions]) {
    if (!guide.includes(`\`${term}\``)) {
      fail(`the authoring guide does not document \`${term}\``);
    }
  }
}

// The enforcement statement is a promise about the code. Every row names a
// boundary and cites the symbol that makes it, so a symbol that moved or was
// deleted must not leave a live guarantee behind; and every statement has to be
// one of the three sentence shapes, because a fourth wording is how "enforces"
// and "observes" start meaning the same thing to a reader.
async function enforcementRows() {
  const page = await readDocs('content/local-data.md');
  const start = page.indexOf('## What Orcaops enforces, and what it only observes');
  if (start < 0) fail('local-data.md has no enforcement statement section');
  const section = page.slice(start, page.indexOf('\n## ', start + 1));
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 3 || cells[0] === 'Check' || /^-+$/.test(cells[0])) continue;
    const where = cells[2].match(/^`([^`]+)` in `([^`]+)`$/);
    if (!where) fail(`the enforcement row "${cells[0]}" does not cite \`symbol\` in \`path\``);
    rows.push({ check: cells[0], statement: cells[1], symbol: where[1], file: where[2] });
  }
  if (rows.length === 0) fail('the enforcement statement table has no rows');
  return rows;
}

async function checkEnforcementStatements() {
  const expected = [
    [
      'An assignment delegates no more than its assigner holds',
      'enforces',
      'publishProjectAssignment',
      'packages/storage/src/history/database/knowledge-assignments.ts',
    ],
    [
      'An act is covered by the authority it cites',
      'enforces',
      'requireAuthority',
      'packages/storage/src/history/database/knowledge-authority.ts',
    ],
    [
      'A correction is covered by the authority it cites',
      'enforces',
      'checkCorrection',
      'packages/storage/src/schema/knowledge-contract.ts',
    ],
    [
      'An act rests on authority that still stands when work is integrated',
      'enforces',
      'assertIntegrationPublication',
      'apps/orcaops-cli/src/lib/integration-authority-gate.ts',
    ],
    [
      'Background processing has a consent grant covering the job',
      'enforces',
      'evaluateProcessingConsent',
      'apps/orcaops-cli/src/lib/knowledge-processing-consent.ts',
    ],
    [
      'An evaluator pack has a grant covering its engine capabilities',
      'enforces',
      'evaluateConsentGate',
      'packages/evaluator-runner/src/trust-capability.ts',
    ],
    [
      'A per-call spend cap the provider can hold as a ceiling',
      'enforces',
      'resolveNoToolCall',
      'packages/llm/src/provider-capabilities.ts',
    ],
    [
      'The daily spend budget and the hourly call allowance',
      'enforces',
      'decideProcessingCall',
      'packages/storage/src/history/database/processing-usage.ts',
    ],
    [
      'The response size one processing call may return',
      'enforces',
      'runPreparedInputCall',
      'packages/llm/src/prepared-input-call.ts',
    ],
    [
      'The transport ceiling on the evidence one review carries',
      'enforces',
      'buildDossier',
      'packages/review-engine/src/dossier.ts',
    ],
    [
      'The identity an act claims',
      'enforces',
      'checkAuthorization',
      'packages/storage/src/schema/knowledge-contract.ts',
    ],
    [
      'The escalation conditions an assignment records',
      'observes',
      'knowledgeAssignmentEntry',
      'apps/orcaops-cli/src/lib/knowledge-assignment-view.ts',
    ],
    [
      'The tokens and cost a provider reports',
      'observes',
      'settleProcessingCall',
      'packages/storage/src/history/database/processing-usage.ts',
    ],
    [
      'Which agent invoked a command',
      'receives',
      'resolveInvokingAgent',
      'apps/orcaops-cli/src/lib/invoking-agent.ts',
    ],
  ];
  const rows = await enforcementRows();
  const expectedModeWords = new Map(
    expected.map(([check, classification]) => [
      check,
      check === 'The identity an act claims' ? ['enforces', 'observes'] : [classification],
    ])
  );
  const actual = rows.map((row) => {
    const classification = row.statement.match(/^Orcaops (enforces|observes|receives) /)?.[1];
    if (!classification) fail(`the enforcement row "${row.check}" uses no known statement shape`);
    const modeWords = [...row.statement.matchAll(/\b(enforces|observes|receives)\b/g)].map(
      (match) => match[1]
    );
    sameValues(
      modeWords,
      expectedModeWords.get(row.check),
      `the enforcement words for "${row.check}"`
    );
    return [row.check, classification, row.symbol, row.file];
  });
  sameValues(actual, expected, 'the enforcement boundary classifications');

  for (const row of rows) {
    const source = await readRepo(row.file).catch(() => null);
    if (source === null) fail(`the enforcement row "${row.check}" names a missing ${row.file}`);
    if (!source.includes(row.symbol))
      fail(
        `the enforcement row "${row.check}" cites ${row.symbol}, which ${row.file} does not hold`
      );
  }

  const dispatch = await readRepo('packages/evaluator-runner/src/dispatch.ts');
  const gate = dispatch.indexOf('const consent = evaluateConsentGate(');
  const refusal = dispatch.indexOf('if (!consent.allowed)', gate);
  const command = dispatch.indexOf("if (evaluator.engine.kind === 'command')", refusal);
  const llm = dispatch.indexOf('return runLlmEngine({', command);
  if (gate < 0 || refusal < gate || command < refusal || llm < command) {
    fail('the evaluator consent gate is not enforced before either evaluator engine dispatches');
  }
}

async function checkProjectKnowledgeGuide() {
  const guide = await readDocs('content/project-knowledge.md');
  const reference = await readDocs('content/project-knowledge-reference.md');
  const referenceProse = reference.replace(/\s+/g, ' ');
  const homepage = await readDocs('content/index.md');
  if (!homepage.includes('link: /project-knowledge')) {
    fail('the documentation index does not link to the project knowledge guide');
  }

  const setupSections = [
    '## Turn on background processing',
    '## Starting with an established repository?',
    '## Use and control your knowledge',
  ];
  for (const heading of setupSections) {
    if (!guide.includes(heading)) fail(`the project knowledge guide is missing "${heading}"`);
  }
  for (const command of ['orcaops knowledge enable', 'orcaops knowledge status']) {
    if (!guide.includes(command)) fail(`the project knowledge guide is missing "${command}"`);
  }

  const requiredSections = [
    '## Configuration and consent are separate',
    '## The disclosure before consent',
    '## Restricted Codex processing',
    '## Limits and what they guarantee',
    '## Processing recovery',
    '## Processing coverage',
    '## Database upgrade and recovery',
    '## Evaluator consent and upgrades',
    '## Enforcement, observations, and assertions',
    '## Limits of this release',
  ];
  for (const heading of requiredSections) {
    if (!reference.includes(heading))
      fail(`the project knowledge reference is missing "${heading}"`);
  }

  const coverageSource = await readRepo('packages/core/src/knowledge/context/coverage.ts');
  const declared = coverageSource.match(/KnowledgeProcessingClaim = ([^;]+);/)?.[1];
  if (!declared) fail('could not read KnowledgeProcessingClaim from source');
  const expectedClaims = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const coverageSection = reference.slice(
    reference.indexOf('## Processing coverage'),
    reference.indexOf('## Database upgrade and recovery')
  );
  const documentedClaims = [...coverageSection.matchAll(/^\| `([^`]+)`\s+\|/gm)].map(
    (match) => match[1]
  );
  sameValues(documentedClaims, expectedClaims, 'the documented processing coverage claims');

  const disclosureSource = await readRepo('apps/orcaops-cli/src/lib/knowledge-processing-terms.ts');
  for (const sourceFact of [
    'Provider:',
    'Model:',
    'What is sent:',
    'Tool access: none.',
    'Tool access: Codex restricted.',
    'Limits in force:',
    'Existing captures:',
    'Already waiting:',
  ]) {
    if (!disclosureSource.includes(sourceFact)) {
      fail(`could not find the consent disclosure fact "${sourceFact}" in source`);
    }
  }
  for (const documentedFact of [
    'the provider and effective model',
    'the tool-access policy',
    'not a guarantee that every Codex tool is absent',
    'every effective call, attempt, byte, token, and dollar limit',
    'whether already-admitted captures are included',
    'other clones or machines',
  ]) {
    if (!referenceProse.includes(documentedFact)) {
      fail(`the project knowledge reference omits the disclosure fact "${documentedFact}"`);
    }
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
await checkKnowledgeProcessingSettings();
await checkKnowledgeProcessingProviderFacts();
await checkCommandReference();
await checkEvaluatorAuthoringFacts();
await checkEnforcementStatements();
await checkProjectKnowledgeGuide();
await checkPageCatalog();
process.stdout.write('Documentation facts match source.\n');
