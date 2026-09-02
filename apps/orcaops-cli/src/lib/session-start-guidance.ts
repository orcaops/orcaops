import { skillRef } from '@orcaops/adapters';

import {
  type SessionStartArtifact,
  type SessionStartState,
  STALE_CHECKPOINT_HOURS,
} from './session-start-state.js';

/**
 * Render the short, state-aware capture nudge a session-start hook injects
 * into the agent's context. Deliberately NOT the AGENTS.md block template:
 * this is ~8-14 lines re-rendered fresh by the installed CLI at every session
 * start, so its content can never go stale on disk (the settings entries that
 * invoke it are version-free for the same reason). Skill references route
 * through the same `skillRef`/prefix helper the block template uses, so
 * naming cannot diverge between the two surfaces.
 *
 * Returns null when there is nothing to say (uninitialized repo) — the hook
 * command then emits nothing at all.
 */
export function renderSessionStartGuidance(state: SessionStartState): string | null {
  if (state.kind === 'uninitialized') return null;
  if (state.kind === 'static') return renderStaticGuidance(state.prefix);
  const { branch, prefix, cacheStatus, inFlight } = state;
  const capture = skillRef('capture', prefix);
  const checkpoint = skillRef('checkpoint', prefix);
  const closing = skillRef('finish', prefix);
  const lines: string[] = [];

  if (inFlight.length === 0) {
    if (cacheStatus === 'missing') {
      lines.push(
        `[orcaops] Capture is set up in this repo, but no cached thread state is available on branch \`${branch}\`.`,
        `Run \`orcaops status --json\` before starting or resuming captured work.`,
        `Capture starts at PLAN APPROVAL, not at conversation start. Once a plan is`,
        `settled and approved, record it via the \`${capture}\` skill BEFORE writing code,`,
        `then wrap each unit of work with the \`${checkpoint}\` skill (open before edits;`,
        `run tests and commit inside the window; close with what finished).`,
        `Before ending a session that captured work, close the thread: ${closing}.`
      );
      return lines.join('\n');
    }
    lines.push(
      `[orcaops] Capture is set up in this repo; no capture thread is in flight on branch \`${branch}\`.`,
      `Capture starts at PLAN APPROVAL, not at conversation start: brainstorm, answer`,
      `questions, and draft the plan freely — nothing to capture yet. Once the plan is`,
      `settled and approved, record it via the \`${capture}\` skill BEFORE writing code`,
      `(the captured plan is the anchor later checks grade against), then wrap each`,
      `unit of work with the \`${checkpoint}\` skill (open before edits; run tests and`,
      `commit inside the window; close with what finished).`,
      `Before ending a session that captured work, close the thread: ${closing}.`,
      `Skip capture for trivial changes (typos, formatting-only, one-line docs).`
    );
    return lines.join('\n');
  }

  if (inFlight.length > 1) {
    lines.push(
      `[orcaops] ${inFlight.length} capture threads are in flight on branch \`${branch}\`:`
    );
    for (const a of inFlight) {
      lines.push(`  - ${a.id} ("${a.label}", ${a.state}${openSuffix(a)})`);
    }
    lines.push(
      `Pass \`artifact_id\` explicitly on every capture command (autodetect is ambiguous here).`,
      `Continue work through the \`${checkpoint}\` skill; close finished threads via ${closing}.`
    );
    return lines.join('\n');
  }

  const a = inFlight[0];
  lines.push(
    `[orcaops] Capture thread ${a.id} ("${a.label}", ${a.state}, ` +
      `${a.checkpointCount} checkpoint(s)) is in flight on branch \`${branch}\`.`
  );
  if (a.openCheckpoints.length > 0) {
    for (const cp of a.openCheckpoints) {
      const stale = cp.idleHours !== null && cp.idleHours >= STALE_CHECKPOINT_HOURS;
      const opened = cp.idleHours === null ? '' : ` (opened ${formatIdle(cp.idleHours)} ago)`;
      lines.push(
        `Checkpoint ${cp.n} is OPEN${opened}` +
          `${stale ? ' — likely left over from a previous session' : ''}.`
      );
    }
    lines.push(
      `Close it with what actually finished — or abandon it — via the \`${checkpoint}\` skill`,
      `before starting new work.`
    );
  } else {
    lines.push(
      `Continue it: open a checkpoint via the \`${checkpoint}\` skill BEFORE changing the worktree.`,
      `If this session is unrelated work, record a fresh plan via \`${capture}\` instead.`
    );
  }
  lines.push(`When the thread's work is done, close it: ${closing}.`);
  return lines.join('\n');
}

/**
 * The `static` payload: the same short nudge every session, rendered fresh by
 * the installed CLI (prefix-aware — it can never go stale on disk) with zero
 * state reads. It deliberately knows nothing about the branch, so it points
 * the agent at `orcaops status --json` for thread state instead of asserting
 * it. The state-aware payload (experimental) replaces that pointer with the
 * actual answer.
 */
function renderStaticGuidance(prefix: string): string {
  const capture = skillRef('capture', prefix);
  const checkpoint = skillRef('checkpoint', prefix);
  const closing = skillRef('finish', prefix);
  return [
    `[orcaops] This repo captures AI coding sessions with orcaops.`,
    `Run \`orcaops status --json\` to see any in-flight capture thread on this branch.`,
    `Capture starts at PLAN APPROVAL, not at conversation start: brainstorm, answer`,
    `questions, and draft the plan freely — nothing to capture yet. Once the plan is`,
    `settled and approved, record it via the \`${capture}\` skill BEFORE writing code`,
    `(the captured plan is the anchor later checks grade against), then wrap each`,
    `unit of work with the \`${checkpoint}\` skill (open before edits; run tests and`,
    `commit inside the window; close with what finished).`,
    `Before ending a session that captured work, close the thread: ${closing}.`,
    `Skip capture for trivial changes (typos, formatting-only, one-line docs).`,
  ].join('\n');
}

function openSuffix(a: SessionStartArtifact): string {
  if (a.openCheckpoints.length === 0) return '';
  const ns = a.openCheckpoints.map((cp) => cp.n).join(', ');
  return `, checkpoint ${ns} open`;
}

function formatIdle(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  return `${Math.round(hours)}h`;
}
