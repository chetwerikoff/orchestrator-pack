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

Before the first receipt exists, reserve ownership epoch `1` for the initial execution. A takeover increments the last valid epoch by exactly one. This epoch remains an organizational continuity field until the repository-owned helper in Issue #966 is implemented; it does not turn an Issue comment into a transactional lock.

At startup, `provisional-B` means the reusable capability profile and current liveness checks support a candidate publication path, but the current session has not yet proved it. It is not confirmed Mode B and does not authorize a large local implementation or a promise to reach `ready for review`.

Choose Mode C immediately when no reliable candidate publication path exists.

A blob SHA identifies exact file contents. A commit SHA identifies a commit. Neither identifier, by itself, proves branch ownership, resulting remote content, CI state, review state, or another contract source.

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

## 3. Task-control record and exact contract binding

For repositories where `/AGENTS.md` makes GitHub Issues the task source of truth, including this repository, every implementation task binds to a GitHub Issue as its task-control record.

The Issue remains authoritative for:

- repository and Issue number;
- state and discussion;
- declared scope and PR linkage;
- operator decisions recorded in the Issue conversation.

The Issue task-control record is not necessarily the exact byte source of the implementation contract. Exact contract identity must use exactly one binding kind:

```text
issue-body
repository-contract
operator-export
existing-pr-adoption
```

The receipt must record:

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

`bindingDigest` is always required.

`bodyDigest` is required only for `bindingKind: issue-body` with `issueBodyAccess: full`. All other binding kinds use `bodyDigest: null`.

Issue `updatedAt` is an advisory signal that the task-control record may have changed. It is not exact contract identity and must not substitute for `bindingDigest`. Receipt comments and unrelated discussion may also move Issue timestamps.

### Full and truncated Issue access

Classify Issue-body access explicitly:

```text
full | truncated
```

Any response described or observed as truncated, summarized, clipped, partial, limited, or incomplete:

- is not a complete Issue body;
- must not be hashed as the full Issue body;
- must not be used to start a new implementation;
- may provide task-control metadata, but not exact Issue-body contract identity.

A summary is never a contract. Do not infer omitted requirements.

For `issue-body`:

- first establish that the complete body was received;
- normalize as UTF-8 with CRLF converted to LF and otherwise preserve text exactly;
- calculate SHA-256 over the normalized complete body;
- use the same digest as `bindingDigest` and `bodyDigest`.

`issueBodyAccess: truncated` with `bindingKind: issue-body` is invalid.

### Repository contract

Use `repository-contract` when the Issue or explicit operator direction identifies a repository Markdown specification as the binding implementation contract.

Record:

- repository-relative path;
- commit or ref used to locate it;
- immutable Git blob SHA;
- `bindingRef` in a form that identifies the path and blob;
- `bindingDigest` equal to the blob SHA;
- `bodyDigest: null` unless a complete Issue body was separately read for task-control comparison.

Do not accept a repository contract inferred only from an incomplete summary. The binding path must be stated by a complete authoritative source or explicitly confirmed by the operator.

For large specifications, prefer:

```text
GitHub Issue
    -> explicitly binds repository Markdown specification
    -> receipt records path and immutable Git blob SHA
```

### Operator export

Use `operator-export` when the operator supplies an exact UTF-8 export of the contract.

Record:

- source description or supplied filename;
- declared normalization, normally exact bytes with no silent rewriting;
- SHA-256 of the exact bound export;
- `bindingRef` identifying that export;
- `bindingDigest` equal to that SHA-256;
- `bodyDigest: null`.

Do not silently normalize, summarize, repair, or reformat an operator export before hashing it.

### New implementation gate

A new implementation may begin only from one exact source:

- a confirmed complete Issue body;
- an explicitly bound repository contract;
- an exact operator export.

A truncated Issue, clipped response, search snippet, summary, PR title, or review summary is insufficient for new implementation.

### Narrow existing-PR adoption

Use `existing-pr-adoption` only when the PR and task branch existed before the new executor and the exact original Issue body cannot be obtained in full.

All conditions are mandatory:

1. the operator explicitly authorizes adoption;
2. the executor reads the current PR, branch, adopted head, and one complete allowed remote-content read-back level;
3. the receipt contains a closed exact finding list, using stable review IDs, signatures, paths, and summaries where available;
4. changes are limited to those findings and directly necessary verification adjustments;
5. new functionality, scope expansion, unrelated cleanup, and speculative refactoring are prohibited;
6. ownership, current-head CI, review binding, finding dispositions, and remote read-back remain fully required.

Record additionally:

```json
{
  "existingPrAdoption": {
    "pr": 123,
    "branch": "task/branch",
    "adoptedHead": "<sha>",
    "operatorAuthorization": "<exact reference or text>",
    "closedFindings": [
      {
        "id": "<review id or signature>",
        "path": "<path|null>",
        "summary": "<exact bounded summary>"
      }
    ]
  }
}
```

For this binding kind:

- `bindingRef` identifies the PR, branch, adopted head, and authorization;
- `bindingDigest` is the adopted head SHA;
- `bodyDigest` is `null`;
- `issueBodyAccess` may be `truncated`.

Existing-PR adoption is not a way to start new work from a partial Issue. Any need to add behavior, broaden scope, change architecture beyond a named finding, or perform unrelated cleanup invalidates adoption and requires a complete exact contract.

### Contract revalidation

Re-read task-control state before the first publication and again before `ready for review`.

If Issue state or `updatedAt` changed, investigate the reason, but do not use the timestamp alone as proof that the contract changed or remained stable.

Revalidate the exact binding through its own mechanism:

- `issue-body`: obtain the complete body and compare normalized SHA-256;
- `repository-contract`: confirm the binding path and immutable blob SHA;
- `operator-export`: compare the exact export digest or obtain an explicit replacement export;
- `existing-pr-adoption`: confirm adopted head, authorization, and closed finding list remain the permitted boundary.

When exact revalidation cannot be completed:

- block new implementation and scope expansion;
- preserve already published work;
- for existing-PR adoption, continue only inside the original closed finding list when authorization remains explicit;
- otherwise obtain an exact source or operator decision.

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

The JSON payload inside the profile Issue must validate against the tracked strict schema:

```text
.github/orchestrator-pack-chat-capability-profile.schema.json
```

The tracked schema is normative for JSON structure, required fields, enums, timestamp formats, expiry representation, and forbidden extra properties. Marker uniqueness, open-Issue selection, authorization, expiry evaluation, and live capability truth still require repository/helper or operator checks; JSON Schema alone does not make the Issue transactional or current.

A profile that fails schema validation is corrupt and must not be used.

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

If more than one matching open profile exists, the marker or JSON is corrupt, repository identity differs, the fingerprint is ambiguous, or schema validation fails:

- do not choose by guess;
- mark the profile unavailable;
- report the ambiguity or validation errors;
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

- status: `proven | available-but-unproven | unavailable | degraded`;
- concrete evidence and test time;
- exactly one of `expiresAt` or `noExpiryRationale`;
- known limits;
- preferred fallback.

The normal minimum profile covers:

```text
repository read
text publication
commit/tree/ref publication and remote read-back
Issue/PR create and update
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
2. validate the JSON payload against `.github/orchestrator-pack-chat-capability-profile.schema.json`;
3. verify repository identity and environment fingerprint;
4. ignore expired entries;
5. use only entries whose evidence applies to the current task and permission class;
6. run short liveness checks for mutable facts.

Only an authenticated repository collaborator acting as the current standalone executor or the explicit operator may update the profile.

Every profile update must:

- remain valid against the tracked schema;
- preserve a bounded human-readable transition history;
- state what changed and why;
- replace only affected entries;
- keep secrets out of the Issue.

A capability entry expires at its stated `expiresAt`. Mutable authorization, network, connector, and service-availability evidence should have bounded expiry. Stable format or transport semantics may use `noExpiryRationale` only when the rationale is recorded.

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

## 5. Per-task liveness, ownership bootstrap, and modes

A normal task does not repeat the full capability investigation. Check current mutable facts:

- repository read succeeds;
- current permissions are sufficient;
- current default-branch HEAD is known;
- both policy files were read live;
- task-control state was read;
- an exact contract binding was established;
- the selected publishing transport is available;
- the planned or existing task branch state is known.

Choose the initial state before the canary:

- `provisional-B` when the reusable capability profile and current liveness checks support every operation required by the task, but current-session publication has not yet been proved;
- `C` when no reliable candidate publication path is available.

### Non-circular ownership bootstrap

Before ordinary ownership exists, reads are allowed. Writes are limited to this closed list:

- create the task-control record when none exists and the operator explicitly authorized creation;
- initial-claim receipt write;
- takeover-claim receipt write.

All other GitHub writes require established ownership, including:

- task-branch creation;
- task-branch update;
- PR creation or mutation;
- review replies;
- workflow dispatch;
- progress receipt updates;
- history rewrite.

The bootstrap order is:

```text
read task-control state and remote branch state
    -> establish exact contract binding
    -> write initial-claim or takeover-claim receipt
    -> read the receipt back and confirm ownership
    -> create or mutate the task branch
    -> perform remote content read-back
```

For an absent planned branch, the initial claim records the intended branch name, exact starting base, and expected branch state `absent`. After claim success, create the branch at that exact base and read it back.

For an existing branch, the claim binds the exact observed head.

Ordinary ownership checks cannot be prerequisites for the initial or takeover write that creates ownership. Issue #966 owns the repository helper that will make these transitions executable. Until it lands, this sequence remains an organizational fail-closed protocol with immediate read-back.

### Publication canary

`provisional-B` is transient. It resolves through the first meaningful task checkpoint:

```text
create or update the claimed task branch
    -> publish a meaningful task commit
    -> read the remote head back
    -> prove resulting remote content through one allowed read-back level
```

On success:

```text
provisional-B -> B
```

If the selected transport fails:

- remain `provisional-B` only while switching to another already-proven candidate transport and rerunning the canary;
- transition to Mode C when no reliable candidate remains.

Do this before a large local implementation. Do not begin one while the state remains `provisional-B`.

### Mode B — full chat execution

Mode B is confirmed only when the capability profile supports the task, ownership was established, exact contract binding is valid, and the current-session canary succeeded.

Mode B may include:

```text
edit
publish
remote read-back
open and update PR
observe CI
observe and address review
prepare a ready-for-review handoff
```

Publication may use shell Git, the GitHub object API, the contents API, or another proven transport.

Historically proven PR and CI capabilities do not need fake per-task tests. Confirm them through the first real PR and CI run. An unexpected failure causes explicit downgrade, escalation, or transport change.

Only confirmed Mode B permits a promise to implement the task and bring its PR to `ready for review`.

### Mode C — implementation handoff

Use Mode C when reliable publication is unavailable or fails.

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

A Mode C session may move to `provisional-B` when a reliable candidate transport becomes available. It becomes confirmed Mode B only after ownership, a remote write transaction, and complete allowed read-back succeed.

## 6. Remote publication and content read-back

The local container is temporary until work is remotely anchored.

After ownership is established, normal Git publication is:

```text
inspect local status and diff
    -> confirm every path is inside task scope
    -> verify active execution ID, epoch, and expected branch state
    -> commit a meaningful checkpoint
    -> push/update the task branch
    -> read the remote head back
    -> prove resulting remote content
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
    -> read remote evidence back
```

The publication manifest preserves Git semantics:

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

Reject absolute paths, `..`, case collisions, unapproved symlinks, gitlinks, or unexplained mode changes. Text-only replacement is insufficient when deletions, executable bits, symlinks, or object types matter.

After blob upload, compare the returned blob SHA. A confirmed truncation or SHA mismatch blocks that transport for the affected payload. Do not vary chunk sizes without new evidence that the transport can be safe.

### Allowed remote-content levels

Do not require a field that every permitted transport cannot return. Every successful publication must satisfy one complete level:

```text
commit-and-tree
commit-and-manifest
commit-diff-and-file-blobs
```

#### `commit-and-tree`

Require:

- remote head commit SHA;
- root tree SHA;
- both read back from the remote repository;
- comparison with the intended commit and resulting tree.

#### `commit-and-manifest`

Require:

- remote head commit SHA;
- complete resulting-tree manifest, or a retained exact manifest plus digest;
- paths, modes, object types, blob SHAs, additions, updates, and deletions;
- evidence reference that permits later reread;
- comparison with the intended resulting content.

#### `commit-diff-and-file-blobs`

Require:

- remote head commit SHA;
- exact changed-path and status evidence;
- remote diff or deterministic diff digest;
- remote blob SHA for every added or modified file;
- explicit deletion evidence for every removed file;
- explicit old/new path evidence for renames;
- explicit mode/object evidence where relevant;
- comparison with the intended delta.

A connector that does not expose root tree SHA may use a complete equivalent level. It must not invent `remoteTreeSha`.

Partial evidence does not satisfy any level.

Record read-back in a dedicated object:

```json
{
  "remoteContent": {
    "level": "commit-and-tree | commit-and-manifest | commit-diff-and-file-blobs",
    "headSha": "<sha>",
    "treeSha": "<sha|null>",
    "manifestDigest": "<digest|null>",
    "diffDigest": "<digest|null>",
    "evidenceRef": "<exact source>",
    "observedAt": "<UTC timestamp>"
  }
}
```

Level-specific evidence may be stored outside the receipt when the exact durable reference and digest are recorded.

### Fail-closed ref update

GitHub's ref-update API does not provide an `expected SHA` parameter. Use the strongest available sequence:

```text
read active execution ID and ownership epoch
    -> read branch head immediately before publication
    -> require receipt and head to match expected state
    -> create commit with that head as parent
    -> update ref with force=false
    -> read branch head and remote-content evidence back
```

Concurrent advancement should produce a non-fast-forward failure.

On ownership mismatch, conflict, or unexpected advancement:

```text
stop the write
    -> read the current receipt and remote head
    -> determine whether takeover or concurrent publication occurred
    -> rebuild/rebase only when this execution still owns the task
    -> revalidate scope, contract, and semantic overlap
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
5. require receipt identity/epoch and head to equal this execution's expected state;
6. narrow the race window;
7. force-update;
8. perform complete allowed read-back immediately;
9. obtain fresh CI and review for the new head.

This is organizational control plus race-window reduction, not a guarantee against concurrent writes.

### Planned ownership helper

Issue #966 owns a Node 22 helper for standalone chat-executor initial claims, takeover claims, and execution-ID/ownership-epoch/head fencing. It must implement the claim-before-branch distinction and the revised contract-binding fields.

Until #966 is implemented:

- do not claim the repository has a transactional receipt mutex;
- keep one active standalone executor;
- use explicit initial claim or takeover;
- reread the receipt and branch head immediately before and after high-risk writes;
- fail closed on duplicate, corrupt, missing, or ambiguous receipt state.

AO-managed workers continue to use their existing AO session, pack-store, claim, and `pack-worker-report` authority. They must not mint a competing standalone receipt ownership authority.

## 7. Remote checkpoint and heartbeat

During active execution, produce a GitHub-visible signal at least every 15–20 minutes. The cadence limits unanchored work and makes loops visible; it is not a limit on total task duration.

User waiting time and an explicitly paused session do not count as active execution.

### Primary heartbeat: remote checkpoint

When a meaningful recoverable file slice exists:

```text
verify ownership
    -> commit
    -> publish task branch
    -> complete remote-content read-back
    -> update execution receipt
    -> reread receipt and branch head
```

A clearly labeled WIP checkpoint is acceptable when it represents real, scoped progress. A local commit without remote publication is not a checkpoint.

Also checkpoint at meaningful boundaries:

- after a functional slice;
- before a long test;
- before a risky operation;
- before changing transport;
- before history rewrite;
- before likely container loss.

Do not create empty or meaningless commits merely to satisfy the timer.

### Minimal heartbeat: evidence update

When no safe meaningful file slice exists, update the execution receipt with concrete evidence after verifying ownership. Typical cases:

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

If local files changed but cannot safely be checkpointed because they contain a secret, violate scope, or form a knowingly invalid tree, record the exact reason and publish at the first safe boundary.

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

A reconnecting executor may poll or terminate only when identity is positively observable and matches. Do not attach, poll as authoritative, or terminate based only on PID, broad command-name matching, repository-path substring, or process grep.

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
    "issueBodyAccess": "full",
    "bindingKind": "issue-body",
    "bindingRef": "Issue #123 complete body",
    "bindingDigest": "<sha256>",
    "bodyDigest": "<sha256|null>"
  },
  "branch": "<task branch>",
  "expectedBranchHead": "<sha|null>",
  "remoteContent": {
    "level": "commit-and-tree",
    "headSha": "<sha|null>",
    "treeSha": "<sha|null>",
    "manifestDigest": null,
    "diffDigest": null,
    "evidenceRef": "<source|null>",
    "observedAt": "<UTC timestamp|null>"
  },
  "mode": "provisional-B",
  "work": "implementing",
  "publication": "local",
  "ci": "not-started",
  "review": "not-open",
  "updatedAt": "<UTC timestamp>"
}
```

Rules:

- `bindingDigest` is always non-null;
- `bodyDigest` is non-null only for complete `issue-body`;
- `issueBodyAccess: truncated` with `bindingKind: issue-body` is invalid;
- `expectedBranchHead` may be `null` only when the claimed planned branch is expected to be absent;
- `remoteContent.headSha` and level evidence may be `null` only before first successful publication or in Mode C;
- `remoteContent.treeSha` is required only for `commit-and-tree`;
- a different allowed level supplies its own complete evidence instead of a fabricated tree SHA;
- `mode` accepts `provisional-B`, `B`, or `C`;
- record the canary transition that confirms B or downgrades to C.

For `existing-pr-adoption`, the `existingPrAdoption` object and closed finding list are mandatory.

`ownershipEpoch` is mandatory for takeover continuity. Until #966 is implemented it remains a self-reported organizational fence, not a transactional lock.

### Independent guarantee identities

Keep these distinct in the receipt:

```text
contract identity
branch ownership
remote content identity
CI identity
review identity
```

Recommended explicit extensions are:

```json
{
  "ciIdentity": {
    "headSha": "<sha>",
    "runsOrChecks": ["<id>"],
    "state": "running | red | green | missing",
    "observedAt": "<UTC timestamp>"
  },
  "reviewIdentity": {
    "headSha": "<sha>",
    "reviews": ["<review id>"],
    "openFindings": ["<signature>"],
    "state": "not-open | open | addressing | clean",
    "observedAt": "<UTC timestamp>"
  }
}
```

No one hash or timestamp proves another guarantee.

Optional extension fields may record:

- process identities;
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

The GitHub Issue comment body limit is 65,536 characters. Keep transition history bounded. When space is low, remove oldest transitions first while retaining:

- current state;
- policy and exact contract bindings;
- active and previous execution IDs;
- ownership epoch;
- expected and last remote head;
- remote-content level and digest/reference;
- takeover history;
- existing-PR adoption boundary when applicable;
- current blockers;
- unresolved finding dispositions.

Issue comment updates are last-write-wins and are not transactional. Two writers can overwrite each other.

Protection is organizational until #966 lands:

- one active standalone branch owner;
- one active execution ID;
- monotonically increasing ownership epoch;
- explicit initial claim or takeover;
- immediate receipt and remote-head read-back;
- fail-closed behavior on ambiguity.

Do not treat the JSON block as a transaction log or independent proof.

The receipt does not replace:

- remote commits and content read-back;
- GitHub Actions;
- GitHub reviews;
- repository-owned AO worker status;
- review-start claim or pack-store authorities.

## 10. Ownership and takeover

One task branch has one active standalone chat executor.

A second standalone executor must not publish into a live branch without takeover.

### Initial claim

The initial claim is the only ownership write for a task that has no current receipt.

Before it:

1. establish exact contract binding;
2. read all comments carrying the receipt marker;
3. require no valid current receipt;
4. read the planned branch and require it to be absent or at an explicitly selected starting head;
5. prepare a new execution ID and epoch `1`.

Write the receipt, then immediately reread all matching comments and branch state.

Initial claim succeeds only when exactly one valid current receipt contains the new execution ID, epoch `1`, contract binding, intended branch, and expected branch state.

On ambiguity, duplicate receipt, overwritten comment, or unexpected branch movement, the claim fails and grants no authority.

### Takeover claim

For takeover:

1. require explicit operator authorization unless the current receipt is already terminal/abandoned under repository policy;
2. read live policy files;
3. read task-control state and exact contract binding;
4. read all comments carrying the receipt marker and require exactly one valid current receipt;
5. read the remote branch head and allowed remote-content evidence;
6. inspect current-head CI and review;
7. create a new execution ID;
8. increment ownership epoch by exactly one;
9. preserve the previous execution ID;
10. state `taking over from <old ID> at <head SHA>`;
11. update the receipt and reread it immediately;
12. continue only when new ID/epoch, contract binding, and expected head are read back unambiguously.

Because Issue comments lack compare-and-swap, claim remains organizational rather than transactional until #966 provides the repository helper. A failed or ambiguous claim grants no ownership.

### Ordinary ownership fence

After claim success and immediately before every later write:

- require exactly one valid current receipt;
- require the receipt execution ID and epoch to equal this executor;
- require exact contract binding to remain valid;
- require the remote branch state to match the expected head or admitted absent state;
- stop without writing on mismatch, duplicate, corrupt, missing, or ambiguous state.

After branch or receipt writes, reread receipt and branch state.

A stale executor that observes another execution ID or a higher epoch must stop. It must not lower the epoch, restore its old receipt, create a replacement branch, or force the branch back to local state.

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
6. update the receipt only if comment writing still works and ownership is unambiguous.

A confirmed integrity mismatch immediately blocks the affected transport.

There is no universal three-attempt limit. Stop repeating one failure class when two consecutive attempts:

- add no diagnostic information;
- do not change observed state;
- repeat an already rejected hypothesis.

The next attempt must change hypothesis, evidence source, diagnostic layer, or solution class.

Review-cycle limits come from `/AGENTS.md`, tier policy, or the task contract, not from this document.

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

All CI and review claims bind to the current PR head SHA and the current exact contract binding.

After every new commit or history rewrite:

- invalidate old-head CI conclusions;
- invalidate old-head clean-review conclusions;
- obtain fresh checks and review for the new head.

Do not call missing CI green. Do not treat cancelled, stale, or earlier-head runs as completion.

### Finding dispositions

Every previously reported finding remains open until exactly one allowed disposition is recorded:

1. `fixed-and-verified` — the finding was fixed and verification is bound to the current head;
2. `removed-or-inapplicable` — relevant code or document text was removed, making the finding inapplicable;
3. `rejected-and-accepted` — the finding was rejected with evidence and that rejection was accepted by the responsible reviewer or user.

A later clean review may support a disposition, but it does not automatically close, supersede, or launder an earlier finding.

Silence from another reviewer is not acceptance.

When GitHub review threads exist, their resolution state must agree with the reported disposition. When findings are represented by pack finding signatures, review-cycle state, or merge-triage markers, reuse those identities rather than inventing a competing finding store.

A clean current-head review is necessary when repository policy requires it, but it is not sufficient while a prior finding lacks an allowed disposition.

For `existing-pr-adoption`, the closed finding list is the maximum mutation boundary. Discovering another defect does not authorize fixing it unless the operator supplies a complete exact contract or explicitly rebinds the task through another allowed kind.

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
  none | retryable | auth | rate-limit | integrity | conflict | ownership | contract | permanent

contract =
  bound | revalidation-required | unavailable | invalid

remoteContent =
  unavailable | partial | commit-and-tree | commit-and-manifest | commit-diff-and-file-blobs

ci =
  not-started | running | red | green | missing

review =
  not-open | open | addressing | clean@<head SHA>
```

Before `publication=published`, do not claim:

```text
implementation complete
final remote content ready
only publication remains
almost ready
```

Accurate examples:

```text
contract unavailable: Issue body truncated; exact source required
existing PR adopted at head <SHA>; fixes limited to findings <IDs>
published to branch; remote content verified by commit-diff-and-file-blobs
publication blocked: ownership ambiguity
clean review for head <SHA>; prior finding dispositions verified
```

## 15. Mandatory acceptance scenarios

The policy behavior is:

| Scenario | Required result |
|---|---|
| Short Issue read in full | Normalize the complete body and use SHA-256 as both binding and body digest. |
| Large Issue is truncated | Do not start new implementation without a complete alternate contract. |
| Large Issue binds a repository specification | Bind repository path and immutable Git blob SHA. |
| Existing PR with truncated Issue | Continue only after explicit operator authorization, complete adopted-head read-back, and a closed exact finding list. |
| Second executor writes to occupied branch | Reject on execution ID, epoch, or expected-head mismatch. |
| Issue or exact contract changes after claim | Require exact contract revalidation before more implementation or ready-for-review reporting. |
| Connector lacks root tree SHA | Use a complete allowed `commit-and-manifest` or `commit-diff-and-file-blobs` level. |
| Executor sees only an Issue summary | Do not treat the summary as contract identity. |
| New commit is published | Invalidate old-head CI and clean-review conclusions. |
| Existing-PR adoption attempts new functionality | Block and require a complete exact contract or explicit rebinding. |

## 16. Definition of Done for "implement the Issue"

A chat implementation is complete only when all applicable conditions hold:

```text
[ ] code or documentation exists in a remote task branch
[ ] exact contract binding is valid
[ ] required execution-receipt fields are complete
[ ] branch ownership is current and unambiguous
[ ] one complete allowed remote-content read-back level succeeded
[ ] task-control state was rechecked
[ ] the PR is linked according to /AGENTS.md
[ ] the PR diff contains only intended changes
[ ] existing-PR adoption, when used, stayed inside its closed finding list
[ ] no transport, secret, or temporary process files remain
[ ] default-branch movement was compared and semantic overlap resolved
[ ] CI exists for the current head
[ ] required or repository merge-contract checks are green
[ ] every review finding has one allowed explicit disposition
[ ] review evidence is bound to the current head and exact contract
[ ] old-head CI and review conclusions were invalidated after changes
[ ] merge conflicts are absent
[ ] the base was updated when semantic overlap or repository policy requires it
[ ] PR is ready for review
[ ] the user received PR URL, head SHA, contract binding kind/digest,
    remote-content level, CI summary, review state, finding dispositions,
    and known limitations
```

`BEHIND` alone is not a blocker unless branch protection or the repository merge contract requires an up-to-date base. However, semantic overlap, an unclassified default-branch change, invalid contract binding, adoption-scope violation, or stale acceptance evidence remains blocking even when Git reports no conflict.

Some API-authored commits may not start workflows. If no run appears for the current head, use an existing repository-owned retrigger. Do not create a diagnostic workflow and do not interpret a missing run as green. Escalate if no safe retrigger exists.

Local tests, local commits, and a clean local tree do not satisfy this Definition of Done.

Mode C ends with `handoff prepared`, not `completed`.

## 17. Operating formula

> Capabilities live in a canonical repository Issue, are keyed to repository and environment identity, and are reused only while current and unambiguous.
>
> Capability JSON must validate against the strict tracked schema in `.github/orchestrator-pack-chat-capability-profile.schema.json`; the Issue remains the mutable instance.
>
> The GitHub Issue is the task-control record; exact contract identity may come from a complete Issue body, repository blob, operator export, or narrow adopted PR head.
>
> Never hash truncated or summarized Issue text as a complete contract.
>
> Establish exact contract binding and claim ownership before creating or mutating the task branch.
>
> Active work produces a GitHub-visible heartbeat every 15–20 minutes.
>
> File progress is anchored in a remote branch and verified through one complete transport-appropriate read-back level.
>
> Root tree SHA is not globally mandatory when an equivalent allowed read-back level proves resulting content.
>
> Contract identity, branch ownership, remote content, CI identity, and review identity remain separate guarantees.
>
> Default-branch movement is classified for semantic contract overlap, not only policy-file drift.
>
> Every prior review finding requires an explicit allowed disposition.
>
> Standalone ownership fencing remains organizational until Issue #966 provides the repository-owned helper.
>
> Full long-process identity remains capability-limited until Issue #967 provides the repository-owned Node 22 wrapper.
>
> Work that exists only in an ephemeral container is not finished work.
