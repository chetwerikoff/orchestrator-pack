# Browser-GPT turn runbook

This runbook owns the portable manager procedure and operational mechanics for a
tracked Browser-GPT turn. The non-always-loaded
[flow-manager carrier](../.cursor/rules/flow-manager-browser-turn-monitoring.mdc)
retains only the manager-review canon fragments selected literally by the
create-issue workflow: **Launch and observation** and **Legacy state and
diagnostic probe**. The canonical create-issue skills own workflow, roles,
stages, receipts, and review policy. The transport
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
   configuration is not resolved; this can also occur with a copied but
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

For governed create-Issue reviewers, do **not** hand-author `${INPUT_FILE}`.
`.claude/skills/create-issue-draft/SKILL.md` owns the manager-review canon
section list and `scripts/lib/manager-review-brief.ts` renders the exact
unmarked reviewer input from that tracked canon plus repository, Issue,
revision, stage, slot, and invocation context. For one plural `stageAttemptId`,
render all sibling input files from one ephemeral canon read before launching
the first sibling. Do not re-prepare a later sibling from newer canon after the
batch has started. The input files are transport inputs only, not provenance
manifests or persisted canon snapshots.

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

For a governed create-Issue direct-publication reviewer, add the existing
direct-publication identity/output arguments and the required canon context:

```bash
  --reviewer-source-output "${REVIEWER_SOURCE_OUTPUT}" \
  --reviewer-source direct-publication/v1 \
  --repository "${REPOSITORY}" \
  --issue-number "${ISSUE_NUMBER}" \
  --source-revision "${EXPECTED_REVISION}" \
  --stage "${STAGE}" \
  --source-slot "${SLOT}"
```

The long-running adapter refuses missing direct-publication context before it
spawns the detached child. State-light independently regenerates current
canonical reviewer bytes from the stable unmarked input before profile/CDP/tab
work and refuses a mismatch with an existing `turn-result/v1` carrying
`state: input_invalid`, `send_count: 0`, and a concrete `canonical_prompt_*`
cause. A byte-mismatch cause includes expected/observed unmarked prompt hashes
and current `path@blobSha` diagnostics, never prompt bytes.

For a fresh project launch, use the same command with
`--new-chat --project-url "${GPT_PROJECT_URL}"` instead of `--chat-url`.

For an ordinary tracked turn, the underlying reference is
`npm run chatgpt-browser-turn -- turn --invocation-id "${INVOCATION_ID}" ...`
with the current local CLI values. A governed create-Issue direct-publication
turn carries the same `--stage` and `--source-slot` values as the long-running
path. The presence of `--invocation-id` is normal for both ordinary and direct-
publication-capable flows and never selects direct mode by itself; direct mode
requires its direct-only arguments. Use the existing launcher contract and
bounded observation; do not invent a shell-backgrounding workaround or a
second monitor.

## Observe and settle

The valid child `turn-result/v1` is the turn authority; for long turns the
launcher terminal envelope represents that settled child result. The handoff
receipt only acknowledges accepted detached launch and is not completion
authority. A stable final page reply is sufficient; PID, shell state, silence,
log growth, and observation heartbeats are not completion authority. Follow the
current workflow for stage/revision policy and this runbook for invocation-local
ownership, marker attribution, retry/no-resend, publication, and cleanup.

If a result, page, or conversation binding is lost after a possible send, do
not infer non-delivery. Re-resolve the current target from `${CHAT_URL}`,
continue sanctioned observation, and harvest the answer with the same
`${INVOCATION_ID}`. The saved target id may be stale.

## Publication and tab lifecycle

Canonical reviewer admission compares **unmarked** input bytes. Only after a
successful match may the existing transport prepend its owned
`OPKTURNV1...` marker; callers and generated prompts never include or fabricate
that marker. The workflow owns direct target-Issue publication and receipt-only
manager output. The reviewer publishes its own complete verdict/findings
comment; the manager consumes the receipt and later owns disposition/workflow
actions.

For direct publication, the one top-level reviewer comment must use exactly
these as its first two non-empty lines:

```text
Read revision: #<ISSUE_NUMBER> <EXPECTED_REVISION>
INVOCATION_ID_TO_ECHO: <INVOCATION_ID>
```

Leading blank lines are ignored for this grammar. The invocation marker must
occur exactly once in that comment and equal the caller-minted invocation id.
Settlement uses that exact comment marker to choose the invocation; same
repository/Issue, candidate order, parent position, titles, URLs, or product
message ids do not substitute for it. Zero exact owned-marker matches and
multiple exact owned-marker matches remain fail-closed, while
missing/conflicting results or post-send uncertainty retain their existing
possible-delivery/no-resend semantics.

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

## Generated independent reviewer prompt

This runbook no longer owns a normative reviewer template. The ordered owning
sections and binding frame live only in
`.claude/skills/create-issue-draft/SKILL.md` under **Manager review brief canon**.
Use `scripts/lib/manager-review-brief.ts` to render exact unmarked reviewer
bytes from those sections and bound invocation context. For plural stages,
render all siblings from one canon snapshot before the first launch. Pass
`--stage` and `--source-slot` on both ordinary and long-running governed direct-
publication launches. Do not add an `OPKTURNV1...` marker to generated bytes;
state-light validates the unmarked input and the transport owns marker insertion
after admission.

If the selected canon changes after a plural batch starts, do not regenerate a
later sibling's input. Its already-materialized old bytes reach state-light,
current-source regeneration disagrees, and that invocation settles pre-browser
as `input_invalid` rather than mixing canon revisions inside one
`stageAttemptId`.

## Maintenance matrix

| Changed contract in a PR | Same-PR documentation obligation |
| --- | --- |
| browser launch, observation, attribution, retry/no-resend, publication, cleanup, probe, handoff | update this runbook; update the flow-manager carrier only when one of its two selected canon fragments changes |
| CLI option, result field, or component boundary | update the transport README; update this runbook when operator behavior changes |
| author role or author invocation | update the owning skill and author template when needed |
| reviewer role, direct publication, receipt, or invocation identity | update the owning skill/canon; update a selected carrier fragment only when its canonical reviewer input must change; do not copy a normative reviewer prompt into this runbook |
| local configuration, launcher prerequisite, or setup procedure | update this runbook and the owning reference |
| link or Issue authority supersession | repair all in-scope pointers and present-tense authority wording |

A PR may say “no operator-documentation impact” only when every row is
unchanged. This is a documentation rule, not a new guard or service.
