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
Execution ID: <unique ID>
Ownership epoch: <positive integer or not-applicable-for-independent-review>
Execution mode: provisional-B | C | review-only
```

`provisional-B` means a reusable capability profile and current liveness checks support a candidate publication path, but current-session publication has not yet been proved. It is not confirmed Mode B and does not authorize a large local implementation or a promise to reach `ready for review`.

Choose Mode C when no reliable publication path exists. Use `review-only` for an independent reviewer that will not mutate the implementation branch, receipt, PR metadata, or existing review threads.

A blob SHA identifies exact file bytes. A commit SHA identifies a commit. Neither proves branch ownership, resulting content, contract identity, CI, review, or another guarantee.

Policy snapshots, capability profiles, and receipts are executor attestations. Unless repository tooling or an operator independently validates them, label them `self-reported`, not `verified`.

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

The receipt records:

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

For large specifications, prefer:

```text
GitHub Issue
    -> explicitly binds repository Markdown specification
    -> receipt records path and immutable Git blob SHA
```

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

### Narrow existing-PR adoption

Use `existing-pr-adoption` only when a PR and branch predate the current executor and the exact original Issue body cannot be obtained in full.

All conditions are mandatory:

1. the operator explicitly authorizes adoption;
2. the executor reads current PR metadata, branch, adopted head, and one complete remote-content level;
3. the receipt contains a closed exact finding list using stable review IDs/signatures where available;
4. changes are limited to those findings and directly necessary verification adjustments;
5. new functionality, scope expansion, unrelated cleanup, and speculative refactoring are prohibited;
6. ownership, current-head CI, review binding, dispositions, and remote read-back remain mandatory.

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

Any need to broaden scope or add unrelated behavior invalidates adoption and requires another exact contract source.

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

### Canonical home and extraction

The canonical home is one dedicated open non-PR GitHub Issue in this repository. Its body contains:

```html
<!-- orchestrator-pack-chat-capability-profile:v1 -->
```

The profile Issue is operational metadata, not an implementation task, branch lock, AO authority, review verdict, or merge approval.

The JSON payload is the single fenced `json` block after the marker and before the next level-two heading. Zero blocks, multiple blocks, malformed JSON, or unrelated payloads make the profile corrupt.

Validate the payload against:

```text
docs/orchestrator-pack-chat-capability-profile.schema.json
```

The schema is normative for structure, required fields, enums/patterns, expiry representation, and forbidden properties. Timestamp validation must use a draft-2020-12 validator with the format-assertion vocabulary enabled, or an equivalent explicit RFC 3339 validation step, for `createdAt`, `updatedAt`, every capability `testedAt`, and every `expiresAt`. A validator that treats `format: date-time` as annotation only does not satisfy profile validation. The schema does not prove marker uniqueness, current permissions, live truth, Issue selection, sorted arrays, or digest correctness.

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

Equivalent environments with differently ordered input arrays must derive the same digest.

Do not put tokens, cookies, credentials, secret URLs, or private data in the key or profile.

### Canonical principal and permission class

`authPrincipal` is the lowercase authenticated GitHub login returned by the current connector or repository permission probe. A display name, remembered account, email address, or operator-supplied alias is not a principal source. If the authenticated login cannot be observed exactly, no profile may match for write capability.

Derive `permissionClass` from the connector-observed repository permission booleans using this fixed highest-privilege precedence:

```text
admin=true                     -> repository-admin-push
admin=false, maintain=true     -> repository-maintain-push
admin=false, maintain=false,
  push=true                    -> repository-write
only triage=true               -> repository-triage
only pull=true                 -> repository-read
no granted repository access   -> repository-none
```

Use exactly one class from this table. Do not add suffixes, synonyms, tool names, or inferred capabilities. A profile whose stored principal or class differs from the current observed derivation is not a match.

### Lookup and fail-closed behavior

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

Additional task-specific keys use bounded kebab-case names.

Only an authenticated repository collaborator acting as the current standalone executor, or the explicit operator, may update the profile. Updates remain schema-valid, replace only affected entries, preserve bounded human-readable history, and contain no secrets.

### Narrow receipt-retrieval downgrade

After every available authenticated path capable of returning the exact execution-receipt comment body has been exhausted and the receipt remains unavailable, one fail-closed capability-profile write may proceed without the blocked task receipt. This is not task ownership and grants no general write authority.

The exception applies only to the single current profile that exactly matches repository ID/full name, canonical environment object and digest, canonical `authPrincipal`, and canonical `permissionClass`. It may change only the existing capability entry that represents execution-receipt ownership/takeover (`standalone-ownership-fence` in the current profile):

- set its status to `degraded`;
- replace its current evidence with the verified failed authenticated retrieval paths and current failure evidence;
- update fields required to keep that one capability entry valid, such as `testedAt`, expiry, known limits, and preferred fallback;
- update only the profile metadata required for the write, currently `updatedAt` and `ownerOrLastUpdater`;
- append exactly one bounded human-readable transition that preserves the affected capability's previous evidence verbatim.

Do not add, rename, or delete a capability key. Every unrelated profile field, every other capability object, and every other capability's evidence must remain byte-for-byte unchanged.

Immediately before writing:

1. retrieve the complete current profile body;
2. require exactly one profile marker and one JSON payload;
3. validate the profile, RFC 3339 timestamps, environment digest, principal, permission class, and target capability;
4. retain the exact pre-write body and construct one expected narrow replacement.

Write once, then immediately retrieve the complete profile body and compare it with that expected replacement. If the profile changed concurrently, the write outcome is ambiguous, or read-back differs, stop. Do not blind-retry, restore an older body, or widen the changed fields. Report the downgrade as pending when it cannot be completed safely.

This exception cannot write the blocked task Issue, execution receipt, branch, PR, review, thread state, workflow, CI state, database state, repository file, or any other capability-profile change.

Starting a new conversation alone does not invalidate a profile. Relevant entries become stale after expiry, permission/connector/runtime changes, or contradictory behavior.

## 5. Roles, liveness, and modes

### Implementer liveness

A normal task checks:

- repository read and current permissions;
- current default-branch HEAD;
- live policy files;
- task-control state and exact contract binding;
- selected publication transport;
- planned or existing branch state;
- current v2 receipt state when applicable.

Choose:

- `provisional-B` when required operations appear available but current-session publication is unproved;
- `C` when reliable publication is unavailable.

`provisional-B` resolves through the first meaningful task checkpoint:

```text
publish exact commit
    -> read back head
    -> prove one complete remote-content level
    -> perform bounded receipt head transition
```

On success, `provisional-B -> B`. On failure, switch only to another already-proven transport or downgrade to C. Do not begin a large local implementation while provisional.

Mode B may edit, publish, read back, update the PR, observe CI/review, address findings, and prepare a ready-for-review handoff.

Mode C may produce a patch, archive, changed-file bundle, manifest, plan, commands, or review. Its terminal status is `handoff prepared`, not completed.

### Independent reviewer authority

An independent reviewer does not take branch ownership merely to review another implementation.

A `review-only` executor may publish only:

- a GitHub review submission; or
- a new top-level review comment.

The review write must bind:

- repository and PR;
- exact reviewed head SHA;
- exact Issue/spec binding;
- reviewer execution identity;
- findings or clean verdict.

Review-only authority must not:

- update branch refs or repository files;
- update an execution receipt;
- change PR title, body, base, draft state, labels, merge state, or reviewers;
- reply as the implementer;
- resolve or unresolve existing threads;
- dispatch workflows;
- make any write that changes implementation state.

Review-addressing replies, thread resolution, PR metadata changes, receipts, and branch writes require implementer ownership.

A reviewer may read CI, comments, threads, Issue/spec state, and the diff without branch ownership.

## 6. Receipt v2 and ownership

### Version and marker

The normative receipt is:

```html
<!-- chat-execution-receipt:v2 -->
```

with:

```text
chat-execution-receipt/v2
```

One task has at most one active v2 receipt comment. Duplicate, malformed, missing-required-field, or ambiguous v2 receipts block implementer writes.

### Retrieval under clipped connector output

A clipped, truncated, or size-limited tool display is not by itself an ownership failure while an underlying authenticated comment resource may still return exact data. Before declaring a receipt unavailable, the executor must:

1. request all Issue comments through every available paginated comments operation;
2. locate every v1 and v2 receipt marker through resource search or an equivalent authenticated comment lookup;
3. retrieve the complete body of every marker-bearing comment through all available authenticated paths capable of returning exact comment bodies;
4. require exactly one valid current receipt under the applicable v1/v2 migration state;
5. parse the complete machine-readable JSON before comparing `executionId`, `ownershipEpoch`, contract binding, and expected branch state/head.

Search may prove that a marker exists. It does not prove marker uniqueness, receipt validity, or the complete body and cannot substitute for full-body retrieval. Unrelated comment bodies need not be expanded once all marker-bearing comments are identified.

If the exact complete receipt remains unavailable after those paths are genuinely exhausted:

- do not create a second receipt;
- do not overwrite or terminalize an existing receipt;
- do not use remembered, cached, or local values for receipt/comment ID, `executionId`, `ownershipEpoch`, contract binding, or branch head;
- report `publication=blocked`, `publicationCause=ownership`, and `mode=C`;
- perform no remote write belonging to the blocked task.

Only the narrow capability-profile downgrade in section 4 may still be attempted under its independent pre-read/read-back fence. If that downgrade cannot be performed safely, report it as pending; do not widen the exception.

### Legacy v1 coexistence and migration

Legacy marker/schema:

```html
<!-- chat-execution-receipt:v1 -->
```

```text
chat-execution-receipt/v1
```

A v1 receipt remains historical evidence only. It does not satisfy v2 ownership or Definition of Done and is never silently interpreted as v2.

When a v1 receipt exists, ordinary v2 work begins only through explicit operator-authorized migration/takeover:

1. read every v1/v2 marker comment;
2. require no active valid v2 receipt;
3. read the current branch/head and old v1 execution identity;
4. record operator authorization and migration reason;
5. create one v2 receipt with a new execution ID, a positive epoch greater than the recorded legacy generation when known, and `previousExecutionId` equal to the old ID;
6. preserve a `legacyReceipt` reference with old marker/comment ID and state;
7. reread every marker and branch state;
8. succeed only when exactly one valid v2 receipt matches the new identity and current head.

The old v1 comment may remain as historical/terminal evidence. It must not be updated to masquerade as v2. Ambiguity grants no ownership.

### Closed pre-ownership writes

Before implementer ownership, writes are limited to:

- explicitly authorized task-control record creation or scope amendment required to establish a valid contract;
- initial v2 claim;
- takeover v2 claim;
- explicit v1-to-v2 migration claim;
- independent review-only submission under the previous section;
- the section 4 narrow capability-profile downgrade after proven receipt-retrieval exhaustion.

All other writes require implementer ownership. The capability-profile downgrade is not a claim and cannot establish or recover task ownership.

### Required v2 fields

The normative minimum is:

```json
{
  "schema": "chat-execution-receipt/v2",
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
    "issueBodyAccess": "full | truncated",
    "bindingKind": "issue-body | repository-contract | operator-export | existing-pr-adoption",
    "bindingRef": "<exact source>",
    "bindingDigest": "<digest>",
    "bodyDigest": "<sha256|null>"
  },
  "branch": "<task branch>",
  "claimedBaseSha": "<sha>",
  "expectedBranchHead": "<sha|null>",
  "expectedBranchState": "absent | present",
  "remoteContent": {
    "level": "commit-and-tree | commit-and-manifest | commit-diff-and-file-blobs | null",
    "headSha": "<sha|null>",
    "publicationParentSha": "<sha|null>",
    "compareBaseSha": "<sha|null>",
    "treeSha": "<sha|null>",
    "manifestDigest": "<digest|null>",
    "diffDigest": "<digest|null>",
    "evidenceRef": "<exact source|null>",
    "observedAt": "<UTC timestamp|null>"
  },
  "ciIdentity": {
    "headSha": "<sha|null>",
    "runsOrChecks": [
      {
        "id": "<id>",
        "name": "<name>",
        "state": "pending | success | failure | cancelled | skipped | missing",
        "conclusion": "<exact conclusion|null>"
      }
    ],
    "state": "not-started | running | red | green | missing",
    "observedAt": "<UTC timestamp>"
  },
  "reviewIdentity": {
    "headSha": "<sha|null>",
    "reviews": ["<review id>"],
    "findings": [
      {
        "id": "<thread/signature>",
        "state": "open | disposed",
        "disposition": "fixed-and-verified | removed-or-inapplicable | rejected-and-accepted | null",
        "verificationHeadSha": "<sha|null>",
        "evidenceRef": "<source|null>"
      }
    ],
    "state": "not-open | open | addressing | clean",
    "observedAt": "<UTC timestamp>"
  },
  "mode": "provisional-B | B | C",
  "work": "analyzing | implementing | testing | preparing-handoff",
  "publication": "local | publishing | published | blocked",
  "updatedAt": "<UTC timestamp>"
}
```

Rules:

- `bindingDigest` is always non-null;
- `bodyDigest` is non-null only for complete `issue-body`;
- `expectedBranchHead` is null only for a claimed absent branch;
- before first publication, remote-content level/head evidence may be null while claimed base and expected branch state are explicit;
- before CI, `ciIdentity` has the intended/current head, an empty check list, and `not-started` or `missing`;
- once CI exists, run/check IDs, names, states, and conclusions are mandatory;
- before review, `reviewIdentity` has the intended/current head, empty arrays, and `not-open`;
- once review exists, review/finding identities are mandatory;
- a finding is terminal only with one allowed disposition;
- `clean` is invalid while any prior finding remains open or lacks disposition;
- coarse status words outside these identity objects are summaries only and cannot satisfy completion.

### Initial claim

Initial claim is allowed only for a branch proven absent and unowned. Before initial claim:

1. establish exact contract binding;
2. retrieve and parse every v1/v2 marker comment using the clipped-output procedure above;
3. require no v1 receipt requiring migration, no active v2 receipt, and no conflicting repository-owned AO/session/pack-store claim authority;
4. read the planned branch and prove that it is absent;
5. record intended branch, claimed base, and explicit absent state;
6. create execution ID and epoch 1.

An existing branch never uses initial claim. It must use the applicable explicit v1 migration, v2 takeover, narrow existing-PR adoption, or AO-managed ownership path; otherwise reject the claim. Unknown branch state or unknown AO ownership state is not unowned.

Write the v2 receipt and reread every marker, branch state, and applicable AO authority. Initial claim succeeds only when exactly one valid v2 receipt matches the identity, binding, absent branch state, and no competing authority exists.

### Takeover

Takeover requires explicit operator authorization unless repository policy already marks the previous execution terminal/abandoned.

Read live policies, task-control/binding, every v2 marker, current branch/head, current CI/review, and the previous execution. Create a new execution ID, increment epoch exactly once, preserve the previous ID, write the receipt, and reread everything.

A failed or ambiguous takeover grants no ownership.

### Ordinary implementer fence

Before every implementer write, retrieve the complete receipt through the clipped-output procedure above, then:

- require exactly one valid current v2 receipt;
- require matching execution ID and epoch;
- require valid exact contract binding;
- require the remote branch to match the receipt's expected state/head;
- stop on mismatch, duplicate, corruption, missing data, or ambiguity.

A true receipt-retrieval failure blocks all task writes and may invoke only the section 4 narrow profile downgrade. A visible truncation banner alone does not establish that failure.

A stale executor observing another ID or higher epoch stops. It must not restore its old receipt or force the branch backward.

This is organizational control. GitHub Issue comments are last-write-wins and provide no compare-and-swap or transactional mutex.

AO-managed workers continue to use AO session, pack-store, claim, and `pack-worker-report` authorities. They do not mint a competing standalone receipt authority.

## 7. Remote publication and read-back

The local filesystem is temporary until work is remotely anchored.

Normal publication:

```text
inspect status/diff and scope
    -> verify active v2 ownership and old expected head
    -> create a meaningful commit
    -> publish fast-forward-only
    -> read back exact remote head
    -> prove one complete content level
    -> perform bounded post-publication receipt transition
```

Reject absolute paths, `..`, case collisions, unapproved symlinks, gitlinks, and unexplained mode/object changes.

After blob upload, compare returned blob SHA. A confirmed truncation or mismatch blocks that transport.

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

A retained local manifest, intended create-tree payload, or durable evidence reference without that remote commit/tree and blob binding is insufficient.

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

For the first publication/adoption, `compareBaseSha` is the claimed starting base. Later checkpoints may use the prior expected head only when that prior head already has complete verified receipt evidence; otherwise retain the stable claimed base. Before Definition of Done, evidence must cover claimed base through current head.

A last-parent-only comparison cannot prove a branch containing earlier unverified commits.

A connector without root tree SHA may use a complete equivalent level. It must not invent a tree SHA. Partial evidence satisfies no level.

### Fail-closed ref update

Use the strongest available sequence:

```text
read receipt identity/epoch and old expected head
    -> reread branch and require exact old state
    -> create commit with old head as parent
       or claimed base as parent for admitted absent branch
    -> update ref with force=false
    -> read back head and content evidence
```

Concurrent advancement should fail non-fast-forward. Do not retry a possibly successful timed-out write blindly; read state first.

### Bounded post-publication receipt transition

Publication changes the branch before the receipt can record the new expected head. This is the only ordinary receipt update admitted while remote head differs from the old `expectedBranchHead`.

Before transition:

1. read the v2 receipt and require the same execution ID/epoch and unchanged old expected state;
2. read the remote branch and require it equals the exact just-published commit;
3. prove that commit's parent is the old expected head, or the claimed base for an absent-branch first publication;
4. complete one remote-content level, including the required compare base/range;
5. require no other branch advancement and no takeover.

Then update the receipt in one bounded write:

- set `previousExpectedBranchHead` to the old head or explicit absent state;
- set `expectedBranchHead` to the exact published head;
- set expected state to present;
- replace `remoteContent` with the complete new-head evidence;
- invalidate old-head CI and review identities (`not-started`/`not-open` for the new head);
- record the transition time.

Immediately reread receipt and branch. Any mismatch blocks. Never advance the receipt to an unproved or merely latest-observed head.

### History rewrite

Force rewrite has no mechanical compare-and-swap. Before an independently authorized rewrite:

1. verify repository policy allows it;
2. confirm sole ownership;
3. read receipt and remote head immediately before write;
4. require matching identity/epoch/head;
5. force-update only the intended commit;
6. perform complete read-back;
7. execute one rewrite-specific receipt transition;
8. obtain fresh CI and review.

The rewrite-specific transition requires the same execution ID/epoch, the unchanged old expected head immediately before the rewrite, explicit rewrite authorization, the exact intended rewritten commit and complete remote-content evidence, and immediate receipt/branch read-back. It records the old and new heads and invalidates old CI/review. Because a rebase/rebuild intentionally changes ancestry, the ordinary parent-equals-old-head condition does not apply; no unrelated or merely latest-observed head may be adopted.

## 8. Checkpoints and heartbeat

During active execution, produce a GitHub-visible signal at least every 15–20 minutes. User waiting time and explicitly paused sessions do not count as active execution.

When a meaningful recoverable slice exists:

```text
verify ownership
    -> publish meaningful checkpoint
    -> complete read-back
    -> bounded receipt transition
    -> reread receipt and branch
```

A WIP checkpoint is acceptable when it is real, scoped progress. A local commit is not a checkpoint. Do not create empty commits to satisfy the timer.

Checkpoint after functional slices and before long tests, risky operations, transport changes, history rewrite, or likely container loss.

When no safe file slice exists, update the receipt with concrete evidence only after ownership verification. Record what was checked, what changed, rejected hypotheses, process/run identity, and next action. `Still working` and similar phrases are not evidence.

Two consecutive heartbeat intervals with no substantive or external evidence change indicate a loop. Preserve the latest checkpoint, record the blocker, and change hypothesis, diagnostic layer, transport, or escalate.

## 9. Long-running commands

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

## 10. Degradation and attempt discipline

If authorization or publication fails after work began:

1. stop writes;
2. read remote state when possible;
3. report the sanitized failure;
4. export work as a patch/archive/manifest;
5. downgrade to Mode C;
6. update the receipt only when ownership remains unambiguous.

A confirmed integrity mismatch immediately blocks the affected transport.

Stop repeating one failure class when two consecutive attempts add no evidence, do not change observed state, and repeat a rejected hypothesis. The next attempt must change hypothesis, evidence source, diagnostic layer, or solution class.

## 11. Secrets and egress

Never publish through commits, connector calls, Issues, receipts, profiles, logs, or handoff archives:

- tokens or API keys;
- cookies or authorization headers;
- raw `.env` files;
- authenticated URLs;
- private keys;
- secret configuration;
- third-party private data.

Scrub CI and process logs before quoting them. Capability evidence may name a non-secret principal, permission class, tool version, HTTP status, or sanitized error class.

## 12. CI and review lifecycle

All CI and review claims bind to the current PR head and exact contract binding.

After each new commit or history rewrite:

- invalidate old-head CI conclusions;
- invalidate old-head clean-review conclusions;
- set new-head identities to not-started/not-open until observed;
- obtain fresh checks and review.

Do not call missing CI green. Cancelled, stale, earlier-head, or unidentified runs do not satisfy completion.

### Finding dispositions

Every prior finding remains open until exactly one disposition is recorded:

1. `fixed-and-verified` — fixed and verified on the current head;
2. `removed-or-inapplicable` — relevant text/code was removed;
3. `rejected-and-accepted` — rejected with evidence and accepted by the responsible reviewer or user.

A later clean review can support a disposition but does not automatically close, supersede, or launder an earlier finding. Silence is not acceptance.

When GitHub threads exist, thread resolution must agree with receipt disposition. Reuse pack finding signatures, review-cycle identities, and merge-triage markers rather than inventing a competing store.

A clean current-head review is not sufficient while a prior finding lacks disposition.

For existing-PR adoption, the closed finding list is the maximum mutation boundary. Another defect requires exact rebinding or explicit operator amendment.

## 13. Status vocabulary

Track orthogonal state:

```text
mode = provisional-B | B | C | review-only
work = analyzing | implementing | testing | preparing-handoff | reviewing
publication = local | publishing | published | blocked | not-applicable
publicationCause = none | retryable | auth | rate-limit | integrity | conflict | ownership | contract | permanent
contract = bound | revalidation-required | unavailable | invalid
remoteContent = unavailable | partial | commit-and-tree | commit-and-manifest | commit-diff-and-file-blobs
ci = not-started | running | red | green | missing
review = not-open | open | addressing | clean@<head SHA>
```

Before publication is proved, do not claim implementation complete, final remote content ready, only publication remains, or almost ready.

## 14. Mandatory scenarios

| Scenario | Required result |
|---|---|
| Short Issue read in full | Normalize complete body and use SHA-256 as binding/body digest. |
| Large Issue truncated | Do not start new implementation without exact alternate contract. |
| Issue binds repository specification | Bind path and immutable blob SHA. |
| Existing PR with truncated Issue | Require authorization, adopted-head read-back, and closed findings. |
| Second implementer writes | Reject on execution ID, epoch, or expected-head mismatch. |
| Contract changes after claim | Require exact revalidation. |
| Connector lacks tree SHA | Use a complete manifest or diff/blob level. |
| Issue summary only | Do not treat it as contract identity. |
| New commit published | Invalidate old-head CI/review. |
| Adoption adds functionality | Block and require rebinding. |
| Successful publication | Bounded transition advances expected head to exact published commit. |
| Unexpected advancement before transition | Block transition. |
| Legacy v1 exists | Require explicit v1-to-v2 migration/takeover. |
| `ci: green` without run/check IDs | Receipt incomplete. |
| Clean review with undisposed prior finding | Not clean/complete. |
| Diff/blob evidence lacks compare base/full range | Invalid. |
| Independent reviewer posts head-bound review | Allowed without branch takeover. |
| Reviewer tries to mutate PR/branch/receipt/thread state | Ownership required; write blocked. |
| Equivalent environment arrays in different order | Canonical digest is identical. |
| Fingerprint object and digest disagree | Profile corrupt and ignored. |
| Equivalent observed repository permissions use different labels | Reject noncanonical labels; derive the fixed highest permission class. |
| Schema validator treats `date-time` as annotation only | Run format assertion or an explicit RFC 3339 validation step before profile use. |
| Connector display is clipped but marker resource is readable | Continue paginated/search/direct authenticated retrieval; do not declare ownership failure. |
| Receipt remains unavailable after all authenticated paths | No task write; report blocked/ownership/Mode C and do not create or overwrite a receipt. |
| Narrow profile downgrade is safe | Change only the existing ownership/takeover capability plus required metadata and one bounded transition; full read-back must match. |
| Narrow profile downgrade is ambiguous or races | Stop without retry/rollback and report the downgrade pending. |
| Existing branch is presented for initial claim | Reject initial claim; require migration, takeover, adoption, or AO authority. |
| Manifest read-back uses only a local retained manifest | Invalid until bound to the fetched remote commit/tree and verified blobs. |
| AO-managed worker completes implementation | Use AO/pack-store/claim/report authority, not a competing standalone receipt. |

## 15. Definition of Done for implementation

For a standalone chat implementer, completion requires all applicable conditions below:

```text
[ ] code or documentation exists in a remote task branch
[ ] exact contract binding is valid
[ ] one valid active v2 receipt contains all mandatory identities
[ ] branch ownership is current and unambiguous
[ ] each publication used a bounded receipt transition
[ ] cumulative remote-content evidence covers claimed base through current head
[ ] task-control state was rechecked
[ ] PR is linked according to /AGENTS.md
[ ] PR diff contains only intended scoped changes
[ ] existing-PR adoption stayed inside its closed finding list
[ ] no secret, transport, or temporary process files remain
[ ] default-branch movement was classified and overlap resolved
[ ] current-head CI identities exist and required checks are green
[ ] current-head review identities exist
[ ] every prior finding has an allowed disposition
[ ] old-head CI/review evidence was invalidated after changes
[ ] merge conflicts are absent
[ ] base was updated when overlap or repository policy requires it
[ ] PR is ready for review
[ ] user received PR URL, head SHA, contract binding, compare base/read-back level,
    CI identities, review state, dispositions, and limitations
```

`BEHIND` alone is not a blocker unless branch protection or merge policy requires an up-to-date base. Unclassified default movement, invalid contract, adoption-scope violation, or stale evidence remains blocking without textual conflict.

If API-authored commits do not start workflows, use an existing repository-owned retrigger. Missing runs are not green. Do not create diagnostic workflows.

AO-managed workers do not mint standalone receipts and do not use the standalone v2-receipt/ownership checklist items. They satisfy the corresponding ownership and lifecycle conditions through the live AO session, repository pack-store/claim authority, and `pack-worker-report` contract in `/AGENTS.md`. All common contract, scope, remote-content read-back, current-head CI/review, finding-disposition, conflict, and PR-linkage requirements still apply.

Local tests, local commits, and a clean local tree do not satisfy Definition of Done. Mode C ends with `handoff prepared`.

## 16. Operating formula

> Live policy is read before work.
>
> Capability structure lives in `docs/orchestrator-pack-chat-capability-profile.schema.json`; mutable observations live in one canonical operational Issue.
>
> Profile lookup uses a versioned closed environment object, connector-observed principal, and canonical permission class, not free-form names.
>
> The Issue is the task-control record; exact contract identity may come from a complete Issue body, repository blob, operator export, or narrow adopted PR head.
>
> Truncated or summarized Issue text is never hashed as a complete contract.
>
> Receipt v2 separates contract, ownership, remote content, CI, and review identities; legacy v1 requires explicit migration. Clipped display triggers exhaustive authenticated retrieval, not a guessed ownership failure.
>
> Independent reviewers can publish head/spec-bound verdicts without taking branch ownership, but cannot mutate implementation state.
>
> Implementer ownership is claimed before branch mutation and remains an organizational, fail-closed protocol because Issue comments are last-write-wins. True receipt unavailability blocks task writes; only the single-capability conservative profile downgrade has a separate fence.
>
> Every publication proves remote content and advances the expected head only through a bounded same-execution transition.
>
> Diff/blob evidence names an exact compare base and full compare range.
>
> Active work is remotely checkpointed and current-head CI/review is reacquired after every change.
>
> Every prior finding requires explicit disposition.
>
> Work that exists only in an ephemeral container is not finished work.