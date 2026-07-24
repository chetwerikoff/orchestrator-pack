# Chat executor rules

## 1. Scope

These rules apply to implementers and reviewers working through a chat-based environment where the conversation, shell/container, filesystem, GitHub connector, GitHub Actions, and tool calls may have different authentication, persistence, network access, and timeout behavior.

A working shell `git push` changes the preferred publication transport; it does not make the environment non-chat. Remote checkpoints, read-back, current-head CI/review binding, and the rule that local work is not completed work still apply.

These rules supplement `/AGENTS.md`. They do not replace or weaken it. `/AGENTS.md` remains authoritative for repository scope, Issue and PR linking, verification, review-cycle limits, merge policy, AO-managed worker lifecycle, and other repository-wide behavior.

If these documents conflict, stop and report the conflict. Do not invent an exception.

## 2. Required start

Before substantive analysis, editing, review, or specification work, read the live default-branch versions of:

1. `/AGENTS.md`;
2. `docs/chat-executor-rules.md`.

Do not rely on a remembered, previously uploaded, or earlier-chat copy while live GitHub reading is available.

If either file cannot be read completely:

- identify the unavailable file;
- do not claim its policy was applied;
- do not begin repository work whose safety depends on it.

Record:

- default-branch commit SHA;
- merge-base SHA when a task branch already exists;
- `/AGENTS.md` path and connector-returned blob SHA;
- this document's path and connector-returned blob SHA;
- UTC read time.

Confirm startup in this form:

```text
AGENTS.md read: <blob SHA>
Chat executor rules read: <blob SHA>
Default branch HEAD: <commit SHA>
Execution mode: provisional-B | C | review-only
```

`provisional-B` means a reusable capability profile and current liveness checks support a candidate publication path, but current-session publication has not yet been proved. It is not confirmed Mode B and does not authorize a large local implementation or a promise to reach `ready for review`.

Choose Mode C when no reliable publication path exists. Use `review-only` for an independent reviewer that will not mutate the implementation branch or PR metadata.

A blob SHA identifies exact file bytes. A commit SHA identifies a commit. Neither proves resulting content, contract identity, CI, review, or another guarantee.

Policy snapshots and capability profiles are executor attestations. Unless repository tooling or an operator independently validates them, label them `self-reported`, not `verified`.

### Default-branch movement

If default-branch HEAD changes before implementation, review, or ready-for-review reporting:

1. recheck both policy blob SHAs;
2. reread each changed policy file;
3. compare the recorded default head or merge base to the new default head;
4. inspect changed commits and paths for semantic overlap;
5. record the comparison range and decision.

Semantic overlap includes:

- task-declared paths and components;
- imported APIs, shared libraries, registries, schemas, generated contracts, and their producers;
- task declarations, scope tooling, policy, Issue, architecture, and specification files;
- tests, fixtures, workflows, and commands used as acceptance evidence;
- a shared artifact whose producer changed even when its consumer path did not.

When overlap exists or cannot be classified confidently:

- rebase, merge, or rebuild on an appropriate current base;
- re-review affected implementation, scope, and evidence assumptions;
- rerun affected checks;
- obtain fresh current-head CI and review.

`BEHIND`, no textual conflict, or no same-path edit does not prove semantic safety.

## 3. Task-control and exact contract identity

When `/AGENTS.md` makes GitHub Issues the task source of truth, every implementation task binds to an Issue as the task-control record.

The Issue remains authoritative for:

- repository and Issue number;
- state and discussion;
- declared scope and PR linkage;
- operator decisions recorded in its conversation.

The Issue is not necessarily the exact byte source of the implementation contract. Exact contract identity uses exactly one kind:

```text
issue-body
repository-contract
operator-export
existing-pr-adoption
```

Record the binding in the PR body, an ordinary Issue/PR progress message, or the final handoff:

```json
{
  "issueBinding": {
    "state": "open",
    "updatedAt": "<timestamp>",
    "issueBodyAccess": "full | truncated",
    "bindingKind": "issue-body | repository-contract | operator-export | existing-pr-adoption",
    "bindingRef": "<exact source>",
    "bindingDigest": "<sha256 | Git blob SHA | adopted head SHA>",
    "bodyDigest": "<sha256|null>"
  }
}
```

No single mutable comment or metadata record is an authority for task ownership or remote writes.

`bindingDigest` is always required. `bodyDigest` is non-null only for complete `issue-body` binding. Issue `updatedAt` is only a change signal; it is not contract identity.

### Full and truncated Issue access

Classify Issue-body access explicitly as `full` or `truncated`.

Any response described or observed as truncated, summarized, clipped, partial, limited, or incomplete:

- is not a complete Issue body;
- must not be hashed as the full body;
- must not start a new implementation;
- may provide task-control metadata only.

A summary is never a contract. Do not infer omitted requirements.

For `issue-body`:

- confirm the complete body was received;
- normalize UTF-8 by converting CRLF to LF and otherwise preserving text exactly;
- calculate SHA-256;
- use it as both `bindingDigest` and `bodyDigest`.

`issueBodyAccess: truncated` with `bindingKind: issue-body` is invalid.

### Repository contract

Use `repository-contract` only when a complete authoritative source or explicit operator direction identifies a repository Markdown specification.

Record:

- repository-relative path;
- ref or commit used to locate it;
- immutable Git blob SHA;
- `bindingRef` identifying path and blob;
- `bindingDigest` equal to that blob SHA;
- `bodyDigest: null` unless a complete Issue body was separately read.

### Operator export

Use `operator-export` when the operator supplies an exact UTF-8 contract export.

Record:

- source description or filename;
- declared normalization, normally exact bytes;
- SHA-256 of the bound export;
- `bindingRef` identifying it;
- `bindingDigest` equal to that SHA-256;
- `bodyDigest: null`.

Do not silently normalize, summarize, repair, or reformat the export before hashing.

### New implementation gate

A new implementation may begin only from:

- a confirmed complete Issue body;
- an explicitly bound repository contract;
- an exact operator export.

A truncated Issue, search snippet, summary, PR title, or review summary is insufficient.

### Existing-PR continuation

Use `existing-pr-adoption` only when a PR and branch predate the current executor and the exact original Issue body cannot be obtained in full.

All conditions are mandatory:

1. the operator explicitly authorizes continuation;
2. the executor reads current PR metadata, branch, adopted head, and one complete remote-content level;
3. the exact requested finding list or correction scope is available;
4. changes are limited to those findings and directly necessary verification adjustments;
5. new functionality, unrelated cleanup, and speculative refactoring are prohibited unless the operator supplies an amended exact contract;
6. current-head CI, review binding, finding disposition, and remote read-back remain mandatory.

Record:

```json
{
  "existingPrAdoption": {
    "pr": 123,
    "branch": "task/branch",
    "adoptedHead": "<sha>",
    "operatorAuthorization": "<exact reference or text>",
    "closedFindings": [
      {
        "id": "<review/thread id or signature>",
        "path": "<path|null>",
        "summary": "<bounded exact summary>"
      }
    ]
  }
}
```

For this kind, `bindingDigest` is the adopted head and `bodyDigest` is null.

Any need to broaden scope or add unrelated behavior invalidates the adoption binding and requires another exact contract source.

### Contract revalidation

Re-read task-control state before first publication and before `ready for review`.

If Issue state or `updatedAt` changed, investigate why. Revalidate through the selected binding mechanism:

- `issue-body`: complete-body digest;
- `repository-contract`: path and immutable blob;
- `operator-export`: exact export digest;
- `existing-pr-adoption`: adopted head, authorization, and closed findings.

When exact revalidation fails, block new implementation and scope expansion. Preserve already published work and obtain an exact source or operator decision.

## 4. Durable capability profile

A capability profile is a reusable machine-readable ledger for one class of chat environment. It records tested transports, permissions, limits, and known dead ends so new chats do not repeat destructive preflight.

The profile is optional evidence. It is not:

- a task lock;
- a task or branch owner;
- a claim, lease, or takeover record;
- a review verdict;
- a merge approval;
- authority to write an Issue, branch, PR, review thread, workflow, or repository file.

No capability-profile entry may represent execution ownership, receipt retrieval, takeover, claim, lease, or lock authority.

### Canonical home and extraction

The canonical home is one dedicated open non-PR GitHub Issue in this repository. Its body contains:

```html
<!-- orchestrator-pack-chat-capability-profile:v1 -->
```

The JSON payload is the single fenced `json` block after the marker and before the next level-two heading. Zero blocks, multiple blocks, malformed JSON, or unrelated payloads make the profile corrupt.

Validate the payload against:

```text
docs/orchestrator-pack-chat-capability-profile.schema.json
```

The schema is normative for structure, required fields, enums/patterns, expiry representation, and forbidden properties. Timestamp validation must use a draft-2020-12 validator with the format-assertion vocabulary enabled, or an equivalent explicit RFC 3339 validation step, for `createdAt`, `updatedAt`, every capability `testedAt`, and every `expiresAt`.

The schema does not prove marker uniqueness, current permissions, live truth, Issue selection, sorted arrays, or digest correctness.

### Deterministic profile key

The lookup key is:

```text
repository ID and full name
+ fingerprintVersion
+ closed environment object
+ environmentDigest
+ non-secret authPrincipal
+ permissionClass
```

The environment object has exactly these keys:

```json
{
  "chatSurface": "<canonical token>",
  "runtimeClass": "<canonical token>",
  "connectors": ["<canonical token>"],
  "publicationTransports": ["<canonical token>"],
  "ciObservation": "<canonical token>",
  "reviewObservation": "<canonical token>"
}
```

Canonicalization version 1:

1. normalize declared tokens to lowercase canonical `[a-z0-9._-]` values;
2. reject empty values;
3. sort and deduplicate both arrays lexicographically by Unicode code point;
4. construct keys in this exact order: `chatSurface`, `runtimeClass`, `connectors`, `publicationTransports`, `ciObservation`, `reviewObservation`;
5. serialize as UTF-8 JSON with no insignificant whitespace;
6. compute lowercase SHA-256 and prefix `sha256:`.

The stored environment object and `environmentDigest` must agree. A mismatch is corrupt.

Do not put tokens, cookies, credentials, secret URLs, or private data in the key or profile.

### Canonical principal and permission class

`authPrincipal` is the lowercase authenticated GitHub login returned by the current connector or repository permission probe. A display name, remembered account, email address, or operator-supplied alias is not a principal source.

Derive `permissionClass` from connector-observed repository permission booleans by evaluating this fixed highest-privilege precedence and selecting the first true row:

```text
admin=true      -> repository-admin-push
maintain=true   -> repository-maintain-push
push=true       -> repository-write
triage=true     -> repository-triage
pull=true       -> repository-read
no true row     -> repository-none
```

Lower permissions may also be reported true for a higher role; the first-true rule makes the result deterministic.

### Lookup and fallback

At task start:

1. search the repository for the exact marker;
2. keep open non-PR Issues only;
3. extract and schema-validate the single payload;
4. recompute the environment digest;
5. match repository identity, fingerprint version/object/digest, principal, and permission class;
6. require exactly one match;
7. ignore expired capability entries;
8. run short mutable liveness checks.

On no match, multiple matches, extraction failure, schema failure, digest mismatch, expiry, inaccessible Issue, or contradiction with live behavior:

- do not choose by guess;
- do not trust chat memory;
- treat the profile or affected entry as unavailable;
- run only the smallest non-destructive task-local checks.

Profile failure does not itself block a task when the required live operations can be proved directly.

Do not create test PRs, empty commits, destructive probes, or main-repository transport artifacts merely to prove capability.

### Required profile contents

The profile records:

- schema version;
- repository ID/full name;
- deterministic profile key;
- created/updated times;
- owner or last updater;
- keyed capability entries.

Each capability entry records:

- `proven | available-but-unproven | unavailable | degraded`;
- concrete evidence and test time;
- exactly one of `expiresAt` or `noExpiryRationale`;
- known limits;
- preferred fallback.

The normal minimum keys are:

```text
repository-read
text-publication
commit-tree-ref-publication
issue-pr-create-update
ci-runs-jobs-logs-read
review-observation
long-process-handling
```

Additional task-specific keys use bounded kebab-case names and must describe transport or observation capability only.

Only an authenticated repository collaborator acting as the current executor, or the explicit operator, may update the profile. Updates remain schema-valid, replace only affected entries, preserve bounded human-readable history, and contain no secrets.

Starting a new conversation alone does not invalidate a profile. Relevant entries become stale after expiry, permission/connector/runtime changes, or contradictory behavior.

## 5. Roles, liveness, and modes

### Implementer liveness

A normal task checks:

- repository read and current permissions;
- current default-branch HEAD;
- live policy files;
- task-control state and exact contract binding;
- selected publication transport;
- planned or existing branch/PR state.

Choose:

- `provisional-B` when required operations appear available but current-session publication is unproved;
- `C` when reliable publication is unavailable.

`provisional-B` resolves through the first meaningful task checkpoint:

```text
read exact current branch state
    -> publish exact non-force commit
    -> read back exact head
    -> prove one complete remote-content level
```

On success, `provisional-B -> B`. On failure, switch only to another already-proven transport or downgrade to C. Do not begin a large local implementation while provisional.

Mode B may edit, publish, read back, update the PR, observe CI/review, address findings, and prepare a ready-for-review handoff.

Mode C may produce a patch, archive, changed-file bundle, manifest, plan, commands, or review. Its terminal status is `handoff prepared`, not completed.

Missing, clipped, malformed, duplicated, or unreadable historical progress comments are not a reason to enter Mode C when exact Git/GitHub state and the required publication path remain readable.

### Independent reviewer authority

An independent reviewer does not need a branch claim merely to review another implementation.

A `review-only` executor may publish only:

- a GitHub review submission; or
- a new top-level review comment.

The review write must bind:

- repository and PR;
- exact reviewed head SHA;
- exact Issue/spec binding;
- findings or clean verdict.

Review-only authority must not:

- update branch refs or repository files;
- change PR title, body, base, draft state, labels, merge state, or reviewers;
- reply as the implementer;
- resolve or unresolve existing threads;
- dispatch workflows;
- make any write that changes implementation state.

A reviewer may read CI, comments, threads, Issue/spec state, and the diff without any ownership record.

## 6. Remote publication and concurrency safety

The local container is temporary until work is remotely anchored.

### Pre-write branch and PR checks

Before every repository-file or branch mutation:

1. read the exact current task branch head;
2. when a PR exists, read its exact current head and base;
3. require the branch/PR head to match the commit used to prepare the intended change;
4. inspect any unexpected advancement before continuing;
5. rebuild or rebase from the new head rather than overwriting it.

No Issue comment, profile entry, label, assignee, or remembered chat state may substitute for the exact live head.

For PR metadata or thread-state mutations, read the current PR/head/thread state immediately before the write and read it back immediately after. These APIs may be last-write-wins; they do not create task ownership.

### Git object publication

When using GitHub object APIs, publish a complete resulting Git tree while uploading only the delta:

```text
local intended tree
    -> compare with known base tree
    -> upload new and changed blobs
    -> apply additions, updates, and deletions
    -> create complete resulting tree
    -> create commit with freshly observed head as parent
    -> update branch ref with force=false
    -> read commit, branch head, and resulting content back
```

The manifest must preserve Git semantics:

```text
repository identity
repo-relative path
mode and object type
blob SHA
addition | update | deletion
base commit and base tree
freshly observed branch head
target branch
manifest digest
```

Reject absolute paths, `..`, case collisions, unapproved symlinks, gitlinks, or mode changes. Text-only replacement is insufficient when deletions, executable bits, or symlinks matter.

After blob upload, compare the returned blob SHA. A confirmed truncation or mismatch blocks that transport.

### Complete remote-content levels

Every successful publication satisfies exactly one complete level:

```text
commit-and-tree
commit-and-manifest
commit-diff-and-file-blobs
```

#### `commit-and-tree`

Require remote head commit SHA and root tree SHA, both read back and compared with the intended commit/tree.

#### `commit-and-manifest`

Require a fetched remote head commit and a complete manifest cryptographically bound to that commit's resulting tree. Satisfy this by either:

- deriving the manifest from a remote tree/inventory read and verifying every path, mode, object type, and blob SHA; or
- binding the exact create-tree input manifest and digest to a fetched commit whose root tree SHA equals the returned created-tree SHA, then independently fetching and verifying every added/modified blob SHA plus explicit deletion, rename, mode, and object-type entries.

A retained local manifest, intended create-tree payload, or durable evidence reference without remote commit/tree and blob binding is insufficient.

#### `commit-diff-and-file-blobs`

Require:

- remote `headSha`;
- `publicationParentSha` proving the immediate publication parent;
- machine-readable `compareBaseSha`;
- exact `compareBaseSha...headSha` compare range;
- changed paths and statuses across that range;
- remote diff or deterministic range digest;
- blob SHA for every added/modified file;
- explicit deletion evidence;
- old/new path evidence for renames;
- mode/object evidence where relevant;
- comparison with the intended admitted delta.

For the first publication/adoption, `compareBaseSha` is the claimed starting base. Later checkpoints may use the immediately previous verified head. Before Definition of Done, evidence must cover the admitted starting base through current head.

A last-parent-only comparison cannot prove a branch containing earlier unverified commits.

A connector without root tree SHA may use a complete equivalent level. It must not invent a tree SHA. Partial evidence satisfies no level.

### Fail-closed non-force update

Use the strongest available sequence:

```text
read exact branch/PR head
    -> prepare commit with that head as parent
    -> reread and require the same head immediately before publication
    -> update ref with force=false
    -> read back remote head and complete content evidence
```

Concurrent advancement should fail non-fast-forward. A failed non-fast-forward publication is not a task deadlock:

1. read the new remote state;
2. inspect the advancement;
3. rebuild on the new head when compatible;
4. republish from the freshly observed base;
5. obtain fresh read-back, CI, and review.

Do not retry a possibly successful timed-out write blindly; read state first.

### History rewrite

Ordinary chat publication is non-force.

A force rewrite is outside the normal path and requires separate explicit operator authorization plus repository-policy permission. It never relies on a receipt, lock, lease, label, or assignee. Before an authorized rewrite:

1. read the exact current branch/PR head;
2. require it to equal the explicitly approved rewrite source;
3. publish only the explicitly approved target;
4. perform complete read-back immediately;
5. obtain fresh current-head CI and review.

If exact source or target identity is unavailable, do not rewrite.

### Merge protection

When the merge API supports an expected head, always pass the exact current PR head, for example `expected_head_sha`.

Immediately before merge:

- reread PR state, draft state, mergeability, base, and exact head;
- reread required checks for that head;
- confirm current-head review and finding dispositions;
- reject stale, missing, pending, or earlier-head evidence.

After merge, read PR state and merge commit back.

## 7. Checkpoints, heartbeat, and evidence

During active execution, produce a GitHub-visible signal at least every 15–20 minutes. User waiting time and explicitly paused sessions do not count as active execution.

When a meaningful recoverable slice exists:

```text
publish meaningful non-force checkpoint
    -> complete remote read-back
    -> report the exact new head and next step
```

A WIP checkpoint is acceptable when it is real, scoped progress. A local commit is not a checkpoint. Do not create empty commits to satisfy the timer.

Checkpoint after functional slices and before long tests, risky operations, transport changes, an authorized history rewrite, or likely container loss.

When no safe file slice exists, report concrete evidence in any ordinary, non-authoritative progress channel. Record what was checked, what changed, rejected hypotheses, process/run identity, and next action.

No progress comment, PR body section, label, assignee, or profile entry is a mutex or prerequisite for future writes. Loss or clipping of one progress message does not block continuation when exact Git/GitHub state is otherwise readable.

`Still working` and similar phrases are not evidence.

Two consecutive heartbeat intervals with no substantive or external evidence change indicate a loop. Preserve the latest checkpoint, record the blocker, and change hypothesis, diagnostic layer, transport, or escalate.

## 8. Long-running commands

For a command exceeding one tool call:

- start one process;
- capture stdout/stderr and exit status when the environment supports it;
- poll the same directly observable process/session;
- do not launch a duplicate suite merely because a tool response timed out;
- verify available process identity before retry or termination.

PID alone is insufficient. Use every identity field directly exposed by the runtime: PID/start time, process group/job identity, command/session identity, working directory, and log handle.

Do not claim nonce/digest continuity when the environment cannot expose it. Do not attach to or terminate an ambiguous process. Do not improvise a repository-wide wrapper outside task scope.

A missing runtime filesystem after container replacement means local process continuity is unavailable; report that limitation rather than inventing recovery.

For GitHub Actions, bind evidence to head SHA, run ID, job ID, step, timestamps, and conclusion. Never combine evidence from different heads.

## 9. Degradation and attempt discipline

If authorization or publication fails after work began:

1. stop writes;
2. read remote state when possible;
3. report the sanitized failure;
4. export work as a patch/archive/manifest;
5. downgrade to Mode C when no reliable publication transport remains.

A confirmed integrity mismatch immediately blocks the affected transport.

Do not downgrade to Mode C merely because a historical Issue or PR comment is clipped, malformed, duplicated, or unreadable. Re-evaluate only the live capabilities actually required by the task.

Stop repeating one failure class when two consecutive attempts add no evidence, do not change observed state, and repeat a rejected hypothesis. The next attempt must change hypothesis, evidence source, diagnostic layer, or solution class.

## 10. Secrets and egress

Never publish through commits, connector calls, Issues, profiles, logs, or handoff archives:

- tokens or API keys;
- cookies or authorization headers;
- raw `.env` files;
- authenticated URLs;
- private keys;
- secret configuration;
- third-party private data.

Scrub CI and process logs before quoting them. Capability evidence may name a non-secret principal, permission class, tool version, HTTP status, or sanitized error class.

## 11. CI and review lifecycle

All CI and review claims bind to the exact current PR head and exact contract binding.

After each new commit or authorized history rewrite:

- invalidate old-head CI conclusions;
- invalidate old-head clean-review conclusions;
- treat the new head as not-started/not-open until observed;
- obtain fresh checks and review.

Do not call missing CI green. Cancelled, stale, earlier-head, or unidentified runs do not satisfy completion.

### Finding dispositions

Every prior material finding remains open until exactly one disposition is evidenced:

1. `fixed-and-verified` — fixed and verified on the current head;
2. `removed-or-inapplicable` — relevant text/code was removed;
3. `rejected-and-accepted` — rejected with evidence and accepted by the responsible reviewer or user.

Use GitHub review threads, review submissions, pack finding signatures, PR discussion, or explicit operator/reviewer decisions as the evidence source.

A later clean review can support a disposition but does not automatically close, supersede, or launder an earlier finding. Silence is not acceptance.

When GitHub threads exist, thread resolution must agree with the disposition. Do not invent a competing ownership or finding store.

A clean current-head review is not sufficient while a prior material finding remains undisposed.

For existing-PR adoption, the closed finding list is the maximum mutation boundary. Another defect requires exact rebinding or explicit operator amendment.

## 12. Status vocabulary

Track orthogonal state:

```text
mode = provisional-B | B | C | review-only
work = analyzing | implementing | testing | preparing-handoff | reviewing
publication = local | publishing | published | blocked | not-applicable
publicationCause = none | retryable | auth | rate-limit | integrity | conflict | contract | permanent
contract = bound | revalidation-required | unavailable | invalid
remoteContent = unavailable | partial | commit-and-tree | commit-and-manifest | commit-diff-and-file-blobs
ci = not-started | running | red | green | missing
review = not-open | open | addressing | clean@<head SHA>
```

Before publication is proved, do not claim implementation complete, final remote content ready, only publication remains, or almost ready.

## 13. Mandatory scenarios

| Scenario | Required result |
|---|---|
| Short Issue read in full | Normalize complete body and use SHA-256 as binding/body digest. |
| Large Issue truncated | Do not start new implementation without exact alternate contract. |
| Issue binds repository specification | Bind path and immutable blob SHA. |
| Existing PR with truncated Issue | Require authorization, adopted-head read-back, and closed findings. |
| Historical execution comment is unreadable | Ignore it as write authority; continue only from freshly observed Git/GitHub state. |
| Two executors publish from the same head | One non-force update succeeds; the other fails non-fast-forward and rereads. |
| Branch advances after pre-read | Reject or fail publication, then inspect and rebuild from the new head. |
| Publication times out | Read remote state before retry. |
| Contract changes after continuation begins | Require exact revalidation. |
| Connector lacks tree SHA | Use a complete manifest or diff/blob level. |
| Issue summary only | Do not treat it as contract identity. |
| New commit published | Invalidate old-head CI/review. |
| Adoption adds functionality | Block and require rebinding. |
| `ci: green` lacks exact current-head runs/checks | Not green/complete. |
| Clean review has an undisposed prior finding | Not clean/complete. |
| Diff/blob evidence lacks compare base/full range | Invalid. |
| Independent reviewer posts head-bound review | Allowed without a branch claim. |
| Reviewer tries to mutate PR/branch/thread state | Requires exact current-state pre-read and read-back; review-only authority is insufficient. |
| Capability profile is missing/corrupt | Use bounded task-local checks; do not infer a task lock. |
| Profile contains a claim/lease/lock capability | Invalid against policy/schema. |
| Merge uses stale head | Expected-head protection rejects it. |
| Proposed replacement uses labels or assignees | Out of scope; requires a separate Issue. |
| Schema validator treats `date-time` as annotation only | Run format assertion or explicit RFC 3339 validation. |
| Manifest read-back uses only a local retained manifest | Invalid until bound to fetched remote commit/tree and verified blobs. |
| AO-managed worker completes implementation | Use AO lifecycle from `/AGENTS.md`; do not introduce a parallel standalone lock. |

## 14. Definition of Done for implementation

For a standalone chat implementer, completion requires all applicable conditions below:

```text
[ ] code or documentation exists in a remote task branch
[ ] exact contract binding is valid
[ ] every publication started from a freshly observed exact head
[ ] every branch update used non-force semantics unless a separate rewrite was explicitly authorized
[ ] cumulative remote-content evidence covers admitted base through current head
[ ] task-control state was rechecked
[ ] PR is linked according to /AGENTS.md
[ ] PR diff contains only intended scoped changes
[ ] existing-PR adoption stayed inside its closed finding list
[ ] no secret, transport, or temporary process files remain
[ ] default-branch movement was classified and overlap resolved
[ ] current-head CI identities exist and required checks are green
[ ] current-head review identities exist
[ ] every prior material finding has an allowed disposition
[ ] old-head CI/review evidence was invalidated after changes
[ ] merge conflicts are absent
[ ] base was updated when overlap or repository policy requires it
[ ] PR is ready for review
[ ] user received PR URL, head SHA, contract binding, compare base/read-back level,
    CI identities, review state, dispositions, and limitations
```

`BEHIND` alone is not a blocker unless branch protection or merge policy requires an up-to-date base. Unclassified default movement, invalid contract, adoption-scope violation, or stale evidence remains blocking without textual conflict.

If API-authored commits do not start workflows, use an existing repository-owned retrigger. Missing runs are not green. Do not create diagnostic workflows.

AO-managed workers satisfy ownership and lifecycle conditions through `/AGENTS.md` and repository-owned AO mechanisms. Standalone chat rules must not create a second lock, lease, label, assignee, or Issue-comment authority.

Local tests, local commits, and a clean local tree do not satisfy Definition of Done. Mode C ends with `handoff prepared`.

## 15. Operating formula

> Live policy is read before work.
>
> The Issue remains task control; exact contract identity is byte-bound.
>
> Truncated or summarized Issue text is never hashed as a complete contract.
>
> Capability profiles describe tools and transports only; they do not own tasks.
>
> Fresh branch and PR heads, non-force publication, immediate read-back, and expected-head merge checks provide remote-write safety.
>
> Concurrent advancement is handled by fail-closed Git semantics and re-read, not by a mutable comment.
>
> Historical progress messages never block continuation when exact Git/GitHub state is readable.
>
> Active work is remotely checkpointed and current-head CI/review is reacquired after every change.
>
> Every prior material finding requires explicit disposition.
>
> Work that exists only in an ephemeral container is not finished work.
