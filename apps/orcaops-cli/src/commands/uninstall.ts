import { randomUUID } from 'node:crypto';
import { link, lstat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import {
  getToolAdapter,
  planGenerateForTool,
  type PlannedFile,
  resolveHintLines,
  type ToolAdapter,
} from '@orcaops/adapters';
import { Repo, resolveConfigSource, worktreeConfigLocation } from '@orcaops/core';
import { assertSafePathSegment } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildContext } from '../lib/context.js';
import { hooksDirCandidates } from '../lib/git-hooks-dir.js';
import { planInfoExcludeMutation } from '../lib/git-info-exclude.js';
import { planRemoveGitignoreEntries } from '../lib/gitignore.js';
import {
  activeEntries,
  type GlobalInstallManifest,
  type GlobalInstallResult,
  readGlobalManifest,
  releaseGlobalRefs,
  resolveGlobalRoot,
  withGlobalInstallLock,
} from '../lib/global-install.js';
import {
  INSTALL_MANIFEST_REL,
  type InstallEntry,
  LOCAL_MANIFEST_REL,
  type LocalEntry,
  type LocalManifest,
  type OwnershipKind,
  readInstallManifest,
  reconstructLocalManifest,
} from '../lib/install-manifest.js';
import { evaluateEntryDeleteGuard } from '../lib/install-prune.js';
import { planRemoveInstructionBlocks } from '../lib/instruction-placement.js';
import { getInvocationCwd } from '../lib/invocation-context.js';
import {
  deleteMutation,
  executeMutations,
  type MutationMode,
  type PlannedMutation,
  planRemoveGitHooks,
  readRepositoryFileForOwnership,
  readRepositoryFileOrNull,
  resolveRepositoryPath,
  writeMutation,
} from '../lib/mutations.js';
import {
  personalManifestClaimsExclude,
  planPersonalManifestWrite,
  readEffectiveLocalManifest,
  readPersonalManifestState,
  retainedPersonalManifest,
} from '../lib/personal-manifest.js';
import { resolveRepoKey } from '../lib/repo-key.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { resolveOrcaopsRoot } from '../lib/resolve-root.js';
import { readUserHooksRecord } from '../lib/session-hooks-user.js';
import { planSessionHookSettings } from '../lib/session-hooks.js';
import { enabledSkillTemplates } from '../lib/skill-set.js';

export interface UninstallOptions {
  /** Also remove confirm-gated, unverifiable managed entries. */
  force?: boolean;
  /** Also delete the whole `.orcaops/` directory (config + captured artifacts). */
  purgeData?: boolean;
  /** Plan and print the changes without writing anything. */
  dryRun?: boolean;
  json?: boolean;
  cwd?: string;
}

interface Preserved {
  path: string;
  kind: OwnershipKind;
  reason: string;
}

const entryKey = (kind: OwnershipKind, p: string): string => `${kind} ${p}`;

/**
 * A null key means no minted identity → nothing was ever keyed to this repo;
 * a degraded repo (identity read fails) is treated the same rather than
 * failing the whole uninstall.
 */
async function resolveRepoKeyOrNull(repo: Repo): Promise<string | null> {
  try {
    return await resolveRepoKey(repo);
  } catch {
    return null;
  }
}

/**
 * `orcaops uninstall` / eject. Reverse `orcaops init`, hash-guarded:
 * remove managed skills/commands + symlinked instruction secondaries under the
 * SAME `deleteMode` guard as orphan-prune (`evaluateEntryDeleteGuard`) — a clean
 * owned file is removed, a user-edited one is preserved + reported, and an
 * confirm-gated, unverifiable entry is listed for explicit
 * confirmation, removed only under `--force`. Excise the managed block from each
 * real instruction file (never deleting the host, unless the file was an
 * orcaops-created block-only file). Remove stamped git hooks and orcaops's
 * `.gitignore` lines. `.orcaops/` (config + captured artifacts) is KEPT unless
 * `--purge-data` is given. `--dry-run` previews and writes nothing.
 */
export async function uninstallAction(opts: UninstallOptions = {}): Promise<void> {
  try {
    const runWithLease = async (installLease: { verify(): Promise<void> }): Promise<void> => {
      if (opts.purgeData && (await finishInterruptedEmptyPurge(opts, installLease))) return;
      const ctx = await buildContext({ cwd: opts.cwd });
      let storeClosed = false;
      const closeStore = (): void => {
        if (!storeClosed) {
          ctx.store.close();
          storeClosed = true;
        }
      };
      try {
        const repoRoot = ctx.repoRoot;
        const config = ctx.config;
        // The install set drives reconstruction genFiles + the block-excise file list;
        // the manifest-driven removal below is agent-agnostic.
        const adapters = config.install.agents
          .map((id) => getToolAdapter(id))
          .filter((a): a is ToolAdapter => a !== undefined);

        const prevInstall = await readInstallManifest(repoRoot);
        const prevLocal = await readEffectiveLocalManifest(repoRoot, config.install.scope);
        const personalManifestState =
          config.install.scope === 'personal' ? await readPersonalManifestState(repoRoot) : null;
        const prevInstallContent = await readRepositoryFileOrNull(
          path.join(repoRoot, INSTALL_MANIFEST_REL),
          repoRoot,
          'install manifest'
        );
        const prevLocalContent = await readRepositoryFileOrNull(
          path.join(repoRoot, LOCAL_MANIFEST_REL),
          repoRoot,
          'local install manifest'
        );
        // `--purge-data` removes the worktree data directory, so the config it
        // restores on a failed purge is the worktree one by construction — the
        // shared personal config is not in this tree and is handled by the
        // uninstall plan, not by the purge.
        const worktreeConfig = worktreeConfigLocation(repoRoot);
        const configContent = opts.purgeData
          ? await readRepositoryFileOrNull(
              worktreeConfig.configPath,
              worktreeConfig.containmentRoot,
              'orcaops configuration'
            )
          : null;
        // Personal scope writes NO committed install.json — its whole record is
        // the git-excluded LOCAL manifest, which must drive the same guarded
        // removal (otherwise a personal uninstall would leave the
        // CLAUDE.local.md block and every local entry behind).
        const logicalEntries: InstallEntry[] =
          prevInstall?.entries ??
          prevLocal?.entries.map((entry) => ({ kind: entry.kind, path: entry.path })) ??
          [];
        const hasOwnershipManifest = prevInstall !== null || prevLocal !== null;

        const mutations: PlannedMutation[] = [];
        /** Generated-file + symlink-secondary + confirm-forced removals (the `.claude` tree). */
        const removed: string[] = [];
        const preserved: Preserved[] = [];
        const confirmRequired: { path: string; kind: OwnershipKind }[] = [];
        // Forced removals of confirm-gated, UNVERIFIABLE entries — a
        // SUBSET of `removed`. Surfaced separately so a forced uninstall is transparent:
        // these orcaops-stamped files could not be byte-verified and may carry manual
        // edits (e.g. on a fresh clone where the per-machine manifest is absent).
        const removedUnverified: { path: string; kind: OwnershipKind }[] = [];
        const blocksRemoved: string[] = [];
        const blocksPreservedModified: string[] = [];
        let gitignoreRemoved: string[] = [];
        const warnings: string[] = [];

        if (hasOwnershipManifest) {
          // Reconstruct-if-absent the local manifest (fresh clone has the committed
          // manifest but no local one) so the delete guard can prove ownership. Union
          // the current generation across the install set.
          const genFiles: PlannedFile[] = [];
          const seenGen = new Set<string>();
          for (const adapter of adapters) {
            const gp = await planGenerateForTool({
              repoRoot,
              adapter,
              generatedBy: CLI_VERSION,
              prefix: config.naming.prefix,
            });
            for (const f of gp.files) {
              if (!seenGen.has(f.path)) {
                seenGen.add(f.path);
                genFiles.push(f);
              }
            }
          }
          const local: LocalManifest =
            prevLocal ??
            (await reconstructLocalManifest(repoRoot, prevInstall!, genFiles, CLI_VERSION));
          const byKey = new Map<string, LocalEntry>(
            local.entries.map((e) => [entryKey(e.kind, e.path), e])
          );

          // 1. Managed skills/commands + symlinked instruction secondaries, guarded.
          for (const entry of logicalEntries) {
            if (entry.kind === 'gitignore-entry') continue; // step 3
            const le = byKey.get(entryKey(entry.kind, entry.path));
            // A real managed block lives inside a user file → step 2 excises it.
            if (entry.kind === 'injected-block' && le?.materialization !== 'symlink') continue;
            const g = await evaluateEntryDeleteGuard(repoRoot, entry, le, CLI_VERSION);
            switch (g.kind) {
              case 'delete':
                mutations.push(g.mutation);
                removed.push(entry.path);
                break;
              case 'preserve':
                preserved.push({ path: entry.path, kind: entry.kind, reason: g.reason });
                break;
              case 'confirm':
                // First place a `confirm` entry is acted on (prune only leaves them).
                if (opts.force) {
                  if (le?.materialization === 'symlink') {
                    const symlinkTarget = le.symlinkTarget;
                    if (typeof symlinkTarget !== 'string') {
                      throw new Error(
                        `forced uninstall symlink ${entry.path} has no planned target`
                      );
                    }
                    mutations.push(
                      deleteMutation(
                        repoRoot,
                        entry.path,
                        { kind: 'symlink', target: symlinkTarget },
                        true
                      )
                    );
                    removed.push(entry.path);
                    removedUnverified.push({ path: entry.path, kind: entry.kind });
                    break;
                  }
                  // Pass the real on-disk content (not null) so --dry-run/JSON can show
                  // WHAT is being removed, and record it as UNVERIFIABLE so the report
                  // flags that these orcaops-stamped files may carry manual edits.
                  const current = await readRepositoryFileOrNull(
                    path.join(repoRoot, entry.path),
                    repoRoot,
                    `forced uninstall entry ${entry.path}`
                  );
                  if (current === null) {
                    throw new Error(
                      `forced uninstall entry ${entry.path} disappeared after planning`
                    );
                  }
                  mutations.push(
                    deleteMutation(repoRoot, entry.path, { kind: 'file', content: current }, true)
                  );
                  removed.push(entry.path);
                  removedUnverified.push({ path: entry.path, kind: entry.kind });
                } else {
                  confirmRequired.push({ path: entry.path, kind: entry.kind });
                }
                break;
              case 'absent':
                break; // already gone — nothing to do
            }
          }

          // 2. Excise the managed block from each REAL instruction file (never the host).
          //    Over the DEDUPED UNION across the install set (every agent shares
          //    AGENTS.md) so a shared file is excised once.
          const instructionFiles = [...new Set(adapters.flatMap((a) => a.agentsFiles ?? []))];
          if (instructionFiles.length > 0) {
            const removal = await planRemoveInstructionBlocks({
              repoRoot,
              instructionFiles,
              generatedBy: CLI_VERSION,
              prefix: config.naming.prefix,
              hints: resolveHintLines(config.workflow.hints),
              enabledSkills: enabledSkillTemplates(config, ctx.gates),
            });
            for (const m of removal.mutations) {
              const le = byKey.get(entryKey('injected-block', m.path));
              // Round-trip: an orcaops-CREATED instruction file whose only content was
              // the managed block becomes empty after excision → delete it instead of
              // leaving an empty file. User prose outside the markers keeps desiredContent
              // non-empty (→ left as an inject-replace), and a reconstructed (adopted)
              // block is never created-owned, so a fresh-clone uninstall stays conservative.
              if (
                m.note === 'remove-block' &&
                (m.desiredContent ?? '').trim() === '' &&
                le?.provenance === 'created'
              ) {
                if (m.currentContent === null) {
                  throw new Error(`instruction file ${m.path} disappeared after planning`);
                }
                mutations.push(
                  deleteMutation(
                    repoRoot,
                    m.path,
                    { kind: 'file', content: m.currentContent },
                    true
                  )
                );
              } else {
                mutations.push(m);
              }
              blocksRemoved.push(m.path);
            }
            blocksPreservedModified.push(...removal.warnings);
            warnings.push(...removal.warnings);
          }

          // 3. orcaops's `.gitignore` lines (the gitignore-entry kind prune skips). On a non-purge
          //    uninstall we KEEP .orcaops data (artifacts + cache), so leave THEIR ignore lines in
          //    place — removing them would un-ignore the retained data. Under --purge-data the whole
          //    .orcaops dir is deleted, so every orcaops line is removed.
          const RETAINED_DATA_IGNORES = new Set([
            '.orcaops/artifacts/',
            '.orcaops/cache/',
            '.orcaops/index.sqlite',
            '.orcaops/usage/',
          ]);
          const gitignoreEntries = logicalEntries
            .filter((e: InstallEntry) => e.kind === 'gitignore-entry')
            .map((e: InstallEntry) => e.path)
            .filter((p) => opts.purgeData || !RETAINED_DATA_IGNORES.has(p));
          const gi = await planRemoveGitignoreEntries(repoRoot, gitignoreEntries);
          gitignoreRemoved = gi.removed;
          const gitignoreRel = path.relative(repoRoot, gi.gitignorePath);
          if (gi.deleteFile) {
            if (gi.currentContent === null) {
              throw new Error('.gitignore disappeared after planning');
            }
            mutations.push(
              deleteMutation(
                repoRoot,
                gitignoreRel,
                { kind: 'file', content: gi.currentContent },
                true
              )
            );
          } else if (gi.desiredContent !== null) {
            mutations.push(
              writeMutation(repoRoot, gitignoreRel, gi.desiredContent, gi.currentContent, true)
            );
          }
        } else {
          warnings.push(
            'no .orcaops/install.json manifest found — removing only stamped git hooks' +
              (opts.purgeData ? ' and the .orcaops directory' : '') +
              '. Run `orcaops init` then `orcaops uninstall` for a manifest-driven removal.'
          );
        }

        // 4. Stamped git hooks (not manifest-tracked → detected by stamp).
        // Union of the active hooks dir + default common dir (plumbing-resolved,
        // linked-worktree correct); fall back to the hand-joined path so
        // uninstall still works in a degraded repo where rev-parse fails.
        let hookDirs: string[];
        let gitCommonDir: string;
        try {
          const repo = new Repo(repoRoot);
          gitCommonDir = await repo.getCommonDirAbsolute();
          hookDirs = await hooksDirCandidates(repo);
        } catch {
          gitCommonDir = path.join(repoRoot, '.git');
          hookDirs = [path.join(gitCommonDir, 'hooks')];
        }
        // Ownership reads anchor at the COMMON dir for the default layout so a
        // redirected (symlinked) hooks/ component reads as unverified rather
        // than being followed; an external core.hooksPath dir is its own root —
        // the user pointed git there deliberately.
        const hooks = await planRemoveGitHooks(
          repoRoot,
          hookDirs,
          (absPath) =>
            readRepositoryFileForOwnership(
              absPath,
              absPath.startsWith(gitCommonDir + path.sep) ? gitCommonDir : path.dirname(absPath),
              'Git hook'
            ),
          CLI_VERSION
        );
        for (const hookPath of hooks.unverified) {
          warnings.push(
            `could not verify ownership at Git hook ${hookPath} because its path is redirected or non-regular — left the path untouched`
          );
        }
        for (const hook of hooks.preservedAhead) {
          warnings.push(
            `Git hook ${hook.path} is stamped by a NEWER orcaops (v${hook.stampedVersion}) than ` +
              'this CLI — left in place. Uninstall it with the owning CLI, or upgrade orcaops.'
          );
        }
        mutations.push(...hooks.mutations);

        // 4b. Session-hook settings entries (not manifest-tracked → detected by
        // the self-identifying `orcaops hook session-start` command substring,
        // mirroring the git-hooks pattern). Scans every known settings path
        // unconditionally so a manifest-less repo still strips cleanly; user
        // hooks and foreign keys survive, invalid JSON is preserved with a
        // warning, and a file left with only its own skeleton is deleted. (The
        // OpenCode session plugin is a manifest-tracked generated file — step 1
        // already covers it.)
        const sessionHooks = await planSessionHookSettings({
          repoRoot,
          agents: [],
          enabled: false,
          scope: 'project',
        });
        mutations.push(...sessionHooks.mutations);
        const sessionHooksRemoved = sessionHooks.plans
          .filter((p) => p.action === 'removed')
          .map((p) => p.path);
        const sessionHooksPreserved = sessionHooks.plans
          .filter((p) => p.action === 'preserved-invalid-json')
          .map((p) => ({ path: p.path, reason: 'invalid-json' }));
        warnings.push(...sessionHooks.warnings);

        // 4c. The info/exclude section (personal scope's hiding mechanism).
        // A non-purge uninstall keeps retained `.orcaops/` data hidden. It also
        // keeps CLAUDE.local.md hidden when removing the managed block leaves
        // user prose behind. The kept lines are unmanaged until re-init reclaims
        // them; both self-heal into the managed section on that path.
        // Best-effort in degraded repos.
        let infoExcludeRemoved: string[] = [];
        // Only repos that were HIDING via exclude keep the line — a project
        // repo that never had a section must not gain one on uninstall. Both
        // signals count: an effective personal config, or a common manifest
        // still claiming the line (a partial uninstall must never expose the
        // retained data of any linked worktree).
        const wasExcludeHidden =
          config.install.scope === 'personal' || (await personalManifestClaimsExclude(repoRoot));
        try {
          const desiredExclude = wasExcludeHidden ? ['.orcaops/'] : [];
          const excludePlan = await planInfoExcludeMutation({
            repoRoot,
            desired: desiredExclude,
          });
          // Uninstall only ever SHRINKS the section. A repo whose section is
          // already gone must not gain one here, and an add must never be
          // reported as a removal.
          if (excludePlan?.claimed) {
            mutations.push(excludePlan.mutation);
            if (excludePlan.removed.length > 0) {
              infoExcludeRemoved = [excludePlan.mutation.path];
            }
          }
        } catch {
          // rev-parse failure — no exclude to strip
        }

        // 5. Keep ownership metadata until every managed path has been reconciled.
        // A personal install's record is the common manifest: it is retained
        // with no entries so it keeps owning the harmless `.orcaops/` exclusion
        // (and lets Doctor recognise uninstalled residue). Purging this
        // worktree cannot prove that sibling worktrees have no retained data.
        if (personalManifestState !== null && personalManifestState.kind !== 'absent') {
          const { location, content } = personalManifestState;
          if (personalManifestState.kind === 'valid') {
            mutations.push(
              planPersonalManifestWrite(
                repoRoot,
                location,
                retainedPersonalManifest(personalManifestState.manifest),
                content
              )
            );
          }
        }
        if (!opts.purgeData && hasOwnershipManifest && config.install.scope !== 'personal') {
          if (prevLocalContent !== null) {
            mutations.push(
              deleteMutation(
                repoRoot,
                LOCAL_MANIFEST_REL,
                { kind: 'file', content: prevLocalContent },
                true
              )
            );
          }
          if (prevInstallContent !== null) {
            mutations.push(
              deleteMutation(
                repoRoot,
                INSTALL_MANIFEST_REL,
                { kind: 'file', content: prevInstallContent },
                true
              )
            );
          }
        }

        // 5b. A personal install's config and evaluator registration live in
        // the git common dir; leaving them would keep every worktree enabled
        // after the uninstall. Locks and the ownership manifest stay.
        const source = await resolveConfigSource(repoRoot);
        if (source.kind === 'common') {
          for (const [rel, absolute] of [
            [path.relative(repoRoot, source.configPath), source.configPath],
            [path.relative(repoRoot, source.evaluatorsPath), source.evaluatorsPath],
          ] as const) {
            const content = await readRepositoryFileOrNull(
              absolute,
              source.containmentRoot,
              'shared personal configuration'
            );
            if (content === null) continue;
            mutations.push(
              deleteMutation(
                repoRoot,
                rel,
                { kind: 'file', content },
                true,
                source.containmentRoot,
                absolute
              )
            );
          }
        }

        // 6. Release this repo's global-install refs (personal + global scope
        // materialize skills into the per-user dirs, ref-counted). Without
        // this, uninstall would leak the ~/.claude/skills/* materialization and
        // a phantom ref that would block another repo's last-repo cleanup.
        const mode: MutationMode = opts.dryRun ? 'preview' : 'apply';
        let globalRelease: GlobalInstallResult | null = null;
        let removedDirs: string[] = [];
        const repoId = await resolveRepoKeyOrNull(ctx.repo);
        const globalManifest = await readGlobalManifest();
        if (repoId === null && globalManifest !== null) {
          warnings.push('no repo identity recorded — skipped the global-install ref release');
        }
        const globalRefs = classifyGlobalRefs(globalManifest, repoId);
        const hasGlobalRefs = globalRefs.releasable;
        if (globalRefs.strandedRoots.length > 0) {
          warnings.push(strandedRefWarning(globalRefs.strandedRoots));
        }
        const applyLocal = async (): Promise<void> => {
          await installLease.verify();
          await executeMutations(mutations, mode);
          // Session-hook file removals feed the empty-dir sweep too
          // (`.codex`/`.cursor` may now be empty); strip-in-place files keep
          // their dir alive naturally.
          removedDirs = await rmdirEmptyAncestors(repoRoot, [...removed, ...sessionHooksRemoved]);
          if (opts.purgeData) {
            closeStore();
            await installLease.verify();
            // Deliberately leaves `orcaops.projectid` in .git/config: the
            // identity is what reattaches this checkout to its archived
            // history, and archived artifacts survive the purge by design.
            // Unsetting it here would orphan them behind a fresh mint.
            await purgeProjectData(repoRoot, configContent);
          }
        };
        if (mode === 'preview') {
          if (repoId !== null) {
            globalRelease = await releaseGlobalRefs(
              { repoId, cliVersion: CLI_VERSION, force: opts.force },
              mode,
              globalManifest
            );
            assertGlobalReleaseAllowed(globalRelease);
          }
          await executeMutations(mutations, mode);
        } else if (repoId !== null && hasGlobalRefs) {
          globalRelease = await withGlobalInstallLock(async (scope) => {
            const preview = await releaseGlobalRefs(
              { repoId, cliVersion: CLI_VERSION, force: opts.force },
              'preview',
              scope.manifest
            );
            assertGlobalReleaseAllowed(preview);
            await installLease.verify();
            return releaseGlobalRefs(
              { repoId, cliVersion: CLI_VERSION, force: opts.force },
              mode,
              scope.manifest,
              scope
            );
          });
          await applyLocal();
        } else {
          await applyLocal();
        }
        if (globalRelease) warnings.push(...globalRelease.warnings);

        // 6b. The machine-level registration is NEVER touched by a repo
        // uninstall (other repos rely on it; removal is `orcaops session-hooks
        // uninstall`). Surface an advisory so "uninstall removed everything"
        // is never silently wrong.
        let userSessionHooksPresent = false;
        try {
          userSessionHooksPresent = (await readUserHooksRecord()) !== null;
        } catch {
          userSessionHooksPresent = false;
        }
        if (userSessionHooksPresent) {
          warnings.push(
            'machine-level session hooks remain in your user agent configs — remove with ' +
              '`orcaops session-hooks uninstall`'
          );
        }

        if (opts.json) {
          emitOk({
            command: 'uninstall',
            applied: !opts.dryRun,
            dry_run: !!opts.dryRun,
            manifest_present: hasOwnershipManifest,
            removed,
            removed_unverified: removedUnverified,
            removed_dirs: removedDirs,
            preserved,
            confirm_required: confirmRequired,
            blocks_removed: blocksRemoved,
            blocks_preserved_modified: blocksPreservedModified,
            hooks_removed: hooks.removed,
            hooks_preserved: hooks.preserved,
            hooks_unverified: hooks.unverified,
            session_hooks_removed: sessionHooksRemoved,
            session_hooks_preserved: sessionHooksPreserved,
            gitignore_removed: gitignoreRemoved,
            info_exclude_removed: infoExcludeRemoved,
            global_removed: globalRelease?.removed ?? [],
            global_skipped_version_mismatch: globalRelease?.skippedVersionMismatch ?? false,
            global_materialized_by: globalRelease?.manifest.materialized_by ?? null,
            user_session_hooks_present: userSessionHooksPresent,
            data_purged: !!opts.purgeData,
            global: globalRelease
              ? {
                  removed: globalRelease.removed,
                  skipped_version_mismatch: globalRelease.skippedVersionMismatch,
                  root: resolveGlobalRoot(),
                }
              : null,
            warnings,
          });
          return;
        }

        writeTerminalSafeStdout(
          formatHuman({
            dryRun: !!opts.dryRun,
            purgeData: !!opts.purgeData,
            removed,
            removedUnverified,
            removedDirs,
            globalRemoved: globalRelease?.removed ?? null,
            preserved,
            confirmRequired,
            blocksRemoved,
            hooks,
            sessionHooksRemoved,
            gitignoreRemoved,
            infoExcludeRemoved,
            globalSkippedVersionMismatch: globalRelease?.skippedVersionMismatch ?? false,
            globalMaterializedBy: globalRelease?.manifest.materialized_by ?? null,
            warnings,
            force: !!opts.force,
          })
        );
      } finally {
        closeStore();
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

/**
 * Which of this repo's global refs this environment can actually release.
 *
 * `releaseGlobalRefs` acts only on the live agent root, so gating on the raw
 * entry list would report a clean uninstall while refs under another root — and
 * the files they hold — stayed behind. Those are reported, not silently skipped.
 */
function classifyGlobalRefs(
  manifest: GlobalInstallManifest | null,
  repoId: string | null
): { releasable: boolean; strandedRoots: string[] } {
  if (repoId === null || manifest === null) return { releasable: false, strandedRoots: [] };
  const releasable = activeEntries(manifest).some((e) => e.refs.includes(repoId));
  const stranded = (manifest.inert_entries ?? []).filter((e) => e.refs.includes(repoId));
  return {
    releasable,
    strandedRoots: [...new Set(stranded.map((e) => path.dirname(path.dirname(e.path))))],
  };
}

function strandedRefWarning(roots: string[]): string {
  return (
    `this repo still holds global-install refs recorded under ${roots.join(', ')}, which is not ` +
    `the agent root in effect here — they were NOT released. Re-run uninstall with the agent ` +
    `config dir they were installed under (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME) ` +
    `set to that root, or those files stay referenced with nothing able to remove them.`
  );
}

function assertGlobalReleaseAllowed(result: GlobalInstallResult | null): void {
  if (!result?.skippedVersionMismatch) return;
  // The AHEAD guard is never cleared by uninstall's own --force (only a
  // downgrade-capable `update --force` overrides it), so advising that flag
  // would be a dead end — name the remedies that actually change the state.
  const remedy = result.skippedAhead
    ? 'Re-run uninstall with the owning (newer) CLI, or run `orcaops update --force` first to deliberately downgrade the global tree.'
    : 'Re-run uninstall with the owning CLI or pass --force.';
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `${result.warnings[0] ?? 'Global installation ownership belongs to another CLI version.'} ` +
      `No project files were removed. ${remedy}`,
    'global install version'
  );
}

async function finishInterruptedEmptyPurge(
  opts: UninstallOptions,
  installLease: { verify(): Promise<void> }
): Promise<boolean> {
  const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
  const repoRoot = await resolveOrcaopsRoot({ cwd });
  const dataRoot = path.join(repoRoot, '.orcaops');
  let state: Awaited<ReturnType<typeof lstat>> | null;
  try {
    state = await lstat(dataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = null;
  }
  // An interrupted purge is a data directory with NO governing config. Under
  // personal scope the config is in the git common dir and the data directory
  // may not exist at all yet, so governance is decided first: a governed repo
  // always takes the normal uninstall path. A config the resolver refuses
  // still counts as present: the normal path reports that error instead of
  // purging around it.
  let governed = true;
  try {
    governed = (await resolveConfigSource(repoRoot)).kind !== 'none';
  } catch {
    governed = true;
  }
  if (governed) return false;
  if (state !== null) {
    if (!state.isDirectory() || state.isSymbolicLink()) return false;
    const entries = await readdir(dataRoot);
    if (entries.length > 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Refusing to resume purge: .orcaops has no configuration but is not empty. ' +
          'Inspect or back up the remaining files, then remove the directory explicitly.',
        'purge recovery'
      );
    }
  }

  const repoId = await resolveRepoKeyOrNull(new Repo(repoRoot));
  const mode: MutationMode = opts.dryRun ? 'preview' : 'apply';
  const globalManifest = await readGlobalManifest();
  const globalRefs = classifyGlobalRefs(globalManifest, repoId);
  const hasGlobalRefs = globalRefs.releasable;
  let globalRelease: GlobalInstallResult | null = null;
  if (mode === 'preview') {
    if (repoId !== null) {
      globalRelease = await releaseGlobalRefs(
        { repoId, cliVersion: CLI_VERSION, force: opts.force },
        mode,
        globalManifest
      );
      assertGlobalReleaseAllowed(globalRelease);
    }
  } else if (repoId !== null && hasGlobalRefs) {
    globalRelease = await withGlobalInstallLock(async (scope) => {
      const preview = await releaseGlobalRefs(
        { repoId, cliVersion: CLI_VERSION, force: opts.force },
        'preview',
        scope.manifest
      );
      assertGlobalReleaseAllowed(preview);
      await installLease.verify();
      const released = await releaseGlobalRefs(
        { repoId, cliVersion: CLI_VERSION, force: opts.force },
        mode,
        scope.manifest,
        scope
      );
      return released;
    });
    if (state !== null) {
      await installLease.verify();
      await rmdir(dataRoot);
    }
  } else {
    if (state !== null) {
      await installLease.verify();
      await rmdir(dataRoot);
    }
  }
  const warnings = [...(globalRelease?.warnings ?? [])];
  if (repoId === null && globalManifest !== null) {
    warnings.push('no repo identity recorded — skipped the global-install ref release');
  }
  if (globalRefs.strandedRoots.length > 0) {
    warnings.push(strandedRefWarning(globalRefs.strandedRoots));
  }
  if (opts.json) {
    emitOk({
      command: 'uninstall',
      applied: mode === 'apply',
      dry_run: mode === 'preview',
      manifest_present: false,
      removed: [],
      removed_unverified: [],
      removed_dirs: [],
      preserved: [],
      confirm_required: [],
      blocks_removed: [],
      blocks_preserved_modified: [],
      hooks_removed: [],
      hooks_preserved: [],
      hooks_unverified: [],
      gitignore_removed: [],
      data_purged: mode === 'apply',
      global: globalRelease
        ? {
            removed: globalRelease.removed,
            skipped_version_mismatch: globalRelease.skippedVersionMismatch,
            root: resolveGlobalRoot(),
          }
        : null,
      warnings,
    });
  } else {
    const lines = [
      mode === 'preview' ? 'DRY RUN — nothing was written.' : 'Completed interrupted purge.',
      state === null ? '.orcaops was already absent.' : 'Removed the empty .orcaops directory.',
      ...warnings.map((warning) => `! ${warning}`),
      '',
    ];
    writeTerminalSafeStdout(lines.join('\n'));
  }
  return true;
}

/**
 * `configContent` is the worktree config to restore if the purge cannot
 * finish, or null when this worktree never had one (personal scope keeps its
 * config in the git common dir).
 */
async function purgeProjectData(repoRoot: string, configContent: string | null): Promise<void> {
  // Deliberately the WORKTREE data directory: purge removes this checkout's
  // artifacts, cache, and config. A shared personal config lives outside it
  // and is never reachable from here.
  const worktreeConfig = worktreeConfigLocation(repoRoot);
  const dataRoot = resolveRepositoryPath(
    path.dirname(worktreeConfig.configPath),
    worktreeConfig.containmentRoot,
    'orcaops data directory'
  );
  const entries = await readdir(dataRoot);
  const rank = (entry: string): number => {
    if (entry === LOCAL_MANIFEST_REL.split(path.sep).at(-1)) return 1;
    if (entry === INSTALL_MANIFEST_REL.split(path.sep).at(-1)) return 2;
    if (entry === 'config.json') return 3;
    return 0;
  };
  for (const entry of entries.sort((left, right) => rank(left) - rank(right))) {
    assertSafePathSegment(entry, 'orcaops purge entry');
    if (entry === 'config.json') continue;
    try {
      await rm(path.join(dataRoot, entry), { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const configPath = worktreeConfig.configPath;
  await rm(configPath, { force: configContent === null });
  try {
    await rmdir(dataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    try {
      if (configContent !== null) {
        await restoreConfigIfAbsent(dataRoot, configPath, configContent);
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Purge did not finish and restoring the configuration also failed.'
      );
    }
    throw error;
  }
}

export async function restoreConfigIfAbsent(
  dataRoot: string,
  configPath: string,
  configContent: string
): Promise<void> {
  const staged = path.join(dataRoot, `.config.restore.${process.pid}.${randomUUID()}`);
  await atomicWriteFile(staged, configContent, dataRoot);
  try {
    await link(staged, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

/**
 * Remove every now-empty ANCESTOR dir of a removed path, deepest-first, up to
 * (never including) the repo root. Non-recursive + ENOTEMPTY/ENOENT-tolerant, so
 * a dir still holding user content (`.claude/settings.json`, a non-orcaops skill)
 * is preserved. Rounds orcaops's own subdirs (`.claude/skills/<prefix>-*`,
 * `.claude/skills`, `.claude/commands`) back to absent, but NEVER the top-level agent
 * dir (`.claude` / `.agents`) — it may have pre-existed orcaops.
 */
async function rmdirEmptyAncestors(repoRoot: string, removedPaths: string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const rel of removedPaths) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && dir !== path.dirname(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  // Deepest-first so a child dir is removed before its parent is attempted. NEVER a top-level
  // (depth-1) dir like `.claude` / `.agents` — it may have pre-existed orcaops; we remove only
  // orcaops's own subdirs (the per-skill dirs, `.claude/skills`, `.claude/commands`).
  // Split on '/', not path.sep: manifest paths are slash-canonical by contract,
  // so a platform separator makes every depth 1 and the >= 2 filter below drops
  // everything — the whole cleanup silently no-ops.
  const depth = (rel: string): number => rel.split('/').length;
  const ordered = [...dirs].filter((rel) => depth(rel) >= 2).sort((a, b) => depth(b) - depth(a));
  const removedDirs: string[] = [];
  for (const rel of ordered) {
    try {
      await rmdir(
        resolveRepositoryPath(
          path.join(repoRoot, rel),
          repoRoot,
          `managed directory cleanup ${rel}`
        )
      );
      removedDirs.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err;
    }
  }
  return removedDirs;
}

function formatHuman(r: {
  dryRun: boolean;
  purgeData: boolean;
  removed: string[];
  removedUnverified: { path: string; kind: OwnershipKind }[];
  removedDirs: string[];
  /** Global artifacts this repo held the last reference to; null when it holds none. */
  globalRemoved?: string[] | null;
  preserved: Preserved[];
  confirmRequired: { path: string; kind: OwnershipKind }[];
  blocksRemoved: string[];
  hooks: { removed: string[]; preserved: string[] };
  sessionHooksRemoved: string[];
  gitignoreRemoved: string[];
  infoExcludeRemoved: string[];
  globalSkippedVersionMismatch: boolean;
  globalMaterializedBy: string | null;
  warnings: string[];
  force: boolean;
}): string {
  const lines: string[] = [];
  if (r.dryRun) lines.push('DRY RUN — nothing was written.', '');
  lines.push(`orcaops uninstall${r.purgeData ? ' --purge-data' : ''}`, '');

  if (r.removed.length > 0) {
    lines.push(`Removed (${r.removed.length}):`);
    for (const p of r.removed) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.removedUnverified.length > 0) {
    lines.push(`Removed — UNVERIFIABLE, may contain manual edits (${r.removedUnverified.length}):`);
    for (const p of r.removedUnverified) lines.push(`  ! ${p.path}`);
    lines.push(
      '  These orcaops-stamped files could not be byte-verified; --force removed them.',
      '  Tip: `uninstall --force --dry-run` previews exactly what --force will delete.',
      ''
    );
  }
  if (r.blocksRemoved.length > 0) {
    lines.push(`Bootstrap block excised (${r.blocksRemoved.length}):`);
    for (const p of r.blocksRemoved) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.hooks.removed.length > 0) {
    lines.push(`Git hooks removed (${r.hooks.removed.length}):`);
    for (const p of r.hooks.removed) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.sessionHooksRemoved.length > 0) {
    lines.push(`Session-hook entries removed (${r.sessionHooksRemoved.length}):`);
    for (const p of r.sessionHooksRemoved) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.gitignoreRemoved.length > 0) {
    lines.push(`.gitignore lines removed: ${r.gitignoreRemoved.join(', ')}`, '');
  }
  if (r.infoExcludeRemoved.length > 0) {
    lines.push(`info/exclude section removed: ${r.infoExcludeRemoved.join(', ')}`, '');
  }
  if (r.globalRemoved && r.globalRemoved.length > 0) {
    lines.push(`Global skills released (${r.globalRemoved.length}):`);
    for (const p of r.globalRemoved) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.globalSkippedVersionMismatch && r.globalMaterializedBy !== null) {
    lines.push(
      `Global release: SKIPPED filesystem changes (CLI v${CLI_VERSION} vs ` +
        `manifest v${r.globalMaterializedBy}); refs released.`,
      ''
    );
  }
  if (r.removedDirs.length > 0) {
    lines.push(`Empty dirs removed (${r.removedDirs.length}):`);
    for (const p of r.removedDirs) lines.push(`  - ${p}`);
    lines.push('');
  }
  if (r.globalRemoved && r.globalRemoved.length > 0) {
    lines.push(`Global artifacts removed (${r.globalRemoved.length}):`);
    for (const p of r.globalRemoved) lines.push(`  - ${p}`);
    lines.push('  (this repo held the last reference to them)', '');
  }
  if (r.preserved.length > 0) {
    lines.push(`Preserved (${r.preserved.length}):`);
    for (const p of r.preserved) lines.push(`  · ${p.path} (${p.reason})`);
    lines.push('');
  }
  if (r.confirmRequired.length > 0) {
    lines.push(`Left in place — unverifiable (${r.confirmRequired.length}):`);
    for (const p of r.confirmRequired) lines.push(`  · ${p.path}`);
    lines.push('  Re-run with --force to remove these.', '');
  }
  for (const w of r.warnings) lines.push(`! ${w}`);
  if (r.warnings.length > 0) lines.push('');

  lines.push(
    r.purgeData
      ? 'Removed the .orcaops directory (config + captured artifacts).'
      : 'Kept .orcaops/ (config + captured artifacts). Re-run with --purge-data to remove it.'
  );
  lines.push('');
  return lines.join('\n');
}
