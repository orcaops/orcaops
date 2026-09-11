/**
 * The stop-on-paused instruction for the ungated lifecycle skills.
 *
 * Names no command, product or reason string, so the committed SKILL.md is
 * byte-identical between a logged-in author and a teammate without credentials.
 * Variable text is deferred to `cloud_sync.message` / `.action` at runtime; the
 * per-reason cloud remediation lives in `CLOUD_SYNC_STEERING`, which ships only
 * to the gated skills.
 */
export const SYNC_SIGNAL_STEERING = `## Capture sync signal

Every capture command returns a \`cloud_sync\` object. Branch on \`cloud_sync.status\`:

- \`"ok"\` or \`"skipped"\` — nothing to do. Continue.
- \`"paused"\` — the capture is saved locally, but its current state is NOT confirmed on the cloud. **STOP and tell the user.** Quote \`cloud_sync.message\` and \`cloud_sync.action\` verbatim; \`cloud_sync.pending\` when present is the number of artifacts waiting in the selected project; an omitted count is unknown. Do NOT re-run the capture hoping it clears: replaying a completed capture does not resend it, and the fault needs the remediation in \`cloud_sync.action\`.`;
