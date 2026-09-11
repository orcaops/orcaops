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
export async function vendorDeclarations({
  seeds,
  aliases = new Map(),
  sourcePaths = new Map(),
  outputRoot = 'src/legacy',
  manifestFile,
}) {
  const sources = new Map();
  const printer = ts.createPrinter({ removeComments: true });
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const names = (node) =>
    ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((entry) => entry.name.getText())
      : node.name
        ? [node.name.text]
        : [];
  function resolveModule(owner, specifier) {
    if (aliases.has(specifier)) return aliases.get(specifier);
    if (!specifier.startsWith('.')) return null;
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(owner), specifier.replace(/\.js$/, '.ts'))
    );
  }
  function load(file) {
    if (sources.has(file)) return sources.get(file);
    const [pkg, ...segments] = file.split('/');
    const sourcePath = sourcePaths.get(file) ?? `packages/${pkg}/src/${segments.join('/')}`;
    const original = execFileSync('git', ['show', `${revision}:${sourcePath}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const parsed = ts.createSourceFile(
      file,
      original,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const transformed = ts.transform(parsed, [
      (context) => (root) => {
        const visit = (node) => {
          if (ts.isVariableDeclaration(node) && node.type?.getText(parsed).includes('z.ZodType'))
            return ts.factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              undefined,
              node.initializer
            );
          return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(root, visit);
      },
    ]).transformed[0];
    const value = {
      file,
      sourcePath,
      original,
      parsed,
      statements: transformed.statements,
      declarations: new Map(),
      imports: new Map(),
      selected: new Set(),
      usedImports: new Set(),
    };
    sources.set(file, value);
    for (const statement of value.statements) {
      for (const name of names(statement)) value.declarations.set(name, statement);
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.name)
          value.imports.set(clause.name.text, {
            statement,
            imported: 'default',
            local: clause.name.text,
            typeOnly: clause.isTypeOnly,
          });
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const specifier of clause.namedBindings.elements)
            value.imports.set(specifier.name.text, {
              statement,
              imported: specifier.propertyName?.text ?? specifier.name.text,
              local: specifier.name.text,
              typeOnly: clause.isTypeOnly || specifier.isTypeOnly,
            });
      }
    }
    return value;
  }
  function resolveExport(file, name, trail = new Set()) {
    if (trail.has(`${file}:${name}`)) return null;
    trail.add(`${file}:${name}`);
    const source = load(file);
    if (source.declarations.has(name)) return { file, name };
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      const target = resolveModule(file, statement.moduleSpecifier.text);
      if (!target) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const specifier = statement.exportClause.elements.find((entry) => entry.name.text === name);
        if (specifier)
          return resolveExport(target, specifier.propertyName?.text ?? specifier.name.text, trail);
      } else {
        const result = resolveExport(target, name, trail);
        if (result) return result;
      }
    }
    return null;
  }
  function bindingNames(binding) {
    if (ts.isIdentifier(binding)) return [binding.text];
    return binding.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
    );
  }
  function references(node) {
    const result = new Set();
    const visit = (child) => {
      if (ts.isIdentifier(child)) {
        let ancestor = child.parent;
        while (ancestor && ancestor !== node) {
          if (
            ts.isFunctionLike(ancestor) &&
            ancestor.parameters.some((parameter) =>
              bindingNames(parameter.name).includes(child.text)
            )
          )
            return;
          if (
            (ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)) &&
            ts.isVariableDeclarationList(ancestor.initializer) &&
            ancestor.initializer.declarations.some((declaration) =>
              bindingNames(declaration.name).includes(child.text)
            )
          )
            return;
          if (
            ts.isBlock(ancestor) &&
            ancestor.statements.some(
              (statement) =>
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some((declaration) =>
                  bindingNames(declaration.name).includes(child.text)
                )
            )
          )
            return;
          ancestor = ancestor.parent;
        }
        const parent = child.parent;
        if (
          !(
            (ts.isPropertyAccessExpression(parent) && parent.name === child) ||
            ((ts.isPropertyAssignment(parent) ||
              ts.isPropertySignature(parent) ||
              ts.isMethodSignature(parent)) &&
              parent.name === child)
          )
        )
          result.add(child.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return result;
  }
  function select(file, name) {
    const source = load(file);
    if (source.selected.has(name)) return;
    const declaration = source.declarations.get(name);
    if (!declaration) throw new Error(`Missing frozen declaration ${file}:${name}`);
    source.selected.add(name);
    for (const referenced of references(declaration)) {
      if (source.declarations.has(referenced)) select(file, referenced);
      const imported = source.imports.get(referenced);
      if (!imported) continue;
      source.usedImports.add(referenced);
      const module = imported.statement.moduleSpecifier.text;
      const target = resolveModule(file, module);
      if (target) {
        const resolved = resolveExport(target, imported.imported);
        if (!resolved)
          throw new Error(`Cannot resolve ${module}:${imported.imported} from ${file}`);
        imported.resolved = resolved;
        select(resolved.file, resolved.name);
      } else if (
        !['zod', 'node:crypto', 'node:path', '@orcaops/diff-fingerprint'].includes(module)
      ) {
        throw new Error(
          `Frozen schema closure requires unsupported dependency ${module}:${imported.imported} in ${file}`
        );
      }
    }
  }
  for (const [file, symbols] of seeds) for (const name of symbols) select(file, name);
  const eslint = new ESLint({ cwd: packageRoot, fix: true });
  const config = await prettier.resolveConfig(packageRoot);
  const manifest = [];
  for (const source of [...sources.values()]
    .filter((entry) => entry.selected.size)
    .sort((a, b) => a.file.localeCompare(b.file))) {
    const imports = [];
    for (const name of [...source.usedImports].sort()) {
      const imported = source.imports.get(name);
      let module = imported.statement.moduleSpecifier.text;
      let exported = imported.imported;
      if (imported.resolved) {
        module = path.posix.relative(
          path.posix.dirname(source.file),
          imported.resolved.file.replace(/\.ts$/, '.js')
        );
        if (!module.startsWith('.')) module = './' + module;
        exported = imported.resolved.name;
      }
      imports.push(
        `import ${imported.typeOnly ? 'type ' : ''}{ ${exported}${exported === name ? '' : ` as ${name}`} } from ${JSON.stringify(module)};`
      );
    }
    const statements = source.statements.filter((statement) =>
      names(statement).some((name) => source.selected.has(name))
    );
    const text =
      imports.join('\n') +
      '\n' +
      statements
        .map((statement) => {
          const selectedRoot = names(statement).some((name) =>
            seeds.get(source.file)?.includes(name)
          );
          const exported =
            ts.canHaveModifiers(statement) &&
            ts
              .getModifiers(statement)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
          return (
            (selectedRoot && !exported ? 'export ' : '') +
            printer.printNode(ts.EmitHint.Unspecified, statement, source.parsed)
          );
        })
        .join('\n');
    const outputPath = `${outputRoot}/${source.file}`;
    const absolute = path.join(packageRoot, outputPath);
    const [lint] = await eslint.lintText(text, { filePath: absolute });
    if (lint.errorCount)
      throw new Error(JSON.stringify({ file: source.file, messages: lint.messages }));
    const output = await prettier.format(lint.output ?? text, { ...config, parser: 'typescript' });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, output);
    manifest.push({
      source_path: source.sourcePath,
      source_sha256: sha(source.original),
      output_path: outputPath,
      output_sha256: sha(output),
      selected_symbols: [...source.selected].sort(),
      transformation:
        'Retain referenced declarations; export requested validator roots; remove comments and redundant ZodType variable annotations; resolve/prune imports into private pinned declarations. Runtime validators are unchanged.',
    });
  }
  await writeFile(
    path.join(packageRoot, manifestFile),
    await prettier.format(JSON.stringify({ source_revision: revision, sources: manifest }), {
      ...config,
      parser: 'json',
    })
  );
}
