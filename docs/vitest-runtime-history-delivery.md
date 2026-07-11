# Vitest Runtime-History Protected-Branch Delivery

Issue `#731` keeps the existing Issue `#691` producer unchanged up to the local
commit point, then replaces the blocked `git push origin HEAD:main` hop with a
dedicated branch PR path.

## Delivery model

- Producer workflow: `.github/workflows/vitest-runtime-history-refresh.yml`
- Delivery branch: `ci/vitest-runtime-history-refresh`
- Allowed delivery diff: `scripts/vitest-runtime-history.json` only
- Trusted delivery owner: `.github/workflows/vitest-runtime-history-delivery.yml`
  on `pull_request_target`

The refresh workflow writes the measured history update, validates that only the
history file is staged, pushes the fixed delivery branch with a non-`GITHUB_TOKEN`
credential, and opens or updates one PR. The trusted delivery workflow runs from
the base-branch definition, validates the PR file list through GitHub API, waits
for the required checks named in the committed snapshot, and merges only when
they pass. Because the merge owner runs on `pull_request_target`, it also requires
`github.event.pull_request.head.repo.full_name == github.repository` before it
exposes the delivery credential or attempts a merge, so a fork cannot reuse the
fixed branch name to enter the privileged path.

When the fixed delivery branch already exists, the refresh workflow fetches that
branch first, reconciles its pending `vitest-runtime-history.json` into the newly
measured artifact, amends the prepared delivery commit if the merged history
changes, and only then pushes with an explicit `--force-with-lease` bound to the
fetched branch tip. That preserves pending measurements from an earlier still-open
delivery PR instead of overwriting them with a stale-base recomputation from
`main` alone.

## Why this path

- `main` rejects direct pushes with required status checks (`GH006`), so the old
  retry loop could only heal stale-base races, not protected-branch policy.
- Native GitHub auto-merge is disabled in this repo (`allowAutoMerge: false` in
  the committed snapshot), so the trusted PR workflow owns the merge/fail outcome.
- The trust boundary stays at the actor credential, not a branch-protection bypass.
  Ordinary contributor PR policy remains unchanged.

## Operator adoption

After merge:

1. Create or rotate `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN` as a repo or org
   secret for `chetwerikoff/orchestrator-pack`.
2. Scope the credential to this repository with permission to push the dedicated
   delivery branch and open/update/merge pull requests.
3. Do not add a branch-protection bypass entry for this flow. The intended path is
   the ordinary PR gate plus the trusted `pull_request_target` delivery workflow.
4. Verify the two required checks named in
   `docs/vitest-runtime-history-delivery-branch-protection.snapshot.json` still
   match live `main` protection; refresh the snapshot in a follow-up PR if they drift.
5. Confirm one end-to-end run creates or updates the fixed delivery PR and that
   the trusted delivery workflow merges it after the required checks pass.
