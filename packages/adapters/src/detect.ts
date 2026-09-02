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
}

/**
 * The detected agents that orcaops can actually install for: the intersection of
 * the vendored registry's detection and the overlay-backed install targets
 * (`SUPPORTED_AGENT_IDS`), returned in canonical order. Drives the DEFAULTS of the
 * interactive `init` checklist — it never silently widens a
 * non-interactive install (that stays the single active agent), so CI / scripts /
 * tests are not machine-dependent.
 */
export async function detectInstallAgents(
  deps: DetectInstallAgentsDeps = {}
): Promise<SupportedAgentId[]> {
  const detect = deps.detectInstalledAgents ?? vendoredDetectInstalledAgents;
  const installed = new Set<AgentType>(await detect());
  return SUPPORTED_AGENT_IDS.filter((id) => {
    const overlay = getAgentOverlay(id);
    return overlay !== undefined && installed.has(overlay.registryAgent);
  });
}
