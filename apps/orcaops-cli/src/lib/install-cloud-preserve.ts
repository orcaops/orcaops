import path from 'node:path';

import {
  COMMAND_TEMPLATES,
  type PlannedFile,
  SKILL_TEMPLATES,
  type SkillTemplate,
  type ToolAdapter,
} from '@orcaops/adapters';
import { type Config, sha256Hex } from '@orcaops/storage';

import {
  classifyAdoption,
  type InstallManifest,
  type LocalEntry,
  type LocalManifest,
  toPortableManifestPath,
} from './install-manifest.js';
import { readRepositoryRegularFileOrNull } from './mutations.js';
import { enabledSkillTemplates, gateWithheldSkillTemplates, type SkillGates } from './skill-set.js';

/** A generated file this run must RECORD but will not write. */
export interface PreservedGeneratedFile {
  /** Slash-normalized repo-relative path. */
  path: string;
  /** The delete guard for THIS machine — carried from prevLocal, else classified from disk. */
  local: LocalEntry;
  /** Position in the open-gate planner sequence; MAX_SAFE_INTEGER when unplaceable. */
  ordinal: number;
}

export interface CloudPreservation {
  /** Sorted by ordinal. Never empty — the resolver returns null instead. */
  files: PreservedGeneratedFile[];
  /**
   * Ordinal of any generated path in the OPEN-GATE sequence — the order a
   * teammate with credentials produces. Planned and preserved paths both resolve
   * through it, so the merged block reproduces that order exactly.
   */
  ordinalOf(relPath: string): number | undefined;
}

export interface ResolveCloudPreservationInput {
  repoRoot: string;
  /** The resolved adapters for this run, in the order the planner generated in. */
  adapters: ToolAdapter[];
  config: Config;
  gates: SkillGates;
  scope: 'project' | 'global' | 'personal';
  /** The running CLI version — the stamp a disk classification compares against. */
  currentVersion: string;
  /** This run's planned generated files (the gate-closed set). */
  genFiles: PlannedFile[];
  prevInstall: InstallManifest | null;
  prevLocal: LocalManifest | null;
}

/**
 * The generated-file order a machine WITH credentials produces — the loop shape
 * `planInstallMutations` walks, so the gate-closed sequence is a subsequence of
 * this one and the merge can splice into planner order rather than re-sorting.
 *
 * Commands belong here even though none is cloud-gated: omitting them ranks
 * every command entry equal, reordering the manifest on multi-adapter repos.
 */
export function generatedFileOrder(
  adapters: ToolAdapter[],
  config: Config,
  prefix: string
): Map<string, number> {
  const ordinal = new Map<string, number>();
  const openGateSkills = enabledSkillTemplates(config, { cloud: true });
  for (const adapter of adapters) {
    if (adapter.skills) {
      for (const template of openGateSkills) {
        const rel = toPortableManifestPath(adapter.skills.filePath(template.id, prefix));
        if (!ordinal.has(rel)) ordinal.set(rel, ordinal.size);
      }
    }
    if (adapter.commands) {
      for (const command of COMMAND_TEMPLATES) {
        const rel = toPortableManifestPath(adapter.commands.filePath(command.id, prefix));
        if (!ordinal.has(rel)) ordinal.set(rel, ordinal.size);
      }
    }
  }
  return ordinal;
}

/**
 * What the cloud gate is withholding here that a teammate already committed.
 *
 * The gate blocks creation, never deletion. Dropping these entries would let
 * `planOrphanPrune` delete the files, its hash guard passing precisely because
 * they are unmodified.
 */
export async function resolveCloudPreservation(
  input: ResolveCloudPreservationInput
): Promise<CloudPreservation | null> {
  const { repoRoot, adapters, config, gates, prevInstall, prevLocal, currentVersion } = input;
  if (gates.cloud || !prevInstall) return null;
  // Under global/personal scope the project tree owns no generated files, so a
  // preserved project entry would be permanently "missing" to the drift check.
  if (input.scope !== 'project') return null;
  const withheld = gateWithheldSkillTemplates(config, gates);
  if (withheld.length === 0) return null;

  const ordinal = generatedFileOrder(adapters, config, config.naming.prefix);
  const planned = new Set(input.genFiles.map((f) => toPortableManifestPath(f.path)));

  // A rename leaves the prior manifest holding paths under prefixes this run
  // can no longer name: the first post-rename update still reads the old prefix
  // from `prevInstall.naming_prefix`, but that update rewrites it — so on every
  // later run the entries themselves are the only durable record. Derive
  // candidates from each unplanned entry by withheld-template-id suffix, under
  // two guards: entries beneath the CURRENT or RECORDED prefix never derive
  // (a retired id like `orcaops-plan-review` lives there and must stay an
  // ordinary orphan, not become prefix "orcaops-plan" + cloud "review"), and a
  // segment that also suffix-matches a LONGER registry id is that skill, not a
  // prefixed shorter one (`foo-task-review` is task-review under "foo").
  const unplanned = new Set<string>();
  for (const entry of prevInstall.entries) {
    if (entry.kind !== 'generated-file') continue;
    const rel = toPortableManifestPath(entry.path);
    if (!planned.has(rel)) unplanned.add(rel);
  }
  const registryIds = SKILL_TEMPLATES.map((t) => t.id);
  const knownPrefixes = [config.naming.prefix, prevInstall.naming_prefix];
  const derived = new Set<string>();
  for (const rel of unplanned) {
    for (const segment of rel.split('/')) {
      if (knownPrefixes.some((p) => segment.startsWith(`${p}-`))) continue;
      for (const t of withheld) {
        if (!segment.endsWith(`-${t.id}`)) continue;
        if (registryIds.some((id) => id.length > t.id.length && segment.endsWith(`-${id}`))) {
          continue;
        }
        const prefix = segment.slice(0, segment.length - t.id.length - 1);
        if (prefix.length > 0) derived.add(prefix);
      }
    }
  }
  const prefixes = [...new Set([...knownPrefixes, ...derived])];
  const candidates = new Map<
    string,
    { adapter: ToolAdapter; template: SkillTemplate; prefix: string }
  >();
  for (const adapter of adapters) {
    if (!adapter.skills) continue;
    for (const prefix of prefixes) {
      for (const template of withheld) {
        const rel = toPortableManifestPath(adapter.skills.filePath(template.id, prefix));
        if (!candidates.has(rel)) candidates.set(rel, { adapter, template, prefix });
      }
    }
  }

  /**
   * An old-prefix path is absent from the order, which is keyed on the current
   * prefix. Resolve it through its template to the slot its current-prefix
   * equivalent holds, so a rename settles the manifest in one pass instead of
   * sinking to the end and moving again on the next credentialed run.
   */
  const ordinalFor = (
    rel: string,
    candidate: { adapter: ToolAdapter; template: SkillTemplate }
  ): number => {
    const direct = ordinal.get(rel);
    if (direct !== undefined) return direct;
    const current = candidate.adapter.skills
      ? toPortableManifestPath(
          candidate.adapter.skills.filePath(candidate.template.id, config.naming.prefix)
        )
      : null;
    return (current !== null ? ordinal.get(current) : undefined) ?? Number.MAX_SAFE_INTEGER;
  };

  const prevLocalByPath = new Map(
    (prevLocal?.entries ?? [])
      .filter((e) => e.kind === 'generated-file')
      .map((e) => [toPortableManifestPath(e.path), e])
  );

  const files: PreservedGeneratedFile[] = [];
  for (const entry of prevInstall.entries) {
    if (entry.kind !== 'generated-file') continue;
    const rel = toPortableManifestPath(entry.path);
    if (planned.has(rel)) continue;
    const candidate = candidates.get(rel);
    // Not gate-withheld — an ordinary orphan the prune should still handle.
    if (!candidate) continue;
    files.push({
      path: rel,
      local:
        prevLocalByPath.get(rel) ??
        (await classifyPreserved(repoRoot, rel, candidate, currentVersion)),
      ordinal: ordinalFor(rel, candidate),
    });
  }
  if (files.length === 0) return null;

  files.sort((a, b) => a.ordinal - b.ordinal || a.path.localeCompare(b.path));
  return { files, ordinalOf: (rel) => ordinal.get(rel) };
}

/**
 * The delete guard for a preserved entry with no prior local record.
 *
 * Classified against disk rather than synthesized from our own render: this run
 * emits no write mutation for the path, so claiming a hash guard for bytes it
 * never wrote would fabricate ownership.
 */
async function classifyPreserved(
  repoRoot: string,
  rel: string,
  candidate: { adapter: ToolAdapter; template: SkillTemplate; prefix: string },
  currentVersion: string
): Promise<LocalEntry> {
  const onDisk = await readRepositoryRegularFileOrNull(
    path.join(repoRoot, rel),
    repoRoot,
    `preserved cloud skill ${rel}`
  );
  if (onDisk === null) {
    // `confirm` + null hash so the guard inspects and reports it absent, rather
    // than listing a file that is not there under "Preserved".
    return {
      kind: 'generated-file',
      path: rel,
      expectedHash: null,
      provenance: 'adopted',
      deleteMode: 'confirm',
    };
  }
  const desired = candidate.adapter.skills!.format(candidate.template, {
    generatedBy: currentVersion,
    prefix: candidate.prefix,
  });
  return {
    kind: 'generated-file',
    path: rel,
    ...classifyAdoption({
      kind: 'generated-file',
      currentContent: onDisk,
      desiredHash: sha256Hex(desired),
      contentMatchesDesired: onDisk === desired,
      currentVersion,
    }),
  };
}
