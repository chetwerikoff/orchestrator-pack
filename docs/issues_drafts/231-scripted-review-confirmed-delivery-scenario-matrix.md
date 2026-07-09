# Scripted review confirmed-delivery gate scenario matrix (Issue #669)

Gate decision matrix (12 cells) and post-send composition fixtures (3 cells).

## changes_requested gate matrix

| auto-delivery-in-window | live_head_owning | drifted_head | dead_terminated |
| --- | --- | --- | --- |
| delivered | suppress | escalate | escalate |
| not_delivered (window expiry) | send | escalate | escalate |
| ambiguous | escalate | escalate | escalate |

## approved gate matrix (auto-delivery N/A — daemon silent)

| liveness | action |
| --- | --- |
| live_head_owning | send |
| drifted_head | escalate |
| dead_terminated | escalate |

## Post-send composition (gate action was send)

| explicit-send-outcome | terminal |
| --- | --- |
| confirmed | delivered_once |
| failed | escalate |
| race_late_auto_delivery | dedup_or_escalate |

Fixture ids under `scripts/fixtures/scripted-review-confirmed-delivery-gate/` mirror these cells.

## Stdout-first delivery cells (Issue #718)

| cell | authority | daemon corpus |
| --- | --- | --- |
| C1/C2 clean/findings | wrapper stdout | empty — still delivers once |
| C12 visibility poll | retired | `submit_visibility_timeout` unreachable |
