// Vendored from vercel-labs/skills@9a7d8ac (v1.5.13), MIT License.
// Upstream: https://github.com/vercel-labs/skills  — reduced to data + detection for orcaops.
//
// Public surface for @orcaops/agent-targets: the data-driven agent registry,
// installed-agent detection, the universal-skills constants, the untrusted-string
// sanitizers, and the symlink/name-sanitize utilities.

export type { AgentType, AgentConfig, Skill } from './types.js';

export { firstConfiguredDir } from './agents.js';

export {
  agents,
  getAgentConfig,
  detectInstalledAgents,
  isUniversalAgent,
  getUniversalAgents,
  getNonUniversalAgents,
  getVisibleUniversalAgents,
} from './agents.js';

export { AGENTS_DIR, SKILLS_SUBDIR, UNIVERSAL_SKILLS_DIR } from './constants.js';

export { stripTerminalEscapes, sanitizeMetadata } from './sanitize.js';

export { createSymlink, sanitizeName } from './symlink.js';
