# Dependency and supply-chain policy

This runbook describes the repository's dependency-update policy and the
guardrails that enforce it. The machine-readable source of truth is
[`config/dependency-policy.json`](../config/dependency-policy.json).

Policy owner: **@orcaops/maintainers**.

## Enforced guardrails

| Guardrail                                                  | Configuration                   | Enforcement                    |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------ |
| Routine updates are minor/patch only                       | `.github/dependabot.yml`        | Dependabot                     |
| Manually managed dependencies have an owner and rationale  | `config/dependency-policy.json` | `pnpm check:dependency-policy` |
| Newly published releases wait seven days before resolution | `pnpm-workspace.yaml`           | pnpm                           |
| Production advisories have no unowned suppression          | `config/dependency-policy.json` | `pnpm audit:prod:ci`           |

The policy deliberately has no automatic merge. Dependency updates require
human review.

## Manually managed dependencies

The policy lists exact package names; wildcards are rejected because they can
silently suppress updates for packages that never received an explicit
decision.

- `typescript` is pinned across the monorepo by `.syncpackrc.json`. Move that
  coordinated pin rather than updating one workspace independently.
- `@opentui/core` and `@opentui/react` move together. Their updates require the
  Watch render, PTY, and performance checks because they affect the interactive
  review surface.
- `conventional-commits-parser` is pinned for seed-history stability. Review
  upgrades against the canonical clustering fixtures and deterministic-id
  checks before moving it.

For an OpenTUI update, run:

```bash
pnpm --filter @orcaops/watch test:render
pnpm --filter @orcaops/watch test:pty
pnpm --filter @orcaops/watch perf:review-cap
pnpm --filter @orcaops/watch perf:review
```

When a package no longer needs manual management, remove both its policy entry
and its Dependabot ignore in the same change. The structural checker requires
the two sets to match.

Dependabot ignores also suppress security pull requests for those exact names.
Dependabot Alerts and the named policy owner are therefore required controls.

## Release-age delay

`pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, which prevents releases
younger than seven days from entering a newly resolved lockfile. It applies to
transitive dependencies, but it is a delay rather than malware detection and it
does not re-resolve versions already present in the lockfile.

For pnpm 10.18.2, an emergency security-fix bypass is:

```bash
pnpm --config.minimum-release-age=0 update <package>
```

The flag disables the age check for every resolution in that command, including
transitive packages. A bypass change must name the reason, contain no unrelated
manifest edits, review every lockfile change, run the dependency-sensitive
checks below, and must not persist the bypass in repository configuration.

## Production advisory policy

`pnpm audit:prod:ci` runs an unfiltered `pnpm audit --prod --json` and applies
the repository's exceptions itself. Do not add pnpm-level `ignoreGhsas` or
`ignoreCves`; the structural checker rejects them because they make the raw
report disagree with the enforced signal.

The invariant is zero unexcepted production advisories. An exception is allowed
only for one GHSA and must include an owner, rationale, evidence, and ISO expiry
date:

```json
{
  "ghsa": "GHSA-xxxx-xxxx-xxxx",
  "owner": "@owner",
  "rationale": "Why temporary acceptance is safer than the available remediation.",
  "expiresOn": "YYYY-MM-DD",
  "evidence": ["https://github.com/advisories/GHSA-xxxx-xxxx-xxxx"]
}
```

Wildcard, package-wide, severity-wide, CVE-only, and permanent exceptions are
not supported. A malformed policy never suppresses a live advisory: the audit
still runs and counts every advisory as unexcepted.

## Verification

Run the focused policy checks for every policy or dependency-guardrail change:

```bash
pnpm check:dependency-policy
pnpm test:dependency-guardrails
pnpm syncpack:list
pnpm audit:prod:ci
```

Dependency upgrades additionally run the repository's normal format, lint,
typecheck, build, and test checks in CI.

The scheduled audit runs with stale-exception enforcement. An expired exception
must be removed when its advisory is gone or treated as actionable while the
advisory remains live.

## Residual risks

- SemVer does not prevent a breaking minor or patch release.
- The release-age delay cannot detect an unreported malicious package and can
  delay a newly published security fix.
- Production audit coverage excludes development-only dependencies.
- A dependency can execute when imported even if its install script was blocked.
- Repository policy and CI are themselves review-governed code.
