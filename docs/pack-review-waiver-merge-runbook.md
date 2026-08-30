# Pack-review waiver merge (operator authorization)

Operator runbook for merging a PR when **`orchestrator-pack/pack-review`** is either
**FAILURE** or has no status for the current head, and the operator explicitly
authorizes the merge.

This is **not** a routine merge path. Default remains: fix the finding, re-run pack
review, and merge on green. For a missing status, do not start pack-review-runner
just to manufacture one. Use a waiver only when the operator has weighed the risk
and recorded an explicit decision.

**Incident reference:** PR [#919](https://github.com/chetwerikoff/orchestrator-pack/pull/919)
(2026-07-21) — all other required CI green; one blocking P1 finding on non-Linux egress
trap; operator authorized merge in current state.

This runbook supplies only the waiver prerequisites and authorization-status POST/read-back
for the waiver branch in
[`.claude/skills/merge-with-local-adoption/SKILL.md`](../.cursor/skills/merge-with-local-adoption/SKILL.md).
After those checks, return to that skill's ordinary Steps 4–10. The waiver branch must not
execute this runbook's merge or adoption steps, because that would duplicate the skill's
merge/adoption flow.

## When this applies

| Situation | Action |
|-----------|--------|
| `orchestrator-pack/pack-review` = **FAILURE**, all other required contexts **SUCCESS** (or SKIPPED where expected) | Failed-review waiver path **may** apply after explicit operator authorization |
| No `orchestrator-pack/pack-review` status for the current head, all other required contexts **SUCCESS** (or SKIPPED where expected) | Missing-status waiver path **may** apply after explicit operator authorization; missing status alone is not permission |
| Any **other** required check red / pending / never reported | **No waiver** — fix CI or delegate to worker (`merge-with-local-adoption` Step 3b) |
| `mergeable: CONFLICTING` | **No waiver** — resolve conflicts on the PR branch first |
| PR not `OPEN` or still draft | Normalize per merge skill Step 3a (`gh pr ready`, `gh pr update-branch`) |
| Operator has not explicitly authorized the merge in writing | **Stop** — report the missing authorization; do not merge |

## Why `--admin` is not enough

`main` branch protection (verified 2026-07-20):

- `enforce_admins: true`
- `required_status_checks.strict: true`
- Required context includes `orchestrator-pack/pack-review` (`app_id: null` — see below)

`gh pr merge --admin` still fails with:

```text
Required status check "orchestrator-pack/pack-review" is failing.
```

GitHub evaluates the **latest commit status** per required context. Admin merge does
not override a failing required check when `enforce_admins` is on.

## Mechanism (what actually unblocks merge)

`orchestrator-pack/pack-review` is a **commit status** posted by the pack review
delivery layer (`scripts/lib/pack-review-delivery.ts`), not an exclusive GitHub App
check. A repo admin can publish a newer status on the **same PR head SHA** via the
[Statuses API](https://docs.github.com/en/rest/commits/statuses). When the status is
missing, branch protection still requires posting a `success` status on the exact
head, with a description stating the operator authorized merging without pack review.

Branch protection uses the **latest** status for that context. A new `success` status
on the head commit satisfies the merge gate. This status is an authorization record,
not evidence that a pack review ran or was clean. It does **not**:

- dismiss or resolve findings in the pack review-run store;
- remove GitHub review comments;
- re-run the reviewer;
- imply the finding was fixed.

Record the waiver in the status `description` so the audit trail is visible on GitHub.

## Prerequisites (read-only)

From pack root, with pack `scripts/gh` on `PATH`:

```bash
P=919   # PR number
./scripts/gh pr view "$P" --json number,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,body
./scripts/gh pr checks "$P" --json name,state,bucket,description
```

Confirm:

1. `state` = `OPEN`, `isDraft` = false, `mergeable` ≠ `CONFLICTING`.
2. Every required context except `orchestrator-pack/pack-review` is green (or an
   expected skip).
3. The `orchestrator-pack/pack-review` context is either **FAILURE** or has no
   status for this exact `HEAD_SHA`.
4. Operator has given **explicit written authorization** to merge (chat, issue
   comment, or ticket — not implied silence).

Capture the current head SHA:

```bash
HEAD_SHA="$(./scripts/gh pr view "$P" --json headRefOid -q .headRefOid)"
echo "$HEAD_SHA"
```

For the failed-review path, inspect the blocking finding (pack store):

```bash
export P=919
node --experimental-strip-types scripts/pack-review-runner.ts list \
  | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      const parsed=JSON.parse(d);
      const runs=(parsed.runs||parsed.items||parsed||[])
        .filter(r=>r.prNumber===Number(process.env.P));
      runs.sort((a,b)=>new Date(b.updatedAt||b.completedAtUtc)-new Date(a.updatedAt||a.completedAtUtc));
      const x=runs[0];
      console.log(JSON.stringify({head:x?.headSha,status:x?.status,findings:x?.findings},null,2));
    });'
```

## No-review evidence for a missing pack-review status

A missing `orchestrator-pack/pack-review` status is not evidence that no reviewer
completed work. Before a missing-status waiver is described as **no completed
review**, produce the read-only reconciliation receipt for the exact PR head:

```bash
P=<PR_NUMBER>
REPO=chetwerikoff/orchestrator-pack
HEAD_SHA="$(./scripts/gh pr view "$P" --repo "$REPO" --json headRefOid -q .headRefOid)"

node --experimental-strip-types scripts/pack-review-no-review-reconcile.ts \
  --source-repo-root <path> \
  --repo-slug "$REPO" \
  --pr-number "$P" \
  --head-sha "$HEAD_SHA"
```

The producer writes exactly one JSON object plus a newline to stdout. Its schema is
`pack-review-no-review-reconciliation/v1`, it is bound to
`repository + prNumber + headSha`, and `workflowAuthority` is always `none`.
It does not post a status, start/retry a reviewer, create a waiver, or write a
receipt store.

The closed dispositions mean:

- `review-present`: exact-head evidence proves that review work completed. Do not
  describe the waiver as “no review”.
- `no-completed-review`: a matching local run exists and every incomplete source
  was closed with authoritative pre-send/zero-send facts or exact owned-turn
  browser reconciliation, after exact-head source-comment and GitHub-review
  censuses were empty.
- `contradiction`: retained and live evidence disagree. Stop and investigate;
  it is not a negative review fact.
- `unavailable/inconclusive`: required identity, census, browser, or provenance
  evidence could not be proved. It is not a negative review fact.

Evidence is enumerated in this order and remains fail-closed:

1. Read the live PR head and require exact equality with the requested 40-hex
   `headSha`.
2. Resolve exactly one run-store root with the existing pack-review store-root
   authority. Enumerate every row in that root for the same project/PR/head
   **before** repository filtering. An unresolved or ambiguous legacy repository
   identity makes the receipt inconclusive.
3. For **every** matching same-repository/PR/head GPT run, derive coverage from
   its existing `sourceSlots` before choosing the latest zero-completed run.
   Any `complete_clean` or `complete_findings` source in any matching run
   immediately proves `review-present`.
4. Before any negative browser conclusion, census credentialed exact-head GPT
   source comments with the existing source-comment principal, target, edit,
   uniqueness, and exact-ID reread rules. Any valid source comment proves
   `review-present`; unavailable, changed, conflicting, or ambiguous comment
   evidence is inconclusive.
5. Census canonical owner-authored exact-head direct GitHub review artifacts with
   the existing GitHub review authority. Any valid exact-head artifact proves
   `review-present`; an unavailable census is inconclusive.
6. Only for a matching run with zero completed sources, close each incomplete
   slot. A bare `planned` lifecycle is not proof that admission never occurred;
   only immutable terminal/pre-launch or explicit zero-send evidence may close
   directly. A possible-delivery slot requires the exact retained
   profile/invocation/CDP launch binding, the same invocation's state-light
   observation, exactly one owned marker user carrier, and sanctioned browser
   `inspect`/`export` evidence. A matching assistant result proves
   `review-present`; mismatched retained and live bytes are `contradiction`;
   missing/ambiguous/unstable evidence is inconclusive. A bound
   `phase=harvested` observation is itself blocking evidence against the
   zero-completed premise and can never be converted into a negative result by
   later page absence.
7. Immediately before emitting `no-completed-review`, repeat the authoritative
   exact-head GPT source-comment census and direct GitHub-review census. A newly
   appeared artifact becomes `review-present`; an unavailable or ambiguous
   recensus is inconclusive.
8. If the inspected root has **no matching local run**, first run the marker-first
   exact-head source-comment census and the exact-head GitHub-review census. If
   both are complete and empty, the result is still
   `unavailable/inconclusive` with
   `run_store_census_not_exhaustive`. Current authority does not prove one
   inspected run-store root is exhaustive across all legitimate roots.

Do not scan alternate run-store roots, add a registry, synthesize a reviewer start,
or use browser absence to strengthen the no-local-run case.

### Receipt use and staleness

The receipt has no age-based TTL, but unchanged-head equality alone is not enough
to reuse a held negative receipt: exact-head source comments or direct GitHub
reviews can appear without changing the PR head. **Immediately before using a
`no-completed-review` result for waiver reasoning, run the producer again and use
that freshly produced receipt**, then re-read the live PR head and require
byte-for-byte equality with the receipt's lowercase 40-hex `headSha`:

```bash
LIVE_HEAD="$(./scripts/gh pr view "$P" --repo "$REPO" --json headRefOid -q .headRefOid)"
test "$LIVE_HEAD" = "$HEAD_SHA"
```

If the head differs, the receipt is stale: discard it and regenerate against the
new head. Even when the head is unchanged, do not reuse an earlier held
`no-completed-review` receipt in place of the fresh-at-consumption run above.
This is an event-freshness requirement, not an age TTL. A `review-present`,
`contradiction`, or `unavailable/inconclusive` receipt also must not be
relabeled as `no-completed-review`.

This evidence step is separate from operator authorization. Even a valid
`no-completed-review` receipt does not publish the waiver status and does not
authorize merge; the explicit operator-authorization procedure below remains
unchanged.

## Waiver procedure (failed review or missing status)

Replace `P`, `HEAD_SHA`, and the description with live values.

### 1. Post operator authorization status (exact head)

For either waiver path, branch protection requires a `success` commit status on the
exact PR head. The description must state that the operator authorized merging
without pack review and identify the non-private source of that direct authorization
(for example, `source=operator-chat` or `source=issue-comment`; do not include names,
handles, message contents, or other private data). For a failed review, identify the
open finding; for a missing status, state that the review status was absent for this head. Posting this status
does not show that a review ran or was clean. Do not start `pack-review-runner` just
to manufacture the status.

```bash
P=919
HEAD_SHA="$(./scripts/gh pr view "$P" --json headRefOid -q .headRefOid)"

./scripts/gh api "repos/chetwerikoff/orchestrator-pack/statuses/${HEAD_SHA}" \
  -f state=success \
  -f context='orchestrator-pack/pack-review' \
  -f description="Operator authorization: merge without pack review; source=<non-private channel/reference>; <finding or reason; state if status was absent for this head>"
```

Use a concrete reason (finding title, issue link, or operator ticket) and a non-private
authorization source. Avoid empty or generic descriptions. This POST records authorization;
it does not create review evidence.

### 2. Verify the status flipped

```bash
./scripts/gh api "repos/chetwerikoff/orchestrator-pack/commits/${HEAD_SHA}/status" \
  --jq '.statuses[] | select(.context=="orchestrator-pack/pack-review") | {state,description,created_at,creator:.creator.login}'
```

The **newest** row for `orchestrator-pack/pack-review` must be `success`.

### 3. Merge (reference only; not executed by the waiver branch)

The merge skill does not execute this section from its waiver branch. It returns to the
skill's ordinary Step 4 and then executes the skill's Step 5.

```bash
./scripts/gh pr merge "$P" --repo chetwerikoff/orchestrator-pack --merge --delete-branch
./scripts/gh pr view "$P" --json state,mergedAt,mergeCommit
```

If merge still fails, re-read checks — another context may have regressed, or
`HEAD_SHA` drifted after a push.

### 4. Complete local adoption (reference only; not executed by the waiver branch)

The merge skill does not execute this section from its waiver branch. It returns to the
skill's ordinary Step 4 and then executes the skill's Steps 5–10.

Continue with **merge-with-local-adoption** from Step 4 (adoption scan) through Step 10
(report). Minimum after merge:

```bash
git fetch origin
git checkout main && git pull --no-rebase origin main   # or Step 6c dirty-tree path
```

Then Step **6e** orchestrator worktree fast-forward if a live orchestrator row exists.

In the Step 10 report, record verbatim:

- operator waiver authorization;
- the non-private source of the direct authorization (channel/reference only);
- waiver status POST (SHA, description, timestamp);
- that open findings were **not** cleared;
- normal merge vs `--admin` attempt outcome.

## What remains after a waiver merge

| Artifact | State after waiver |
|----------|-------------------|
| Pack review-run store (`pack-review-runner.ts list`) | Still `changes_requested` / findings on the reviewed head |
| Missing `orchestrator-pack/pack-review` status on the merged head | Remains absent as review evidence; the posted `success` status records operator authorization only |
| GitHub PR review comments | Unchanged |
| Open finding on a **later** PR | Still must be fixed or waived again — waiver is per-head |
| Follow-up work | Optional issue/PR to address waived finding if still desired |

Do not hand-edit review-run JSON on disk.

## Alternatives (preferred)

1. **Fix and re-review** — push a fix, wait for CI, then:
   ```bash
   node --experimental-strip-types scripts/pack-review-runner.ts start \
     --pr-number "$P" --head-sha "$HEAD_SHA"
   ```
2. **Delegate to worker** — `merge-with-local-adoption` Step 3b when a worker session
   exists.
3. **Future automation** — Issue [#926](https://github.com/chetwerikoff/orchestrator-pack/issues/926)
   (merge actuator) is designed to admit merges only under typed policy tokens; it does
   not replace ad-hoc operator waiver until enabled.

## Do not

- Waive red **non–pack-review** CI — fix or delegate.
- Post `success` without explicit operator authorization.
- Start `pack-review-runner` just to manufacture a missing status.
- Assume waiver clears findings for merge policy helpers (`evaluateMergePolicy`, triage
  gates) on **future** heads.
- Use `git push --force` to `main` as a workaround.
- Run blanket retired-runtime session cleanup during merge adoption; use the exact owned-identity cleanup in the canonical merge skill.

## Related docs

- [`.claude/skills/merge-with-local-adoption/SKILL.md`](../.cursor/skills/merge-with-local-adoption/SKILL.md) — full merge + pull + 6e/8/9 flow
- [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md) — after manual PR merge
- [`script-owned-review-pipeline.md`](script-owned-review-pipeline.md) — pack review runner
- [`architecture.md`](architecture.md#review-paths) — review paths