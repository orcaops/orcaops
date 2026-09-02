/**
 * The per-reason cloud remediation, appended to the CLOUD-GATED skills only.
 * It names cloud commands, so it can ship only where the cloud is reachable —
 * the ungated lifecycle skills carry the product-neutral stop instruction
 * instead, and defer their remediation to the `cloud_sync` envelope.
 *
 * Auth failures must not pass silently: the agent surfaces them so the user
 * re-authenticates, instead of discovering days later that nothing reached the
 * cloud.
 */
export const CLOUD_SYNC_STEERING = `## Cloud sync signal — do not ignore

Every capture command returns a \`cloud_sync\` field telling you whether THIS artifact reached the cloud. Branch on \`cloud_sync.status\`:

- \`"ok"\` — uploaded (or already on the cloud). Continue normally.
- \`"paused"\` — NOT uploaded and you must act. STOP and tell the user; \`cloud_sync.pending\` is how many artifacts are waiting locally, and \`cloud_sync.reason\` says how to heal it:
  - \`not_authenticated\` → run \`orcaops resync\` (an expired session refreshes automatically), or \`orcaops login\` if it reports your session ended.
  - \`push_failed\` → run \`orcaops resync --force\` to retry.
  - \`content_invalid\` → NOT retryable: this artifact contains a disallowed control byte and will not sync until it is scrubbed and rebuilt (\`resync --force\` re-trips the same check and will NOT fix it). Run \`orcaops doctor\` to see the offending field, then scrub the event log + plan.json (recompute its checksum), \`orcaops rebuild\`, and \`orcaops resync\`.
  - \`upgrade_required\` → NOT retryable on this binary: the cloud rejected this CLI as below its minimum supported version. STOP and tell the user to upgrade their orcaops install, then \`orcaops resync\`.
- \`"skipped"\` — NOT uploaded, but benign and expected (\`reason: "missing_remote"\` = a local-only repo with no git remote; \`reason: "drain_disabled"\` = \`ORCAOPS_DISABLE_DRAIN=1\`; \`reason: "no_cloud_configured"\` = this machine holds no cloud credentials at all). No action needed; continue.

> ⚠ When status is \`"paused"\`: Cloud sync paused — your captured artifacts aren't uploading. Follow the \`cloud_sync.reason\` remediation above.`;
