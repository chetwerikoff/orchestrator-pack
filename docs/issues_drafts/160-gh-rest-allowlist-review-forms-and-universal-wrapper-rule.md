# Close the orchestrator-path GraphQL leak: REST-cover the review/merge-verify gh forms + a universal "reads go through the pack gh wrapper" agent rule

GitHub Issue: #501

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub
  #431, **merged** PR #437) — already builds the `scripts/gh` PATH intercept, the
  argv→REST inventory classifier, the REST route table, and the first
  `agent_rules.md` "report-do-not-improvise" backstop. This draft **extends** that
  inventory and that backstop; it does not rebuild them.
- `docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md` (GitHub #443,
  **merged** PR #451) — extended the classifier for the AO plugin
  `detectPR`/`resolvePR` argv classes. Reference only; different argv gap.
- PR #500 (**merged**) — REST-routed the `gh issue view` spawn field-set and
  `state,stateReason`, mapping REST `state_reason → stateReason`. This draft is the
  **sibling** of #500 for the `pr view` / `pr checks` review-path forms; it follows
  the same pattern (add forms to the inventory + a REST mapping + matcher/mapping
  tests).

## Goal

The autonomous orchestrator turn currently leaks GitHub reads onto the **GraphQL**
rate-limit bucket and, when that bucket is exhausted, flails — improvising raw
`curl`, `gh api graphql`, and throwaway `gh` shims instead of using the REST
transport that already exists. The root is a **drift between two surfaces that share
the same literal**: the gh read-form. `orchestratorRules` instruct the agent to run
forms (`gh pr view <n> --json state,mergedAt`; bare `gh pr checks <n>`) that the
#431 classifier does **not** recognise, so they fall through to real `gh` → GraphQL.
End state: every gh read-form the agent rules instruct routes to REST, the two
surfaces cannot silently drift again, and a single universal rule makes the pack gh
wrapper the only sanctioned GitHub-read transport for **every** agent.

```behavior-kind
action-producing
```

## Binding surface

- The argv→REST inventory recognises the **merge-verify** `pr view` field-set the
  orchestrator rules instruct (`state` + `mergedAt`), routing it to the REST
  `pulls/{n}` endpoint and mapping the REST merge fields onto the `gh --json` field
  names the caller expects. (REST `pulls/{n}` exposes `state` and `merged_at`;
  captured below.)
- The CI-read form the orchestrator rules instruct routes to REST. The repository
  may satisfy this **either** by adding the rules' literal form to the inventory
  **or** by making the rules emit an already-covered form — but the chosen surface
  must be the one the agent actually runs, and the two surfaces must agree.
- A **no-drift guard**: a static check fails when a gh **read**-form that appears in
  a tracked agent-facing rule surface (`prompts/agent_rules.md`,
  `agent-orchestrator.yaml.example`) is **not** REST-covered by the classifier.
  Re-use / extend the existing `scripts/check-gh-inventory-static.ps1` rather than
  adding a parallel allowlist literal.
- `prompts/agent_rules.md` carries one universal rule, visible to **every** agent
  surface (orchestrator via `agentRulesFile`, workers, reviewer): GitHub reads go
  through the pack `gh` wrapper using canonical forms (auto-REST); agents MUST NOT
  improvise raw `curl` to `api.github.com`, `gh api graphql`, throwaway `gh` shims,
  or `unset GH_WRAPPER_ACTIVE`. When a needed form is uncovered **and** fails under
  GraphQL exhaustion, the agent uses `gh api <REST path>` (REST endpoint) only —
  never GraphQL/curl/shims — and reports the uncovered form so it is added to the
  inventory.
- The allowlist literal must not gain a third hand-maintained copy. If a form is
  added to the classifier, the static guard derives from or stays in sync with the
  classifier's coverage; the draft does not mandate which is canonical, only that
  they cannot disagree.

**Operator adoption.** The live `agent-orchestrator.yaml` is gitignored, so the
worker PR updates the tracked `agent-orchestrator.yaml.example` and
`prompts/agent_rules.md`. After merge the operator must port any changed
`orchestratorRules` gh read-forms into the live `agent-orchestrator.yaml` and run
`ao stop` / `ao start` so the orchestrator turn picks up the corrected forms and the
new universal rule. Verify with the Verification section's wrapper-route check.

## Files in scope

- `scripts/lib/**` — the argv→REST classifier and REST route table for the added
  `pr view` merge-verify form (and the CI-read form if the inventory route is the
  chosen surface).
- `scripts/check-gh-inventory-static.ps1` — extend the no-drift guard.
- `prompts/agent_rules.md` — the universal wrapper-transport rule.
- `agent-orchestrator.yaml.example` — align the instructed gh read-forms with
  REST-covered forms.
- Test + capture fixtures for the matcher, the REST mapping, and the guard.

## Files out of scope

- `agent-orchestrator.yaml` (gitignored live config — operator adoption, not a PR
  edit).
- Supervisor-child PATH coverage (owned by the #447 line), AO-core
  `agentConfig.env` propagation (#107), GraphQL request budgeting / coalescing /
  backoff (#129/#130/#142), `gh.exe` native Windows shim.
- Any write verb (`gh pr merge` / `comment` / `create` / `close` / `edit`) — reads
  only.
- A **cross-project** global rule (`~/agent-rules`, `~/.claude/CLAUDE.md`): the rule
  depends on the pack-specific gh wrapper; exporting "use REST on GraphQL
  exhaustion" to projects with no wrapper would legitimise the very raw-`curl`
  improvisation this draft removes. The universal surface here is
  `prompts/agent_rules.md` (every pack agent reads it) — that is the intended
  "global for all agents."

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

## Acceptance criteria

1. `scripts/gh pr view <n> --json state,mergedAt` returns the PR's `state` and
   `mergedAt` via the REST `pulls/{n}` endpoint (REST `merged_at` surfaced under the
   `mergedAt` key), and does **not** consume the GraphQL bucket — verifiable with the
   GraphQL quota exhausted.
2. The CI-read form that `orchestratorRules` instruct routes to REST: either the
   instructed form is inventory-covered, or the tracked rule surface emits a form the
   classifier already covers. The static guard (criterion 4) passes for that form.
3. Forms already covered by #431/#443/#500 still route to REST unchanged (no
   regression in the existing matcher/route tests).
4. `scripts/check-gh-inventory-static.ps1` fails when a gh **read**-form present in
   `prompts/agent_rules.md` or `agent-orchestrator.yaml.example` is not REST-covered
   by the classifier, and passes once every such form is covered. The guard does not
   introduce a second independently-edited allowlist literal that can drift from the
   classifier.
5. `prompts/agent_rules.md` states the universal rule: pack gh wrapper is the only
   sanctioned GitHub-read transport for all agents; raw `curl` to `api.github.com`,
   `gh api graphql`, throwaway `gh` shims, and `unset GH_WRAPPER_ACTIVE` are
   forbidden; an uncovered form failing under GraphQL exhaustion is served with
   `gh api <REST path>` and reported, never improvised via GraphQL/curl/shim.

```positive-outcome
asserts: scripts/gh pr view <n> --json state,mergedAt returns {state, mergedAt} sourced from REST pulls/{n} (merged_at→mergedAt) without touching the GraphQL bucket
input: external-tool-output
provenance: capture-backed
```

```contract-evidence
binding-id: github:rest:pulls:merge-fields
binding-type: structured
binding: GitHub REST pulls/{n} exposes merged_at for merge-state verification (mapped to the gh --json mergedAt key)
producer: gh
evidence: capture@gh-pr-open/pulls-merge-fields
selector: $.merged_at
expected: 2026-06-28T05:01:44Z
```

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repo secret; REST routing reuses the existing `gh`-resolved token path.
- No unsupported YAML: the `.example` change is prose inside existing
  `orchestratorRules`; no new schema keys.
- Reads only — no write/mutation verb gains a REST route.

## Verification

1. **REST mapping (AC1, positive-outcome):** with the GraphQL bucket exhausted (or a
   forced-passthrough probe), run `scripts/gh pr view <merged-PR> --json state,mergedAt`;
   assert output carries `state` and `mergedAt` (value = REST `merged_at`), and that
   `gh api rate_limit` shows GraphQL `used` unchanged across the call.
2. **CI-read form (AC2):** run the matcher/route test for the instructed CI-read
   form and confirm REST routing; if the chosen surface is the rule emitting a
   covered form, confirm the tracked rule text contains only covered forms.
3. **No regression (AC3):** the existing gh-wrapper matcher/route test suite passes.
4. **No-drift guard (AC4):** add a temporary uncovered gh read-form to a fixture rule
   surface → `pwsh -NoProfile -File scripts/check-gh-inventory-static.ps1` exits
   non-zero; remove it → exits zero. Confirm the guard reads the classifier's
   coverage rather than a separate hand-maintained list.
5. **Universal rule (AC5):** `prompts/agent_rules.md` contains the rule text; grep
   confirms the forbidden-transport clause (raw curl / `gh api graphql` / temp shim /
   `unset GH_WRAPPER_ACTIVE`) and the `gh api <REST path>`-and-report fallback.
