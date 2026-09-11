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
- \`"paused"\` — The capture is saved locally, but its current state is NOT confirmed on the cloud and you must act. Follow \`cloud_sync.action\` verbatim; it may require inspecting an unknown delivery before retrying. STOP and tell the user; \`cloud_sync.pending\` when present counts artifacts waiting in the selected project (an omitted count is unknown), and \`cloud_sync.reason\` says how to heal it:
  - \`not_authenticated\` → run \`orcaops resync\` (an expired session refreshes automatically), or \`orcaops login\` if it reports your session ended.
  - \`push_failed\` → run \`orcaops resync --force\` to retry.
  - \`content_invalid\` → NOT retryable: this artifact contains content the cloud cannot store (\`resync --force\` re-trips the same check and will NOT fix it). Run \`orcaops doctor\` to inspect the retained field, preserve the registered database and its companion files, and report the diagnostic for investigation. Do not edit retained event bytes or checksums.
  - \`upgrade_required\` → NOT retryable on this binary: the cloud rejected this CLI as below its minimum supported version. STOP and tell the user to upgrade their orcaops install, then \`orcaops resync\`.
- \`"skipped"\` — No upload was needed or attempted in this invocation; benign and expected (\`reason: "missing_remote"\` = a local-only repo with no git remote; \`reason: "drain_disabled"\` = \`ORCAOPS_DISABLE_DRAIN=1\`; \`reason: "no_cloud_configured"\` = this machine holds no cloud credentials at all). An unchanged artifact is already synchronized; a replay does not resend it. No action needed; continue.

> ⚠ When status is \`"paused"\`: Cloud sync paused — your captured artifacts aren't uploading. Follow the \`cloud_sync.reason\` remediation above.`;
