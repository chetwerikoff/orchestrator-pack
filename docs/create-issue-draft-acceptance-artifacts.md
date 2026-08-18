# create-issue-draft acceptance artifacts

The flow-manager produces acceptance inputs from the evidence it already holds.
The validators remain the authority; this producer only materializes files that
the validators already consume.

The acceptance inventory has four roles: `tier-intake.json`, each
`attempt-NNN.json` stage-evidence input (`create-issue-stage-evidence/v1`), and
`author-dispositions.json` (`create-issue-author-dispositions/v1`) are
flow-manager-authored inputs; the files in Produced files are producer outputs;
reviewer captures, `turn-result/v1` artifacts, and Claude producer evidence/waivers
are conditional evidence; chats, author replies, and tier-gate receipts are
audit-only records.
The flow-manager records the two manual input schemas; this component has no
writer for them and no writer for `remote-authority.json`.

## Pre-acceptance path

Run the missing-input check before acceptance:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/create-issue-stage-finalize.ts -- check-artifacts \
  --review-dir "$REVIEW_DIR" \
  --tier-intake "$REVIEW_DIR/tier-intake.json" \
  --stage-evidence "$REVIEW_DIR/attempt-001.json" \
  --author-dispositions "$REVIEW_DIR/author-dispositions.json" \
  --output-dir "$REVIEW_DIR" --json
```

After every required stage has a recorded result, produce the files:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/create-issue-stage-finalize.ts -- produce-artifacts \
  --review-dir "$REVIEW_DIR" \
  --tier-intake "$REVIEW_DIR/tier-intake.json" \
  --stage-evidence "$REVIEW_DIR/attempt-001.json" \
  --stage-evidence "$REVIEW_DIR/attempt-002.json" \
  --author-dispositions "$REVIEW_DIR/author-dispositions.json" \
  --output-dir "$REVIEW_DIR" --phase final-acceptance --json
```

Use `--phase pre-lens` when only the T3 pre-lens stages are complete. The
command returns a non-zero status and a named missing input when evidence is
absent. It writes no acceptance artifact on failure.

`check-artifacts`, artifact production, launch admission, and final acceptance
consume the single executable stage-plan authority in
`scripts/lib/create-issue-stage-topology.ts`. T1 requires one `architectural`
stage. T2 requires `architectural-review` followed by `architectural`. T3 reads
the immutable `tier-intake/v1` decision: `competitiveDecision: required` with a
non-empty `competitiveRationale` requires `competitive`; `skipped` with a
non-empty rationale omits it. T3 then requires `architectural-review`,
`architectural-lens`, and `architectural`. Journal state is audit-only and does
not choose this topology.

A clean settled stage closes with the governed no-findings disposition only: no
author fix-round, Issue-body edit, revision increment, or re-run of that stage.
A stage with findings gets the bounded author correction/disposition defined by
the lifecycle contract, after which only the next canonical stage can be
admitted. The terminal GPT stage is Issue-lifetime one-shot; a permitted bounded
post-terminal correction does not create a second terminal receipt.

Browser starts are staggered by 10–15 seconds. No stage starts on a stale Issue
revision; reviewers read the latest admitted revision.

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

For covered Browser-GPT review and terminal-lens stages, stage readiness has one
authority path: the live GitHub Issue artifact. A `turn-result/v1` receipt is
transport diagnostics only; its presence or state does not create a second
acceptance path and is not required to prove that the stage artifact exists.

Immediately before the Issue-comment census, the producer resolves the current
authenticated GitHub login through the same existing GitHub transport. It then
exhausts the complete paginated top-level comment census for the exact target
Issue once for the production attempt. For each expected invocation, exactly
one unedited comment must satisfy the canonical reviewer grammar and bind the
exact Issue, that invocation's own `sourceRevision`, invocation id, stage/slot
facts exposed by the grammar, and the authenticated publisher login. The
producer never accepts caller-supplied comment bytes, publisher identity,
hashes, lengths, finding counts, or a partial census as authority.

A proven-complete census with zero canonical matches proves absence. An
incomplete/unavailable census is TEMPORARY `source-unavailable`; multiple
canonical matches are TEMPORARY `identity-unresolved`; unavailable authenticated
principal or comment-author evidence is TEMPORARY `provenance-unresolved`; local
observer loss before the authoritative reread finishes is TEMPORARY
`observation-lost`. An observed publisher mismatch is `provenance-mismatch`.
Unknown is never rewritten into absence.

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
  publisherLogin: <authenticated principal>
  createdAt: <immutable timestamp>
  updatedAt: <same timestamp>
```

That branch requires the ordinary existing capture. It may credential a capture
when the transport classification is non-`complete`, while the original
transport classification remains unchanged. `terminalResultIdentity` and
`reviewerSource` are present only when actually observed. The pre-existing
successful transport branch retains its existing invariants.

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
An empty `findings` array is an explicit governed no-findings value, not a
missing producer result. The producer computes ledger counts from the capture
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

## Operator URL compatibility

The existing direct-operator URL input remains parse-compatible only as a
non-authoritative narrowing hint inside the same complete census. It cannot
supply comment bytes, hashes, counts, publisher identity, uniqueness, or a
second acceptance route. Any supplied URL must identify the same unique
canonical comment already proven by the census.

The URL cannot convert `source-unavailable`, `identity-unresolved`,
`provenance-unresolved`, `observation-lost`, a proven zero-match, publisher
mismatch, edited/malformed source, byte mismatch, or capture conflict into
acceptance. Browser-GPT artifact acceptance never writes an
`operator_adjudicated` readiness fact and never upgrades absent/non-`ok`
transport evidence.
