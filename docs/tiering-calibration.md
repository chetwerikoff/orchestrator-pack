# Tiering calibration corpus

This append-only corpus is an independently audited calibration source for the
human failure-type-first rubric in [`docs/tiering.md`](tiering.md). It is not a
lexical classifier, quota, live per-Issue gate, or substitute for applying the
rubric to the actual change.

## Frozen baseline

The initial baseline is exactly 30 ordered rows. Both engine verdicts and disputed
labels are evidence and must remain unchanged. Future audited rows may be appended
only after the complete existing row sequence.

| Issue | Claimed | Opus | Codex | Consensus |
|---|---|---|---|---|
| 1030 | T3 | T2 | T2 | T2 |
| 1031 | T3 | T3 | T3 | T3 |
| 1036 | T3 | T2 | T2 | T2 |
| 1039 | T3 | T3 | T2 | DISPUTED |
| 1060 | T3 | T3 | T3 | T3 |
| 1061 | T3 | T3 | T3 | T3 |
| 1062 | T3 | T2 | T2 | T2 |
| 1063 | T3 | T3 | T2 | DISPUTED |
| 1065 | T2 | T2 | T2 | T2 |
| 1066 | T3 | T2 | T2 | T2 |
| 1067 | T3 | T3 | T3 | T3 |
| 1068 | T3 | T3 | T3 | T3 |
| 1089 | T3 | T2 | T2 | T2 |
| 1090 | T3 | T2 | T2 | T2 |
| 1091 | T1 | T1 | T1 | T1 |
| 1093 | T3 | T2 | T2 | T2 |
| 1101 | T3 | T3 | T3 | T3 |
| 1104 | T3 | T2 | T3 | DISPUTED |
| 1110 | T3 | T3 | T3 | T3 |
| 1111 | T2 | T2 | T2 | T2 |
| 1112 | T3 | T3 | T3 | T3 |
| 1114 | T3 | T2 | T3 | DISPUTED superseded |
| 1115 | T3 | T3 | T3 | T3 |
| 1116 | T3 | T2 | T3 | DISPUTED superseded |
| 1117 | T3 | T2 | T2 | T2 |
| 1120 | T3 | T3 | T3 | T3 |
| 1122 | T3 | T3 | T3 | T3 |
| 1123 | T3 | T2 | T2 | T2 |
| 1125 | T3 | T2 | T1 | INFLATED |
| 1135 | T3 | below-ladder | T1 | INFLATED |

The checker serializes each parsed row as one compact UTF-8 JSON tuple
`[Issue,Claimed,Opus,Codex,Consensus]`, followed by `\n`, in table order. The
SHA-256 digest of the first 30 serialized tuples is frozen by Issue #1142 as
`89d3804e53772e27a54bcaffa366558f7fdc2721cddfbd4f39ca0f46edf04e5d`.
The checker also requires the base-branch parsed row sequence to be an exact
prefix of the candidate sequence and allows only appends.

Audited anchors: #1135 is below-ladder/T1 with L4 `not-applicable`; #1036,
#1089, #1093, and #1117 are T2. The frozen baseline contains 11 definite
honest-T3 rows, below the maximum of 16.

## Label-blind re-grade

1. Copy only each task's Goal, Binding surface, scope, acceptance criteria, and
   verification into a review packet; omit its claimed tier and title prefix.
2. Apply the conjunctive T3 test from `docs/tiering.md`, then the T1/T2
   size-and-design-judgment split.
3. Record the Opus and Codex verdicts independently. Preserve disagreement as
   `DISPUTED`; do not silently resolve it upward.
4. Append an audited row only after the two verdicts and consensus label are
   recorded. Never edit an existing row.

## Commands

Validate committed calibration integrity (CI-gated):

```bash
npm run tiering:calibration
```

Run the read-only, non-gating distribution report (operator invoked):

```bash
npm run tiering:distribution -- --repo chetwerikoff/orchestrator-pack
```

The report's non-zero status is an operator signal only. It is not a required CI,
branch-protection, merge-eligibility, or per-Issue authoring gate.
