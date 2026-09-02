# Contributing

Thank you for looking. Please read this before you spend time on a change.

## This repository is a mirror

Orcaops is developed in a private repository. What you see here is exported
from it at each release: the shipping source, squashed, with internal material
withheld. It is not a commit-for-commit copy, and the history here will not
line up with the history there. Work lands upstream first and appears here when
it ships.

That has one consequence worth stating plainly: **pull requests are not
accepted.** There is nowhere for them to merge to. A PR opened here cannot be
taken upstream, and leaving it open would only waste your time waiting on a
review that will not come. We close pull requests without review, and we are
sorry for it — the alternative is pretending a door is open that is not.

## Issues are genuinely welcome

Issues are read, and they change what gets built. Please open one for:

- **Bugs.** Include the orcaops version (`orcaops --version`), your OS and Node
  version, what you ran, what happened, and what you expected. `orcaops doctor`
  output is usually the fastest way to tell us about your environment.
- **Feature requests.** Describe the problem you hit before the solution you
  have in mind; the problem is the part we cannot guess.
- **Documentation that is wrong or missing.** A doc that misled you is a real
  defect and one of the easiest things to fix.
- **Questions about intended behaviour.** If you cannot tell whether something
  is a bug, that ambiguity is itself worth reporting.

Please do **not** open a public issue for a suspected security vulnerability.
[SECURITY.md](SECURITY.md) describes the private reporting channel.

## If you want to send code anyway

You are free to fork under the terms in [LICENSE](LICENSE). The Functional
Source License permits use, modification and redistribution for any purpose
except a Competing Use — read that clause yourself rather than taking this
sentence for it — and each release converts to Apache-2.0 on its second
anniversary. A fork is a legitimate way to carry a change we have not made.

The prose in `docs/` and `apps/docs/` is additionally available under CC BY
4.0, including for a Competing Use. The brand assets are not: see
[TRADEMARKS.md](TRADEMARKS.md).

Two things to keep in mind if you do:

- Read [TRADEMARKS.md](TRADEMARKS.md). You may say what your fork is; you may
  not present it as the official one.
- An issue describing the change, with a link to your fork or a patch pasted
  inline, is the form we can actually act on. If the change is one we want, we
  will implement it upstream and say so in the issue.

## What to expect

There is no service-level agreement here. Issues are triaged in batches, and a
quiet issue has not been ignored. If something is time-sensitive, say so in the
issue and explain why.
