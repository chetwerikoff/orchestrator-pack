# create-issue-draft acceptance artifacts

This document describes the single create-Issue acceptance producer path. The
manager invokes producers; it does not transcribe, repair, pair, or synthesize
acceptance files. Field authority is closed:

| Artifact / field family | Authority | Producer rule |
| --- | --- | --- |
| `tier-intake.json`: task/Issue identity, first revision, tier/topology inputs, competitive decision/rationale | lifecycle-tool-witnessed | lifecycle records the values when admitted; callers do not reconstruct the file |
| `attempt-NNN.json`: episode/attempt/cycle/stage/slot/cardinality/revision, invocation, send/retry/terminal/settlement facts | lifecycle-tool-witnessed | lifecycle/send-boundary tools record only observed facts |
| `attempt-NNN.json`: comment id/url, capture identity/hash/bytes/finding count, `artifactAuthority` | GitHub-witnessed | reconciliation derives them from one complete Issue census plus targeted reread |
| `author-dispositions.json`: exact current Issue draft/body and source revision | GitHub-witnessed | producer uses the one stable live Issue snapshot for the production attempt |
| `author-dispositions.json`: defect/remedy dispositions, reasons/evidence, M3 and M4 | author-owned | consume the structured governed author turn verbatim; the manager does not infer or fill values |
| `author-dispositions.json`: reviewEpisodeId, predecessor stage, topology binding | lifecycle-tool-witnessed | producer binds the author payload to canonical lifecycle state |
| `issue-rNN-body.json` | GitHub-witnessed | freeze exact `{issueNumber, sourceRevision, title, body}` from the same stable observation |
| stage-completeness receipts | lifecycle-tool-witnessed with embedded GitHub facts | derive from canonical topology, lifecycle evidence and reconciled artifacts |
| terminal input bundle: live Issue bytes/revision | GitHub-witnessed | consume/revalidate the same producer-owned Issue snapshot |
| terminal input bundle: episode/predecessor/topology/stage | lifecycle-tool-witnessed | consume canonical lifecycle outputs |
| terminal input bundle: findings/M3/M4 | author-owned | consume governed author output; assembler never re-authors it |
| finding ledger capture identities/raw counts | GitHub-witnessed | recompute from canonical reconciled capture bytes |
| finding ledger mapping/dispositions | author-owned | consume governed disposition rows |
| inventory / relay / acceptance manifest | derived lifecycle producer output | `produce-artifacts` remains the sole producer |

One production attempt owns exactly one stable GitHub Issue observation. Every
GitHub-witnessed body/revision datum produced or validated during that attempt
must agree with that observation. State movement is a stale/restart condition;
two independently observed revisions may not be normalized into one output set.

Conflicting immutable snapshot, capture, disposition, receipt, bundle, ledger or
manifest bytes fail closed. When a required authority is unavailable, the
producer reports the exact field and authority and commits no partial new
acceptance input/output. A canonical capture produced while an attempt is later
rejected is rolled back unless it pre-existed the attempt.

## Pre-acceptance path

The canonical review directory is the normal input surface. Lifecycle evidence
is auto-discovered there; explicit `--tier-intake`, `--stage-evidence` and
`--author-dispositions` paths are assertion/override seams, not instructions
for a manager to hand-author those files.

Read-only status:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/create-issue-stage-finalize.ts -- check-artifacts \
  --review-dir "$REVIEW_DIR" --output-dir "$REVIEW_DIR" --json
```

Produce from owning authorities:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/create-issue-stage-finalize.ts -- produce-artifacts \
  --repo <owner/name> --issue-number <N> \
  --review-dir "$REVIEW_DIR" --output-dir "$REVIEW_DIR" \
  --phase <pre-lens|post-lens|final-acceptance> --json
```

For T2 before terminal review use `--phase pre-lens`; for T3 after the Claude
lens use `--phase post-lens`. Final artifact production uses
`--phase final-acceptance`. T1 has no predecessor review receipt; its
zero-state author payload is produced by the same path.

A non-success result names the unavailable authority. When a legal bounded
continuation exists, the normative continuation is the returned
`nextAction.argv`; execute that vector rather than interpreting prose or
repairing JSON by hand. A terminal/external/stale state with no legal
continuation returns `nextAction: null`.

The terminal reviewer bundle and final acceptance consume canonical producer
outputs. Final acceptance derives cycle, Issue snapshots, receipt inventory,
captures, ledger and relay evidence from the review directory; old explicit
body/revision/cycle/receipt flags are assertion-only and cannot become
acceptance authority.

## Evidence inputs

`tier-intake.json` is the existing immutable `tier-intake/v1` record. Each
stage-evidence file is a recorded `create-issue-stage-evidence/v1` result. It
contains the stage facts already recorded by the flow-manager:

- `tier`, `stage`, `stageAttemptId`, `stageSequence`, `policyVersion`;
- `cycleId` and the recorded `cycleBinding` witness;
- `reviewerCardinality`, `cardinalityConfigIdentity`, `sourceRevision`;
- `outcome`, `revisionChecks`, `settlement`;
- `invocations`, with the recorded invocation envelope fields and, when they
  exist, `capturePath` and `turnResultPath` transport evidence.

For covered Browser-GPT review and terminal stages, GitHub artifact authority
is joined to the already-admitted lifecycle mapping by the exact invocation id.
The comment does not need stage/slot fields: lifecycle owns stage/slot, while
GitHub proves Issue, revision, invocation, publisher and exact body.

Reconciliation first resolves the current authenticated GitHub principal through
the tracked transport using `gh api user --jq .login` (`GET /user`). It then
performs one complete bounded top-level Issue-comment census and filters
candidate reviewer artifacts by case-insensitive publisher-login equality
**before uniqueness**. Repository ownership or `author_association` is not a
substitute selector.

A slot credentials only from exactly one principal-owned, unedited canonical
comment for the exact Issue, frozen revision and admitted invocation, followed
by an identical targeted reread. Zero principal-owned matches, more than one
principal-owned match, wrong publisher, edited comment, wrong Issue, wrong
revision/invocation, incomplete census, unresolved principal, or reread byte
drift fail closed. Unknown is never converted to absence. A case-only login
difference is the same principal.

The original transport result remains independent truth. Reconciliation may add
GitHub artifact authority to an `incident`/possible-delivery invocation but
does not rewrite it to `complete`, synthesize `state: ok`, invent
`reviewer_source`, alter send accounting, or grant resend authority. When
transport itself says `complete`, its real `turn-result/v1` success evidence
continues to be validated.

The exact decoded GitHub comment body becomes the stage source bytes. The
producer derives the existing canonical capture name from stage evidence:

- plural `competitive` / `architectural-review`:
  `pass-<stageSequence>-<stage>-<reviewerSlot>.capture.txt`;
- singular terminal `architectural`:
  `pass-<stageSequence>-architectural.capture.txt`.

If that capture is absent, the producer atomically materializes the exact live
bytes in the canonical review directory. If it already exists, the live body
must be byte-for-byte identical; a conflict is rejected and never overwritten.
The producer computes the existing `CaptureIdentityV1` byte length, SHA-256,
raw finding count, and capture identity from those bytes. This same capture is
then contributed exactly once to the existing credentialing, relay, governed
capture union, finding ledger, occurrence, and stage-completeness topology.

When transport evidence exists, the producer still reads it for diagnostics and
preserves its actual `state`, `send_count`, scope/cause, retry class,
`terminalClassification`, terminal-result identity, and `reviewer_source`.
Artifact acceptance never creates or upgrades `turn-result/v1 state: ok`, never
invents `reviewer_source` or parentage, and never synthesizes a successful
terminal-result identity. A successful receipt is accepted only after the same
authoritative artifact census/reread and exact capture comparison.

The existing `reviewer-invocation-envelope/v1` represents artifact authority
with the bounded optional `artifactAuthority` branch:

```text
artifactAuthority:
  kind: authoritative-github-artifact
  repositoryFullName: <owner/repo>
  issueNumber: <positive integer>
  commentId: <canonical comment id>
  commentUrl: <canonical Issue-comment URL>
  publisherLogin: <observed comment author; audit metadata>
  createdAt: <immutable timestamp>
  updatedAt: <same timestamp>
```

That branch requires the ordinary existing capture. It may credential a capture
when the transport classification is non-`complete`, while the original
transport classification remains unchanged. `terminalResultIdentity` and
`reviewerSource` are present only when actually observed. Live stage-time keeps
the pre-existing transport/terminal/send/retry invariants. Final acceptance does
not turn those provenance/transport identities into completion credentials when
the trusted substantive artifact is already present.

Each stage is bound to its own recorded `sourceRevision`;
`tier-intake.firstRevision` remains the immutable episode root, not the required
revision for every later stage. A bounded author correction can therefore move
the Issue from one revision to the next before the next canonical stage, while
the stage that produced the finding remains permanently consumed. A verdict
declaring a revision different from its own invocation's frozen
`sourceRevision` is rejected.

`author-dispositions.json` carries the producer-owned terminal-bundle binding as
well as occurrence-level dispositions:

```json
{
  "schema": "create-issue-author-dispositions/v1",
  "producer": "governed-author-output/v1",
  "reviewEpisodeId": "issue:1439@r01",
  "sourceRevision": "r02",
  "predecessorStage": "architectural-review",
  "draft": "<exact live Issue body for r02>",
  "findings": [
    {
      "id": "DEFECT-1",
      "type": "quality",
      "occurrences": ["sha256:<digest>:<filename>:1"],
      "defectDisposition": "addressed",
      "remedyDisposition": "accepted"
    }
  ]
}
```

`predecessorStage: null` is an explicit valid value when there is no predecessor.
The substantive `findings` and `m4.inventory` rows come from the latest governed
`round-NN-author-reply.*` `create-issue-author-dispositions/v1` fenced payload;
that author reply is an authority source, not audit-only prose. An empty
`findings` array is an explicit governed no-findings value. The producer computes
ledger counts from the capture
bytes and disposition values, copies the producer-owned
`reviewEpisodeId`/`sourceRevision`/`predecessorStage`/exact-draft binding into
`finding-disposition-ledger.json`, and runs the finding-ledger guard before
writing it. Terminal-bundle composition verifies those bindings and refuses
absent, stale, or foreign producer data instead of re-wrapping it as current.

`check-artifacts` validates the complete output set, not just two marker files:
every stage receipt, `verified-relay-evidence.json`,
`finding-disposition-ledger.json`, `review-episode-inventory.json`, and
`acceptance-artifacts.json` must be regular, parseable files with the expected
schemas and manifest coverage. Directories and malformed files are rejected.

## Produced files

- `stage-completeness-receipt-<stageAttemptId>.json`
- `verified-relay-evidence.json`
- `finding-disposition-ledger.json`
- `review-episode-inventory.json`
- `acceptance-artifacts.json`

`acceptance-artifacts.json` records
`acceptanceBasis: authoritative-github-artifact`. It does not introduce a
second receipt acceptance value or a new artifact class.

`reviewEpisodeId` is computed as
`<tierIntake.taskIdentity>@<tierIntake.firstRevision>`.
`stageReceiptId` is computed as
`<reviewEpisodeId>:stage-receipt:<zero-padded stage sequence>`.
The producer rejects any supplied values that disagree with these derivations.
Receipt census and previous-receipt links are also computed from the ordered
stage evidence; they are never caller input.

The finding-ledger dispositions are closed:

- defect: `addressed`, `rejected-as-false`, `unresolved`;
- remedy: `accepted`, `replaced-by-cheaper-sufficient`,
  `rejected-as-overengineering`.

## Why this cannot forge a stage

The producer does not accept a `stage-ran` flag, caller-supplied source bytes,
publisher login, or caller-supplied artifact identity fields. A Browser-GPT
stage can be credentialed only after a complete target-Issue census resolves
exactly one unedited canonical comment for the expected invocation and the
observed comment author equals the authenticated GitHub principal. All source
identity is recomputed from the live body before any acceptance artifact is
published.

The source-to-governance bridge writes only the pre-existing capture format and
refuses to overwrite conflicting bytes. The additive `artifactAuthority` branch
states why that capture may credential the invocation; it does not repair or
replace transport truth. The resulting receipt, inventory, relay evidence, and
ledger are checked by the existing guards.

## Final completion authority

Final acceptance consumes the current readable live Issue bytes and the required
substantive review/result artifacts. Historical cycle IDs, `cycleBinding`,
cross-record `sourceRevision` equality, stage-event publication, producer/run/
reviewer-source identity, receipt writer, and journal/projection state remain
truthful audit metadata but do not independently credential or veto completion.
The strict current-cycle validator remains the stage publication contract; this
cut applies only after the required work/results already exist.

The terminal GPT remains Issue-lifetime one-shot. Exact reviewed/current bytes
are the ordinary path. The only non-equal path is a bounded post-terminal
correction from `rN` to exactly `rN+1`, with one original terminal substantive
result and all findings/dispositions processed. `rN+2` or unrelated body drift
fails. Final acceptance also performs a fresh stable Issue read-back; failure to
read it or mutation across that read-back remains blocking.

Public journal append and projection-label synchronization are attempted after
content acceptance when possible. Failure is reported as audit/projection
diagnostic state and must not rewrite successful content acceptance into failure
or synthesize replacement journal/cycle/receipt success.
## Operator URL compatibility

The existing direct-operator URL input remains parse-compatible only as a
non-authoritative narrowing hint inside the same complete census. It cannot
supply comment bytes, hashes, counts, publisher identity, uniqueness, or a
second acceptance route. Any supplied URL must identify the same unique
canonical comment already proven by the census.

The URL cannot convert `source-unavailable`, `observation-lost`, an
untrusted/edited/malformed source, a proven zero-match, byte mismatch, or capture
conflict into acceptance. Publisher/current-principal identity itself is not a
completion gate, so the URL has no authority to prefer one trusted publisher
over another. Browser-GPT artifact acceptance never writes an
`operator_adjudicated` readiness fact and never upgrades absent/non-`ok`
transport evidence.
