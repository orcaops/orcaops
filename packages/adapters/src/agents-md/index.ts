export {
  injectOrcaopsSection,
  hashOrcaopsSection,
  planInjectOrcaopsSection,
  planRemoveOrcaopsSection,
  readOrcaopsSectionIdentity,
  readOrcaopsSectionStamp,
  readOrcaopsSectionStampVersions,
  type InjectAction,
  type InjectOrcaopsSectionOptions,
  type InjectPlan,
  type InjectResult,
  type OrcaopsSectionIdentity,
  type RemoveAction,
  type RemovePlan,
} from './inject.js';
export {
  ORCAOPS_AGENTS_MD_MARKER_END,
  ORCAOPS_AGENTS_MD_MARKER_START_RE,
  renderOrcaopsAgentsMdSection,
  type AgentsMdSectionOptions,
} from './template.js';
export {
  ALWAYS_DROPPED_HINT_KEY,
  nonRenderingHintKeys,
  ORCAOPS_BLOCK_ROUTING_SENTINEL,
  renderableHintKeys,
  resolveBootstrapContent,
  type BootstrapContent,
  type BootstrapContentInput,
  type BootstrapLifecycleStep,
  type BootstrapRoutingEntry,
  type HintRenderabilityInput,
} from './bootstrap-content.js';
export {
  CURATED_HINTS,
  resolveHintLines,
  type CuratedHint,
  type HintsInput,
} from './hints-catalog.js';
