# Pack-review waiver merge (operator)

Operator runbook for merging a PR when **`orchestrator-pack/pack-review`** is the
**only** required check still failing and the operator explicitly accepts the open
finding(s).

This is **not** a routine merge path. Default remains: fix the finding, re-run pack
review, merge on green. Use a waiver only when the operator has weighed the risk and
recorded an explicit decision.

**Incident reference:** PR [#919](https://github.com/chetwerikoff/orchestrator-pack/pull/919)
(2026-07-21) — all other required CI green; one blocking P1 finding on non-Linux egress
trap; operator authorized merge in current state.

Post-merge pull, orchestrator worktree sync, and adoption still follow
[`.claude/skills/merge-with-local-adoption/SKILL.md`](../.claude/skills/merge-with-local-adoption/SKILL.md)
(Steps 4–10).

## When this applies

| Situation | Action |
|-----------|--------|
| `orchestrator-pack/pack-review` = **FAILURE**, all other required contexts **SUCCESS** (or SKIPPED where expected) | Waiver path **may** apply after explicit operator authorization |
| Any **other** required check red / pending / never reported | **No waiver** — fix CI or delegate to worker (`merge-with-local-adoption` Step 3b) |
| `mergeable: CONFLICTING` | **No waiver** — resolve conflicts on the PR branch first |
| PR not `OPEN` or still draft | Normalize per merge skill Step 3a (`gh pr ready`, `gh pr update-branch`) |
| Operator has not explicitly waived the finding | **Stop** — report blocking finding; do not merge |

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
[Statuses API](https://docs.github.com/en/rest/commits/statuses).

Branch protection uses the **latest** status for that context. A new `success` status
on the head commit satisfies the merge gate. This does **not**:

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
3. Operator has given **explicit written authorization** to merge with the open
   finding (chat, issue comment, or ticket — not implied silence).

Capture the current head SHA:

```bash
HEAD_SHA="$(./scripts/gh pr view "$P" --json headRefOid -q .headRefOid)"
echo "$HEAD_SHA"
```

Inspect the blocking finding (pack store):

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

## Waiver procedure

Replace `P`, `HEAD_SHA`, and the description with live values.

### 1. Post operator waiver status (exact head)

```bash
P=919
HEAD_SHA="$(./scripts/gh pr view "$P" --json headRefOid -q .headRefOid)"

./scripts/gh api "repos/chetwerikoff/orchestrator-pack/statuses/${HEAD_SHA}" \
  -f state=success \
  -f context='orchestrator-pack/pack-review' \
  -f description="Operator waiver: merge authorized with open pack-review finding — <one-line reason>"
```

Use a concrete reason (finding title, issue link, or operator ticket). Avoid empty or
generic descriptions.

### 2. Verify the status flipped

```bash
./scripts/gh api "repos/chetwerikoff/orchestrator-pack/commits/${HEAD_SHA}/status" \
  --jq '.statuses[] | select(.context=="orchestrator-pack/pack-review") | {state,description,created_at,creator:.creator.login}'
```

The **newest** row for `orchestrator-pack/pack-review` must be `success`.

### 3. Merge (no `--admin` required once status is green)

```bash
./scripts/gh pr merge "$P" --repo chetwerikoff/orchestrator-pack --merge --delete-branch
./scripts/gh pr view "$P" --json state,mergedAt,mergeCommit
```

If merge still fails, re-read checks — another context may have regressed, or
`HEAD_SHA` drifted after a push.

### 4. Complete local adoption

Continue with **merge-with-local-adoption** from Step 4 (adoption scan) through Step 10
(report). Minimum after merge:

```bash
git fetch origin
git checkout main && git pull --no-rebase origin main   # or Step 6c dirty-tree path
```

Then Step **6e** orchestrator worktree fast-forward if a live orchestrator row exists.

In the Step 10 report, record verbatim:

- operator waiver authorization;
- waiver status POST (SHA, description, timestamp);
- that open findings were **not** cleared;
- normal merge vs `--admin` attempt outcome.

## What remains after a waiver merge

| Artifact | State after waiver |
|----------|-------------------|
| Pack review-run store (`pack-review-runner.ts list`) | Still `changes_requested` / findings on the reviewed head |
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
- Assume waiver clears findings for merge policy helpers (`evaluateMergePolicy`, triage
  gates) on **future** heads.
- Use `git push --force` to `main` as a workaround.
- Run blanket `ao session cleanup` during merge adoption (merge skill Step 9c).

## Related docs

- [`.claude/skills/merge-with-local-adoption/SKILL.md`](../.claude/skills/merge-with-local-adoption/SKILL.md) — full merge + pull + 6e/8/9 flow
- [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md) — after manual PR merge
- [`script-owned-review-pipeline.md`](script-owned-review-pipeline.md) — pack review runner
- [`architecture.md`](architecture.md#review-paths) — review paths
