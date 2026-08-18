# Browser-GPT turn runbook

This is the portable manager procedure for a tracked Browser-GPT turn. The
normative mechanics live in
[the flow-manager carrier](../.cursor/rules/flow-manager-browser-turn-monitoring.mdc).
The canonical create-issue skills own workflow, roles, stages, receipts, and
review policy. The transport
[README](../scripts/chatgpt-browser-turn/README.md) owns CLI arguments,
result fields, and implementation-local boundaries. The existing
[long-running-child runbook](flow-manager-long-running-child-runbook.md) owns
launcher internals.

## Local-only configuration

Do not put operator values in tracked documentation. Use the existing
gitignored `local.config.json` surface and environment variables consumed by
the current launcher. The names below are placeholders for local substitution,
not a new runtime configuration contract.

| Value | Existing local input or shell placeholder |
| --- | --- |
| repository, Issue, revision, stage, slot, invocation | `<REPOSITORY>`, `<ISSUE_NUMBER>`, `<EXPECTED_REVISION>`, `<STAGE>`, `<SLOT>`, `<INVOCATION_ID>` |
| project URL | `${GPT_PROJECT_URL}` shell placeholder; `DISCUSS_WITH_GPT_PROJECT_URL` environment variable or `projectUrl` in gitignored `local.config.json` |
| conversation URL | `${CHAT_URL}` shell-only placeholder passed to `--chat-url` |
| browser profile | `${BROWSER_PROFILE}` shell placeholder; `DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR` or `chromeUserDataDir` |
| Chrome executable | `${CHROME_PATH}` shell placeholder; `DISCUSS_WITH_GPT_CHROME_PATH` or `chromePath` |
| CDP endpoint | `${CDP_ENDPOINT}` shell-only placeholder passed to `--cdp` |
| prompt and outputs | `${INPUT_FILE}`, `${OUTPUT_FILE}`, `${HANDOFF_RECEIPT}`, `${TERMINAL_ENVELOPE}` |
| local config | existing `local.config.json` keys and supported environment variables |

Use new no-clobber paths inside an existing local directory. Never commit a
real project or conversation URL, browser path, CDP endpoint, home/worktree
path, prompt/output path, receipt, envelope, cookie, token, or credential.

## Start-of-shift preflight

1. Enter a trusted current checkout and read the live `AGENTS.md` and
   `docs/chat-executor-rules.md`.
2. Verify the repository's Node 22 requirement and the current task's tier,
   role, stage, and frozen revision.
3. Before starting flow-manager in a fresh worktree, provision the gitignored
   browser configuration from the operator checkout:
   `cp "<OPERATOR_CHECKOUT>/.claude/skills/discuss-with-gpt/local.config.json" "<WORKTREE_PATH>/.claude/skills/discuss-with-gpt/local.config.json"`.
   Alternatively, set both required values through the environment:
   `export DISCUSS_WITH_GPT_PROJECT_URL="<PROJECT_URL>"` and
   `export DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR="<CHROME_USER_DATA_DIR>"`.
   If launch reports
   `discuss-with-gpt: operator configuration missing`, the mandatory
   configuration is not resolved; this can also happen with a copied but
   incomplete config. Verify both `projectUrl` and `chromeUserDataDir`, or
   both environment-variable equivalents.
4. Load the gitignored local configuration and confirm the configured headed
   automation Chrome is running and logged in. Never type credentials.
5. Start or verify the configured browser through the existing launcher:
   `.claude/skills/discuss-with-gpt/launch-chrome.sh`. Select the applicable
   canonical workflow; stage cardinality and topology belong to that workflow,
   not this runbook.

## Prepare one turn

Write the complete prompt to `${INPUT_FILE}`. Allocate fresh, distinct,
attempt-isolated `${OUTPUT_FILE}`, `${HANDOFF_RECEIPT}`, and
`${TERMINAL_ENVELOPE}` destinations. Before every tracked turn, the
caller/orchestrator must mint and retain one non-empty `${INVOCATION_ID}` and
pass that exact value through the ordinary turn or long-running adapter and any
later harvest/finalization action for the same attempt. Transport/adapter code
validates and forwards this identity; it must not mint, replace, or reinterpret
it. Choose an existing conversation or a fresh project using local values;
tracked content must not contain either URL.

## Launch

For applicable long turns, use the tracked adapter:

```bash
npm run --silent flow-manager-browser-gpt-long-run -- \
  --run-identity <RUN_ID> \
  --attempt-identity <ATTEMPT_ID> \
  --invocation-id "${INVOCATION_ID}" \
  --handoff-receipt "${HANDOFF_RECEIPT}" \
  --terminal-envelope "${TERMINAL_ENVELOPE}" \
  --output "${OUTPUT_FILE}" \
  --profile "${BROWSER_PROFILE}" \
  --cdp "${CDP_ENDPOINT}" \
  --input "${INPUT_FILE}" \
  --chat-url "${CHAT_URL}"
```

For a fresh project launch, use the same command with
`--new-chat --project-url "${GPT_PROJECT_URL}"` instead of `--chat-url`.

For an ordinary tracked turn, the underlying reference is
`npm run chatgpt-browser-turn -- turn --invocation-id "${INVOCATION_ID}" ...`
with the current local CLI values. The presence of `--invocation-id` is normal
for both ordinary and direct-publication-capable flows and never selects direct
mode by itself; direct mode requires its direct-only arguments. Use the existing
launcher contract and bounded observation; do not invent a shell-backgrounding
workaround or a second monitor.

## Observe and settle

The valid child `turn-result/v1` is the turn authority; for long turns the
launcher terminal envelope represents that settled child result. The handoff
receipt only acknowledges accepted detached launch and is not completion
authority. A stable final page reply is sufficient; PID, shell state, silence,
log growth, and observation heartbeats are not completion authority. Follow the carrier's invocation-local
ownership, marker, stage, revision, and retry rules.

If a result, page, or conversation binding is lost after a possible send, do
not infer non-delivery. Re-resolve the current target from `${CHAT_URL}`,
continue sanctioned observation, and harvest the answer with the same
`${INVOCATION_ID}`. The saved target id may be stale.

## Publication and tab lifecycle

The transport owns a per-payload `OPKTURNV1...` marker and exact-one current
user-node attribution. The workflow owns direct target-Issue publication and
receipt-only manager output. For direct publication, the one top-level reviewer
comment must begin with exactly these two lines:

```text
Read revision: #<ISSUE_NUMBER> <EXPECTED_REVISION>
INVOCATION_ID_TO_ECHO: <INVOCATION_ID>
```

The `INVOCATION_ID_TO_ECHO:` declaration must occur exactly once in that comment
and equal the caller-minted invocation id. Settlement uses that exact comment
marker to choose the invocation; same repository/Issue, candidate order, parent
position, titles, URLs, or product message ids do not substitute for it. Zero
exact owned-marker matches and multiple exact owned-marker matches remain
fail-closed, while missing/conflicting results or post-send uncertainty retain
their existing possible-delivery/no-resend semantics.

Publish final bytes before closing the exact retained invocation page. Preserve
a reachable page after post-send failure or no publication; release only the
invocation's browser client. Never close a foreign, sibling, or orphan tab by
URL, target id, age, focus, metadata, or liveness.

## Incident handling

Only a proven pre-send zero-send quota/composer/fill result with
`send_count: 0` is eligible for the single paced retry. Possible or confirmed
delivery, ambiguous post-send loss, output conflict, missing terminal result,
observation uncertainty, or cleanup failure never permits resend. Missing
`turn-result/v1`, post-send page/browser loss, landing mismatch, and
owned-conversation identity mismatch are observation uncertainty, not proof of
non-delivery. Escalation requires either a sanctioned observation showing no
owned prompt or unavailable observation tooling. A blocker report names the
exact probe and its observed result.

## One-shot diagnosis

Use the sanctioned diagnostic utility once, with local values:

```bash
npm run browser-gpt-page-probe -- inspect --cdp "${CDP_ENDPOINT}" --url "${CHAT_URL}"
```

`list`, `inspect`, `export`, and `liveness` are diagnostic-only and always have
`workflow_authority: none`. `harvest` is the sole action-producing probe
(`diagnostic_only: false`), and it also has `workflow_authority: none`; it may
recover/publish only the exact owned turn for the caller-supplied invocation.
The non-acquisition diagnostic probes are read-only and exit once. They cannot
retry, resend, progress a stage, create, or close a tab. The explicit
`--open-if-missing true` acquisition path is the sole opt-in exception: it may
create one owned page, wait for bounded readiness, and close exactly that
owned page. Resolve the current target from the conversation URL instead of
trusting a saved target id. Probe mechanics remain owned by Issues #1272 and
#1122; do not replace this utility with raw CDP, selectors, JavaScript, a watch
loop, or a transcript dump.

## Shift handoff/close

Record the current `<ISSUE_NUMBER>` and `<EXPECTED_REVISION>`, role, stage,
slot, `<INVOCATION_ID>`, owned chat locator when available, and the identities
of `${INPUT_FILE}`, `${OUTPUT_FILE}`, `${HANDOFF_RECEIPT}`, and
`${TERMINAL_ENVELOPE}`. Include the direct publication URL when applicable,
the terminal result or unresolved incident, and the next legal action. Never
hand off only “background job running”.

## Universal author prompt template

Copy this prompt and substitute placeholders:

```text
Role: author for <REPOSITORY>.
Mode: <brief-only-create|revise-existing-issue>.
Authoritative input: <BRIEF_REFERENCE> or live Issue <ISSUE_URL>; expected revision: <EXPECTED_REVISION>.

Read the live target through GitHub when an Issue exists. Follow the canonical
create-issue-draft procedure and current tier, floor, and scope rules.
For brief-only-create, author from the supplied brief. For revise-existing-issue,
preserve the source revision marker and increment it for a substantive body
revision. Apply these requirements: <AUTHORING_REQUIREMENTS>.

Only mutate the target Issue title/body. Do not create a PR, label, milestone,
merge, or unrelated GitHub authority. Re-read the final body for consistency.
After a successful mutation return only this receipt, at most 15 lines:
Issue URL/number, revision marker, and changed sections.
Use the existing audited genuine-write-failure fallback only when the direct
GitHub mutation actually fails.
Never include or fabricate an OPKTURNV1... transport marker; the tracked
transport owns marker insertion.
```

## Universal independent reviewer prompt template

Use this for one caller-selected independent reviewer invocation:

```text
Role: independent reviewer for <REPOSITORY>, Issue <ISSUE_URL>.
Stage: <STAGE>; source slot: <SLOT>; expected revision: <EXPECTED_REVISION>.
INVOCATION_ID_TO_ECHO: <INVOCATION_ID>

Open and read the live Issue through GitHub. Do not review memory or a pasted
body. The one top-level Issue comment must begin with exactly these two lines:
Read revision: #<ISSUE_NUMBER> <EXPECTED_REVISION>
INVOCATION_ID_TO_ECHO: <INVOCATION_ID>
The invocation marker must appear exactly once in that comment and immediately
after the revision line.

Apply the owning workflow's stage rubric. Use stable finding ids and include
severity, type, evidence, non-binding recommendation, and
persistent-machinery fields, plus the exact clean-verdict grammar.
Attempt exactly one top-level comment containing the complete verdict/findings.
Do not edit the Issue, mutate a PR, label, milestone, merge, add a second
comment, or perform unrelated GitHub actions.

On success, manager-facing chat output is exactly:
VERDICT: <...>
COMMENT_URL: <...>
REVISION: <...>
INVOCATION_ID: <...>
FINDING_COUNT: <...>

Use the existing complete authoritative no-commit fallback only for a genuine
write failure. Possible delivery never permits another comment or resend.
Do not receive sibling output, a manager summary, or a prior verdict unless
the owning stage explicitly authorizes it. Never include or fabricate an
OPKTURNV1... marker; tracked transport prepends it.
```

Stage-specific rubric and topology belong to the canonical workflow; this
template does not define reviewer cardinality, repeat-round concurrency, or
launch topology.

## Maintenance matrix

| Changed contract in a PR | Same-PR documentation obligation |
| --- | --- |
| browser launch, observation, attribution, retry/no-resend, publication, cleanup, probe, handoff | update the canonical carrier and audit this runbook |
| CLI option, result field, or component boundary | update the transport README; update carrier/runbook when operator behavior changes |
| author/reviewer role, direct publication, receipt, or invocation identity | update the owning skill and corresponding template |
| local configuration, launcher prerequisite, or setup procedure | update this runbook and the owning reference |
| link or Issue authority supersession | repair all in-scope pointers and present-tense authority wording |

A PR may say “no operator-documentation impact” only when every row is
unchanged. This is a documentation rule, not a new guard or service.