# REST-route spawn-gate PR head refs and guard new gh read shapes

GitHub Issue: [#546](https://github.com/chetwerikoff/orchestrator-pack/issues/546)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), closed; PR #437) - pack `scripts/gh` inventory classifier and REST routes. Already does: selected `pr-view` field sets including `number,headRefOid,baseRefName,state`. Does not cover the two-field spawn-gate shape `headRefOid,headRefName`.
- `docs/issues_drafts/160-gh-rest-allowlist-review-forms-and-universal-wrapper-rule.md` (GitHub [#501](https://github.com/chetwerikoff/orchestrator-pack/issues/501), closed; PR #503) - review/merge gh read forms and the universal "reads go through pack wrapper" rule. This draft extends the same invariant to new pack-owned gh read shapes that appear in scripts or prompts.
- `docs/issues_drafts/168-gh-rest-rca-read-allowlist-and-static-guard.md` (GitHub [#520](https://github.com/chetwerikoff/orchestrator-pack/issues/520), closed; PR #523) - RCA/review prompt static-guard coverage for executable gh read forms. This draft reuses that guard instead of creating a parallel checker.
- `docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md` (GitHub [#530](https://github.com/chetwerikoff/orchestrator-pack/issues/530), closed; PR #531) - six-field AO `resolvePR` / full `detectPR` `prInfoFromView` routes, including `headRefName`. Already does: `gh pr view <ref> --repo <slug> --json number,url,title,headRefName,baseRefName,isDraft`. Does not cover the narrower spawn-gate shape `gh pr view <n> --json headRefOid,headRefName`.
- `docs/issues_drafts/173-gh-pr-view-state-rest-route.md` (GitHub [#538](https://github.com/chetwerikoff/orchestrator-pack/issues/538), open) - state-only `pr-view` gap for AO `getPRState`. Sibling inventory gap; not a prerequisite.

**Prior-art verdict:** extends shipped #431/#501/#520/#530. This is a narrow follow-up for one uncovered `pr-view` field set plus a no-drift guard for future gh read additions; it must not reimplement the existing wrapper, static guard, or six-field `resolvePR` route.

## Goal

Route the spawn worktree gate's `gh pr view <n> --json headRefOid,headRefName` through pack `scripts/gh` REST inventory, and make new pack-owned GitHub read command shapes fail review/CI unless they are classified, explicitly REST-only, or intentionally exempted.

```behavior-kind
action-producing
```

## Binding surface

The pack-owned spawn gate currently reads PR head identity with:

```text
gh pr view <n> --json headRefOid,headRefName
```

The installed pack wrapper must classify that argv as a REST `pr-view` route and emit gh-CLI field names `headRefOid` and `headRefName` from the pull data it already fetches for `pr-view` routes.

The existing gh inventory static guard remains the single enforcement surface. It must treat newly introduced executable GitHub read forms as inventory obligations: covered by `classifyArgv`, explicitly REST `gh api repos/...` reads, or a documented intentional passthrough exception. The guard must not flag prose-only mentions or historical examples that are already excluded by the existing rule-mode filters.

**Operator adoption:** none. This is pack code/prompt enforcement only; no daemon restart or local config change is required beyond normal PR rollout.

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:gh-inventory:pr-view-head-ref-classifier
binding-type: cli-behavior
binding: gh pr view <n> --json headRefOid,headRefName classifies to pr-view REST, not passthrough
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:gh-inventory:pr-view-head-ref-output
binding-type: structured
binding: REST-routed pr-view emits gh-CLI fields headRefOid and headRefName
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:gh-inventory-static-guard:new-read-shape-guard
binding-type: cli-behavior
binding: static guard fails on new unclassified executable gh read shapes and passes classified/rest-only/exempt shapes
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/**` - gh inventory matcher, REST route shaping, wrapper/static-guard tests, check scripts.
- `prompts/agent_rules.md` - agent-facing rule that new GitHub read shapes must be checked against pack inventory before being recommended or committed.
- `docs/issues_drafts/**` - this task draft and any narrow cross-reference updates needed by the publish flow.

## Files out of scope

- AO plugin source or vendored Composio/agent-orchestrator packages.
- Reworking the whole gh wrapper architecture.
- Changing the already-shipped six-field `resolvePR` route from #530 except where regression tests prove it remains intact.
- GraphQL degraded-mode/backoff work (#540).
- GitHub issue publishing mechanics outside the normal draft publish flow.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
prompts/**
docs/issues_drafts/**
```

## Acceptance criteria

1. **Classifier:** `gh pr view <n> --json headRefOid,headRefName` classifies to `pr-view`, not passthrough, with and without a supported `--repo <owner/repo>` prefix if the existing parser admits the repo flag for `pr-view`.

```producer-emission
producer: orchestrator-pack
datum: gh-inventory
expected: pr-view-head-ref-classifier
proof-command: npx vitest run scripts/gh-wrapper.test.ts
```

```positive-outcome
asserts: argv ['pr','view','527','--json','headRefOid,headRefName'] classifies to route id pr-view
input: realistic
```

2. **REST output parity:** A mocked or fixture-backed REST pull response through the wrapper emits exactly the requested gh-CLI fields for this route: `headRefOid` from the PR head SHA and `headRefName` from the PR head ref; no GraphQL transport is invoked.

```producer-emission
producer: orchestrator-pack
datum: gh-inventory
expected: pr-view-head-ref-output
proof-command: npx vitest run scripts/gh-wrapper.test.ts
```

```positive-outcome
asserts: under a GraphQL-exhausted or GraphQL-forbidden wrapper harness, pr-view head-ref argv returns JSON with headRefOid and headRefName sourced from the REST pull fixture
input: realistic
```

3. **New gh read shape guard:** The existing static guard fails on a fixture/rule/script sample that adds an unclassified executable gh read such as `gh pr view 123 --json unknownField`, and passes when the sample uses a classified shape, an explicit REST `gh api repos/...` read, or a documented intentional passthrough exception.

```producer-emission
producer: orchestrator-pack
datum: gh-inventory-static-guard
expected: new-read-shape-guard
proof-command: npx vitest run scripts/gh-inventory-static-guard.test.ts
```

4. **Agent rule:** `prompts/agent_rules.md` tells agents that every new GitHub read argv shape must be checked against pack `scripts/gh` inventory classification before being recommended or committed; uncovered forms are inventory-extension reports, not authorization for GraphQL, raw curl, temp wrappers, or direct bash REST branches.

5. **Regression:** Existing routed forms from #431/#501/#520/#530 remain classified and shaped as before, including the six-field `resolvePR` / `prInfoFromView` route and state/body/baseRefName `pr-view` routes.

6. **No bypass:** The implementation introduces no `gh api graphql`, raw `curl api.github.com`, temporary wrapper, `unset GH_WRAPPER_ACTIVE`, or hand-built REST branch outside the existing wrapper/inventory route machinery.

## Upgrade-safety check

- Pack-owned `scripts/`, `prompts/`, and draft docs only; no vendor or AO core patches.
- One additional `pr-view` field set uses the same REST pull endpoint as existing `pr-view` routes.
- Static guard changes must derive from the same inventory classifier where practical, so the guard and wrapper cannot drift into separate allowlists.
- Unsupported future gh read forms must fail closed as inventory gaps, not silently passthrough to native GraphQL.

## Verification

- `node --input-type=module -e "import { classifyArgv } from './scripts/lib/gh-inventory-match.mjs'; console.log(classifyArgv(['pr','view','527','--json','headRefOid,headRefName']).route?.id)"`
- `npx vitest run scripts/gh-wrapper.test.ts`
- `npx vitest run scripts/gh-inventory-static-guard.test.ts`
- `pwsh -NoProfile -File scripts/check-gh-inventory-static.ps1`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/177-gh-pr-view-head-ref-rest-route-and-gh-read-shape-guard.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/177-gh-pr-view-head-ref-rest-route-and-gh-read-shape-guard.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Design analysis

**Critical mechanics:** `classifyArgv` is the source of truth for wrapper inventory routing; route execution must shape REST pull data into gh-CLI field names; static guard must catch executable command shapes without treating prose as code.

**Options considered:**

| Option | Cost | Risk | Sufficiency |
|---|---:|---:|---|
| Extend existing `pr-view` route and static guard | Low | Low | Sufficient; reuses shipped inventory machinery |
| Add a special-case spawn-gate replacement command | Medium | Medium | Insufficient; fixes one caller while leaving the inventory gap class open |
| Broaden wrapper to REST-route every `gh pr view --json ...` field set | Medium | High | Too broad; risks mismatched gh-CLI field parity for unverified fields |

**Chosen:** extend the existing allowlist for the verified field set and strengthen the existing guard for future additions. This fixes the immediate spawn-gate GraphQL passthrough while preserving the wrapper's conservative field-parity contract.
