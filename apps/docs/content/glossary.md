---
description: 'Connect Orcaops product language with the terms shown by the CLI, task record, digest, and Task Review.'
---

# Glossary

These definitions connect the product language used in the guides with the
precise names exposed by the CLI, stored data, digest, and Task Review.

## Task record

The complete user-facing record Orcaops builds while an agent works: the plan
and its revisions, checkpoints, decisions, verification, evaluator results,
uncertainty, summary, and related review evidence.

## Artifact

The CLI and storage name for one captured task thread. An artifact has a stable
ID and lifecycle. A branch or worktree can contain several artifacts, which a
branch-level Task Review can consider together.

## Plan

The intended outcome, ordered steps, acceptance criteria, boundaries, and
decisions captured before implementation. Revisions extend the same artifact
rather than erasing the earlier plan.

## Checkpoint

A coherent unit of implementation recorded within an artifact. Its open and
close boundaries connect changed code with the plan steps, decisions,
verification, uncertainty, and completion evidence reported for that work.

## Completion check

The user-facing last look at finished work before accepting it. Evaluators can
compare the task record with its requirements, Task Review can independently
inspect the code and captured account, and the digest can present the resulting
evidence. It is not a single CLI command or an automatic merge verdict.

## Evaluator

A check that runs at a defined lifecycle phase and records a pass, violation,
informational result, or skip. Evaluators are distributed in packs and are
optional; fresh configuration installs no packs.

## Rule-based check

The product name for a command-engine evaluator. It runs deterministic program
logic and does not need a language model.

## Judgment check

The product name for an LLM-engine evaluator. It uses the selected coding-agent
CLI and explicitly declared context for questions that require language
reasoning.

## Task Review

The branch-level human review assembled by `orcaops-task-review` and read in
`orcaops watch`. Its forensic lane reviews code without the agent's account; its
account lane organizes captured intent and evidence without inspecting code.

## Story, Act, and Part

Task Review's reading structure. A **Story** is the causal account of the branch,
an **Act** groups a major problem or transition, and a **Part** connects a
specific unit of that account to captured checkpoints and owned code ranges.

## Finding

A concrete lead produced by the capture-blind forensic review. Findings require
human adjudication; their presence does not prove a defect, and their absence
does not prove the branch is correct.

## Digest

The reviewer-facing rendering of one captured artifact: its outcome, decisions,
evaluator results, verification, open items, and usage attribution. It can also
be used as the basis for a pull-request description.

## Skill

An agent-facing workflow installed by Orcaops. A skill translates natural
language intent into CLI calls, validates the responses, and handles the next
step. The [Skills guide](./skills.md) lists every shipped skill ID.

## Plan approval

The optional Cloud workflow in which a human reviews a plan on the web. The
agent preserves the approved version as the task's source plan when capture
begins.
