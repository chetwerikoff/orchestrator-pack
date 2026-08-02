# Review-lane routing

Issue #1201 routes reviewer cardinality by the author-owned change declaration.
This is orthogonal to `complexity-tier`: it does not add a review stage, change
reviewer roles, alter prompts or findings, or change final acceptance.

## Immutable activation order

```text
author declaration
  -> consistent revision/body freeze
  -> lossless lane-input normalization
  -> classifier v1
  -> immutable routing/topology
  -> reviewer invocation
```

The canonical Issue fence is the YAML-like `review-lane-change-set/v1` format
used in Issue #1201. The parser accepts the older JSON representation as a
compatibility form, but it never repairs or broadens either representation.

The manager may normalize separators, repository-relative paths, explicitly
case-insensitive comparisons, ordering, exact duplicate entries with identical
semantics, and derived identities. It may not add paths, broaden families,
choose behavior tags, merge independent paths, repair contradictions, or edit
the Issue. Invalid author content requests a new author revision. A transient
body-identity drift is repaired with at most two fresh reads; two consecutive
equal revision/body pairs are required before freezing.

## Lane matrix

| Input | Topology | Possible slots | Initially active |
| --- | --- | --- | --- |
| safe, one–six exact paths | `fixed/v1` | `01` | `01` |
| safe, seven or more exact paths | `conditional-third/v1` | `01..03` | `01,02` |
| safe family | `conditional-third/v1` | `01..03` | `01,02` |
| sensitive, destructive, or conservative scope | `fixed/v1` | `01..03` | `01,02,03` |

Every attempt uses `review-lane-routing/v1`, freezes the source revision,
cardinality, possible slots, initial slots, topology, and
`cardinalityConfigIdentity`. Conditional slot `03` activates only after
`material-verdict-conflict/v1`; it is never a judge, majority vote, or
replacement source.

## Closed verdict and settlement rules

Source verdicts are `accept`, `material-findings`, `blocked`, `refused`, or
`unparseable`. Only the first two credential a required slot. Exact
`NO_FINDINGS` maps to `accept`; valid material finding blocks without that
token map to `material-findings`. Missing or contradictory evidence is
`unparseable`. A blocked, refused, or unparseable initial source blocks
settlement and cannot create another source or stage attempt.

For conditional topology:

- `accept/accept` and `material-findings/material-findings` leave `03`
  `not-activated`;
- either mixed valid pair activates `03`;
- any invalid initial verdict blocks without activating `03`.

All possible slots appear in the existing stage receipt census. Routed
identities and settlement evidence are additive fields on existing
`reviewer-invocation-envelope/v1`, `stage-completeness-receipt/v1`, and stage
record artifacts; no new persistent store or receipt family is introduced.
