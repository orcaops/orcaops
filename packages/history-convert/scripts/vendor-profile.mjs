import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const revision = '9cb6e606cebed31a3e22bb928119c04cb041bfc3';
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(path.dirname(packageRoot));
const destination = path.join(packageRoot, 'src', 'legacy');
const prefixes = {
  storage: 'packages/storage/src/',
  protocol: 'packages/evaluator-protocol/src/',
};
const selections = new Map([
  [
    'storage/usage/ledger-log.ts',
    ['LoadedUsageEvent', 'isValidUsagePayload', 'usageRecordContentIdentity'],
  ],
  [
    'storage/usage/ledger.ts',
    ['RebuildUsageLedgerResult', 'replayUsageEventsIntoStore', 'payloadToRow'],
  ],
  ['storage/store/sqlite.ts', ['UsageSnapshotRow', 'SourcePlanLinkRow']],
  ['storage/artifacts/store.ts', ['planMarkdown', 'checkpointMarkdown', 'summaryMarkdown']],
  [
    'storage/events/event-log.ts',
    [
      'EventTypeSchema',
      'EventType',
      'InlineEventRecordSchema',
      'SidecarEventRecordSchema',
      'EventRecordSchema',
      'EventRecord',
      'InlineEventRecord',
      'SidecarEventRecord',
    ],
  ],
  ['storage/ids/uuidv7.ts', ['UUID_V7_REGEX', 'isUuidV7', 'UuidV7Schema']],
  ['storage/artifacts/errors.ts', ['RecoveryRefusedError']],
  ['protocol/containment.ts', ['PathContainmentError', 'assertSafeRelativePath']],
]);
const schemas = [
  'plan',
  'checkpoint',
  'summary',
  'evaluator-run',
  'artifact-json',
  'config',
  'usage-ledger',
  'source-plan',
  'git-import-enrichment',
  'diff-fingerprint',
  'pre-pr-checked',
];
const queue = [
  'storage/usage/ledger.ts',
  'storage/usage/ledger-log.ts',
  'protocol/secrets.ts',
  'storage/artifacts/store.ts',
  ...schemas.map((name) => `storage/schema/${name}.ts`),
  'storage/events/rebuilders.ts',
  'storage/events/canonical-json.ts',
  'protocol/schemas/common.ts',
  'protocol/schemas/run.ts',
  'protocol/schemas/disposition.ts',
  'protocol/schemas/gate-audit.ts',
  'protocol/capture-exclude.ts',
  'protocol/containment.ts',
];
const printer = ts.createPrinter({ removeComments: true });
const entries = [];
const emitted = new Set();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = (node) =>
  ts.isVariableStatement(node)
    ? node.declarationList.declarations.map((declaration) => declaration.name.getText())
    : node.name
      ? [node.name.text]
      : [];
const prettierConfig = await prettier.resolveConfig(packageRoot);
const eslint = new ESLint({ cwd: packageRoot, fix: true });
const format = (text) => prettier.format(text, { ...prettierConfig, parser: 'typescript' });

while (queue.length) {
  const target = queue.shift();
  if (emitted.has(target)) continue;
  emitted.add(target);
  const [domain, ...segments] = target.split('/');
  const sourcePath = prefixes[domain] + segments.join('/');
  const source = execFileSync('git', ['show', `${revision}:${sourcePath}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const parsed = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let selected = selections.get(target);
  if (target === 'protocol/secrets.ts') {
    const declarations = new Map(
      parsed.statements.flatMap((node) => names(node).map((name) => [name, node]))
    );
    const reachable = new Set();
    const visit = (name) => {
      if (reachable.has(name) || !declarations.has(name)) return;
      reachable.add(name);
      const walk = (node) => {
        if (ts.isIdentifier(node)) visit(node.text);
        ts.forEachChild(node, walk);
      };
      walk(declarations.get(name));
    };
    visit('redactSecretsInValue');
    selected = [...reachable].sort();
  }
  const statements = parsed.statements.filter((node) => {
    if (target === 'storage/events/rebuilders.ts' && names(node).includes('loadEventsWithPayloads'))
      return false;
    if (!selected) return true;
    if (ts.isImportDeclaration(node)) {
      if (
        [
          'storage/artifacts/store.ts',
          'storage/usage/ledger-log.ts',
          'storage/usage/ledger.ts',
          'storage/store/sqlite.ts',
        ].includes(target)
      )
        return false;
      if (target === 'protocol/secrets.ts') return true;
      const name = node.moduleSpecifier.text;
      return (
        name === 'zod' ||
        (target === 'protocol/containment.ts' && name === 'node:path') ||
        name === '../ids/uuidv7.js'
      );
    }
    return names(node).some((name) => selected.includes(name));
  });
  let text = statements
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, parsed))
    .join('\n');
  if (target === 'storage/usage/ledger-log.ts') {
    text = [
      "import { createHash } from 'node:crypto';",
      "import { canonicalJson } from '../events/canonical-json.js';",
      "import { AgentUsageSnapshotPayloadSchema, SourcePlanLinkPayloadSchema, type UsageLedgerEventType, type UsageLedgerRecord } from '../schema/usage-ledger.js';",
      text.replace(/^function isValidUsagePayload\(/m, 'export function isValidUsagePayload('),
    ].join('\n');
  }
  if (target === 'storage/usage/ledger.ts') {
    text = [
      "import type { LoadedUsageEvent } from './ledger-log.js';",
      "import { AgentUsageSnapshotPayloadSchema, SourcePlanLinkPayloadSchema, type AgentUsageSnapshotPayload } from '../schema/usage-ledger.js';",
      "import type { UsageSnapshotRow, SourcePlanLinkRow } from '../store/sqlite.js';",
      'type Store = { insertUsageSnapshot(row: UsageSnapshotRow): unknown; applySourcePlanLink(row: SourcePlanLinkRow): unknown };',
      text,
    ].join('\n');
  }
  if (target === 'storage/artifacts/store.ts') {
    text = [
      "import { serializeMarkdown } from '../markdown/serialize.js';",
      "import type { Plan } from '../schema/plan.js';",
      "import type { Checkpoint } from '../schema/checkpoint.js';",
      "import type { Summary } from '../schema/summary.js';",
      text.replace(
        /^function (planMarkdown|checkpointMarkdown|summaryMarkdown)\(/gm,
        'export function $1('
      ),
    ].join('\n');
  }
  if (target === 'storage/events/event-log.ts')
    text = text.replace('isUuidV7, uuidv7, UuidV7Schema', 'UuidV7Schema');
  if (target === 'storage/events/rebuilders.ts') text = text.replace(', loadEventPayload', '');
  if (target === 'storage/paths/containment.ts')
    text = "export { assertSafeRelativePath } from '@orcaops/evaluator-protocol';\n";
  const ast = ts.createSourceFile(target, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements = [];
  for (const node of ast.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier)
      continue;
    const specifier = node.moduleSpecifier.text;
    if (specifier === '@orcaops/evaluator-protocol') {
      let relative = path.posix.relative(path.posix.dirname(target), 'protocol/index.js');
      if (!relative.startsWith('.')) relative = './' + relative;
      replacements.push({
        start: node.moduleSpecifier.getStart(ast) + 1,
        end: node.moduleSpecifier.end - 1,
        value: relative,
      });
    } else if (specifier.startsWith('.')) {
      queue.push(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(target), specifier.replace(/\.js$/, '.ts'))
        )
      );
    } else if (
      !['zod', 'yaml', '@orcaops/diff-fingerprint'].includes(specifier) &&
      !specifier.startsWith('node:')
    ) {
      throw new Error(`Unclassified frozen dependency in ${target}: ${specifier}`);
    }
  }
  for (const replacement of replacements.reverse())
    text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
  const file = path.join(destination, target);
  const [lint] = await eslint.lintText(text, { filePath: file });
  if (lint.errorCount) throw new Error(JSON.stringify(lint.messages));
  const output = await format(lint.output ?? text);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, output);
  entries.push({
    source_path: sourcePath,
    source_sha256: sha(source),
    output_path: 'src/legacy/' + target,
    output_sha256: sha(output),
    selected_symbols: selected ?? null,
    omitted_symbols: target === 'storage/events/rebuilders.ts' ? ['loadEventsWithPayloads'] : [],
    transformation:
      'Remove comments; retain selected declarations when listed; export selected pure Markdown renderers and usage validators with their exact dependencies; replace the usage projector Store type with its two-method structural sink, preserving replay bodies and row types; rewrite protocol imports to private frozen dependencies; remove event payload I/O from pure replay.',
  });
}
await writeFile(
  path.join(destination, 'protocol', 'index.ts'),
  await format(
    [
      "export * from './schemas/common.js';",
      "export * from './schemas/run.js';",
      "export * from './schemas/disposition.js';",
      "export * from './schemas/gate-audit.js';",
      "export * from './capture-exclude.js';",
      "export * from './containment.js';",
    ].join('\n')
  )
);
await writeFile(
  path.join(packageRoot, 'legacy-sources.json'),
  await prettier.format(
    JSON.stringify({
      schema_version: 1,
      source_revision: revision,
      entries: entries.sort((a, b) => a.output_path.localeCompare(b.output_path)),
    }),
    { ...prettierConfig, parser: 'json' }
  )
);
