# Chat executor rules

## 1. Scope

These rules apply only to implementers working through a chat-based environment in which the conversation, shell container, local filesystem, GitHub connector, GitHub Actions, and tool calls may have different authentication, network access, persistence, and timeout behavior.

A working shell `git push` changes the preferred publishing transport; it does not make the environment non-chat. Remote checkpoints, remote read-back, heartbeat, long-process handling, and the rule that local work is not completed work still apply.

These rules supplement `/AGENTS.md`. They do not replace or weaken repository policy. `/AGENTS.md` remains authoritative for scope, Issue and PR linking, verification, review-cycle limits, merge policy, and other repository-wide behavior. If the two documents appear to conflict, stop and report the conflict rather than inventing an exception.

## 2. Required start

Before substantive analysis, editing, review, or specification work, read the live default-branch versions of:

1. `/AGENTS.md`;
2. `docs/chat-executor-rules.md`.

Do not rely on a remembered or previously uploaded copy while live GitHub reading is available. If either file cannot be read completely, say so and do not claim that its policy has been applied.

Record a policy snapshot containing:

- default-branch commit SHA;
- `/AGENTS.md` path and connector-returned blob SHA;
- this document's path and connector-returned blob SHA;
- UTC read time.

Confirm the start in this form:

```text
AGENTS.md read: <blob SHA>
Chat executor rules read: <blob SHA>
Default branch HEAD: <commit SHA>
Execution ID: <unique ID>
Execution mode: B | C
```

A blob SHA identifies exact file contents. A commit SHA identifies the repository commit whose tree was read.

Policy snapshots and execution receipts are operational attestations made by the executor. They are not independently verified evidence merely because they contain hashes. Where repository tooling or an operator validator exists, it may compare the reported bindings with live GitHub state. Without such validation, describe them as `self-reported`, not `verified`.

The compatible validation architecture is:

```text
connector-side read or capability probe
    -> capability ledger / execution receipt
    -> optional repository-side or operator validation
```

## 3. Issue binding

For repositories where `/AGENTS.md` makes GitHub Issues the task source of truth, including this repository, every implementation task must bind to its Issue.

Record:

- repository;
- Issue number;
- Issue state;
- Issue `updatedAt`;
- SHA-256 digest of the normalized Issue body.

Normalize the Issue body as UTF-8 with CRLF converted to LF; otherwise preserve the text exactly.

Re-read the Issue before `ready for review`. If its state, timestamp, or body digest changed, reconcile the implementation with the new task text or obtain an explicit user decision. Do not silently continue against a stale specification.

## 4. Capability profile

A capability profile is a reusable, machine-readable ledger for a class of chat environment. Its purpose is to record tested transports and known dead ends so every new chat does not repeat the same destructive preflight.

Each capability entry should record:

- transport;
- status: `proven | available-but-unproven | unavailable | degraded`;
- evidence and test time;
- environment/tool fingerprint;
- non-secret auth principal or permission class;
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

A profile remains reusable across chats. Re-run the full capability preflight only after a material change:

- connector or tool inventory changed;
- authentication principal or repository permissions changed;
- the profile explicitly expired;
- the actual transport contradicted the profile;
- an unexpected integrity, authorization, or network failure occurred.

Starting a new conversation alone is not an invalidation event.

Destructive capability tests, including test branches and test PRs, belong in a sandbox repository. Do not create temporary PRs in the main repository merely to test PR creation.

## 5. Per-task liveness check and modes

A normal task does not repeat the full capability investigation. Check only current mutable facts:

- repository read succeeds;
- current permissions are sufficient;
- current default-branch HEAD is known;
- both policy files were read live;
- the selected publishing transport is available;
- a real task branch can be created or reused.

The first real task commit is the session canary:

```text
create a meaningful task checkpoint
    -> publish it to the task branch
    -> read the remote head and tree back
    -> compare them with the intended commit/tree
```

Do this before a large local implementation.

### Mode B — full chat execution

Mode B is available when the current capability profile and canary support the operations required by the task:

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

Only Mode B permits a promise to implement the Issue and bring its PR to `ready for review`.

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

Upgrade to Mode B only after a remote write transaction and read-back succeed.

## 6. Remote publication

The local container is temporary until work is remotely anchored.

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
    -> create commit with that head as parent
    -> update ref with force=false
    -> read branch head and tree back
```

Concurrent advancement should produce a non-fast-forward failure. On mismatch or conflict:

```text
read new remote head
    -> rebase/rebuild the resulting tree
    -> republish from the new base
```

Do not retry a possibly successful timed-out write blindly; read remote state first.

### History rewrite

A force rewrite has no mechanical compare-and-swap protection. `force=true` disables fast-forward protection.

Before an allowed rewrite:

1. verify repository policy permits it;
2. confirm sole ownership of the task branch;
3. read the remote head immediately before the write;
4. require it to equal this execution's last published head;
5. narrow the race window as much as possible;
6. force-update;
7. read the new head and tree back immediately.

This is an organizational control plus race-window reduction, not a guarantee against concurrent writes.

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

Record what was checked, what changed in the diagnosis, what hypothesis was rejected, process or run identity, and the next specific step.

If local files have changed but cannot safely be checkpointed because they contain a secret, violate scope, or form a knowingly invalid tree, record the exact reason and publish at the first safe boundary.

Phrases such as `still working`, `almost done`, or `only publication remains` are not evidence.

### Loop detection

Rewording an old conclusion is not new evidence.

A sufficient core signal that execution is stuck is two consecutive heartbeat intervals with both:

- no new substantive evidence affecting diagnosis, implementation, or the next justified action; and
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
PID
process start time
command digest
nonce
process-group ID
working directory
log paths
```

PID alone is insufficient because operating systems reuse PIDs. Terminate only a process group whose full identity matches.

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

Recommended machine-readable fields:

```json
{
  "schema": "chat-execution-receipt/v1",
  "repository": "owner/repo",
  "issue": 123,
  "executionId": "chat-123-...",
  "previousExecutionId": null,
  "attestation": "self-reported",
  "policy": {
    "defaultBranchHead": "<sha>",
    "agentsBlobSha": "<sha>",
    "chatRulesBlobSha": "<sha>"
  },
  "issueBinding": {
    "state": "open",
    "updatedAt": "<UTC timestamp>",
    "bodyDigest": "<sha256>"
  },
  "baseSha": "<sha>",
  "remoteHeadSha": "<sha|null>",
  "remoteTreeSha": "<sha|null>",
  "mode": "B",
  "work": "implementing",
  "publication": "published",
  "ci": "running",
  "review": "not-open",
  "updatedAt": "<UTC timestamp>"
}
```

Follow it with:

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

The GitHub Issue comment body limit is 65,536 characters. Keep transition history bounded. When space is low, remove the oldest transitions first, while retaining current state, policy and Issue bindings, active and previous execution IDs, last remote head, takeover history, and current blockers.

Issue comment updates are last-write-wins and are not transactional. Two writers can overwrite each other. Protection is organizational, not mechanical:

- one active branch owner;
- one active execution ID;
- explicit takeover;
- remote-head verification before continuing.

Do not treat the JSON block as a transaction log or independent proof. Repository tooling or an operator may validate it; otherwise it remains self-reported.

The receipt does not replace remote commits, Actions, GitHub reviews, or repository-owned worker-status mechanisms.

## 10. Ownership and takeover

One task branch has one active chat executor.

A second executor must not publish into a live branch without takeover.

For takeover:

1. read the live policy files;
2. read the current Issue and receipt;
3. read the remote branch head and tree;
4. inspect current-head CI and review;
5. record the old and new execution IDs;
6. state `taking over from <old ID> at <head SHA>`;
7. continue only from the confirmed remote head.

Fast-forward-only publication prevents many accidental overwrites, but receipt comments remain last-write-wins and force rewrites remain race-prone.

If branch deletion is unavailable, do not use temporary branches in the main repository. Put abandoned task branches into an operator cleanup queue.

## 11. Degradation and attempt discipline

If authorization or write permission fails after work began:

1. stop GitHub writes;
2. read remote state if reading still works;
3. report the exact sanitized failure;
4. export local work as a patch, archive, or manifest;
5. downgrade to Mode C;
6. update the receipt if comment writing still works.

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

Scrub CI and process logs before quoting them. Capability evidence may name a non-secret login, permission class, tool version, HTTP status, or sanitized error class; it must not contain credentials.

## 13. Status vocabulary

Track orthogonal state rather than one vague status:

```text
work =
  analyzing | implementing | testing | preparing-handoff

publication =
  local | publishing | published | blocked

publicationCause =
  none | retryable | auth | rate-limit | integrity | conflict | permanent

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
clean review for head <SHA>
```

## 14. Definition of Done for "implement the Issue"

A chat implementation is complete only when all applicable conditions hold:

```text
[ ] code exists in a remote task branch
[ ] remote head and resulting tree were read back
[ ] the Issue binding was rechecked
[ ] the PR is linked according to /AGENTS.md
[ ] the PR diff contains only intended changes
[ ] no transport or temporary process files remain
[ ] CI exists for the current head
[ ] required or repository merge-contract checks are green
[ ] review findings are resolved for the current head
[ ] old-head CI and clean-review receipts were invalidated after changes
[ ] merge conflicts are absent
[ ] the base was updated if repository policy requires it
[ ] PR is ready for review
[ ] the user received PR URL, head SHA, CI summary, review state,
    and known limitations
```

`BEHIND` alone is not a blocker unless branch protection or the repository merge contract requires an up-to-date base.

Some API-authored commits may not start workflows. If no run appears for the current head, use an existing repository-owned retrigger. Do not create a diagnostic workflow and do not interpret a missing run as green. Escalate if no safe retrigger exists.

Local tests, local commits, and a clean local tree do not satisfy this Definition of Done.

Mode C ends with `handoff prepared`, not `completed`.

## 15. Operating formula

> Capabilities are investigated rarely and reused across chats.

> Each task checks current liveness and proves publication with its first real checkpoint.

> Active work produces a GitHub-visible heartbeat every 15–20 minutes.

> File progress is regularly anchored in a remote branch and verified by read-back.

> Every CI, review, and completion claim is bound to the current head.

> Work that exists only in an ephemeral container is not finished work.
