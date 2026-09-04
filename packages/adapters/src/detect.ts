import { readdir as fsReaddir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  type AgentType,
  detectInstalledAgents as vendoredDetectInstalledAgents,
} from '@orcaops/agent-targets';
import { SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

import { getAgentOverlay } from './overlay.js';

export interface DetectInstallAgentsDeps {
  /**
   * Injectable for tests — defaults to the vendored registry detector. The
   * registry's home-dir consts are frozen at module load, so detection cannot be
   * steered per-test via env; this seam is how a test forces a detected set.
   */
  detectInstalledAgents?: () => Promise<AgentType[]>;
  /** Home directory the evidence probes read; defaults to `os.homedir()`. */
  home?: string;
  /** Directory listing the evidence probes use; a rejection reads as "no evidence". */
  readdir?: (dir: string) => Promise<string[]>;
}

export interface InstallAgentEvidence {
  id: SupportedAgentId;
  /**
   * The `~`-relative path of something the agent's product wrote, or null for
   * agents whose registry detection needs no corroboration.
   */
  evidence: string | null;
}

interface EvidenceProbe {
  home: string;
  readdir: (dir: string) => Promise<string[]>;
}

/** Sorted listing of `~/<dir>`; empty when the directory is missing or unreadable. */
async function listing(probe: EvidenceProbe, dir: string): Promise<string[]> {
  try {
    return [...(await probe.readdir(path.join(probe.home, dir)))].sort();
  } catch {
    return [];
  }
}

/**
 * The first entry of `~/<dir>` that is neither a dotfile nor one of
 * `ownEntries`, rendered as `~/<dir>/<entry>`; null when there is none.
 */
async function firstForeignEntry(
  probe: EvidenceProbe,
  dir: string,
  ownEntries: readonly string[]
): Promise<string | null> {
  const match = (await listing(probe, dir)).find(
    (entry) => !entry.startsWith('.') && !ownEntries.includes(entry)
  );
  return match === undefined ? null : `~/${dir}/${match}`;
}

/**
 * Registry detection for these agents is "the config directory exists", which
 * Superset (`~/.cursor/hooks.json`) and orcaops' own global skills satisfy on
 * machines that never ran the product. Each probe must find something the
 * product itself wrote.
 */
const EVIDENCE_PROBES: Partial<
  Record<SupportedAgentId, (probe: EvidenceProbe) => Promise<string | null>>
> = {
  cursor: async (probe) =>
    (await firstForeignEntry(probe, '.cursor', ['hooks.json', 'skills'])) ??
    ((await listing(probe, '.local/share')).includes('cursor-agent')
      ? '~/.local/share/cursor-agent'
      : null),
  'github-copilot': (probe) => firstForeignEntry(probe, '.copilot', ['skills']),
};

/**
 * The detected agents that orcaops can actually install for, in canonical order:
 * the intersection of the vendored registry's detection and the overlay-backed
 * install targets (`SUPPORTED_AGENT_IDS`), minus any agent whose evidence probe
 * finds nothing its product wrote. Drives the DEFAULTS of the interactive `init`
 * checklist — it never silently widens a non-interactive install (that stays the
 * single active agent), so CI / scripts / tests are not machine-dependent.
 */
export async function detectInstallAgentEvidence(
  deps: DetectInstallAgentsDeps = {}
): Promise<InstallAgentEvidence[]> {
  const detect = deps.detectInstalledAgents ?? vendoredDetectInstalledAgents;
  const probe: EvidenceProbe = {
    home: deps.home ?? homedir(),
    readdir: deps.readdir ?? ((dir) => fsReaddir(dir)),
  };
  const installed = new Set<AgentType>(await detect());
  const out: InstallAgentEvidence[] = [];
  for (const id of SUPPORTED_AGENT_IDS) {
    const overlay = getAgentOverlay(id);
    if (overlay === undefined || !installed.has(overlay.registryAgent)) continue;
    const evidenceProbe = EVIDENCE_PROBES[id];
    if (evidenceProbe === undefined) {
      out.push({ id, evidence: null });
      continue;
    }
    const evidence = await evidenceProbe(probe);
    if (evidence !== null) out.push({ id, evidence });
  }
  return out;
}

export async function detectInstallAgents(
  deps: DetectInstallAgentsDeps = {}
): Promise<SupportedAgentId[]> {
  return (await detectInstallAgentEvidence(deps)).map((entry) => entry.id);
}
