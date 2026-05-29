# Issue queue index — one registry mapping draft files to GitHub Issue numbers

GitHub Issue: #57

## Prerequisite

None. Documentation and architect-process hygiene. Does not block other
implementation work; land early so RCA and queue reviews stop mis-labeling
shipped work as "planned."

**5 Whys (failure trace, 2026-05-28):**

1. An architect RCA listed draft work as "planned" when the corresponding
   GitHub Issues were already closed/shipped.
2. The author cited `docs/issues_drafts/NN-….md` file prefixes as if they were
   GitHub Issue numbers.
3. The two numbering schemes do not line up: e.g. draft
   `19-codex-review-finding-bar.md` maps to GitHub **#51**, while GitHub **#19**
   is an unrelated task (Auto-fix loop convergence metrics, which descends
   from draft `09-…`). Several draft prefixes (`14`–`18`) have **no** GitHub
   Issue at that number at all — the numbers simply don't exist as issues.
4. The real GitHub numbers live in scattered `GitHub Issue:` header lines, and
   only some drafts record them.
5. Root cause: no single registry resolving draft file → GitHub Issue, and no
   agent procedure requiring that resolution before making a status claim.

## Goal

Establish **one canonical registry** mapping each draft file to its GitHub
Issue number, and a procedure that forbids inferring "shipped" or "planned"
from a draft filename. The registry stores the stable mapping only; **live
issue state stays authoritative in GitHub** (queried via `gh`), never copied
into and re-synced across markdown files. Referencing queue work uses either
the **draft path** (stable) or a **GitHub `#number` resolved from the
registry**, never a bare `NN` whose scheme is ambiguous.

Implemented registry: [`docs/issue_queue_index.md`](../issue_queue_index.md).

## Binding surface

See GitHub Issue #57 for full binding surface, acceptance criteria, and
verification steps.
