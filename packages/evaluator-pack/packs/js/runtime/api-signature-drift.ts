#!/usr/bin/env node
/**
 * Detect removed or signature-changed public exports between
 * `plan.base_sha` and the working tree across TS/JS files in scope.
 *
 * Scope semantics: `params.scope_files` is interpreted as globs
 * (picomatch). An empty / absent list means every TS/JS file is in
 * scope. Path matching is POSIX-normalized for cross-platform
 * consistency. Common patterns:
 *   - `src/**\/*.ts`          — only files under src/
 *   - `**\/*.public.ts`        — files declaring public API surface
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';

import {
  type EvaluatorContext,
  type EvaluatorResultEnvelope,
  matchesAnyGlob,
} from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

const execFileAsync = promisify(execFile);

interface Params {
  scope_files?: string[];
}

interface ExportedSig {
  name: string;
  signature: string;
}

interface FileFinding {
  file: string;
  removed: ExportedSig[];
  changed: Array<{ name: string; before: string; after: string }>;
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

export async function check(ctx: EvaluatorContext): Promise<EvaluatorResultEnvelope> {
  const args = parseParams(ctx.params);
  const scopeFiles = args.scope_files ?? [];

  const inScope = ctx.changed_files.filter((f) => {
    if (!TS_EXT.test(f)) return false;
    if (scopeFiles.length === 0) return true;
    return matchesAnyGlob(f, scopeFiles);
  });

  if (inScope.length === 0) {
    return pass('PASS\n\nNo TS/JS files in scope changed since plan.base_sha.', {
      raw: { scannedFiles: 0 },
    });
  }

  const findings: FileFinding[] = [];
  for (const file of inScope) {
    let beforeText: string | null = null;
    try {
      beforeText = (
        await execFileAsync('git', ['show', `${ctx.plan.base_sha}:${file}`], {
          cwd: ctx.repo.root,
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout;
    } catch {
      beforeText = null;
    }
    let afterText: string | null = null;
    try {
      afterText = await readFile(path.join(ctx.repo.root, file), 'utf8');
    } catch {
      afterText = null;
    }

    const beforeExports = beforeText !== null ? extractExports(beforeText, file) : [];
    const afterExports = afterText !== null ? extractExports(afterText, file) : [];

    const afterByName = new Map(afterExports.map((e) => [e.name, e]));
    const removed: ExportedSig[] = [];
    const changed: FileFinding['changed'] = [];

    for (const before of beforeExports) {
      const after = afterByName.get(before.name);
      if (!after) {
        removed.push(before);
      } else if (after.signature !== before.signature) {
        changed.push({ name: before.name, before: before.signature, after: after.signature });
      }
    }

    if (removed.length > 0 || changed.length > 0) {
      findings.push({ file, removed, changed });
    }
  }

  if (findings.length === 0) {
    return pass(`PASS\n\nScanned ${inScope.length} TS/JS file(s); no removed or changed exports.`, {
      raw: { scannedFiles: inScope.length, findings: [] },
    });
  }

  return violation(formatViolationBody(findings), {
    raw: { scannedFiles: inScope.length, findings },
  });
}

function parseParams(raw: Record<string, unknown>): Params {
  const out: Params = {};
  if (raw.scope_files !== undefined) {
    if (!Array.isArray(raw.scope_files) || raw.scope_files.some((s) => typeof s !== 'string')) {
      throw new Error('api-signature-drift: `scope_files` must be a string array if set');
    }
    out.scope_files = raw.scope_files as string[];
  }
  return out;
}

function extractExports(source: string, fileName: string): ExportedSig[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: ExportedSig[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name) {
      out.push({ name: node.name.text, signature: signatureOfFunctionDecl(node) });
    } else if (ts.isClassDeclaration(node) && hasExportModifier(node) && node.name) {
      out.push({ name: node.name.text, signature: `class ${node.name.text}` });
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const init = decl.initializer;
          if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
            out.push({
              name: decl.name.text,
              signature: signatureOfFunctionLike(decl.name.text, init),
            });
          } else {
            out.push({ name: decl.name.text, signature: `const ${decl.name.text}` });
          }
        }
      }
    } else if (ts.isExportAssignment(node)) {
      out.push({ name: 'default', signature: 'default' });
    }
  };

  sf.statements.forEach(visit);
  return out;
}

function hasExportModifier(
  node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement
): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function signatureOfFunctionDecl(node: ts.FunctionDeclaration): string {
  const name = node.name?.text ?? '<anonymous>';
  return signatureOfFunctionLike(name, node);
}

function signatureOfFunctionLike(name: string, node: ts.FunctionLikeDeclaration): string {
  const paramCount = node.parameters.length;
  const required = node.parameters.filter((p) => !p.questionToken && !p.initializer).length;
  const ret = node.type ? node.type.getText() : '<inferred>';
  return `function ${name}(${required}/${paramCount}) -> ${ret}`;
}

function formatViolationBody(findings: FileFinding[]): string {
  const lines: string[] = ['VIOLATION', '', '## findings'];
  for (const f of findings) {
    lines.push(`### ${f.file}`);
    for (const r of f.removed) {
      lines.push(`- removed: \`${r.signature}\``);
    }
    for (const c of f.changed) {
      lines.push(`- changed \`${c.name}\`:`);
      lines.push(`    before: \`${c.before}\``);
      lines.push(`    after:  \`${c.after}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

runIfDispatched(check);
