import path from 'node:path';

import {
  getToolAdapter,
  planGenerateForTool,
  type PlannedFile,
  resolveHintLines,
  type ToolAdapter,
} from '@orcaops/adapters';
import { Repo } from '@orcaops/core';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildContext } from '../lib/context.js';
import {
  INSTALL_MANIFEST_REL,
  LOCAL_MANIFEST_REL,
  readInstallManifest,
} from '../lib/install-manifest.js';
import {
  canonicalAgents,
  planInstallManifests,
  publishInstallManifestsLast,
} from '../lib/install-plan.js';
import { resolveInstructionPlacement } from '../lib/instruction-placement.js';
import { getInvocationCwd } from '../lib/invocation-context.js';
import {
  executeMutations,
  type MutationMode,
  type PlannedMutation,
  readRepositoryFileOrNull,
  writeMutation,
} from '../lib/mutations.js';
import { readEffectiveLocalManifest } from '../lib/personal-manifest.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { resolveOrcaopsRoot } from '../lib/resolve-root.js';
import { enabledSkillTemplates } from '../lib/skill-set.js';

export interface LinkOptions {
  /** Confirm a consolidation that drops a divergent file's unique content. */
  yes?: boolean;
  /** Which instruction file to keep as canonical (default AGENTS.md). */
  canonical?: string;
  json?: boolean;
  cwd?: string;
  /** Plan and print the changes without writing anything. */
  dryRun?: boolean;
}

/**
 * Consolidate an agent's instruction files (AGENTS.md / CLAUDE.md) onto ONE
 * canonical file + symlinks. Where init/update would dual-maintain two
 * divergent real files (never lossy), `link` collapses them on purpose — so it
 * is gated: if the consolidation would drop a divergent file's unique content it
 * refuses (exit 1) and prints exactly what would be lost unless `--yes` is given.
 */
export async function linkAction(opts: LinkOptions = {}): Promise<void> {
  try {
    const runWithLease = async (installLease: { verify(): Promise<void> }): Promise<void> => {
      const ctx = await buildContext({ cwd: opts.cwd });
      try {
        const repoRoot = ctx.repoRoot;
        if (ctx.config.install.scope === 'personal') {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            '`orcaops link` is unavailable under personal scope because personal installs own no repository instruction files or worktree manifests.'
          );
        }
        const installAgents = ctx.config.install.agents;
        const adapters = installAgents
          .map((id) => getToolAdapter(id))
          .filter((a): a is ToolAdapter => a !== undefined);
        // `link` consolidates the DEDUPED UNION of instruction files across the install
        // set (every agent targets AGENTS.md). Need ≥2 to have anything to link.
        const instructionFiles = [...new Set(adapters.flatMap((a) => a.agentsFiles ?? []))];
        if (instructionFiles.length < 2) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Nothing to link: the install set has fewer than two instruction files.`
          );
        }
        if (opts.canonical && !instructionFiles.includes(opts.canonical)) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--canonical ${opts.canonical} is not one of the install set's instruction files (${instructionFiles.join(', ')}).`
          );
        }

        // Force-collapse: one canonical + symlinks. The resolver emits a guarded
        // delete before each symlink; a delete whose content the canonical does NOT
        // reproduce is a LOSSY drop (a divergent secondary).
        const placement = await resolveInstructionPlacement({
          repoRoot,
          instructionFiles,
          generatedBy: CLI_VERSION,
          prefix: ctx.config.naming.prefix,
          hints: resolveHintLines(ctx.config.workflow.hints),
          enabledSkills: enabledSkillTemplates(ctx.config, ctx.gates),
          mode: 'force-collapse',
          canonical: opts.canonical,
        });
        if (placement.canonical === '') {
          if (opts.json) {
            emitOk({
              command: 'link',
              applied: false,
              dry_run: !!opts.dryRun,
              canonical: '',
              results: placement.results,
              dropped: [],
              warnings: placement.warnings,
            });
          } else {
            writeTerminalSafeStdout(`${placement.warnings.join('\n')}\n`);
          }
          return;
        }
        const canonicalContent = await readRepositoryFileOrNull(
          path.join(repoRoot, placement.canonical),
          repoRoot,
          `canonical instruction file ${placement.canonical}`
        );
        const lossy = placement.mutations.filter(
          (m) =>
            m.kind === 'delete' &&
            m.currentContent !== null &&
            m.currentContent !== canonicalContent
        );
        const dropped = lossy.map((m) => m.path);
        const repointedDetail = placement.mutations
          .filter((m) => m.kind === 'delete' && m.deleteExpectation?.kind === 'symlink')
          .map((m) => ({
            path: m.path,
            from: m.deleteExpectation?.kind === 'symlink' ? m.deleteExpectation.target : '',
            to: placement.canonical,
          }));
        // Surface WHAT is lost (size + a flattened snippet), not just the path,
        // so the --yes consent is informed.
        const droppedDetail = lossy.map((m) => ({
          path: m.path,
          size_bytes: Buffer.byteLength(m.currentContent ?? '', 'utf8'),
          preview: contentPreview(m.currentContent ?? ''),
        }));
        const changed = placement.mutations.some((m) => m.changed);

        // Refuse a real (non-dry-run) destructive or ownership-changing collapse unless confirmed.
        if ((dropped.length > 0 || repointedDetail.length > 0) && !opts.yes && !opts.dryRun) {
          if (opts.json) {
            emitOk({
              command: 'link',
              applied: false,
              confirmation_required: true,
              canonical: placement.canonical,
              would_drop: droppedDetail,
              would_repoint: repointedDetail,
              warnings: placement.warnings,
            });
          } else {
            const lines = ['Refusing to consolidate instruction files without --yes.'];
            if (droppedDetail.length > 0) {
              lines.push(
                'Content that would be lost:',
                ...droppedDetail.map((d) => `  ${d.path} (${d.size_bytes} bytes): ${d.preview}`)
              );
            }
            if (repointedDetail.length > 0) {
              lines.push(
                'Symlinks that would be re-pointed:',
                ...repointedDetail.map((d) => `  ${d.path}: ${d.from} -> ${d.to}`)
              );
            }
            lines.push(
              'Re-run with --yes to apply these changes, or --dry-run to preview them. Copy any',
              `content worth keeping into ${placement.canonical} before confirming.`
            );
            writeTerminalSafeStderr(lines.join('\n') + '\n');
          }
          throw new CliExit(1);
        }

        // Build the applied set: the instruction mutations + a manifest refresh so
        // install.local.json reflects the new symlink materialization. Generation is
        // NOT re-run (link only touches instruction files); planGenerateForTool only
        // feeds the manifest's generated-file ownership.
        const mutations: PlannedMutation[] = [...placement.mutations];
        const currentInstall = await readInstallManifest(repoRoot);
        const gitignoreLines = (currentInstall?.entries ?? [])
          .filter((e) => e.kind === 'gitignore-entry')
          .map((e) => e.path);
        const genFiles: PlannedFile[] = [];
        const seenGen = new Set<string>();
        for (const adapter of adapters) {
          const genPlan = await planGenerateForTool({
            repoRoot,
            adapter,
            generatedBy: CLI_VERSION,
            prefix: ctx.config.naming.prefix,
            // Manifest ownership must mirror the ENABLED set — the full registry
            // would resurrect entries `update` pruned for disabled skills.
            skills: enabledSkillTemplates(ctx.config, ctx.gates),
          });
          for (const f of genPlan.files) {
            if (!seenGen.has(f.path)) {
              seenGen.add(f.path);
              genFiles.push(f);
            }
          }
        }
        const currentLocal = await readEffectiveLocalManifest(repoRoot, ctx.config.install.scope);
        // Through the manifest choke point, not `buildManifests` directly: link
        // rebuilds the committed manifest from the GATED skill set, so on a
        // machine without credentials a direct build drops the cloud entries a
        // teammate committed — and once dropped, `update` has nothing to preserve.
        const { install, local } = await planInstallManifests({
          repoRoot,
          adapters,
          installAgents: canonicalAgents(installAgents),
          config: ctx.config,
          gates: ctx.gates,
          scope: ctx.config.install.scope,
          currentVersion: CLI_VERSION,
          genFiles,
          instructionPlacements: placement.placements,
          gitignoreLines,
          prevInstall: currentInstall,
          prevLocal: currentLocal,
        });
        const installJson = `${JSON.stringify(install, null, 2)}\n`;
        const localJson = `${JSON.stringify(local, null, 2)}\n`;
        const currentInstallJson = currentInstall
          ? `${JSON.stringify(currentInstall, null, 2)}\n`
          : null;
        const currentLocalJson = currentLocal ? `${JSON.stringify(currentLocal, null, 2)}\n` : null;
        mutations.push(
          writeMutation(
            repoRoot,
            INSTALL_MANIFEST_REL,
            installJson,
            currentInstallJson,
            installJson !== currentInstallJson
          )
        );
        mutations.push(
          writeMutation(
            repoRoot,
            LOCAL_MANIFEST_REL,
            localJson,
            currentLocalJson,
            localJson !== currentLocalJson
          )
        );

        const mode: MutationMode = opts.dryRun ? 'preview' : 'apply';
        await installLease.verify();
        await executeMutations(publishInstallManifestsLast(mutations), mode);

        if (opts.json) {
          emitOk({
            command: 'link',
            applied: !opts.dryRun,
            dry_run: !!opts.dryRun,
            canonical: placement.canonical,
            // Frozen {path, action} entries — planner divergence metadata
            // surfaces through warnings, never through this shape.
            results: placement.results.map((r) => ({ path: r.path, action: r.action })),
            dropped: droppedDetail,
            repointed: repointedDetail,
            warnings: placement.warnings,
          });
          return;
        }

        const lines: string[] = [];
        if (opts.dryRun) lines.push('DRY RUN — nothing was written.', '');
        if (!changed) {
          lines.push(`Already consolidated: ${placement.canonical} is canonical; nothing to link.`);
        } else {
          lines.push(`Consolidated instruction files onto ${placement.canonical}:`);
          for (const r of placement.results) {
            if (r.path === placement.canonical) continue;
            lines.push(`  → ${r.path} (symlink)`);
          }
          if (dropped.length > 0) {
            lines.push('', 'Dropped unique content from:');
            for (const d of droppedDetail) {
              lines.push(`  ${d.path} (${d.size_bytes} bytes): ${d.preview}`);
            }
          }
          if (repointedDetail.length > 0) {
            lines.push('', 'Re-pointed symlinks:');
            for (const link of repointedDetail) {
              lines.push(`  ${link.path}: ${link.from} -> ${link.to}`);
            }
          }
        }
        if (placement.warnings.length > 0) {
          lines.push('', ...placement.warnings.map((warning) => `Warning: ${warning}`));
        }
        writeTerminalSafeStdout(lines.join('\n') + '\n');
      } finally {
        ctx.store.close();
      }
    };
    if (opts.dryRun) {
      await runWithLease({ verify: async () => {} });
    } else {
      const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
      const repoRoot = await resolveOrcaopsRoot({ cwd });
      const commonDir = await new Repo(repoRoot).getCommonDirAbsolute();
      await withRepositoryInstallLock(commonDir, runWithLease);
    }
  } catch (err) {
    if (err instanceof CliExit) throw err;
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/** Flatten content to one line and cap it — a glanceable snippet of dropped bytes. */
function contentPreview(content: string, max = 160): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
