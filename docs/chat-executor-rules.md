# Chat executor rules

## 1. Scope

These rules apply to standalone implementers and reviewers working through a chat environment where the conversation, shell/container, filesystem, GitHub connector, GitHub Actions, and tool calls may have different authentication, persistence, network access, or timeout behavior.

They supplement `/AGENTS.md`; they do not replace it. `/AGENTS.md` remains authoritative for repository scope, Issue/PR linking, verification, review-cycle limits, merge policy, and the pack-owned worker lifecycle described by the current runbook.

These rules do **not** define or replace the pack-owned worker/runtime lifecycle contracts referenced by `/AGENTS.md`.

## 2. Start with live sources

Before repository work:

1. read the live default-branch `/AGENTS.md`;
2. read the live default-branch `docs/chat-executor-rules.md`;
3. read the binding Issue/spec when the task has one;
4. read additional documents only when the task actually depends on them.

Do not rely on remembered or previously uploaded policy while live repository reading is available.

If a required source cannot be read completely, say which source is unavailable and do not make decisions that depend on missing content.

If the default branch moves during the task, inspect whether the change affects the work. Re-read or revalidate affected material when it does. If it clearly does not, continue; no separate movement ledger or semantic-overlap report is required.

## 3. Task contract

GitHub Issues/specifications remain the task contract where `/AGENTS.md` requires them.

For a normal readable Issue, read it and implement it. Do not create SHA-256 bookkeeping, normalization records, source-kind taxonomies, or JSON binding records merely to prove that it was read.

If only truncated or partial task text is available and the missing content is needed to understand scope or behavior safely, stop and obtain the complete contract or another explicit authoritative source. Do not guess omitted requirements.

When the task contract changes materially during work, re-read it and reconcile the implementation before continuing.

## 4. Normal publication path

Use the practical repository-approved transport that is actually available, including shell Git, the GitHub Contents API, Git object APIs, or connector-backed GitHub mutations.

The normal path is:

```text
read current relevant remote state
-> perform the ordinary operation
-> read the result back
-> investigate further only when a real conflict or ambiguity appears
```

For repository-file or branch writes, check the current branch/PR head before an important mutation. Publish from current state rather than knowingly overwriting unexpected advancement.

Non-force publication is the normal branch-update path. A non-fast-forward failure or unexpected head is a signal to read current remote state, understand the change, and continue from the appropriate current base.

Do not blindly retry a write that timed out or may have succeeded. Read authoritative remote state first.

For ordinary Issue, PR body/metadata, comment, and similar GitHub mutations, use the normal API. A pre-read is sensible for important replacements; verify important results afterward. Do not require a custom ETag, CAS, lease, or lock protocol unless the underlying API/task actually requires one.

### Contents API

The GitHub Contents API is allowed for ordinary file creation, replacement, and deletion when it is the practical available transport. Its lack of branch-head CAS is not by itself a reason to ban it.

Read the current target before replacement when needed, use the API's ordinary file-version guard when available, and read the resulting branch/file back. Handle an observed concurrent edit as an exception rather than imposing extra ceremony on every write.

### Force and history rewrite

Do not use force/history rewrite without a real need.

When a rewrite is genuinely needed, explicitly authorized, and allowed by repository policy:

1. read the current branch/PR head immediately before the operation;
2. perform only the intended rewrite;
3. read the resulting head/diff back immediately;
4. obtain fresh CI and review for the rewritten head.

Do not add a separate lease, handoff environment, or ownership service for this rare path.

## 5. Read-back proportional to the artifact

For ordinary text/code changes, successful publication normally requires:

- the expected remote head is observable after the write; and
- the PR diff/changed files match the intended scoped change.

Do not require every publication to prove a full Git object graph, manifest, per-file blob inventory, compare-base digest, or named remote-content level.

Use deeper verification only when the task actually depends on semantics that a normal diff may miss, for example:

- executable mode changes;
- symlinks or gitlinks;
- deletes or renames where path identity matters;
- binary or Git LFS content;
- complex Git object API publication;
- another explicitly identified integrity-sensitive case.

Choose the smallest verification that proves the property the task actually needs.

## 6. Checkpoints and long-running commands

Make a remote checkpoint after a meaningful recoverable slice or before a genuinely risky step when that is useful. Do not create commits, comments, or other remote writes merely because a timer expired.

For long-running commands:

- avoid accidentally launching a duplicate heavy command;
- retain or observe enough output to determine the result;
- do not interpret a tool-call timeout as automatic process failure;
- before retrying, check whether the previous process is still running when the environment makes that practical.

Do not require universal nonce, command-digest, PID/start-time/process-group, or supervisor bookkeeping for every command.

If an operation fails, do not repeat the same action blindly. Inspect current state and change the approach when needed. If a required action remains impossible, report exactly which action could not be completed and what remote state was verified.

## 7. Independent review role

An independent reviewer may inspect the task, diff, CI, comments, and review threads and may publish a head-bound review.

Review work must not mutate implementation state unless the user/task also authorizes implementation changes. This is a role boundary, not a global execution mode or ownership state machine.

### Direct connected-GitHub pack review

For a direct top-level request to review or pack-review an `orchestrator-pack`
pull request, a connected-GitHub chat reviewer may perform and publish the review
immediately. Required CI, worker smoke, WorkerReport/WorkerStatus, runner/run-store
state, source cardinality, and automatic review-cycle cap are not admission gates
for performing or publishing that direct review.

The reviewer reads the live Issue/spec, current PR head, diff/code, useful
comments/threads and CI facts, performs the substantive review in the same chat,
then rereads the PR head immediately before publication. Publish one GitHub PR
review with event `COMMENT` bound to that exact commit and exactly one marker:

`<!-- opk-pack-review:v1 head=<40hex> verdict=<clean|findings> blocking=<true|false> -->`

The marker head must equal the GitHub review commit id, `verdict=clean` requires
`blocking=false`, and the review must be authored by the repository owner.
Immediately reread the PR head after publication. If the head advanced, the
submitted review remains historical evidence for its reviewed commit but must
not directly mutate the newer head's pack-review status. No runner invocation,
second model call, start comment, confirmation step, queue, lease, or provenance
service is required for this direct path. Worker CI/smoke/readiness obligations
remain separate and strict.

### Evidence-feasibility gate

Before introducing or strengthening a blocking review requirement that depends on correlation, causality, identity, provenance, parentage, turn/session context, or another witness, first establish that the required evidence is actually observable on the exact production execution or transport path being constrained.

Identify the evidence producer and the exact observation surface that supplies it. Ground the evidence's existence in an authoritative contract or an observed live production shape. A mock, fixture, inferred schema, or evidence available only on a different path does not prove that the constrained path provides it.

If the required evidence is absent, do not demand it as though it exists. Use weaker available evidence that still proves the needed property, add scoped instrumentation when the task permits it, or state that the desired invariant cannot be proven at that boundary and adjust the design or specification accordingly.

A blocking finding that depends on an impossible or unproven witness must be withdrawn or explicitly adjudicated; it must not generate another implementation round whose only purpose is to manufacture evidence the production path does not supply.

## 8. CI, smoke, and review authority stay current-head bound

Required CI and smoke conclusions apply only to the exact PR head they evaluated. Review authority is also current-head bound, but reviewer invocation and review authority are not the same event: the pack-owned runner may establish current-head authority through an exact authority-selected conflict-free carry-over from an authorized clean source head without invoking the reviewer model again.

For a pack-review start, the PR number is the canonical target. The live PR supplies the current head and its closing reference supplies the Issue. Session-binding cache state is advisory correlation only; missing, corrupt, stale, or disagreeing cache data cannot veto a valid PR-led start or replace the linked Issue. If the exact bound Issue snapshot is missing, the runner freezes it only after acquiring its existing start claim.

After every new commit or history rewrite:

- earlier-head CI is stale;
- earlier-head smoke is stale;
- an in-progress required review round remains bound to the head it actually reviewed;
- for a new pack-review cycle, required rounds are logical PR/task-cycle units with caps T1=1, T2=1, T3=2; T3 round 2 may review the same head as round 1;
- once the required stage has durably reached `reviewStageComplete=true`, later heads do not reopen or consume another required round. Instead the pack-owned status projection writes `orchestrator-pack/pack-review=success` on the current head with `Required pack-review stage completed; no additional review round required.`;
- direct connected-GitHub reviews remain exact-commit evidence and do not themselves create or rewrite the runner's durable stage-completion latch.

A persisted clean terminal for the exact same head suppresses a redundant automatic/common reviewer-model invocation. A cycle already at cap also suppresses further automatic/common model calls. Neither case weakens current-head CI or smoke. Smoke admission remains required for a new head before an at-cap refusal, so cap exhaustion cannot hide absent or failed current-head smoke evidence.

Missing, pending, cancelled, failed, or earlier-head required checks are not green for the current head.

For GitHub Actions diagnostics, the available GitHub transport can fetch decoded job logs directly by job ID. A practical path is `run -> jobs -> failed job ID -> decoded job log`; the returned log includes step stdout/stderr. This is one available way to inspect the exact CI failure without first creating a separate artifact solely to capture command output.

Before ready-for-review or merge, there must be no known current material blocker/major finding left unresolved. A fixed finding may be closed. A rejected finding may be explicitly adjudicated. A finding made irrelevant by a later operator-approved contract change or by removal of the affected code/text does not remain permanent administrative debt.

Use GitHub review/thread state and explicit reviewer/operator decisions directly; do not maintain a separate finding-state ledger merely to restate them.

## 9. Merge

Follow `/AGENTS.md` merge authority. Do not merge unless the direct top-level user explicitly orders it.

Immediately before an authorized merge:

1. read the current PR state and exact head;
2. confirm required CI and review authority are acceptable for that head;
3. use `expected_head_sha` or equivalent expected-head protection when the available merge API supports it;
4. perform the merge;
5. read the merge result back.

Do not turn merge into a separate execution state machine.

## 10. Secrets and truthful reporting

Never publish secrets or private data through commits, Issues, PRs, comments, logs, or handoff artifacts, including tokens, API keys, cookies, authorization headers, private keys, raw secret configuration, authenticated URLs, or third-party private data.

Scrub sensitive logs before quoting them.

Do not claim that a remote action succeeded unless authoritative remote state confirms it. A possibly-successful timed-out write must be read back before retry.

## 11. Definition of Done

For a normal standalone implementation, completion means:

```text
[ ] intended changes are published in the PR
[ ] PR diff/changed files match the task scope
[ ] important published results were read back
[ ] required CI is green for the current PR head
[ ] required smoke is current-head bound when the task declares it
[ ] no known current material review finding remains unresolved
[ ] current-head review authority is acceptable
[ ] the user is told the PR/head/CI/review state and any concrete limitation
```

When the task actually involves special artifact semantics, destructive operations, deployment, migration, or another repository-specific risk, apply the additional checks required by that task and `/AGENTS.md`.

Merge is part of completion only when the user explicitly requested it and repository policy permits this executor to perform it.

## 12. Operating formula

> Read live task and policy.
>
> Do the work with an ordinary available tool.
>
> Read important remote results back.
>
> Treat real conflicts and ambiguity as exceptions when they actually occur.
>
> Use current-head CI, smoke, and review authority.
>
> Report truthfully, or merge only when explicitly authorized and allowed.
