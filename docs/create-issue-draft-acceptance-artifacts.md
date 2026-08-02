# create-issue-draft acceptance artifacts

The flow-manager produces acceptance inputs from the evidence it already holds.
The validators remain the authority; this producer only materializes files that
the validators already consume.

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

## Evidence inputs

`tier-intake.json` is the existing immutable `tier-intake/v1` record. Each
stage-evidence file is a recorded `create-issue-stage-evidence/v1` result. It
contains the stage facts already recorded by the flow-manager:

- `tier`, `stage`, `stageAttemptId`, `stageSequence`, `policyVersion`;
- `cycleId` and the recorded `cycleBinding` witness;
- `reviewerCardinality`, `cardinalityConfigIdentity`, `sourceRevision`;
- `outcome`, `revisionChecks`, `settlement`;
- `invocations`, with the recorded invocation envelope fields and a
  `capturePath` for each successful capture.

The producer reads every `capturePath`. It computes the capture byte length,
SHA-256, raw finding count, and capture identity from the bytes. A supplied
capture object or mismatching asserted capture identity is rejected.

`author-dispositions.json` has this shape:

```json
{
  "schema": "create-issue-author-dispositions/v1",
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

The producer computes the ledger counts from the capture bytes and disposition
values, then runs the unchanged finding-ledger guard before writing it.

## Produced files

- `stage-completeness-receipt-<stageAttemptId>.json`
- `verified-relay-evidence.json`
- `finding-disposition-ledger.json`
- `review-episode-inventory.json`
- `acceptance-artifacts.json`

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

The producer does not accept a `stage-ran` flag, caller-supplied capture bytes,
or caller-supplied artifact fields. A receipt can be built only after the
recorded stage-evidence file is present and every referenced capture file can
be read. A missing stage result or capture is reported by name. All fields
derived from capture bytes are computed before any output directory is created;
any error leaves the output artifact set absent. The resulting receipt,
inventory, relay manifest, and ledger are then checked by the existing guards.
