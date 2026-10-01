# Target portability sink audit — Issue #2188

## Provenance

- Audited implementation-PR base: `435683abea628c9dc185e45a84bda40cc9f5bb7b` (`main` at final reconciliation).
- The first implementation lineage was cut from `23adc0c4214d4d47cccc8728d7cb147d793ce678`. While findings were being fixed, the live PR base advanced to `435683abea628c9dc185e45a84bda40cc9f5bb7b` and GitHub reported the PR non-mergeable. The existing branch was therefore synchronized with exactly that live base in merge-sync commit `6197ddca965fac376d78f09d3a8fab6b18e478c8`; no second branch or PR was created.
- The base refresh contained 83 default-branch commits. Only four current-base paths overlapped #2188-owned changes: `.cursor/skills/merge-with-local-adoption/SKILL.md`, `scripts/draft-discipline.mjs`, `scripts/pack-review-runner.ts`, and `scripts/worker-smoke-run.ts`. The first three merged without semantic conflict. The worker-smoke refactor already carried selected-repository routing but still retained pack/default-branch literals; reconciliation kept the refactor and reapplied the #2188 project/default-branch bindings. GitHub read-back then reported the PR mergeable again.
- Audit universe: tracked non-test production/instruction files under `scripts/**`, `plugins/**`, `prompts/**`, `.cursor/skills/**`, `.claude/skills/**`, `.github/workflows/**`, plus the three documentation paths allowed by Issue #2188.
- Explicitly excluded by the Issue contract: `packages/core/**`, `vendor/**`, test-only files, fixture-only files, and files outside the allowed roots.
- Test files are evidence only; they are not selector rows.

The base-bound matrix below is the provenance record. Completion is additionally
checked against the final PR head by the focused tests and the final reconciliation
procedure in this document.

## Discovery and trace recipe

Discovery was performed while the default branch was exactly the audited base
above, using repository code search for the following terms/classes and then
reading the owning functions at that exact commit. The locally reproducible
equivalent is to checkout the base SHA and run the bounded `git grep` commands
below, then trace every hit to its owning caller before assigning a disposition.

Search terms/classes:

- `chetwerikoff/orchestrator-pack`;
- `--repo`, `-R`, `GH_REPO`, `GITHUB_REPOSITORY`, full GitHub PR/Issue URLs;
- `resolveRepoContext`, `process.cwd()`, cwd/repository-root defaults, `git remote`, `origin`;
- bare `orchestrator-pack` and `DEFAULT_PROJECT_ID` fallbacks;
- `OPK_PROJECT_ID`, `--project`, and `projectId` selection;
- `defaultBranch`, `baseRefName`, `origin/main`, `refs/remotes/origin/main`, and integration/base branch literals;
- required-status/check and pack-review routing;
- project URL, state/config roots, checkout/worktree builders, and generated state paths.

Reproducible local search:

```bash
BASE=435683abea628c9dc185e45a84bda40cc9f5bb7b
ROOTS=(
  scripts plugins prompts .cursor/skills .claude/skills .github/workflows
  docs/target-portability-sinks.md docs/target_repo_setup.md docs/migration_notes.md
)

git grep -n -E 'chetwerikoff/orchestrator-pack|GH_REPO|GITHUB_REPOSITORY|resolveRepoContext|process\.cwd\(\)|git remote|DEFAULT_PROJECT_ID|OPK_PROJECT_ID|defaultBranch|baseRefName|origin/main|refs/remotes/origin/main'   "$BASE" -- "${ROOTS[@]}"   ':(exclude)**/*.test.*' ':(exclude)**/*.spec.*' ':(exclude)**/fixtures/**'

git grep -n -E -- '--repo|-R|https://github\.com/.+/(pull|issues)/|required.?status|required.?check|pack-review|projectUrl|stateRoot|configRoot|worktree|checkout'   "$BASE" -- "${ROOTS[@]}"   ':(exclude)**/*.test.*' ':(exclude)**/*.spec.*' ':(exclude)**/fixtures/**'
```

For each hit, the trace step reads the owning function and its production callers.
Text that merely describes a historical example or a fixed pack product/evidence
identity is not treated as a target selector after that trace; those retained
occurrences are nevertheless called out below when they are likely to be confused
with target identity.

## Sink matrix

| ID | Base site(s) / owning surface | Selector class | Disposition | Evidence / final treatment |
|---|---|---|---|---|
| T01 | `scripts/gh` → `scripts/lib/gh-wrapper.mjs` → `scripts/lib/gh-repo-resolve.mjs` | repo/host ingress, `GH_REPO`, cwd/origin, native passthrough | `target` | Target mode is non-empty `OPK_PROJECT_ID`. `scripts/gh` now invokes one pre-native/pre-network authorization helper before `GH_WRAPPER_ACTIVE` and operator-unblock branches, resolves `resolveTargetContext`, exports the selected repo/host, validates explicit repo-bearing ingress, and rejects arbitrary target-mode GraphQL. Existing resolver logic remains usable for non-target/operator mode only. |
| T02 | `scripts/lib/gh-rest-routes.mjs::fetchPullByReference` and generic REST routes | full PR URL / REST repo path | `target` | In target mode these routes are downstream of T01, so a cross-repository URL or `repos/<owner>/<repo>` path is rejected before the route/native network path can run. The route module does not become an independent selector. |
| T03 | `scripts/publish-issue-body-sync.ts` → `scripts/lib/publish-issue-body-sync.ts::syncPublishIssueBody` | Issue create/edit repository | `target` | Production caller now resolves the selected card, rejects disagreeing `--repo`, sets `OPK_PROJECT_ID`, and supplies `context.repository` to the existing application seam. |
| T04 | `scripts/lib/create-issue-stage-record-cli.ts`, `create-issue-stage-record-artifacts.ts`, `create-issue-stage-record-gh.ts`, `create-issue-stage-record-core.ts`, `create-issue-final-acceptance.ts` | Issue repository + create-Issue journal state | `target` | CLI repository is card-selected. The journal default now derives from existing `canonicalReviewStateRoot()`, producing `create-issue-draft/<projectId>/<issue>/journal`; production workdir overrides cannot cross the selected project. Pending-event and active-cycle files therefore share that project fence. |
| T05 | `scripts/pack-review-runner.ts::resolveTarget`, production callers of `resolveCurrentPrHead` / `resolveCurrentPrTarget` | canonical PR repository, base ref, project namespace | `target` | The selected context supplies repository/project/default branch. The checkout remote is validation only. A selected repo mismatch or PR-base/default-branch mismatch fails; base ref derives from `context.defaultBranch`. |
| T06 | `scripts/run-pack-review-gpt.ts`; `plugins/codex-pr-reviewer/lib/review_cli.ts` | review repository/base | `target` | Production review entrypoints require the selected target, validate the observed checkout against the selected repository, and derive the base from the selected default branch. Missing selection fails through the typed target-context `missing-selection` path before repository/base effects; only explicit Vitest/`OPK_VITEST_HARNESS` fixture execution may remain unbound. |
| T07 | `scripts/worker-smoke-run.ts` | smoke repo/project/default branch, pack-review store | `target` | Production smoke now requires the selected target, validates origin and live repository default branch, uses selected project state, and derives merge/base proof from `context.defaultBranch`. Vitest-only pack defaults remain fixture behavior. |
| T08 | `scripts/manager-review-terminal-bundle.ts` | review bundle repo | `target` | Repository comes from selected context; explicit `--repo` may only corroborate it. |
| T09 | `scripts/draft-discipline.mjs` | live Issue repository, `GITHUB_REPOSITORY`/pack fallback | `target` | Live reads resolve the selected card before tracked gh. Target-mode ambient repository disagreement fails; Vitest-only no-selector fallback remains fixture behavior. |
| T10 | `scripts/pack-worker-report.ts` | worker report project/repository | `target` | Both explicit-binding and automatic report paths require a selected project through `resolveTargetContext`; there is no `orchestrator-pack` selector fallback. Explicit repository input must corroborate the selected card before report/state effects. |
| T11 | `scripts/lib/worker-status-store.mjs::resolveWorkerStatusBindingRepoSlug` | `GITHUB_REPOSITORY` fallback | `target` | In target mode the ambient Actions variable is no longer a fallback. The selected supervisor/session/input binding must already provide the repository; otherwise the store fails closed with `selected_target_repo_required`. |
| T12 | `scripts/pr2-foundation/supervised-task-launch-assistant.ts` | manager worktree repo/default branch | `target` | Production CLI already resolves the selected card. Manager refresh/create now carries `context.defaultBranch`, requires `origin/<selected-default>`, and validates the local branch is distinct from that branch instead of hard-coding `main`. |
| T13 | `scripts/worktree-teardown.ts`; `scripts/worktree-lifecycle/operations.ts` | merged PR base/adopted default branch | `target` | Post-merge proof resolves the selected default branch in production and checks/fetches/ancestry-proves that branch. Vitest-only no-selector fallback is `main`. |
| T14 | `.cursor/skills/create-issue-draft/SKILL.md`, `publish-issue-draft/SKILL.md`, `merge-with-local-adoption/SKILL.md`, `direct-fix-checklist/SKILL.md`, `prompts/investigate_root_cause.md` | target-running instruction repo/base | `target` | Instructions now resolve the selected project card and bind target repository/default branch rather than naming the pack repo or `main` for target effects. |
| D01 | `scripts/lib/target-context.ts`, project-card schema/binding, extra-remote behavior | project/repository/default branch/project URL | `done in #2185/#2186/#2187` | #2185 established card authority and origin validation while permitting unrelated extra remotes; #2187 owns target verification. This Issue reuses the resolver rather than introducing another selector. |
| D02 | wake-supervisor/project state roots, worker assignment/smoke receipt state, cutover migration/bindings | project state namespace | `done in #2185/#2186/#2187` | #2186 moved target supervisor/control-plane state to project namespaces and bound repository identity. Residual pack defaults are library/non-target compatibility defaults; target launchers supply/require the selected project. T04 fixes the one known producer that could recreate flat create-Issue journal state. |
| D03 | `scripts/chatgpt-browser-turn/state-light-turn-base.ts::browserTurnRecurrencePath/readBrowserTurnProjectIdentity` | Browser-turn recurrence project/repository state binding | `done on current base` | The refreshed base introduced/changed this state-only surface. When `OPK_PROJECT_ID` is present it namespaces recurrence state by project and validates the selected project card plus persisted project/repository binding before appending incident state; without a selector it uses the legacy non-target recurrence path. It does not choose a GitHub Issue/PR repository for target effects, so no new #2188 transport selector is introduced. |
| P01 | `scripts/lib/gh-rest-routes.mjs` + `scripts/lib/gh-inventory-match.mjs` fixed runtime-history routes | fixed runtime-history repository/status policy | `pack-only` | The fixed slug is used only by route IDs named `runtime-history-*`, including the pack `main` protection/status-history endpoints. Generic PR/Issue routes accept the repo object supplied through T01 and are covered by T01/T02. |
| P02 | `scripts/vitest-runtime-history-delivery.mjs`, `scripts/lib/vitest-runtime-history-merge.mjs`, matching runtime-history workflows | runtime-history delivery repo/base/status contexts | `pack-only` | These modules explicitly validate `TARGET_REPOSITORY = chetwerikoff/orchestrator-pack`, pack runtime-history contexts, and the dedicated runtime-history workflow path; they reject any other repository. This is pack CI history delivery, not target task routing. |
| P03 | `scripts/pr2a/closure-receipt.ts`, `scripts/pr2a/closed-world-scanner.ts`, `scripts/pr2a/contracts.ts`, `scripts/pr2a/planning-manifest.json` and PR2A conformance/precutover helpers | PR2A evidence repository | `pack-only` | The closure receipt validates pack-specific PR2A evidence (including Issue 928 and exact pack repository). Issue #2188 explicitly keeps it audit-only and out of the target smoke. |
| P04 | `scripts/chatgpt-browser-turn/too-many-requests-source.ts` | fixed Issue/repository URL | `pack-only` | The module is an evidence source for fixed Issue 1168: constants `ISSUE_NUMBER = 1168`, issue-specific schemas, and fixed source comment lookup prove it is not a general target Issue path. |
| P05 | `scripts/pr2-foundation/terminalized/review-bulk-send-diagnose.ts` | fixed pack Issue URL | `pack-only` | The literal is diagnostic metadata for fixed pack Issue 140 in a terminalized contract diagnostic, not target publication/routing. |
| C01 | `plugins/codex-pr-reviewer/lib/emit.ts` footer link | product identity link | `pack-owned constant` | The link identifies the reviewing product in emitted prose (“Automated review by Codex CLI · orchestrator-pack”); it does not choose a repository for any read/write. |
| C02 | `scripts/data/ops-wiki-manifest.json::source_repo` | pack documentation source identity | `pack-owned constant` | The manifest indexes the orchestrator-pack ops wiki itself. `source_repo` describes the pack source corpus, not the selected task repository. |
| C03 | `prompts/codex_review_prompt.md` references to trusted pack root / pack base | trusted pack source authority | `pack-owned constant` | Those references constrain the reviewer’s trusted pack code/prompt source; they are not the reviewed target repository selector. |
| C04 | `docs/migration_notes.md` historical pack slugs/paths and target-setup references that explicitly describe pack installation | documentation/product identity | `pack-owned constant` | These occurrences document the product and historical migrations. They do not feed runtime repository selection. |
| C05 | `scripts/pr-scope-runner.ts` / `.github/workflows/scope-guard.yml` `GITHUB_REPOSITORY` | GitHub event repository | `pack-owned constant` | Semantic trace shows this is the trusted GitHub Actions event boundary: the workflow checks out the PR base from the event repository and supplies the event’s owner/name to the trusted scope runner. It is not a local project-card selector and cannot redirect the operation to an arbitrary second repo. The policy of using the hosting event repository is part of the reusable scope-guard contract. |
| C06 | CI wallclock/runtime-history/report workflows using `GITHUB_REPOSITORY` solely as current Actions repository identity | GitHub event identity | `pack-owned constant` | Same evidence class as C05: the value is supplied by the hosting GitHub Actions event and scoped to that run, not selected from local project/card/cwd. Target-mode wrapper authorization is not active unless `OPK_PROJECT_ID` is deliberately supplied. |
| C07 | `scripts/lib/review-start-claim-cli.ts`, `scripts/lib/pack-review-run-store.ts` pack project fallback | default namespace for non-target/legacy pack calls | `pack-owned constant` | Target pack-review production entrypoints now resolve/pass the selected project before these stores. The remaining default names the pack’s own non-target compatibility namespace; it no longer selects a target repository. |
| C08 | `scripts/lib/reverify-bound-issue-snapshot.ts`, `worker-smoke-receipt.ts`, `wake-supervisor-state-root.ts`, cutover helpers with bare pack project fallback | helper fallback namespace | `done in #2185/#2186/#2187` | Target-running supervisor paths from #2186 carry the project binding; these low-level helpers retain a pack fallback for pack/non-target callers. No target entrypoint may use that fallback as target authority. |
| C09 | `scripts/lib/create-issue-stage-record-artifacts.ts` full Issue/comment URLs | derived artifact URL | `target` | URLs are constructed from the already bound `repositoryFullName` supplied by T04 and are validated back against that same repository. They are not an independent URL selector. |

### Discovery hits that are not selector rows

The search recipe intentionally over-matches. Test/fixture files are evidence only.
Other textual hits are excluded from the matrix when tracing shows they neither
choose nor authorize repository/project/base/state identity—for example schema
names containing `orchestrator-pack`, package/import names, status context names,
comments, historical migration prose, and generated diagnostic labels. Fixed
pack evidence identities that could plausibly be mistaken for routing are retained
as P/C rows above rather than silently discarded.

## GitHub target-mode authorization contract

The target authorization seam is `scripts/lib/gh-target-authorization.ts`,
called by `scripts/gh` before the existing recursion/operator-unblock paths.

In target mode it:

1. requires non-empty `OPK_PROJECT_ID` and resolves `resolveTargetContext`;
2. binds the effective host to `github.com`;
3. checks `GH_HOST`, `--hostname`, and host-qualified URLs;
4. checks `GH_REPO`, `--repo`, `-R`, `--repo=...`, concrete
   `repos/<owner>/<repo>/...` API paths, and full GitHub PR/Issue URLs against
   `context.repository`;
5. makes no-repository-ingress calls use `context.repository` by exporting
   `GH_REPO` only after authorization;
6. rejects arbitrary `gh api graphql` in target mode;
7. runs before `GH_WRAPPER_ACTIVE`, so the recursion marker is never an
   authorization bypass.

No new host selector, arbitrary repository allowlist, or persistent transport was
introduced.

## Two-target dry-run evidence

Focused test `scripts/target-portability-sinks.test.ts` creates two realistic
project cards with different repositories/default branches and uses the same
Issue/PR number under both. It verifies:

- the selected card is bound by the production `scripts/publish-issue-body-sync.ts`
  caller and the test then drives the real `syncPublishIssueBody` seam, recording
  the Issue edit mutation plus parity-read repository/endpoint/Issue identity;
- the test drives the real `resolveCurrentPrHead` seam with its injected runner
  and records the canonical `repos/<selected>/pulls/<same-number>` request;
- identical Issue 77 journal paths are disjoint by project id;
- a pending event written under project alpha is not visible under project beta;
- `active-cycle-id.txt` is independently persisted/read per project;
- an alpha journal path cannot be supplied as beta’s production workdir;
- wrapper authorization covers matching and mismatching repository/host ingress,
  URL-valued mutation payloads, repository slugs containing `s`, recursion-shaped
  calls, GraphQL fail-closed behavior, and the operator-unblock no-`--repo` branch;
- required-CI policy path construction covers non-`main` selected branches, and
  target-classified review/report entrypoints prove selector-absent typed failure
  outside explicit test harnesses.

No test performs a live remote write.

## Final-head reconciliation

Immediately before handoff:

1. verify the live PR base and PR merge-base still equal
   `435683abea628c9dc185e45a84bda40cc9f5bb7b`; if either moves, regenerate this
   audit against the new base before handoff;
2. rerun the discovery recipe over the final checkout, with the same exclusions;
3. inspect `git diff --name-only 435683abea628c9dc185e45a84bda40cc9f5bb7b...HEAD` and separately prove the final head remains a strict descendant of the reviewed findings head `0be7a502ac5fae9958223c8b844870a0228ddeb0`;
4. confirm every introduced/changed repository/project/base/state selector is
   already represented by a T/D/P/C row above;
5. confirm no changed path is outside Issue #2188 allowed roots or inside its
   denylist;
6. run focused tests plus the repository-required verification/CI on that exact
   final head.

The final PR/head/CI receipt, rather than this base-bound prose alone, is the
completion evidence for step 6.
