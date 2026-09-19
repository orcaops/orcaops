import { skillRef } from '@orcaops/adapters';

import {
  type SessionStartArtifact,
  type SessionStartBootstrap,
  type SessionStartState,
  STALE_CHECKPOINT_HOURS,
} from './session-start-state.js';

/**
 * Render the short, state-aware capture nudge a session-start hook injects
 * into the agent's context. Deliberately NOT the AGENTS.md block template:
 * this is re-rendered fresh by the installed CLI at every session start, so
 * its content can never go stale on disk (the settings entries that invoke it
 * are version-free for the same reason).
 *
 * This is the HOOK formatter over `resolveBootstrapContent` — the block
 * template is the other one. Every row both surfaces share comes from the
 * state's `content` in its `short` register; only the state-specific lines
 * (thread counts, open checkpoints) are this module's own prose. That is what
 * keeps the two surfaces from drifting apart again.
 *
 * Returns null when there is nothing to say (uninitialized repo) — the hook
 * command then emits nothing at all.
 */
export function renderSessionStartGuidance(state: SessionStartState): string | null {
  if (state.kind === 'uninitialized') return null;
  if (state.kind === 'static') {
    return [`[orcaops] This repo captures AI coding sessions with orcaops.`, ...tail(state)].join(
      '\n'
    );
  }

  const { branch, prefix, cacheStatus, inFlight } = state;
  const capture = skillRef('capture', prefix);
  const checkpoint = skillRef('checkpoint', prefix);
  const closing = skillRef('finish', prefix);
  const lines: string[] = [];

  if (inFlight.length === 0) {
    lines.push(
      cacheStatus === 'missing'
        ? `[orcaops] Capture is set up in this repo, but no cached thread state is available on branch \`${branch}\`.`
        : `[orcaops] Capture is set up in this repo; no capture thread is in flight on branch \`${branch}\`.`
    );
  } else if (inFlight.length > 1) {
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
  } else {
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
  }

  return [...lines, ...tail(state)].join('\n');
}

/**
 * The rows every payload shares, in the order the block renders them: the
 * lifecycle, then routing ONLY when no managed block carries it, then the
 * attribution rule, the skip rule, and workflow preferences. Identical across
 * the static payload and all four state-aware branches — a branch that
 * rendered a different tail is how the hook came to carry the lifecycle and
 * nothing else.
 */
function tail(state: SessionStartBootstrap): string[] {
  const { content, hooksOnly } = state;
  const lines = content.lifecycle.map((step) => step.short);
  if (hooksOnly && content.routing.length > 0) {
    lines.push(`Match user phrasing to these skills:`);
    // `lead` arrives already quoted and comma-joined; re-quoting it would
    // nest quotes around the whole list. `action`, not `ref`: an entry whose
    // instruction is "recommend the human run this" says the opposite once
    // truncated at the ref.
    for (const entry of content.routing) lines.push(`- ${entry.lead} → ${entry.action}`);
  }
  // The model wraps attribution for the block's numbered list; the hook
  // renders one unwrapped sentence per row.
  lines.push(content.attribution.replace(/\s+/g, ' '));
  lines.push(content.skip.short);
  if (content.hints.length > 0) {
    lines.push(`Workflow preferences for this repo:`);
    for (const hint of content.hints) lines.push(`- ${hint}`);
  }
  return lines;
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
