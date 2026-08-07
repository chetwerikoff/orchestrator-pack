# Codex PR reviewer

Runtime-neutral Codex PR review contract for GitHub Issues-linked pull requests.

## Goal

Run a bounded Codex review against the exact PR head while the pack owns scope
assembly, reviewer selection, start claims, cycle caps, structured verdicts, and
publication. This is a no core patch design.

## Authorities

- GitHub Issues: live task specification and scope fences.
- GitHub pull request head: code identity under review.
- Pack review runner and store: operational start, list, status, claim, and cap.
- GitHub PR review and required CI: delivery verdict and merge-readiness evidence.
- `PACK_REVIEWER`: tracked reviewer selector.

No concrete runtime command, dashboard, daemon API, configuration file, or session
state is a review fallback.

## Reviewer budget

The effective hard budget defaults to 10 minutes through
`OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS`. Trusted local review prepends command guards
that reject full-suite or destructive commands. Timeout before a verdict emits
`failureClass: timeout_no_verdict`; repeated timeout on the same head escalates
instead of retrying forever.

## Entry points

Common review starts use the pack review runner. Manual Browser-GPT review uses:

```bash
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

The reviewer-neutral wrapper ultimately invokes the selected tracked wrapper.
Direct plugin invocation is for focused fixture/testing work only; it does not
replace runner claims or publication authority.

## Codex wrapper

The local Codex wrapper uses the repository's Node 22 TypeScript policy and
`codex exec review --json`. It loads the pack-owned prompt, explicit Issue fences,
and the active declaration snapshot. Absolute code locations are normalized to
repository-relative paths before signatures or publication.

Trusted local review requires explicit `--source codex-local`, no CI signal, and no
untrusted external workspace root. Only that case may use workspace-write and
network access for approved coworker delegation. GitHub Actions, omitted source,
external PR workspaces, and CI signals remain read-only. Exfiltratable token and
credential environment variables are removed from the child process in every mode.

## Verdict selection

The primary source is a valid `exited_review_mode.review_output` event from Codex
JSONL. The pack maps native findings into its structured finding contract. The
last-message file is a bounded fallback only when no valid native review payload
exists.

Terminal contract:

- exit 0 always writes one non-empty parseable verdict JSON to stdout;
- clean emits `verdict: clean` and `findingCount: 0`;
- findings emit `verdict: findings` with normalized findings;
- malformed, contradictory, empty, timeout, or prose-only output exits non-zero and
  must not parse as clean;
- one clean result for the same PR head is terminal and is not re-invoked.

`NO_FINDINGS` or structured pack JSON may recover a missing native payload only
through the shape-gated fallback. Broad JSONL errors do not fall through to prose.

## Finding contract

Each finding carries stable type, code, severity, path, summary, source, and
signature fields. Scope context comes from the linked Issue and declaration. If
scope cannot be resolved, the wrapper reports a non-blocking
`scope-context-unavailable` warning rather than inventing authority.

## Optional GitHub Actions path

`.github/workflows/codex-pr-review.yml` runs the same wrapper in read-only CI and may
publish findings to the PR. The caller pins the pack ref explicitly and supplies
credentials through encrypted Actions secrets. Secrets are never copied into the
reviewed workspace or child environment.

The local and CI paths share:

- `prompts/codex_review_prompt.md`;
- `plugins/codex-pr-reviewer/bin/review.{ts,ps1}`;
- the same scope assembly and finding mapper;
- the same terminal stdout and failure contract.

This is shared implementation, not dual review authority: the pack runner and
single publication owner still determine the lifecycle.

## Non-goals

- no core patch;
- no concrete runtime review command or dashboard integration;
- no compatibility alias, fallback transport, hidden retry, or second publication
  owner;
- no stored API keys or model credentials;
- no inference that a failed or empty run is clean.

## Contract markers

- Reviewer: Codex
- Default model: `gpt-5.5`
- Trigger: PR review
- Task source: GitHub Issues
- Constraint: no core patch
