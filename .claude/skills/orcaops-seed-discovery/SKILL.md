---
name: "Orcaops: discover history gaps"
description: "Report scoped git-history coverage gaps during normal work. Use after an Orcaops `why` miss, when entering a coverage-cold directory, or when prior-art search is empty for an old subsystem. Read cached coverage and recommend the user-invoked seed skill without previewing or importing history. Skip for the initial repository-wide backfill (orcaops-seed skill)."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "60d10b16f18d"
tags: ["orcaops", "insight"]
---

# Read-only discovery

Use this only after normal work exposes a history gap. This workflow is
strictly read-only about history: never preview, import, enrich, or ask for
import confirmation. It performs exactly one state write — recording that it
made an offer, in step 4 — so the same area is not offered again next week.

1. Read the cached worklist:

   ```bash
   orcaops seed status --json
   ```

   Check `coverage`, `coverage_stale`, and `discovery`. Suppression has three
   states per area, and `discovery` is the only source for them:
   - listed in `discovery.declined` — the user said no. Never offer that area
     again until they ask; the way back is
     `orcaops seed status --offer-again <area>`, which only the user decides to
     run.
   - listed in `discovery.offered` with `cooldown_active: true` — offered
     within the last 7 days and unanswered. Do not re-offer it yet.
   - absent, or offered with the cooldown expired — offerable.

   This state is durable and machine-local: it survives a cache wipe and is
   shared by every linked worktree, so a suppression you read here is the same
   one another worktree recorded.
2. Identify the narrowest likely gap from the read-only evidence:
   - For a `why` miss, report the implicated commit when one is already known.
   - For a cold subsystem, report the top-level directory and its coverage.
   - Empty prior art alone is not proof of a gap; corroborate it with repository
     age and the coverage report.

When several old subsystems are plausible gaps, you may ask parallel
subagents to assess disjoint directories against the cached coverage report.
Collect their read-only findings before reporting one narrow recommendation; no
subagent may preview or import history, alter seed state, or ask for consent.

3. Report the cold coverage and recommend that the user explicitly invoke
   `orcaops-seed`, passing along the suggested path or commit as
   context.
4. Record the offer you just made, so it is not repeated during the cooldown:

   ```bash
   orcaops seed status --offered <area>
   ```

   This is the workflow's ONE sanctioned state write. It stamps only the
   offer timestamp that suppression reads — it imports nothing and touches
   no repository file — so run it even when you are otherwise operating
   under a read-only or no-write posture; skipping it re-nags the user on
   every session. Then continue the user's original task. Recording a
   decline is the user's call, not yours.

All preview, confirmation, enrichment, and import actions belong to the
user-invoked `orcaops-seed` workflow.
