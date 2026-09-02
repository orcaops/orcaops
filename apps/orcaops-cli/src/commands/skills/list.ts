import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { getAgentSkillsDirs, getToolAdapter } from '@orcaops/adapters';
import { PathContainmentError, type SupportedAgentId } from '@orcaops/storage';

import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import {
  type GlobalInstallManifest,
  readGlobalManifest,
  resolveGlobalSkillsDir,
} from '../../lib/global-install.js';
import { readGeneratedByStamp } from '../../lib/install-drift.js';
import { resolveRepoKey } from '../../lib/repo-key.js';
import {
  currentSkillCapabilities,
  resolveSkillSet,
  visibleSkillTemplates,
} from '../../lib/skill-set.js';

/**
 * `orcaops skills list [--json]` — every shipped skill template with its
 * resolution: group, default, override, EFFECTIVE state, capability
 * satisfaction, and per-agent install status. Under project scope that is a
 * stamp check on the repo trees; under global and personal scope the files
 * live in per-user dirs, so it is the global manifest's record for THIS repo
 * plus on-disk presence (`null` only when the repo has no resolvable
 * identity to attribute per-user state to).
 */
export interface SkillsListOptions {
  json?: boolean;
}

interface SkillRow {
  id: string;
  name: string;
  group: string | null;
  default_enabled: boolean;
  override: boolean | null;
  effective: boolean;
  requires: string[];
  capability_satisfied: boolean;
  /**
   * agent id → installed. Project scope: stamped file present in the repo
   * trees. Global/personal scope: this repo holds a manifest ref for the
   * skill's per-user file and the file exists on disk. `null` when per-user
   * state cannot be attributed (no repo identity).
   */
  installed: Record<string, boolean> | null;
}

/** The per-user file a skill materializes to for an agent, or null when the agent has no global skills dir. */
function perUserSkillPath(
  agentId: SupportedAgentId,
  skillId: string,
  prefix: string
): string | null {
  const adapter = getToolAdapter(agentId);
  if (!adapter?.skills) return null;
  const skillsDir = resolveGlobalSkillsDir(agentId);
  const projDir = getAgentSkillsDirs(agentId)?.skillsDir;
  if (!skillsDir || !projDir) return null;
  const rel = path.relative(projDir, adapter.skills.filePath(skillId, prefix));
  return path.join(skillsDir, rel);
}

/** Manifest ref for this repo + on-disk presence — the same signal doctor's global-install check trusts. */
async function perUserSkillInstalled(
  manifest: GlobalInstallManifest | null,
  repoId: string,
  agentId: string,
  filePath: string,
  prefix: string
): Promise<boolean> {
  const entry = manifest?.entries.find(
    (e) =>
      e.agent === agentId && e.surface === 'skill' && e.prefix === prefix && e.path === filePath
  );
  if (!entry || !entry.refs.includes(repoId)) return false;
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function skillsListAction(opts: SkillsListOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const config = ctx.config;
      const resolved = resolveSkillSet(config, ctx.gates);
      const enabledIds = new Set(resolved.enabled.map((t) => t.id));
      const capabilityMissing = new Map(
        resolved.disabled
          .filter((d) => d.reason === 'capability_unsatisfied')
          .map((d) => [d.template.id, d.missing_capabilities ?? []])
      );
      // Global AND personal scope materialize skills into per-user dirs
      // (planGlobalInstall); only project scope keeps them in the repo trees.
      const perUserScope = config.install.scope === 'global' || config.install.scope === 'personal';
      let manifest: GlobalInstallManifest | null = null;
      let repoId: string | null = null;
      if (perUserScope) {
        manifest = await readGlobalManifest();
        try {
          repoId = await resolveRepoKey(ctx.repo);
        } catch {
          repoId = null;
        }
      }

      const rows: SkillRow[] = [];
      for (const t of visibleSkillTemplates(ctx.gates)) {
        let installed: Record<string, boolean> | null = null;
        if (perUserScope) {
          if (repoId !== null) {
            installed = {};
            for (const agentId of config.install.agents) {
              const filePath = perUserSkillPath(agentId, t.id, config.naming.prefix);
              if (filePath === null) continue;
              installed[agentId] = await perUserSkillInstalled(
                manifest,
                repoId,
                agentId,
                filePath,
                config.naming.prefix
              );
            }
          }
        } else {
          installed = {};
          for (const agentId of config.install.agents) {
            const adapter = getToolAdapter(agentId);
            if (!adapter?.skills) continue;
            const rel = adapter.skills.filePath(t.id, config.naming.prefix);
            let stamp: string | null;
            try {
              stamp = await readGeneratedByStamp(path.join(ctx.repoRoot, rel), ctx.repoRoot);
            } catch (err) {
              if (!(err instanceof PathContainmentError)) throw err;
              stamp = null;
            }
            installed[agentId] = stamp !== null;
          }
        }
        rows.push({
          id: t.id,
          name: t.name,
          group: t.group ?? null,
          default_enabled: t.defaultEnabled ?? true,
          override: config.skills.enabled[t.id] ?? null,
          effective: enabledIds.has(t.id),
          requires: t.requires ?? [],
          capability_satisfied: !capabilityMissing.has(t.id),
          installed,
        });
      }

      if (opts.json) {
        emitOk({
          skills: rows,
          capabilities: currentSkillCapabilities(config, ctx.gates),
        });
        return;
      }

      const lines: string[] = [];
      lines.push('ID              GROUP          EFFECTIVE  DEFAULT  OVERRIDE  INSTALLED');
      for (const r of rows) {
        const installedCol =
          r.installed === null
            ? '(no repo identity)'
            : Object.entries(r.installed)
                .map(([a, ok]) => `${a}:${ok ? 'yes' : 'no'}`)
                .join(' ') || '(no agents)';
        lines.push(
          `${r.id.padEnd(15)} ${(r.group ?? '-').padEnd(14)} ${String(r.effective).padEnd(10)} ` +
            `${String(r.default_enabled).padEnd(8)} ${String(r.override ?? '-').padEnd(9)} ${installedCol}` +
            (r.capability_satisfied ? '' : `  [requires ${r.requires.join(', ')}]`)
        );
      }
      lines.push('');
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
