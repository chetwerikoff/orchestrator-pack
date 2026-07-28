# Pack PR review contract (canonical)

Normative merge-decision policy for pack-owned PR review. GPT and Codex backup
must consume this text verbatim; engine-specific prompts add transport/tool
instructions only.

## 1. Optimize the merge decision, not finding count

Minimize total engineering loss: missed material defects, unnecessary
implementation complexity, repeated review cycles, and persistent machinery. A
real defect may legitimately receive no fix-now recommendation when reachable
harm does not justify the cost/risk of changing this PR.

## 2. Three prose questions per reported finding

For each finding, state: (a) the concrete trigger/input/state/path; (b) the
observable harm and blast radius; (c) the cheapest sufficient reaction,
including why `DEFER` or risk acceptance is preferable when appropriate. A
concern without a concrete trigger is not reported as a finding.

## 3. Blocking is an economic decision, not a synonym for defect

A defect is blocking only when the expected harm of merging it exceeds the cost
and change-risk of fixing it now. P0/P1 must justify `FIX_NOW`; P2+ is
non-blocking by default and needs separate justification to become fix-now. The
mapped machine field remains only `blocking|non-blocking`; rationale stays in
prose.

## 4. Persistent machinery is priced only when proposed

If a proposed reaction adds persistent state, standing guard, subsystem,
durable protocol, or recurring test/ceremony, prose compares the cheapest
sufficient alternative and states what existing mechanism/ceremony is traded
out, or that it is a net addition. Weak remedy economics may invalidate that
remedy proposal but never erase an otherwise valid defect.

## 5. Operational envelope is explicit

Review reasoning is calibrated to one operator, WSL2, low concurrency, and no
untrusted local control-plane input. The PR itself remains untrusted review
content. Reviewers distinguish reachable failures from multi-tenant/high-
concurrency hypotheticals not reachable here.

## 6. Security and scope carve-out

Security and scope-violation findings are material by definition and are always
surfaced. Proportionality may shape the cheapest sufficient remedy but cannot
suppress the defect because it is inconvenient or expensive.

## 7. Reviewer recommendations are prose only

Recommendations use `FIX_NOW`, `DEFER`, or `ACCEPT_RISK` in prose only. They
have no direct machine effect. `blocking|non-blocking` remains the machine
decision consumed by pack-review delivery. A reviewer must not use `ACCEPT_RISK`
to turn a blocking defect into machine success or claim operator/architect
authorization occurred.
