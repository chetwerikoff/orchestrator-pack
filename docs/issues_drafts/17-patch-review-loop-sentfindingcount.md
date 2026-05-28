# Patch review-loop contract: pending-worker detection must cover sentFindingCount

GitHub Issue: #45

## Prerequisite

Issue #28 (file `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`)
must be merged. This patch corrects two contract gaps found by Codex review run
`op-rev-10` against PR #42 (the #28 implementation).

**5 Whys (failure trace):**
1. Review loop stalled after #42 merge — op-rev-7/5/4 stayed in `waiting_update`,
   worker could report `completed` without addressing findings.
2. The worker-completion block in `agent_rules.md` only fires when
   `openFindingCount > 0`.
3. After `ao review send`, AO transitions findings from `open` to `sent_to_agent`,
   setting `openFindingCount: 0` while `sentFindingCount > 0`.
4. The #28 spec described the loop in terms of finding count without modelling
   the AO state transition that occurs on `ao review send`.
5. Root cause: acceptance criteria for #28 used `openFindingCount` as the proxy
   for "has pending review feedback", but the correct signal after send is
   `sentFindingCount > 0`.

## Goal

Correct two gaps in the autonomous review-loop contract so that:
- The orchestrator treats any `waiting_update` run as pending-worker-response
  regardless of `openFindingCount`.
- The worker cannot report `completed` (success termination) while `sentFindingCount > 0`
  on the latest review run for the current PR. Terminal failure with a reason remains
  permitted — the worker must still be able to signal "I cannot address these findings."

## Binding surface

Two contract changes, same scope as #28:

1. **Orchestrator rules** (`agent-orchestrator.yaml.example`): The
   pending-worker-response detection must not gate `waiting_update` runs on
   `openFindingCount > 0`. After `ao review send`, AO marks findings as
   `sent_to_agent` and sets run status to `waiting_update`, so
   `ao review list` reports `sentFindingCount > 0` and `openFindingCount: 0`
   for the normal pending-worker case. A `waiting_update` run IS pending
   regardless of `openFindingCount`.

2. **Worker completion rule** (`prompts/agent_rules.md`): The rule blocking
   terminal worker reports must cover `sentFindingCount > 0` in addition to
   `openFindingCount > 0`. After `ao review send`, findings are in sent state;
   a worker must report `addressing_reviews` — not `completed` (success
   termination) — until the findings are resolved. Terminal failure with a reason
   remains permitted so the worker can signal inability to address findings.

## Files in scope

- `agent-orchestrator.yaml.example` — patch `orchestratorRules`: step 2
  `waiting_update` condition; step 5 pending-worker detection; step 5d terminal
  clean condition (must require `sentFindingCount: 0` or use `findingCount: 0`
  which already subsumes all finding states).
- `prompts/agent_rules.md` — patch worker completion block to block terminal
  reports when `sentFindingCount > 0` on the latest run for the current PR.
- `docs/migration_notes.md` — add a paragraph instructing operators to pull the
  updated `orchestratorRules` block into their live config and restart AO
  (`ao stop` → `ao start`).
- `docs/issues_drafts/17-patch-review-loop-sentfindingcount.md` — this spec.

## Acceptance criteria

- **`waiting_update` is pending regardless of openFindingCount.**
- **Send is openFindingCount-gated; pending detection is not.**
- **Terminal clean condition is not satisfiable with sentFindingCount > 0.**
- **Worker `completed` blocked when sentFindingCount > 0; failure still allowed.**
- **Migration paragraph present.**
