import { CAPTURE_AGENT_IDS } from '@orcaops/storage';

/**
 * The self-declaration instruction interpolated into every
 * artifact-producing skill body (capture, checkpoint, summary, pre-pr,
 * plan-approval) and the AGENTS.md managed block.
 *
 * MUST stay agent-GENERIC: codex, cursor, opencode, and github-copilot
 * consume byte-identical files from the shared `.agents/skills` tree
 * (first-wins dedupe in the install planner, guarded by the overlay
 * parity test), so a per-agent literal like `--invoked-by-agent codex`
 * can never be rendered into a skill body. The executing agent fills in
 * its own id; the CLI's env-marker auto-detection backstops it.
 *
 * The id list is derived from `CAPTURE_AGENT_IDS` so a future agent
 * addition cannot strand a stale hand-written list here.
 */
export const INVOKED_BY_AGENT_PLACEHOLDER = '--invoked-by-agent <your-agent-id>';

export const ATTRIBUTION_INSTRUCTION = `# Attribution: declare your agent id

Every artifact-writing command accepts \`--invoked-by-agent <your-agent-id>\`.
Pass YOUR OWN id — one of: ${CAPTURE_AGENT_IDS.join(', ')} — so each
plan / checkpoint / summary event records which agent actually produced
it (this is how multi-agent repos keep provenance trustworthy). Never
copy another agent's id from an example. When the flag is omitted,
orcaops falls back to \`ORCAOPS_INVOKED_BY_AGENT\`, then best-effort
environment detection, then \`other\`.`;
