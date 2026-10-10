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

The local Codex wrapper uses the repository's declared-runtime TypeScript policy and
`codex exec review --json`. It loads the pack-owned prompt, explicit Issue fences,
and the active declaration snapshot. Absolute code locations are normalized to
repository-relative paths before signatures or publication.

Trusted local review requires explicit `--source codex-local`, no CI signal, and no
untrusted external workspace root. Only that case may use workspace-write and
network access for approved coworker delegation. GitHub Actions, omitted source,
external PR workspaces, and CI signals remain read-only. Exfiltratable token and
credential environment variables are removed from the child process in every mode.

## Claude pack-review format correction

The Claude-only wrapper appends its own **last** output instruction after the
shared review prompt (and any conflict carry-over). A completed initial response
is admitted only when its **whole raw stdout**, apart from surrounding whitespace,
is exactly `NO_FINDINGS` (clean) or one JSON object with a nonempty
`findings` array. Each finding requires `type` from
`scope-violation|spec|quality|test|ci|security`, nonempty `code` and
`summary`, `severity` exactly `blocking|non-blocking`, `path` exactly
a nonempty string or `null`, and `source` matching the resolved invocation
(`codex-local|codex-github-action`). Optional `details` and `suggested_fix`
must be strings. Wrappers, fences, prose, bare arrays, empty findings,
coercion, and extra clean text are invalid **before** the shared Codex parser.

A completed malformed **first** answer may receive **one** format-only re-ask,
which quotes the preceding answer as untrusted text and targets the *same
explicit Claude UUID session* via `--resume`. Repair must return nonempty
structured findings; **NO_FINDINGS is only permitted on the original reply**.
Even a narrative-clean first reply followed by repaired `NO_FINDINGS` is
refused as a failed non-judgment: preserving the meaning of arbitrary prose is
not mechanically provable. A second malformed answer does not produce a review.

Both native children share one original effective budget, without resetting
the timer or creating another runner ordinal/logical review round. An exit-zero
empty stdout is a completed format failure (repairable only for the first
answer while time remains); nonzero exit, signal, timeout, cancellation, spawn
failure, or ambiguous process outcome is **never** format-repair eligible.
A failed/expired resume and an invalid repair exit nonzero with no terminal
verdict. Native child PID/process-group evidence can change across the two
children, but the same-ordinal observer's replacement clock stays on its
persisted initial native-attempt start. Codex-native JSONL and fallback
admission remain unchanged.

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
