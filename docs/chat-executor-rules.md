# Chat executor rules

## 1. Scope

These rules apply only to implementers working through a chat-based environment in which the conversation, shell container, local filesystem, GitHub connector, GitHub Actions, and tool calls may have different authentication, network access, persistence, and timeout behavior.

A working shell `git push` changes the preferred publishing transport; it does not make the environment non-chat. Remote checkpoints, remote read-back, heartbeat, long-process handling, and the rule that local work is not completed work still apply.

These rules supplement `/AGENTS.md`. They do not replace or weaken repository policy. `/AGENTS.md` remains authoritative for scope, Issue and PR linking, verification, review-cycle limits, merge policy, AO-managed worker lifecycle, and other repository-wide behavior.

If the two documents appear to conflict, stop and report the conflict rather than inventing an exception.

## 2. Required start

Before substantive analysis, editing, review, or specification work, read the live default-branch versions of:

1. `/AGENTS.md`;
2. `docs/chat-executor-rules.md`.

Do not rely on a remembered, previously uploaded, or earlier-chat copy while live GitHub reading is available.

If either file cannot be read completely:

- say which file is unavailable;
- do not claim its policy was applied;
- do not begin repository work whose safety depends on it.

Record a policy snapshot containing:

- default-branch commit SHA;
- merge-base SHA when a task branch already exists;
- `/AGENTS.md` path and connector-returned blob SHA;
- this document's path and connector-returned blob SHA;
- UTC read time.

Confirm the start in this form:

```text
AGENTS.md read: <blob SHA>
Chat executor rules read: <blob SHA>
Default branch HEAD: <commit SHA>
Execution ID: <unique ID>
Ownership epoch: <positive integer>
Execution mode: provisional-B | C
```

Before the first receipt exists, use ownership epoch `1` for the initial execution. A takeover increments the last valid epoch by exactly one. This epoch is an organizational continuity field until the repository-owned helper in Issue #966 is implemented; it does not turn an Issue comment into a transactional lock.

At startup, `provisional-B` means the reusable capability profile and current liveness checks support a candidate publication path, but the current session has not yet proved it. It is not confirmed Mode B and does not authorize a large local implementation or a promise to reach `ready for review`.

Choose Mode C immediately when no reliable candidate publication path exists.

A blob SHA identifies exact file contents. A commit SHA identifies the repository commit whose tree was read.

Policy snapshots, capability profiles, and execution receipts are operational attestations made by an executor. They are not independently verified evidence merely because they contain hashes. Where repository tooling or an operator validator exists, it may compare reported bindings with live GitHub state. Without such validation, describe them as `self-reported`, not `verified`.

The compatible validation architecture is:

```text
connector-side read or capability probe
    -> durable capability profile / execution receipt
    -> optional repository-side or operator validation
```

### Default-branch movement and semantic revalidation

If the default-branch HEAD changes before implementation, review, or ready-for-review reporting:

1. recheck the blob SHAs of `/AGENTS.md` and this document;
2. reread either policy document whose blob SHA changed;
3. compare the recorded default-branch head or merge base to the new default-branch head;
4. inspect changed commits and paths for overlap with the task's implementation contracts;
5. record the comparison range, changed-path summary, and overlap decision in the execution receipt.

Contract overlap is broader than a direct edit to the same file. Treat at least the following as overlap when they can affect the task:

- files or components declared by the task;
- imported APIs, shared libraries, registries, schemas, generated contracts, and their producers;
- task declarations, scope tooling, policy files, Issue text, and architecture/specification files;
- tests, fixtures, CI workflows, and commands used as acceptance evidence;
- shared artifacts whose producer changed even when the task's consumer path did not.

When overlap exists, or when the comparison cannot be classified confidently:

- rebase, merge, or otherwise rebuild the work on an appropriate current base;
- re-review affected implementation, scope, and evidence assumptions;
- rerun checks whose assumptions changed;
- obtain fresh current-head CI and review before ready-for-review reporting.

When no overlap exists, record the evidence supporting that conclusion.

`BEHIND` status alone does not prove safety. The absence of a textual merge conflict or same-path edit does not waive semantic contract revalidation.

## 3. Issue binding

For repositories where `/AGENTS.md` makes GitHub Issues the task source of truth, including this repository, every implementation task must bind to its Issue.

Record:

- repository;
- Issue number;
- Issue state;
- Issue `updatedAt`;
- SHA-256 digest of the normalized Issue body;
- declared paths or components relevant to semantic-overlap checks.

Normalize the Issue body as UTF-8 with CRLF converted to LF; otherwise preserve the text exactly.

Re-read the Issue before the first publication and again before `ready for review`.

If its state, timestamp, or body digest changed:

- reconcile the implementation with the new task text;
- obtain an explicit user decision when the new text changes scope or behavior;
- do not silently continue against a stale specification.

## 4. Durable capability profile

A capability profile is a reusable, machine-readable ledger for one class of chat environment. Its purpose is to record tested transports, permissions, limits, and known dead ends so each new chat does not repeat the same destructive preflight.

### Canonical durable home

The canonical durable home is one dedicated open GitHub Issue in this repository. Its body must contain the exact marker:

```html
<!-- orchestrator-pack-chat-capability-profile:v1 -->
```

The profile Issue is operational metadata. It is not:

- an implementation task;
- a task-branch lock;
- an AO worker/session authority;
- a review verdict;
- a merge approval.

A new chat locates the profile by searching the current repository for the exact marker and selecting the single open, non-pull-request Issue whose profile key matches the current environment.

The profile key is:

```text
repository database ID
+ repository full name
+ environment/tool fingerprint
+ non-secret auth principal or permission class
```

The environment/tool fingerprint must identify the material execution class, for example:

- available connectors;
- shell/runtime class;
- publication transports;
- CI/review-read capabilities.

It must not contain tokens, cookies, credentials, secret URLs, or private data.

If no matching profile exists, create one only when the current executor has authority and real non-destructive evidence to record. If it cannot be created, treat the profile as unavailable and perform only the bounded capability checks required by the current task.

If more than one matching open profile exists, the marker or JSON is corrupt, repository identity differs, or the fingerprint is ambiguous:

- do not choose by guess;
- mark the profile unavailable;
- report the ambiguity;
- use bounded current-task checks until an operator repairs or explicitly selects the canonical profile.

### Required profile contents

The profile must record:

```text
profile schema/version
repository ID and full name
environment/tool fingerprint
non-secret auth principal or permission class
createdAt and updatedAt
profile owner or last updater
capability entries
```

Each capability entry must record:

- transport or tool;
- status: `proven | available-but-unproven | unavailable | degraded`;
- concrete evidence and test time;
- `expiresAt`, or `no-expiry` with rationale;
- known limits;
- preferred fallback.

The normal minimum profile covers:

```text
repository read
text publication
commit/tree creation
branch create/update
remote read-back
PR create/update
CI runs/jobs/logs read
review observation
long-process handling
```

Task-specific capabilities are required only when the task uses them:

```text
binary or large files
maximum safe payload
executable modes
symlinks
Git LFS
artifact upload/download
signed commits
history rewrite
```

A missing unused capability does not block full chat execution.

### Lookup, update, expiry, and fallback

At task start:

1. locate the canonical profile by marker and profile key;
2. verify repository identity, fingerprint, and JSON integrity;
3. ignore expired entries;
4. use only entries whose evidence applies to the current task and permission class;
5. run short liveness checks for mutable facts.

Only an authenticated repository collaborator acting as the current standalone executor or the explicit operator may update the profile.

Every profile update must:

- preserve a bounded human-readable transition history;
- state what changed and why;
- replace only affected entries;
- keep secrets out of the Issue.

A capability entry expires at its stated `expiresAt`. Mutable authorization, network, connector, and service-availability evidence should have bounded expiry. Stable format or transport semantics may use `no-expiry` only when the rationale is recorded.

The whole profile is stale when:

- its fingerprint no longer matches;
- required entries expired;
- repository identity differs;
- actual behavior contradicts it.

Re-run the full capability preflight only after a material change:

- connector or tool inventory changed;
- authentication principal or repository permissions changed;
- runtime class changed;
- the relevant profile entry expired;
- actual behavior contradicted the profile;
- an unexpected integrity, authorization, or network failure occurred.

Starting a new conversation alone is not an invalidation event.

When the canonical profile is absent, corrupt, ambiguous, stale, or inaccessible:

- do not trust chat memory;
- fall back to the smallest non-destructive checks required by the current task;
- do not create test PRs, empty commits, destructive probes, or transport artifacts in the main repository merely to prove capability.

## 5. Per-task liveness check and modes

A normal task does not repeat the full capability investigation. Check only current mutable facts:

- repository read succeeds;
- current permissions are sufficient;
- current default-branch HEAD is known;
- both policy files were read live;
- the binding Issue is open and understood;
- the selected publishing transport is available;
- a real task branch can be created or reused.

Choose the initial state before the canary:

- `provisional-B` when the reusable capability profile and current liveness checks support every operation required by the task, but current-session publication has not yet been proved;
- `C` when no reliable candidate publication path is available.

`provisional-B` is a transient startup state. It must resolve through the first real task commit, which is the session canary:

```text
create a meaningful task checkpoint
    -> publish it to the task branch
    -> read the remote head and tree back
    -> compare them with the intended commit/tree
```

On success, transition:

```text
provisional-B -> B
```

If the selected transport fails:

- remain `provisional-B` only while switching to another already-proven candidate transport and rerunning the canary;
- transition to Mode C when no reliable candidate remains.

Do this before a large local implementation. Do not begin one while the state is still `provisional-B`.

### Mode B — full chat execution

Mode B is confirmed only when the current capability profile supports the operations required by the task and the current-session canary has succeeded:

```text
edit
publish
remote read-back
open and update PR
observe CI
observe and address review
```

Publication may use shell Git, the GitHub object API, the contents API, or another proven transport.

Historically proven PR and CI capabilities do not need a fake per-task test. Confirm them through the first real PR and CI run. An unexpected failure causes an explicit downgrade, escalation, or transport change.

Only confirmed Mode B permits a promise to implement the Issue and bring its PR to `ready for review`.

### Mode C — implementation handoff

Use Mode C when a reliable publication path is absent or fails.

Permitted results include:

- patch;
- archive;
- changed-file bundle;
- publication manifest;
- implementation plan;
- application commands;
- review of another implementation.

Name the actual delivery channel and its limit. Do not promise a remote branch or PR.

The terminal Mode C status is:

```text
handoff prepared
```

A Mode C session may move to `provisional-B` when a reliable candidate transport becomes available. It becomes confirmed Mode B only after a remote write transaction and read-back succeed.

## 6. Remote publication

The local container is temporary until work is remotely anchored.

For normal Git publication:

```text
inspect local status and diff
    -> confirm every path is inside Issue scope
    -> commit a meaningful checkpoint
    -> push/update the task branch
    -> read the remote head and diff back
```

When using GitHub object APIs, publish a complete resulting Git tree while uploading only the delta:

```text
local Git index
    -> compare with known base tree
    -> upload new and changed blobs
    -> apply additions, updates, and deletions
    -> create complete resulting tree
    -> create commit
    -> update branch ref
    -> read commit and tree back
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

After blob upload, compare the returned blob SHA. A confirmed truncation or SHA mismatch blocks that transport for the affected payload. Do not keep varying chunk sizes without new evidence that the transport can be safe.

### Fail-closed ref update

GitHub's ref-update API does not provide an `expected SHA` parameter. Use the strongest available fail-closed sequence:

```text
read branch head immediately before publication
    -> require it to equal the expected last observed head
    -> create commit with that head as parent
    -> update ref with force=false
    -> read branch head and tree back
```

Concurrent advancement should produce a non-fast-forward failure.

On mismatch, conflict, or unexpected advancement:

```text
stop the write
    -> read the current receipt and remote head
    -> determine whether takeover or concurrent publication occurred
    -> rebuild/rebase only when this execution still owns the task
    -> revalidate scope and semantic overlap
    -> republish from the new base
```

Do not retry a possibly successful timed-out write blindly; read remote state first.

### History rewrite

A force rewrite has no mechanical compare-and-swap protection. `force=true` disables fast-forward protection.

Before an allowed rewrite:

1. verify repository policy permits it;
2. confirm sole ownership of the task branch;
3. read the active execution receipt;
4. read the remote head immediately before the write;
5. require the receipt identity/epoch and head to equal this execution's last observed state;
6. narrow the race window as much as possible;
7. force-update;
8. read the new head and tree back immediately;
9. obtain fresh CI and review for the new head.

This is an organizational control plus race-window reduction, not a guarantee against concurrent writes.

### Planned ownership helper

Issue #966 owns a Node 22 helper for standalone chat-executor initial claims, takeover claims, and execution-ID/ownership-epoch/head fencing.

Until #966 is implemented:

- do not claim the repository has a transactional receipt mutex;
- keep one active standalone executor;
- use explicit takeover;
- reread the receipt and branch head immediately before and after high-risk writes;
- fail closed on duplicate, corrupt, missing, or ambiguous receipt state.

AO-managed workers continue to use their existing AO session, pack-store, claim, and `pack-worker-report` authority. They must not mint a competing standalone receipt ownership authority.

## 7. Remote checkpoint and heartbeat

During active execution, produce a GitHub-visible signal at least every 15–20 minutes. The cadence limits unanchored work and makes loops visible; it is not a limit on total task duration.

User waiting time and an explicitly paused session do not count as active execution.

### Primary heartbeat: remote checkpoint

When a meaningful recoverable file slice exists:

```text
commit
    -> publish task branch
    -> remote read-back
    -> update execution receipt
    -> reread receipt and branch head
```

A clearly labeled WIP checkpoint is acceptable. It must represent real progress and remain within task scope. A local commit without remote publication is not a checkpoint.

Also checkpoint at meaningful boundaries regardless of the timer:

- after a functional slice;
- before a long test;
- before a risky operation;
- before changing transport;
- before history rewrite;
- before likely container loss.

Do not create empty or meaningless commits merely to satisfy the timer.

### Minimal heartbeat: evidence update

When no safe meaningful file slice exists, update the execution receipt with concrete evidence. Typical cases:

- specification or dependency analysis;
- inventory construction;
- CI diagnosis;
- one long-running local process;
- one running GitHub Actions job.

Record:

- what was checked;
- what changed in the diagnosis;
- what hypothesis was rejected;
- process or run identity;
- the next specific step.

If local files have changed but cannot safely be checkpointed because they contain a secret, violate scope, or form a knowingly invalid tree, record the exact reason and publish at the first safe boundary.

Phrases such as `still working`, `almost done`, or `only publication remains` are not evidence.

### Loop detection

Rewording an old conclusion is not new evidence.

A sufficient core signal that execution is stuck is two consecutive heartbeat intervals with both:

- no new substantive evidence affecting diagnosis, implementation, or the next justified action;
- no change in process or external evidence.

For a long process, changed evidence may include:

- the same full process identity remains live;
- log size or offset increased;
- log timestamp changed;
- new output appeared;
- GitHub job or step progressed;
- measurable CPU time increased;
- an external service still reports active execution.

When stuck:

1. stop repeating the same hypothesis;
2. preserve the latest safe remote checkpoint;
3. record the evidence and blocker;
4. change hypothesis, diagnostic layer, transport class, or escalate to the user.

## 8. Long-running commands

For commands longer than one tool call:

- start one process;
- write stdout and stderr to files;
- store exit code separately;
- poll the same process;
- do not launch a duplicate suite;
- verify the old process before retrying;
- do not interpret a tool-response timeout as process failure.

Track a full process identity:

```text
wrapper PID and operating-system start time
child PID and operating-system start time
process-group ID or equivalent job identity
command digest
nonce
working directory
stdout and stderr paths
exit-code path
metadata path
```

PID alone is insufficient because operating systems reuse PIDs.

A reconnecting executor may poll or terminate only when the identity is positively observable and matches. Do not attach, poll as authoritative, or terminate based only on PID, broad command-name matching, repository-path substring, or process grep.

Treat partial, missing, schema-invalid, dead-PID, reused-PID, or mismatched metadata as stale.

Issue #967 owns the repository-provided Node 22 launcher and atomic metadata implementation.

Until #967 is implemented:

- do not claim nonce/digest continuity unless the current runtime exposes it directly;
- do not improvise a reusable repository wrapper outside task scope;
- do not kill or attach when identity is ambiguous;
- use the current tool/session's directly observable process handle when available;
- record the limitation in the receipt.

For GitHub Actions, bind evidence to:

```text
head SHA
run ID
job ID
current step
timestamps
conclusion
```

Never combine CI evidence from different heads.

## 9. Execution receipt

Use one editable comment in the source Issue as the per-task execution receipt. Find it by a stable marker:

```html
<!-- chat-execution-receipt:v1 -->
```

The comment is both a compact machine-readable record and a human-readable progress view.

### Required minimum fields

The following fields are mandatory. An executor that cannot populate them must mark the receipt invalid or unavailable and must not claim completion:

```json
{
  "schema": "chat-execution-receipt/v1",
  "repository": "owner/repo",
  "issue": 123,
  "executionId": "chat-123-...",
  "ownershipEpoch": 1,
  "previousExecutionId": null,
  "attestation": "self-reported",
  "policy": {
    "defaultBranchHead": "<sha>",
    "mergeBaseSha": "<sha|null>",
    "agentsBlobSha": "<sha>",
    "chatRulesBlobSha": "<sha>"
  },
  "issueBinding": {
    "state": "open",
    "updatedAt": "<UTC timestamp>",
    "bodyDigest": "<sha256>"
  },
  "branch": "<task branch>",
  "remoteHeadSha": "<sha|null>",
  "remoteTreeSha": "<sha|null>",
  "mode": "provisional-B",
  "work": "implementing",
  "publication": "published",
  "ci": "running",
  "review": "not-open",
  "updatedAt": "<UTC timestamp>"
}
```

`remoteHeadSha` and `remoteTreeSha` may be `null` only before the first successful publication or in Mode C.

The `mode` field accepts `provisional-B`, `B`, or `C`. Record the canary transition that confirms B or downgrades to C.

`ownershipEpoch` is mandatory for takeover continuity. Until #966 is implemented it remains a self-reported organizational fence, not a transactional lock.

Optional extension fields may record:

- process identities;
- CI run/job IDs;
- changed-path and semantic-overlap comparisons;
- transport diagnostics;
- finding dispositions;
- bounded transition history.

Optional fields do not replace the required minimum.

Follow the JSON with:

```markdown
## Chat execution progress

### Completed
- ...

### Current
- ...

### Next
- ...

### Blockers
- none

### Recent transitions
- ...
```

Use UTC as canonical time.

The GitHub Issue comment body limit is 65,536 characters. Keep transition history bounded. When space is low, remove the oldest transitions first while retaining:

- current state;
- policy and Issue bindings;
- active and previous execution IDs;
- ownership epoch;
- last remote head/tree;
- takeover history;
- current blockers;
- unresolved finding dispositions.

Issue comment updates are last-write-wins and are not transactional. Two writers can overwrite each other.

Protection is organizational until #966 lands:

- one active standalone branch owner;
- one active execution ID;
- monotonically increasing ownership epoch;
- explicit takeover;
- immediate receipt and remote-head read-back;
- fail-closed behavior on ambiguity.

Do not treat the JSON block as a transaction log or independent proof.

The receipt does not replace:

- remote commits;
- GitHub Actions;
- GitHub reviews;
- repository-owned AO worker status;
- review-start claim or pack-store authorities.

## 10. Ownership and takeover

One task branch has one active standalone chat executor.

A second standalone executor must not publish into a live branch without takeover.

For takeover:

1. read the live policy files;
2. read the current Issue and all comments carrying the receipt marker;
3. require exactly one valid current receipt;
4. read the remote branch head and tree;
5. inspect current-head CI and review;
6. create a new unique execution ID;
7. increment ownership epoch by exactly one;
8. preserve the previous execution ID;
9. state `taking over from <old ID> at <head SHA>`;
10. update the receipt and reread it immediately;
11. continue only when the new ID/epoch and expected head are read back unambiguously.

Because Issue comments lack compare-and-swap, takeover remains organizational rather than transactional until #966 provides the repository-owned helper. A failed or ambiguous update grants no ownership.

A stale executor that observes another execution ID or a higher ownership epoch must stop. It must not lower the epoch, restore its old receipt, or force the branch back to its local state.

Fast-forward-only publication prevents many accidental overwrites, but receipt comments remain last-write-wins and force rewrites remain race-prone.

AO-managed workers do not use this standalone ownership protocol. They continue to use the AO-managed lifecycle and authorities defined by `/AGENTS.md`.

If branch deletion is unavailable, do not create temporary transport branches in the main repository. Put abandoned task branches into an operator cleanup queue.

## 11. Degradation and attempt discipline

If authorization or write permission fails after work began:

1. stop GitHub writes;
2. read remote state if reading still works;
3. report the exact sanitized failure;
4. export local work as a patch, archive, or manifest;
5. downgrade to Mode C;
6. update the receipt if comment writing still works and ownership is unambiguous.

A confirmed integrity mismatch immediately blocks the affected transport.

There is no universal three-attempt limit. Stop repeating one failure class when two consecutive attempts:

- add no diagnostic information;
- do not change observed state;
- repeat an already rejected hypothesis.

The next attempt must change the hypothesis, evidence source, diagnostic layer, or solution class.

Review-cycle limits come from `/AGENTS.md`, tier policy, or the Issue contract, not from this document.

## 12. Secrets and egress

Never publish through commits, connector calls, Issue comments, receipts, capability profiles, logs, or handoff archives:

- tokens or API keys;
- cookies or authorization headers;
- raw `.env` files;
- authenticated URLs;
- private keys;
- secret configuration;
- third-party private data.

Scrub CI and process logs before quoting them.

Capability evidence may name a non-secret login, permission class, tool version, HTTP status, or sanitized error class; it must not contain credentials.

## 13. CI and review finding lifecycle

All CI and review claims bind to the current PR head SHA and the current Issue/spec binding.

After every new commit or history rewrite:

- invalidate old-head CI conclusions;
- invalidate old-head clean-review conclusions;
- obtain fresh checks and review for the new head.

Do not call missing CI green. Do not treat cancelled, stale, or earlier-head runs as completion.

### Finding dispositions

Every previously reported finding remains open until exactly one allowed disposition is recorded:

1. `fixed-and-verified` — the finding was fixed and verification is bound to the current head;
2. `removed-or-inapplicable` — the relevant code or document text was removed, making the finding inapplicable;
3. `rejected-and-accepted` — the finding was rejected with evidence and that rejection was accepted by the responsible reviewer or user.

A later clean review may support a disposition, but it does not automatically close, supersede, or launder an earlier finding.

Silence from another reviewer is not acceptance.

When GitHub review threads exist, their resolution state must agree with the reported disposition. When findings are represented by pack finding signatures, review-cycle state, or merge-triage markers, reuse those identities rather than inventing a competing finding store.

A clean current-head review is necessary when repository policy requires it, but it is not sufficient while a prior finding lacks an allowed disposition.

## 14. Status vocabulary

Track orthogonal state rather than one vague status:

```text
mode =
  provisional-B | B | C

work =
  analyzing | implementing | testing | preparing-handoff

publication =
  local | publishing | published | blocked

publicationCause =
  none | retryable | auth | rate-limit | integrity | conflict | ownership | permanent

ci =
  not-started | running | red | green | missing

review =
  not-open | open | addressing | clean@<head SHA>
```

Before `publication=published`, do not claim:

```text
implementation complete
final tree ready
only publication remains
almost ready
```

Accurate examples:

```text
implementing locally
published to branch; CI running
publication blocked: authentication failure
publication blocked: ownership ambiguity
clean review for head <SHA>; prior finding dispositions verified
```

## 15. Definition of Done for "implement the Issue"

A chat implementation is complete only when all applicable conditions hold:

```text
[ ] code or documentation exists in a remote task branch
[ ] remote head and resulting tree were read back
[ ] required execution-receipt fields are complete
[ ] the Issue binding was rechecked
[ ] the PR is linked according to /AGENTS.md
[ ] the PR diff contains only intended changes
[ ] no transport, secret, or temporary process files remain
[ ] default-branch movement was compared and semantic overlap resolved
[ ] CI exists for the current head
[ ] required or repository merge-contract checks are green
[ ] every review finding has one allowed explicit disposition
[ ] review evidence is bound to the current head
[ ] old-head CI and review conclusions were invalidated after changes
[ ] merge conflicts are absent
[ ] the base was updated when semantic overlap or repository policy requires it
[ ] PR is ready for review
[ ] the user received PR URL, head SHA, CI summary, review state,
    finding dispositions, and known limitations
```

`BEHIND` alone is not a blocker unless branch protection or the repository merge contract requires an up-to-date base. However, semantic overlap, an unclassified default-branch change, or stale acceptance evidence remains blocking even when Git reports no conflict.

Some API-authored commits may not start workflows. If no run appears for the current head, use an existing repository-owned retrigger. Do not create a diagnostic workflow and do not interpret a missing run as green. Escalate if no safe retrigger exists.

Local tests, local commits, and a clean local tree do not satisfy this Definition of Done.

Mode C ends with `handoff prepared`, not `completed`.

## 16. Operating formula

> Capabilities live in a canonical repository Issue, are keyed to repository and environment identity, and are reused only while current and unambiguous.
>
> Each task checks current liveness, starts in `provisional-B` or C, and uses the first real checkpoint to confirm B or downgrade.
>
> Active work produces a GitHub-visible heartbeat every 15–20 minutes.
>
> File progress is anchored in a remote branch and verified by read-back.
>
> Default-branch movement is classified for semantic contract overlap, not only policy-file drift.
>
> Every prior review finding requires an explicit allowed disposition.
>
> Standalone ownership fencing remains organizational until Issue #966 provides the repository-owned helper.
>
> Full long-process identity remains capability-limited until Issue #967 provides the repository-owned Node 22 wrapper.
>
> Every CI, review, and completion claim is bound to current evidence.
>
> Work that exists only in an ephemeral container is not finished work.
