# Reviewer coworker pass maps PR diffs to the task contract

GitHub Issue: #362

## Prerequisite

- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148,
  closed) — *already does:* establishes “delegate I/O, keep reasoning,” the
  provider-input fence, and the invariant that review judgment stays on the main
  reviewer.
- `docs/issues_drafts/83-coworker-delegation-threshold-and-enforcement.md`
  (GitHub #255, closed) — *already does:* makes diff/log summaries over the
  read-delegation floor observable and keeps reviewer-path judgment outside the
  delegated denominator.
- `docs/issues_drafts/84-codex-reviewer-no-sandbox-coworker.md` (GitHub #258,
  closed) — *already does:* permits the trusted Codex reviewer path to invoke
  coworker with the execution/network access needed for delegated reads.
- `docs/issues_drafts/109-diff-read-directly-not-delegated.md` (GitHub #337,
  closed) — *historical contrary decision:* required every agent to read diffs
  directly. Its implementation was intentionally reverted by commit `32743aa`,
  restoring the current reviewer bulk-diff recipe. This draft extends the
  restored recipe; it does not revive #337 or delegate final review judgment.

## Goal

Make the reviewer-only coworker read useful for contract-heavy PRs, not merely a
file-change summary: when a review has an accessible task specification with
testable acceptance criteria, coworker also maps those criteria to the diff and
test changes and returns concrete gap candidates. The main reviewer must still
inspect the diff directly, validate every candidate, assign severity, and make
the final review verdict.

```behavior-kind
action-producing
```

## Binding surface

- The canonical reviewer recipe keeps the existing bulk-diff summary for diffs
  over the delegation floor.
- When the PR is linked to an accessible issue/spec containing testable
  acceptance criteria, the reviewer performs an additional, reviewer-only
  contract-mapping ask using the scrubbed diff and the minimal relevant spec
  text.
- The mapping pass resolves the task contract from the PR's explicit closing or
  task reference under the repository's existing scope-context rules. Accepted
  authoritative sources are: an explicit task/issue identifier in the
  review invocation/context; a unique GitHub closing-keyword reference in the PR
  body; or a unique task issue carried by the repository's declaration/scope
  context. PR title, branch name, commit text, and non-closing prose mentions are
  not authoritative. Resolution collects every authoritative reference: when
  they identify the same issue, or the bound spec text explicitly declares a
  parent/child or prerequisite relationship between them, they are co-applicable
  and form the named contract set. Mere topical similarity, shared paths, or
  simultaneous mention is not proof. Otherwise the result is `ambiguous_spec`.
  No higher-priority source silently overrides a conflicting lower source. The
  reviewer records the resolved issue/spec
  identity, a hash of the exact spec snapshot, and the PR head SHA used for the
  diff. Summary, mapping, direct inspection, and final verdict must cover that
  same head and spec snapshot; either changing makes the mapping stale and
  requires regeneration.
- Resolution must produce one authoritative contract set. When multiple explicit
  references are contract-bearing, all applicable specs are mapped as a named set;
  if their authority or applicability is ambiguous, mapping is skipped rather
  than selecting one heuristically.
- Multi-spec `mapped` is all-or-nothing: every applicable member must be
  available, safe, current, and complete. Partial candidates may be retained only
  as explicitly incomplete hypotheses while the final set status remains
  non-mapped.
- Diff and spec artifacts are explicitly untrusted **data**, never instructions.
  The coworker ask must ignore commands, role changes, tool requests, and output
  directives embedded in either artifact; it may read only the supplied paths
  and return the reviewer-defined candidate schema. Artifact content cannot
  authorize command execution or additional data access.
- The contract-mapping output is explicitly **candidate evidence**, not a review
  finding. Coworker must not assign severity, approve/reject the PR, or replace
  direct reviewer inspection.
- The output is an exhaustive requirement ledger, not only a candidate list:
  every bound acceptance criterion has an entry with owning spec identity/hash,
  exact cited text, mapping status, implementation/test evidence or explicit
  `not_found`, and an optional gap candidate. `mapped` is invalid if any bound
  criterion is omitted or unaccounted.
  Any omitted/unaccounted criterion makes the whole response
  malformed/non-mapped; every candidate from that response remains incomplete
  hypothesis evidence and cannot be promoted as mapped evidence.
- Each candidate identifies the requirement, owning spec identity and snapshot
  hash, exact cited requirement text from that bound snapshot, relevant
  implementation location, concrete input/state, expected contract outcome,
  observed or implied mismatch, and test evidence.
  When the gap is missing implementation/wiring, it may instead identify the
  expected owning surface and state that required implementation is absent from
  the changed diff; it must not invent a code location.
  Claims that a test is missing require inspection of the complete changed
  content for every test file in the PR diff, not an implementation-only excerpt
  or selected test hunk.
- Test evidence is selected using repository conventions and changed-file
  content, not filename suffix alone. Renamed, nonstandard, generated/golden,
  script-hosted, and document-based contract fixtures that may test the
  requirement are included; ambiguous test-like changed files block a
  missing-test claim rather than being ignored.
- The mapping input uses the complete scrubbed PR diff plus deterministic
  contract-bearing spec sections: Goal, Binding surface, Acceptance criteria,
  and Verification (or their repository-equivalent headings). If those sections
  cannot be extracted completely within the provider/input boundary, mapping
  falls back rather than using a subjective excerpt. Redaction that removes
  decision-bearing implementation or test context always produces
  `skipped_provider_fence`; this issue does not support hypothesis-only mapping.
- `mapped` is valid only when the complete scrubbed diff and every required spec
  section were supplied without truncation. If provider/input limits prevent
  that, it reports `skipped_input_limit` and continues direct review; partitioned
  mapping/recombination is outside this issue.
- Confirmed observations, hypotheses, and missing-validation suggestions are
  separated. Generic risk lists without a concrete failure scenario are not
  presented as findings.
- If no usable spec is linked, the spec is not safely sendable under the
  provider-input fence, coworker is unavailable, or the mapping response is
  malformed, the reviewer continues with direct inspection and reports the
  bounded fallback. Contract mapping must not become a review availability
  dependency.
- Every attempt emits one fixed review-status value:
  `mapped`, `skipped_no_spec`, `skipped_provider_fence`, `unavailable`,
  `lookup_unavailable`, `skipped_no_acceptance`, `malformed`, `stale_head`,
  `stale_spec`, `ambiguous_spec`, `artifact_prep_failed`, or
  `skipped_input_limit`, or `incomplete_evidence`. Reviewer output carries a structured status record with
  that enum plus PR head SHA, resolved spec set and snapshot hashes when bound,
  and current usability; this is not a new durable subsystem. Final reviewer
  output reports current usability:
  when an earlier `mapped` attempt becomes stale, the final status is
  `stale_head`/`stale_spec` and its candidates cannot be promoted as mapped
  evidence.
- When multiple conditions occur, status precedence is deterministic:
  `stale_head` overrides `stale_spec` when both changed (the structured metadata
  still records both stale dimensions); either stale status overrides an earlier
  mapped attempt; then `artifact_prep_failed`; then `skipped_provider_fence`; then
  `ambiguous_spec`; then `lookup_unavailable`; then `skipped_no_spec` /
  `skipped_no_acceptance`; then `incomplete_evidence`; then
  `skipped_input_limit`; then `unavailable`; then response-shape failure after
  invocation, `malformed`.
- Only the task spec text needed to interpret requirements is eligible input;
  issue comments, attachments, screenshots, linked logs, and unrelated body
  sections are excluded by default. If the relevant spec text cannot be scrubbed
  of secrets or private/third-party data without losing the contract signal, the
  mapping pass is skipped under the existing provider-input fence.
- The same provider-input scrub applies to the complete diff. Secret/private
  diff content is redacted only when contract-relevant evidence remains
  complete; decision-bearing redaction triggers `skipped_provider_fence`.
- Coworker `--paths` for this pass contains only the generated scrubbed diff and
  spec artifacts. It never names the repository root, issue/comment dumps,
  denylisted/runtime/session roots, home/config directories, or unrelated files.
  Before invocation, both paths resolve inside one controlled per-attempt artifact
  directory and are freshly generated regular non-symlink files; traversal,
  symlink, stale/reused artifact, or out-of-directory resolution fails with
  `artifact_prep_failed`.
- Artifact hashes and structured status metadata are computed from the exact
  finalized scrubbed files after all extraction, redaction, and writes, and those
  same files are passed through `--paths`; any mismatch is
  `artifact_prep_failed`.
- The provider-input fence and mandatory `--profile code` / `--allow-code` /
  `--paths` invocation shape remain unchanged.

## Files in scope

- `prompts/agent_rules.md` — canonical reviewer coworker recipe.
- `prompts/codex_review_prompt.md` — reviewer execution contract.
- Reviewer prompt/policy contract checks and fixtures under `scripts/**`.
- An executable reviewer-side owner/helper under existing `scripts/**`
  conventions for artifact preparation, finalized-file hashing, status assembly,
  and pre-invocation failure handling; the planner chooses the concrete file and
  integration shape.
- `docs/issues_drafts/00-architecture-decisions.md` — record the reviewer-only
  refinement and its relationship to the reverted #337 decision.

## Files out of scope

- Coworker use outside PR review.
- Coworker model/provider selection or CLI implementation.
- Automated acceptance of coworker candidates as review findings.
- Changes to review triggering, finding routing, merge policy, or AO core.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
scripts/**
docs/issues_drafts/**
```

## Acceptance criteria

1. For a PR diff over the delegation floor with an authoritative contract source
   resolved by criterion 23 and containing acceptance criteria, when preflight
   proves the complete scrubbed diff and required spec sections fit the
   provider/input boundary, the reviewer contract invokes coworker with both
   artifacts and requests a
   requirement-to-implementation-to-test mapping. Otherwise it reports the
   applicable `skipped_*`/fallback status without invoking an incomplete mapping.
   The review status identifies the resolved task spec, its snapshot hash, and PR
   head SHA.
2. The mapping contract requires every gap candidate to include a concrete
   failure scenario and either a concrete changed location or an expected owning
   surface plus verified absence, separates confirmed observations from
   hypotheses, and prohibits severity and final verdict.
   It also treats artifact-embedded instructions as untrusted data and prohibits
   artifact-directed commands or additional reads.
   Each candidate cites the owning spec identity/hash and exact requirement text
   from that bound snapshot.
3. A “missing test” candidate is permitted only when the ask covers the complete
   changed content of every test file in the PR diff; the prompt must not infer
   absence from an implementation-only excerpt, omitted test path, or selected
   test hunk.
4. After receiving the mapping, the reviewer contract still requires direct diff
   inspection and independent validation before a candidate can become a finding.
   Summary, mapping, direct inspection, and verdict are bound to one PR head; a
   head or spec-snapshot change invalidates the prior mapping.
   Independent validation covers both the exact cited spec text and the exact
   implementation/test evidence.
5. A review with no linked usable spec retains the current summary/direct-review
   path without failing or fabricating a contract.
6. A provider-fence rejection, unavailable coworker, invalid response, or
   unavailable issue lookup degrades to direct reviewer inspection with an
   explicit fallback status and no loss of review availability.
   Issue comments/attachments/linked logs are not implicitly added to provider
   input, and unsafely scrubbable spec text triggers this fallback.
   Every attempt reports exactly one status from the fixed vocabulary.
7. Non-review reads and their existing delegation thresholds are unchanged.
8. Static/fixture checks fail if the reviewer prompt allows coworker to assign
   severity/verdict, omits direct validation, sends files positionally instead
   of through `--paths`, or makes contract mapping unconditional when no usable
   spec exists.
9. A malicious instruction embedded in the issue/spec or diff cannot change the
   ask's role, authorize tools/commands, expand input paths, or alter the required
   candidate-only output contract.
10. Multiple explicit task references map as one named authoritative contract set
    when applicability is clear; ambiguity produces `ambiguous_spec`, never a
    heuristic single-spec choice. If any applicable member is unavailable,
    unsafe, stale, or incomplete, the set cannot report `mapped`.
11. Input truncation or incomplete diff/spec coverage can never report `mapped`;
    `skipped_input_limit` and direct review are required.
12. Provider-facing paths are limited to the generated scrubbed diff/spec
    artifacts, and secret/private content in either artifact is redacted safely
    or causes `skipped_provider_fence`.
13. Final status reflects whether mapping evidence is usable at verdict time:
    mapped-then-drift reports stale and no stale candidate is promoted.
14. Failure to generate/write/hash scrubbed artifacts reports
    `artifact_prep_failed`, does not invoke coworker, and continues direct review.
15. Missing-implementation candidates may cite the expected owning surface and
    verified absence from the changed diff; a fabricated concrete code location
    is prohibited.
16. Ambiguous test-like changed files prevent a missing-test claim until the main
    reviewer classifies them.
17. `mapped` requires one accounted ledger entry for every bound acceptance
    criterion; silent criterion omission makes the entire response
    malformed/non-mapped and none of its candidates can be promoted as mapped
    evidence.
18. The structured status record carries enum, PR head, bound spec IDs/hashes,
    and current usability when applicable.
19. Artifact paths resolve to fresh regular non-symlink files inside the
    controlled per-attempt directory; unsafe resolution is
    `artifact_prep_failed`.
20. Reported artifact/spec hashes are computed from the finalized files actually
    passed via `--paths`; pre-finalization/wrong-file mismatch is
    `artifact_prep_failed`.
21. Decision-bearing redaction never produces a mapped/hypothesis-only coworker
    result; it skips mapping with `skipped_provider_fence`.
22. Overlapping failure conditions resolve under the declared deterministic
    status precedence; simultaneous head+spec drift reports `stale_head` and
    records both stale dimensions in metadata.
23. Task binding uses only the declared authoritative sources; weak text mentions
    cannot select the contract. Conflicting authoritative sources never resolve
    by precedence; they form a set only when they identify the same issue or an
    explicit parent/child/prerequisite relationship in the bound specs, otherwise
    they produce `ambiguous_spec`.
24. Contract-relevant binary/non-text/non-diffable changed files are incomplete
    evidence unless full scrubbed content is supplied; otherwise mapping is
    skipped with `incomplete_evidence` and missing-test claims are prohibited.
25. The executable reviewer path, not only prompt prose, owns artifact
    finalization/hashing/status preflight and suppresses coworker invocation on
    preparation failure.

```positive-outcome
asserts: on a representative large PR diff plus its acceptance-criteria-bearing issue body, the reviewer invokes the contract-mapping coworker ask and receives requirement-to-code-to-test candidates while retaining direct validation and final judgment locally
input: realistic
```

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No second authoritative coworker policy body; reviewer guidance remains rooted
  in `prompts/agent_rules.md`.
- No secrets or private issue content cross the provider-input fence.
- The additional pass is reviewer-only and conditional; worker/architect
  delegation behavior is unchanged.
- Coworker output never becomes an automatic approval, rejection, severity, or
  merge signal.

## Verification

1. Run reviewer prompt/policy contract fixtures proving the large-diff +
   acceptance-criteria case produces the conditional mapping ask with canonical
   CLI shape.
2. Run negative fixtures for no linked issue, issue without acceptance criteria,
   provider-fence rejection, unavailable issue lookup, coworker failure, and
   malformed mapping output; each continues to direct review.
3. Run a fixture where the test diff already covers the named criterion and
   assert the mapping contract does not label the test missing merely because it
   appears outside the implementation hunk; companion negative fixtures omit or
   truncate changed test-file content and prove a missing-test claim is not
   allowed.
4. Run a prompt-contract fixture proving coworker cannot assign severity or final
   verdict and the reviewer must independently validate candidates against the
   exact diff and exact cited spec snapshot text.
5. Run a head-drift fixture where the PR head changes after summary or mapping;
   the previous mapping is stale and cannot support the final verdict.
6. Run a spec-drift fixture where the issue body changes after mapping; the prior
   spec hash is stale and cannot support the final verdict.
7. Run provider-input fixtures proving comments, attachments, linked logs, and
   sensitive unsafely-scrubbable spec text are excluded or cause bounded fallback;
   include secret/private content in the diff and assert safe non-decision-bearing
   redaction or `skipped_provider_fence`; decision-bearing redaction never emits
   hypothesis-only mapping output.
8. Run prompt-injection fixtures with malicious directives in both artifacts;
   coworker remains data-only, reads no extra path, executes no artifact-supplied
   command, and returns only candidate schema.
9. Run deterministic extraction fixtures proving all contract-bearing sections
   are included or the pass falls back, plus fixtures for every fixed status.
10. Run oversized/truncated-input fixtures proving incomplete coverage cannot
    report `mapped`, plus multi-reference fixtures proving deterministic
    all-applicable mapping or `ambiguous_spec`.
11. Run a diff-redaction fixture where decision-bearing implementation/test
    context is removed and assert `skipped_provider_fence` with no mapping output.
12. Run a path-scope fixture proving the ask supplies only generated scrubbed
    diff/spec artifacts and rejects repo-root, raw issue dump, denylisted,
    runtime/session, home, config, and unrelated paths.
13. Assert `lookup_unavailable` covers issue lookup failure and
    `skipped_no_acceptance` covers a linked issue without acceptance criteria.
14. Run mapped-then-head/spec-drift final-output fixtures, including one changed
    spec inside a multi-spec set; final status is stale and no stale candidate is
    promoted.
15. Run scrubbed-artifact generation/write/hash failure fixtures; status is
    `artifact_prep_failed`, coworker is not invoked, and direct review continues.
16. Run multi-spec partial-failure fixtures; one unavailable/fenced/stale member
    makes the whole set non-mapped and partial candidates remain incomplete
    hypotheses.
17. Run test-evidence classification fixtures for renamed, nonstandard,
    generated/golden, script-hosted, and document-based contract tests; ambiguous
    test-like files block missing-test claims.
18. Run a missing-implementation fixture where the candidate cites an expected
    owning surface and verified absence without inventing a code location.
19. Run an exhaustive-ledger fixture where one acceptance criterion is omitted;
    the response cannot report `mapped`.
20. Run a structured-status fixture asserting enum, PR head SHA, spec identities,
    snapshot hashes, and usability are independently present and checked.
21. Run artifact identity fixtures for traversal, symlink, stale/reused, and
    out-of-controlled-directory paths; each fails before coworker invocation.
22. Run an over-limit preflight fixture proving no incomplete coworker mapping is
    invoked and status is `skipped_input_limit`.
23. Run a partial-ledger fixture with otherwise valid candidates but one omitted
    criterion; all candidates remain non-mapped hypotheses.
24. Run an artifact-finalization fixture proving hashes/status bind to the exact
    finalized files passed via `--paths`.
25. Run overlapping-failure fixtures proving deterministic status precedence.
26. Run task-reference fixtures for explicit invocation context, unique closing
    keyword, unique declaration/scope issue, weak prose mention, demonstrably
    co-applicable references, and conflicting references.
27. Run binary/non-text/non-diffable contract-fixture cases; absent full scrubbed
    content produces `incomplete_evidence` and prevents `mapped` and missing-test
    claims.
28. Run an integration fixture through the executable reviewer-side owner proving
    finalized-file hashes/status are assembled before invocation and preparation
    failure suppresses coworker.
29. Run `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md`.
30. Run `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md`.
31. Run `pwsh -NoProfile -File scripts/verify.ps1` and
   `pwsh -NoProfile -File scripts/check-reusable.ps1`.

## Decisions (design analysis)

**Prior art.** #148 already reserves judgment for the main reviewer; #255/#258
make delegated reviewer reads possible. #337 argued that summarization loses
line-level evidence, but its implementation was reverted and the current
canonical prompt intentionally delegates large-diff summarization. The remaining
gap is therefore not whether coworker may read a large diff, but whether that
read has enough task-contract context to produce useful candidates without
claiming reviewer authority.

**Options considered.**

1. Keep summary-only coworker use — lowest cost, but the PR #351 trial showed it
   missed a concrete fail-closed contract violation and produced speculative
   generic risks.
2. Add the issue/spec to the existing summary ask — cheapest additional provider
   cost, but combines orientation and adversarial contract checking in one
   response, making completeness and failure classification harder to test.
3. Add a conditional second contract-mapping ask — higher latency/token cost,
   but preserves the stable summary recipe and gives the mapping pass a narrow,
   mechanically checkable output contract. Chosen for contract-heavy reviews;
   it is skipped when no usable acceptance criteria exist.

The chosen option is bounded to reviewer reads. Final correctness, severity, and
verdict remain non-delegable reasoning.

## Decisions (GPT adversarial pass)

Pass 1 (`completed_valid`, `NEEDS_ATTENTION`, 6 findings):

- **Accepted:** bind task-spec resolution and all review stages to one explicit PR
  head; stale-head mapping is unusable.
- **Partially accepted:** define complete test evidence as all changed content for
  every test file and exclude comments/attachments/linked logs from spec input.
- **Rejected:** a new persisted machine audit artifact for each mapping attempt;
  explicit review status plus fixtures are sufficient for this prompt-level
  contract.
- **Rejected:** dedicated Windows/Ubuntu path harness; the canonical `--paths`
  command shape and existing pack portability checks already own that boundary.

Pass 2 (`completed_valid`, `BLOCKED`, 6 findings):

- **Accepted:** treat diff/spec artifacts as untrusted data with an explicit
  instruction-isolation boundary; artifact text cannot authorize commands,
  tools, or extra reads.
- **Accepted:** bind mapping to an exact spec snapshot hash as well as PR head.
- **Partially accepted:** deterministic extraction covers complete
  contract-bearing sections; incomplete/redacted decision evidence downgrades to
  hypothesis or fallback.
- **Accepted:** use a fixed mapping/fallback status vocabulary in reviewer output,
  without adding a durable audit subsystem.
- **Rejected:** `GitHub Issue: TBD` is normal before the create-issue sync step
  and will be replaced before implementation.

Pass 3 (`completed_valid`, `NEEDS_ATTENTION`, 4 findings):

- **Accepted:** candidate promotion requires independent validation against exact
  cited spec text as well as exact diff/test evidence.
- **Accepted:** incomplete or truncated large inputs cannot report `mapped`;
  deterministic complete partitioning or `skipped_input_limit` is required.
- **Accepted:** multiple explicit contract references map as one applicable set or
  produce `ambiguous_spec`, never heuristic selection.
- **Accepted:** decision-bearing diff redaction gets a dedicated
  hypothesis-only/fallback fixture.

Pass 4 (`completed_valid`, `NEEDS_ATTENTION`, 4 findings):

- **Accepted:** provider-fence fixtures cover secret/private diff content as well
  as spec content.
- **Accepted:** `--paths` is restricted to generated scrubbed diff/spec artifacts;
  broad repo/runtime/home/raw-dump paths are prohibited.
- **Partially accepted:** removed partition/recombination entirely; oversized
  complete input falls back via `skipped_input_limit`.
- **Accepted:** added explicit `lookup_unavailable` and
  `skipped_no_acceptance` statuses.

Pass 5 (`completed_valid`, `NEEDS_ATTENTION`, 3 findings):

- **Accepted:** final reviewer status reflects mapped-then-stale lifecycle and
  stale candidates cannot be promoted.
- **Accepted:** multi-spec candidates carry owning spec identity and snapshot
  hash.
- **Accepted:** local scrubbed-artifact preparation failure is
  `artifact_prep_failed` and bypasses coworker.

Pass 6 (`completed_valid`, `NEEDS_ATTENTION`, 4 findings):

- **Rejected:** a new no-code/no-network sandbox for this ask; `coworker ask` is
  read-only and `--allow-code` is the existing source-corpus gate, not permission
  to execute artifact instructions.
- **Accepted:** multi-spec `mapped` is all-or-nothing; partial coverage remains
  non-mapped hypothesis evidence.
- **Accepted:** repository-aware test-evidence classification includes
  nonstandard/renamed/generated/document fixtures; ambiguity blocks a
  missing-test claim.
- **Accepted:** missing-implementation candidates may cite an expected owning
  surface and verified absence rather than fabricate a location.

Pass 7 (`completed_valid`, `NEEDS_ATTENTION`, 4 findings):

- **Accepted:** `mapped` requires an exhaustive per-acceptance-criterion ledger;
  omitted criteria make the response non-mapped.
- **Accepted:** reviewer status is a structured record carrying enum plus bound
  PR/spec metadata and current usability.
- **Partially accepted:** generated artifacts must be fresh regular non-symlink
  files in a controlled per-attempt directory; a broader filesystem race/hardlink
  subsystem is outside this prompt-level task.
- **Accepted:** candidate schema consistently allows changed location **or**
  expected owning surface plus absence proof.

Pass 8 (`completed_valid`, `NEEDS_ATTENTION`, 3 findings):

- **Accepted:** mapping invocation is conditional on complete preflight; over-limit
  input skips without sending incomplete artifacts.
- **Accepted:** any non-exhaustive ledger makes the whole response non-mapped and
  all candidates hypothesis-only.
- **Accepted:** hashes/status bind to the finalized files actually passed via
  `--paths`; mismatch is `artifact_prep_failed`.

Pass 9 (`completed_valid`, `NEEDS_ATTENTION`, 4 findings):

- **Accepted:** removed hypothesis-only coworker mapping; decision-bearing
  redaction always skips via `skipped_provider_fence`.
- **Accepted:** overlapping failures use deterministic status precedence.
- **Accepted:** task binding uses explicit review context, unique closing keyword,
  or unique declaration/scope issue; weak prose/title/branch/commit mentions are
  non-authoritative.
- **Rejected:** a file-internal enforcement matrix would prescribe planner-owned
  test layout; canonical prompt surfaces and observable fixtures already bound the
  implementation.

Pass 10 (`completed_valid`, `NEEDS_ATTENTION`, 3 findings):

- **Accepted:** removed the stale hypothesis-only allowance from provider-fence
  verification.
- **Partially accepted:** require an executable reviewer-side owner/helper under
  `scripts/**` for artifact/hash/status preflight, while leaving its concrete file
  and integration shape to the planner.
- **Accepted:** binary/non-text/non-diffable contract evidence is incomplete unless
  full scrubbed content is supplied.

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final STATE=completed_valid VALIDATION=ok pass=ad3ebd66-6635-4e22-822b-f67209b775e3 sha=b7d72d24b4d2d4cfc2ab5cb9e643aaee7430f4f00066d7b16d495b56c998bb99.

Post-GPT change not re-reviewed: the three bounded pass-10 resolutions above
were applied after the cap-bound reviewed SHA.
