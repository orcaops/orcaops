---
description: 'Log in only for Cloud workflows and understand how Orcaops stores, refreshes, and removes credentials.'
---

# Authentication

Authentication is optional. Capture, evaluators, local artifacts, and Task Review
work while logged out. While logged out, the CLI sends no repository, capture,
review, evaluator, file-path, hash, or usage data to Orcaops Cloud. Log in only
when you want captured artifacts synced for web review. Visit
[orcaops.ai](https://orcaops.ai) to create an account or request access.

For the end-to-end team workflow, start with
[Cloud collaboration](./cloud-collaboration.md).

## Log in

```bash
orcaops login
```

This authorizes against **`https://api.orcaops.ai`** (the built-in default) using
the standard OAuth loopback flow: your browser opens, you approve, and a one-shot
local server on `127.0.0.1` receives the redirect and exchanges a PKCE code. The
token is stored at `~/.config/orcaops/credentials.json` (mode `0600`).

- If the browser doesn't open automatically, copy the URL the CLI prints.
- **Headless / SSH / remote box:** the redirect lands on `127.0.0.1` of the
  machine running the CLI. Forward the printed loopback port over SSH to your
  laptop, or export an `ORCAOPS_TOKEN` issued for the official Orcaops Cloud.

Confirm who you're signed in as:

```bash
orcaops whoami
```

## Credential storage

By default, credentials live in a `0600` file under `~/.config/orcaops/` — no OS
keychain required. To use your OS keychain instead, opt in with
`ORCAOPS_CREDENTIAL_STORE=keyring`.

## Organizations

If your account belongs to more than one organization, switch the active one:

```bash
orcaops org switch
```

## Log out

```bash
orcaops logout
```

If authentication misbehaves, ask your agent to diagnose the Cloud connection
with the `orcaops-doctor` skill. For direct terminal diagnosis, run
`orcaops doctor`; see also `orcaops login --help`.
