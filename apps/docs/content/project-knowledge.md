---
description: 'Set up project knowledge, choose a provider and model, and check that processing is working.'
---

# Project knowledge

Orcaops keeps the plans, decisions, requirements, evidence, and open questions
recorded as your agent works. You and your agent can search those captures without
setting up a model. With **background knowledge processing** enabled, Orcaops also
uses a model to connect related ideas across tasks, so future work can find
continuing requirements and earlier decisions.

Background processing is **off by default**. It uses a local Claude Code or Codex
CLI and that CLI's existing login. The model call may send captured content to
the provider. You choose the provider and model, review what will be sent, and
give consent at a terminal before any knowledge-processing call runs.

## Turn on background processing

### 1. Choose a provider and model

We recommend choosing both explicitly. If you leave the provider on `inherit`,
the default `llm.tool: auto` prefers Claude Code when it is installed and uses
Codex otherwise. If you leave the model on `inherit` without an `llm.model`
setting, the provider CLI chooses its own default. An explicit choice makes the
setup predictable; Orcaops does not silently switch providers or models when an
explicit choice stops working.

| If you use  | Suggested model                                                          | Why choose it                                                                                                                  |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | [`claude-sonnet-5`](https://platform.claude.com/docs/en/models/overview) | A balance of speed and capability. We recommend `high` effort. Its default no-tools policy needs no tool-access setting.       |
| Codex       | [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna) | A fast, lower-cost choice for processing many captures. We recommend `high` effort and the explicit `codex_restricted` policy. |
| Codex       | [`gpt-6-sol`](https://developers.openai.com/api/docs/models/gpt-6-sol)   | Choose it for a higher-quality assessment at higher cost. It uses the same Codex tool-access policy.                           |

These are starting points, not models Orcaops installs or guarantees your account
can use. Check your provider's current model list and your CLI access before
pinning a model. In our GPT-6 Luna testing, estimated model cost was roughly
**$0.001–$0.003 per call**. A large capture can require several calls, and actual
usage can vary. Codex reports token usage but not a dollar cost to Orcaops, so
this estimate is neither a billed amount nor a spending cap. Review the limits
shown before consenting.

Orcaops uses the login already in your provider CLI. If your Codex CLI is signed
in with a ChatGPT subscription, knowledge processing uses that same subscription
and its usage allowance; it does not require a separate Orcaops API key. Usage
beyond an included allowance depends on your
[plan and credit settings](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

### 2. Set the knowledge options in your config

Run `orcaops knowledge status` to see the configuration file governing this
checkout. You can ask your agent to prepare the edit, but review the chosen
provider, model, and limits yourself. Add one of these sections to the existing
file, keeping its other settings. A file containing `knowledge_processing` needs
`schema_version: 8`; see [Configuration](./configuration.md#background-knowledge-processing)
for the complete settings and version rules.

For Claude Code:

```json
{
  "schema_version": 8,
  "knowledge_processing": {
    "enabled": false,
    "provider": "claude",
    "model": "claude-sonnet-5",
    "effort": "high"
  }
}
```

For Codex:

```json
{
  "schema_version": 8,
  "knowledge_processing": {
    "enabled": false,
    "provider": "codex",
    "model": "gpt-6-luna",
    "effort": "high",
    "tool_access": "codex_restricted",
    "max_cost_usd_per_call": "none"
  }
}
```

These show the relevant keys, not a replacement for your whole config file.
Keep `enabled` false until you have reviewed the disclosure in the next step.
Codex's restricted policy limits tool access but does not guarantee that every
built-in tool is absent. `max_cost_usd_per_call: "none"` is not a spending cap. See
[Restricted Codex processing](./project-knowledge-reference.md#restricted-codex-processing)
for the exact boundary.

### 3. Review the terms and enable it yourself

From the repository, run this in an **interactive terminal**:

```bash
orcaops knowledge enable
```

The command shows the provider, model, content it may send, tool-access policy,
effective limits, and any waiting captures. It asks you to type a confirmation.
An agent cannot grant consent through a config edit or a non-interactive flag.
The grant is local to this project's history on your machine; teammates need to
make their own choice.

If you captured work while processing was off and want those **already queued
captures** processed too, choose that explicitly:

```bash
orcaops knowledge enable --include-backlog
```

Without `--include-backlog`, consent covers new captures only. This backlog is
captured Orcaops work, not old Git commits. The next section explains how to
import those separately.

### 4. Check that it is working

```bash
orcaops knowledge status
```

Status shows the effective provider and model, consent, any pause reason, the
queue, and processing coverage. Processing happens after a capture is saved; it
does not hold up your agent's work. If work is waiting or paused, run
`orcaops doctor` for the next action. Orcaops keeps raw captures searchable even
when background processing is off or behind.

## Starting with an established repository?

Knowledge processing handles eligible Orcaops captures. It does not
reconstruct earlier work from Git automatically. To bring an existing
repository's commits into search and provenance, ask your agent:

```text
Backfill this repository's existing git history into Orcaops.
```

The agent uses the [`orcaops-seed` workflow](./seed.md) to preview the import and
asks you to approve the exact selection before writing it. Imported artifacts
are marked as reconstructions from Git evidence, not as captures of the original
agent's reasoning. **Git imports do not get knowledge-processing jobs.** They
improve search and provenance, but enabling processing or choosing
`--include-backlog` does not make the model interpret those imports into
connected project knowledge. A later live capture can refer to an import as
background without turning the imported artifact into a processed capture.

## Use and control your knowledge

Once captures exist, ask your agent questions such as “What did we decide about
auth?” or “Which earlier requirement applies to this change?” The installed
skills use Orcaops search and knowledge lookup and should show when processing
has not covered all relevant work. A model's interpretation is a candidate with
source evidence, not an automatically approved project rule.

Use `orcaops knowledge disable` to stop processing while retaining your grant,
or `orcaops knowledge revoke` to withdraw the grant. Run both if you want both
states changed. There is no automatic fallback to another provider or model
for an explicit selection; `orcaops knowledge status` reports what needs
attention if the selected one cannot run.

For every setting and limit, see [Configuration](./configuration.md#background-knowledge-processing).
For consent, coverage, recovery, and technical boundaries, see the
[project knowledge reference](./project-knowledge-reference.md). For the
available commands, see the [command reference](./command-reference.md#background-knowledge-processing).
