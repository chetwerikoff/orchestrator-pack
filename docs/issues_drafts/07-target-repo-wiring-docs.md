# End-to-end target-repo wiring docs + example

GitHub Issue: #10

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`), #4, #5, and #6 must be
merged. This issue documents the user-facing flow that those implement.

## Goal

Document how a target repository adopts orchestrator-pack: install the
pre-commit hook, wire the reusable Codex review workflow, set up the required
secret, and write a first GitHub Issue with a denylist.

## Binding surface

Documentation only.

## Files in scope

- `docs/target_repo_setup.md` (new) — end-to-end checklist
- `docs/issue_template_example.md` (new) — minimal Issue body example with a mandatory `denylist` fence and an optional `allowed_roots` fence (no `declared-files` in the issue body; declared paths are produced by `ao-declare` and committed as the snapshot)
- `README.md` — link to the new docs from "Configure AO for a target repository"
- `docs/issues_drafts/07-target-repo-wiring-docs.md` — this spec

## Files out of scope

- Any executable code
- AO core, vendor
- Plugin implementations

## Denylist

- `vendor/**`
- `packages/core/**`

## Acceptance criteria

- Checklist covers, in order:
  1. Prerequisites (Node 20+, Git 2.25+, gh authenticated)
  2. `npm install -g @aoagents/ao`
  3. Copy `agent-orchestrator.yaml.example` to a local-only `agent-orchestrator.yaml`
  4. Generate and set `CODEX_AUTH_JSON` secret
  5. Install the scope-guard pre-commit hook and agent wrapper (scripts from #5)
  6. Add `.github/workflows/pr-review.yml` reusing the pack's Codex workflow
  7. Open a first GitHub Issue with a mandatory `denylist` fence and an optional `allowed_roots` fence (point to the example file)
  8. Run `ao-declare --issue <n>` to produce the declaration snapshot
  9. Commit the snapshot at `docs/declarations/{n}.{iteration_id}.json` to the feature branch
  10. Verify the scope-guard wrapper blocks an out-of-scope edit (smoke test)
  11. Push the PR and verify CI scope-guard fails when an out-of-scope file is included
- Example issue body must be directly parseable by `_shared/issue_parser` from #4.
- References #3.A for the source-of-truth model; no per-target decision left to the operator.

## Upgrade-safety check

- All references to upstream AO go through `npm install -g @aoagents/ao`.
- No instruction asks the user to clone, vendor, or patch AO core.
- No reference to unsupported YAML fields.

## Verification

- Dry-run the checklist on an empty test repo; every step is executable as written.
- Example issue body, when fed to `ao-declare`, produces a valid declaration JSON.
