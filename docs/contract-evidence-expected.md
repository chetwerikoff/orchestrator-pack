# Contract-evidence `expected` field

Authoring-time `contract-evidence` rows on **structured** captures (rows with a
`selector`) may ground values with either a literal or a shape/presence predicate.

Implementation lives in `scripts/contract-evidence-validator.mjs` (wired from
`scripts/draft-discipline.mjs` and tests). `scripts/contract-evidence.mjs` remains
the legacy authoring gate surface for governed-surface compatibility (#377).

## Literal equality (unchanged)

When `expected` is not a reserved predicate token (and not a quoted literal — see
below), the checker compares the selector-resolved capture value with literal
equality: `String(value) === expected` for scalars.

## Shape/presence predicates

Reserved tokens (closed set):

| Token | Passes when |
|-------|-------------|
| `present` | Value is non-null and non-undefined |
| `non-empty-string` | Value is a string with length > 0 |
| `integer` | Value is a finite integer number (not a string-encoded number) |
| `positive-integer` | Value is an integer > 0 |
| `boolean` | Value is boolean `true` or `false` |

Predicates are **fail-closed**: absent selector resolution or wrong type/shape fails
the row the same way a literal mismatch does.

Predicates apply only to structured `capture@` rows with a `selector`. Unstructured,
CLI-behavior, and `NEW(...)` rows keep literal semantics.

## Literal vs predicate disambiguation

If `expected` matches a reserved predicate token, it is evaluated as a predicate.

To assert a capture value that literally equals a predicate token, wrap the value in
double quotes in the draft row, e.g. `expected: "boolean"` asserts the string
`boolean`.

## Binding identity

Conflict detection keys rows by canonical `(producer, datum, evidence)`. Two rows
that share producer and selector but reference **different** captures are not treated
as conflicting solely because of different `expected` literals or predicates.

Within one `contract-evidence` block, each `binding-id` string must appear at most
once.
