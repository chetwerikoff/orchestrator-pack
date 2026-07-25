---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". With only a brief and no artifact, route through create-issue-draft's brief-only entry and preserve the requested GPT competitive stage before acceptance. Otherwise run the standalone GPT adversarial loop (≤3 fresh-chat passes, evaluate-don't-obey) over a local markdown artifact. Also the canonical tracked browser-turn mechanics home for create-issue-draft; its one-shot turns use `npm run chatgpt-browser-turn`, while `driver.mjs` retains standalone adversarial duties. Browser-GPT twin of adversarial-draft-review; for «с кодексом» use that skill. Skip plain "создай драфт" with no «с gpt» marker.
---

# discuss-with-gpt

Runs a **GPT adversarial challenge loop** over a local draft/artifact against
a **custom GPT in automation Chrome** (Playwright driver). Twin of
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md) (Codex CLI).

Two roles under the GPT-chat authoring flow
([`create-issue-draft`](../create-issue-draft/SKILL.md)):

- **Standalone** — challenge a local artifact (a draft not yet a GPT-authored
  Issue, a proposal, a `study-external-source` adoption) on user request. This
  role keeps using `driver.mjs` and its prompt/validation contract.
- **Mechanics home** — `create-issue-draft` one-shot task/review turns use the
  tracked Issue #964 helper `scripts/chatgpt-browser-turn.ts` through
  `npm run chatgpt-browser-turn -- ...`: task-chat turns use exact `--chat-url`;
  fresh task/review turns use `--new-chat --project-url`. Review conversations
  are never reused for a later pass. The old untracked scratchpad bootstrap is
  fallback-only under the fail-closed rule below, not the normal path.

**Trust model differs from Codex.** Codex returns process-level JSON. This path
drives a mutable browser UI + ChatGPT product + custom GPT + prose output. The
standalone driver hardens its passes with **per-pass `PASS_ID` + draft `SHA256`
echo**; the tracked helper uses its own causal-witness/result/publication
contract. Treat either path according to its own validation contract.

Issue-body floors, ledger normalization, tier gate, decision logging, chat-role
separation, and acceptance stay owned by `create-issue-draft`.

## When to invoke

| Trigger | Skill |
|---------|-------|
| «с gpt» / «с гпт» / «обсуди с gpt» / «драфт с gpt» / "draft with gpt" | **this skill** |
| «с кодексом» / "with codex" | [`adversarial-draft-review`](../adversarial-draft-review/SKILL.md) |
| GPT-authored Issue task (Issue + task-chat links) | `create-issue-draft` — this skill supplies the tracked persistent-task/fresh-review browser mechanics |
| plain «создай драфт» (no marker) | `create-issue-draft` directly |
| bug/root-cause consult («почему упал…») | `investigate-root-cause` / `codex:rescue` |

**Brief-only GPT creation route.** For «создай задачу с gpt» / "draft with
gpt" with no existing local artifact or Issue, do **not** start the standalone
driver. Route immediately to `create-issue-draft`'s brief-only entry and record
that this wrapper was explicitly requested. That flow creates the Issue and
forces its browser-GPT competitive stage before acceptance; accepted findings
are relayed through the task chat and therefore change the Issue itself.

Do not impose the standalone loop by default — it spends ChatGPT quota and
browser time. Normal `create-issue-draft` browser stages are selected by that
skill's tier/topology contract, not by this standalone trigger table.

## Browser preconditions — check BEFORE the first pass

The tracked helper and standalone driver are **connect-only**: they attach to
already-running automation Chrome with a **logged-in** custom-GPT session. Never
type credentials.

**One command to bring Chrome up:**

```bash
bash .claude/skills/discuss-with-gpt/launch-chrome.sh
```

- Idempotent; exit 0 = ready, non-zero = real blocker in stderr.
- **Do NOT wrap in `timeout`** — the script bounds its own wait; `timeout` yields
  false exit 143.
- **Do NOT run parallel diagnostics** (hand-rolled `curl` loops, hunting
  `powershell.exe`, launching `chrome.exe` yourself). The script handles WSL/Windows.

Requirements:

- Automation Chrome on `--remote-debugging-port=9222` (loopback), **dedicated
  minimal profile** (never the user's main profile).
- `curl -s http://localhost:9222/json/version` is a fast pre-check only. The
  tracked helper has its own profile/UI/witness checks; the standalone driver's
  preflight remains authoritative for standalone runs.

### Operator configuration (required)

No personal URLs or profile paths ship in git. Configure before first run:

| Setting | Env var | `local.config.json` key |
|---------|---------|---------------------------|
| Custom GPT project URL | `DISCUSS_WITH_GPT_PROJECT_URL` | `projectUrl` |
| Chrome user-data-dir | `DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR` | `chromeUserDataDir` |
| Chrome executable (optional) | `DISCUSS_WITH_GPT_CHROME_PATH` | `chromePath` |

Copy `local.config.example.json` → `local.config.json` (gitignored) **or** export
env vars. Env wins over file. First launch: log into ChatGPT once in the
automation profile; subsequent launches reuse the session.

Missing config → `CONFIG_ERROR` / `STATE=config_missing` for the standalone
driver; tracked-helper invocations receive explicit `--profile`, `--cdp`, and
fresh-chat `--project-url` values.

## Tracked one-shot helper for `create-issue-draft`

### Gate B and first live use (mandatory before any real `turn`)

Do **not** run the first live `turn` for a newly built or otherwise
uncharacterized #964 candidate until **all** prerequisites below are complete and
recorded in task/review artifacts. Full operator detail lives in
`scripts/chatgpt-browser-turn/README.md` (§ Gate B and first live use, §
Retained recovery copy and rollback); this section is the skill gate.

**1. Deterministic Gate-B tests green for the current candidate**

```bash
npm run test:issue-964
```

Re-run after any candidate, verifier, runtime-build, or Gate-B test-source change.

**2. Retained recovery root pinned to `candidate_digest`**

Before the first browser effect, choose an absolute recovery root **outside** the
working tree. Canonical layout:

```bash
RECOVERY_ROOT="$(realpath "$HOME")/.local/lib/orchestrator-pack/chatgpt-browser-turn-recovery/<candidate_digest>"
```

Populate it with digest-pinned copies per the README retained-recovery list
(`scripts/chatgpt-browser-turn.ts`, the complete `scripts/chatgpt-browser-turn/`
directory, `scripts/kernel/subprocess.ts`,
`.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs`, exact Node 22 runtime
reference, and Playwright package location/version reference). Record SHA-256
digests for every retained first-party file and the printed absolute
`RECOVERY_ROOT` path alongside live-characterization evidence. Keep the copy
until `status/list` is clear and every relevant `publication-status` is terminal
with no opaque quarantine or blocking tombstone.

**3. Operator Gate-B live characterization on the exact profile/CDP**

For the exact automation `--profile` and `--cdp` that will be used in production:

```bash
npm run chatgpt-browser-turn -- capability   --profile /absolute/path/to/automation-profile   --cdp http://127.0.0.1:9222
```

Record `expected_binding.candidate_digest`, `build_digest`, `config_digest`, and
`gate_digest`. For the operator-controlled live characterization invocation only,
export the exact gate digest before the successful serialized existing-chat turn:

```bash
export CHATGPT_BROWSER_TURN_GATE_B_DIGEST='<expected_binding.gate_digest>'
```

Do not reuse a digest after any candidate, verifier, runtime-build, or Gate-B
test-source change.

The live smoke minimum (serialized, on the dedicated automation profile) must
demonstrate:

1. one existing-chat success with service-issued user-to-assistant causal witness
   and byte-verified publication;
2. one fresh-chat success with canonical conversation identity;
3. same-chat overlap serialized/refused without duplicate send;
4. destination collision leaves external bytes untouched and yields the correct
   pre-send or post-delivery state;
5. `status/list`, exact `clear`, opaque quarantine/tombstone, and
   `publication-status` remain usable after a forced interrupted run.

Query `capability` again after characterization. Record capability
before/after (`state`, browser provenance, evidence digest, observation/expiry
timestamps, downgrade generation). Positive parallel capability is admitted only
when the post-smoke result is `state: ok`; otherwise remain on configured-profile
serialization. Do not mint positive capability from synthetic tests alone.

Only after steps 1–3 are complete may `create-issue-draft` one-shot turns use
the tracked helper on that candidate/profile/CDP binding.

Use the repository package entrypoint so the Node-major guard runs first.
Existing-chat mode:

```bash
npm run chatgpt-browser-turn -- turn \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --chat-url https://chatgpt.com/c/<conversation-id>
```

Fresh-chat mode uses the landed alternative destination shape:

```bash
npm run chatgpt-browser-turn -- turn \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --new-chat \
  --project-url <configured-project-url>
```

The architect prepares the exact argv and absolute input/output paths. The
sanctioned channel is the architect seat itself or a **hands-only Cursor helper**
that executes that exact command and returns stdout/reply state verbatim. Cursor
must not write browser code, change prompt/argv, interpret findings, or invent a
fallback.

The helper sends the caller's snapshotted input content-neutral. `turn` emits one
`turn-result/v1` JSON line on an ordinary terminal path. The exact closed turn
states are:

`ok`, `input_invalid`, `quota`, `challenge`, `login`, `stream_timeout`,
`send_failed`, `no_reply`, `chrome_not_running`, `driver_error`,
`profile_mismatch`, `recovery_required`, `orphaned_fresh_turn`,
`ui_contract_mismatch`, `foreign_activity`, `output_conflict`,
`conversation_busy`, `profile_busy`, `incompatible_record`.

Each turn result carries `scope` (`none|invocation|conversation|profile|machine|blocking_domain`)
and `cause`. Exit mapping is exact: `ok` → 0;
`input_invalid|send_failed|ui_contract_mismatch|output_conflict` → 10;
`stream_timeout|no_reply|recovery_required|foreign_activity|conversation_busy` → 11;
`quota|challenge|login|chrome_not_running|profile_mismatch|orphaned_fresh_turn|profile_busy` → 12;
`driver_error` → 13; `incompatible_record` → 14.

The body-free control/publication plane is also closed:

- `status/list`: `ok|none|profile_blocked|profile_mismatch|driver_error`;
- `clear`: `cleared|quarantined|refused_active|stale_generation|evidence_changed|not_found|profile_blocked|profile_mismatch|driver_error`;
- capability: `ok|no_evidence|expired|downgraded|profile_blocked|profile_mismatch|driver_error`;
- `publication-status`: `committed_ok|not_committed|in_progress|recovery_required|conflict|profile_blocked|profile_mismatch|driver_error`.

`status/list`, `clear`, and capability emit `control-result/v1`; publication
queries emit `publication-status/v1`. Evaluated control outcomes exit 0,
profile block/mismatch 21, driver error 22. Publication
`committed_ok|not_committed` exits 0; `in_progress|recovery_required|conflict` 20;
profile block/mismatch 21; driver error 22.

A hard crash may emit no turn stdout. Never resend after possible delivery merely
because the caller missed a terminal result: query `status/list` and, when the
invocation identity is available, `publication-status` first. The helper's
normal long-turn timeout is at least 1,800,000 ms; a timeout, non-`ok` turn,
missing stdout, or process-liveness uncertainty is not fallback authorization.

### Scratchpad fallback and coexistence

The former untracked one-shot scratchpad is eligible only when one of these is
proven and recorded **before fallback use**:

1. the tracked executable or sanctioned architect/hands-only channel is proven
   unavailable before any tracked-helper or browser effect; or
2. a complete compatible #964 control/publication result proves no possible
   delivery and no blocking state.

Helper failure states, timeouts, and missing process output do not qualify. If
possible delivery cannot be excluded or status is incomplete/incompatible, stay
on the tracked helper's status/publication/recovery path. Do not run the
scratchpad or `driver.mjs` as a surrogate transport and do not resend.

Record every scratchpad fallback in the owning task/review artifacts and final
status, including why it was eligible; never report it as a successful tracked
helper run. Fallback is serialized only and creates no second parallel-use
policy.

While any helper conversation/provisional/publication incident, unreadable-record
profile block, profile wall, opaque quarantine, or blocking tombstone remains
unresolved for the configured profile, no legacy-driver or scratchpad browser
send may run against it. This survives rollback. Reverting the skills to the old
scratchpad mandate requires a complete compatible #964 status/incident check
proving no blockers; without that proof the no-legacy/scratchpad prohibition
remains until exact clearance.

`driver.mjs` keeps its standalone adversarial prompt construction,
PASS_ID/SHA/verdict validation, durable behavior, and supported standalone modes.
The tracked helper does not replace or redesign those duties.

## Standalone driver pass states — record in decision log + final status

These states belong to `driver.mjs`, not to the tracked `turn-result/v1` contract
above. Every standalone driver invocation resolves to exactly one state. The
driver writes a record under
`~/.local/state/discuss-with-gpt/<slug>/…-<state>.md` and prints `STATE=<state>`.

| State | Meaning |
|-------|---------|
| `completed_valid` | `VALIDATION=ok`: PASS_ID+SHA echoed, packet parses. Includes clean `VERDICT=APPROVE` with no findings. **`PARSED approve_empty=true`** — confirm it was a genuine review, not lazy; downgrade to `low_quality` if it reads empty. |
| `low_quality` | Manual downgrade of `completed_valid` — findings generic/non-specific |
| `invalid` | `echo-missing` / `hash-mismatch` / `truncated` / `malformed` |
| `chrome_not_running` / `login_required` / `quota_limit` / `challenge` / `wrong_project` / `cdp_profile_mismatch` | Preflight blockers — fix and retry |
| `stream_timeout` / `no_reply` | Generation incomplete — retry once |
| `send_failed` | Prompt never landed as a user message — the turn was not submitted; resend, do not wait |
| `driver_error` | Unexpected Playwright/UI exception — inspect artifact, fix, retry |
| `skipped` | Browser unavailable and user absent |
| `fallback_codex` | Ran `adversarial-draft-review` instead |

**Fail loud.** If `skipped` / `invalid` / `fallback_codex`, say so plainly. Do
not let a standalone state masquerade as a tracked-helper state or vice versa.

Standalone exit-code hints: `chrome_not_running`(3) / `login_required`(4) /
`stream_timeout`(5) / `no_reply`(6) / `invalid`(7) / `quota_limit`(8) /
`challenge`(9) / `send_failed`(14).

## Standalone driver long turns: poll the page, never infer from the process

GPT routinely thinks **10–15+ minutes** on a large spec. The driver's `--timeout`
therefore defaults to **900000 ms**; never lower it below that for a real draft —
a shorter deadline discards a genuine reply as `stream_timeout`.

**A running process proves nothing.** `pgrep` only shows that the local Node
process has not exited. It looks identical whether GPT is generating, the answer
arrived and the completion detector stuck, the tab errored, or the message never
landed. Never report "GPT is still thinking" on process liveness alone.

**Poll the page itself every 5–10 minutes** while a standalone driver turn is
outstanding. Connect read-only over CDP and read three signals from the chat tab:

| Signal | Meaning |
|--------|---------|
| `[data-testid="stop-button"]` present | generation genuinely in progress |
| stop-button absent + last assistant message ends mid-sentence | stalled — retry |
| stop-button absent + message complete | **done** — take the text from the page |

**Never hand-copy a reply off the page.** Text scraped by hand carries no
`PASS_ID`/`DRAFT_SHA256` echo check, no parsed packet, no durable state record —
so it can never be a `completed_valid` pass, and treating it as one breaks the
validation contract in step 3. If the page shows a finished answer while the
driver is still waiting, that is a **driver defect**: kill the run, record it as
`driver_error`, fix the detector, and re-run so the reply is validated on the
normal path. The two known causes are already fixed — a mid-render message count
taken before the history settled, and duplicate tabs of one chat (below).

**Delivery is verified by the standalone driver, not by you.** After sending it
confirms the prompt appeared as a user message and exits `send_failed`(14) if it
did not. This does not override the tracked helper's stricter possible-delivery
and recovery rules above.

## Tabs and chat identities: reuse one, never merge streams

For tracked `create-issue-draft` turns, `--chat-url <url>` targets the exact
existing task conversation, while `--new-chat --project-url <url>` creates a
fresh destination. The helper owns page selection/coordination; do not use a
legacy send to work around helper busy/recovery state.

For the standalone driver, when a **chat URL** is supplied, pass
`--chat-url <url>`: the driver converses inside that conversation, reuses the tab
already showing it, and foregrounds it. With `--new-chat`, it opens a new page on
the project URL.

`create-issue-draft` topology remains:

- task chat: its own stable `--chat-url`;
- competitive: a fresh `--new-chat` per pass, never reused;
- architectural: a fresh `--new-chat` per pass, never reused;
- final architectural verification: a fresh `--new-chat`, never a prior review URL.

A successful standalone review turn's durable `ARTIFACT` may provide its exact
chat URL for audit recording, but that URL is not an input to a later review pass.

Accumulated duplicate tabs are an active standalone-driver failure source:
different tabs of one conversation can render different message counts, causing
false liveness or `send_failed` states.

Standalone driver rules:

- pass `--chat-url` for a persistent conversation only when that standalone mode
  intentionally targets it;
- use `--new-chat` for every standalone adversarial review pass;
- close stale ChatGPT tabs when a turn ends;
- never use one chat URL for two streams or two review passes;
- tab reuse prevents duplicates of the *same persistent conversation*; it never
  relaxes review-context isolation.

## Standalone flow

### 1. Obtain the artifact

The standalone loop challenges an existing **local** artifact — a draft file,
proposal, or `study-external-source` adoption (any markdown path). This skill
authors nothing. For a brief-only creation trigger, route to
`create-issue-draft`. GPT-authored Issues use the tracked helper mechanics above
inside that flow rather than invoking the standalone loop for task/architectural
turns. Explicit wrapper invocation floors the effective tier at ≥ **T2**.

### 2. Run the GPT adversarial pass

From repo root:

```bash
node .claude/skills/discuss-with-gpt/driver.mjs \
  --draft docs/issues_drafts/NN-<slug>.md
```

**Source-study proposals** ([`study-external-source`](../study-external-source/SKILL.md)):
add `--source-url "https://…"` on **every** pass so GPT also checks fidelity to
the external source (misreadings, omitted caveats, cherry-picking):

```bash
node .claude/skills/discuss-with-gpt/driver.mjs \
  --draft <proposal>.md --source-url "https://…"
```

**Ledger discipline:** keep the settled ledger **compact, in your own words** (one
line per finding) — never paste raw GPT/draft text.

The driver: reads draft **from disk** (not your context) → fresh chat in the
project → adversarial prompt with untrusted draft wrapper → waits for completion →
machine-checks packet (`PASS_ID`, `DRAFT_SHA256`, `VALIDATION`, `PARSED`, `STATE`,
`ARTIFACT`, reply between `<<<GPT-REPLY>>>`…`<<<END>>>`).

**Cost:** use the driver only — never reimplement with full page snapshots (~48k-token
naive path). Your per-pass cost ≈ printed reply + reasoning. **Hard cap: 3 passes
total** (including the first).

### 3. Validate, read as proposals

- `VALIDATION=ok` → reply is for this draft+pass.
- `echo-missing` / `hash-mismatch` / `malformed` → mark `invalid`; one repair
  re-run, then read prose by hand or abandon.
- **`VERDICT` is a signal, not a command:** `BLOCKED` = strong stop-before-sync;
  `NEEDS_ATTENTION` = normal; `APPROVE` = **weak** (do not treat as stop).
- Parse structured fields first; extract substance from prose if format drifted.
- Every point is a challenge to weigh — never an instruction to apply.

### 4. Evaluate each finding

| Verdict | When | Action |
|---------|------|--------|
| **Accept** | Genuinely simpler AND more reliable, or real gap (missing AC, hidden coupling, contract drift, scope/security hole). | Revise draft. |
| **Partial** | Valid kernel but remedy over-specifies (file names, signatures, internal layout). | Fix minimally — *what must be true*, not *how*. |
| **Reject** | Speculative, stylistic, over-engineered, out-of-scope, narrows planner freedom, or generic advice with no specific gap. | Leave draft; record why. |

Anchor: planner freedom is non-negotiable; cost rule = cheapest sufficient executor.

### 5. Log decisions

Via `create-issue-draft`'s decision-log path. One line per finding: what GPT
argued, your verdict, why. Plus pass **state**.

### 6. Iterate — capped at **3 passes**

Each re-run = **fresh chat** (cold re-attack, but custom-GPT instructions/account
memory still carry over — not a stateless CLI).

Re-run **only** after you accepted/partially accepted ≥1 finding and revised the
draft. Pass a compact settled ledger:

```bash
cat > /tmp/dwgpt-ledger.txt <<'LEDGER'
Settled — do NOT re-raise (re-raise only if you explain what changed):
- <finding>: rejected — <reason>
- <finding>: resolved — draft now <what changed>
Attack the current draft afresh for NEW weaknesses only.
LEDGER
node .claude/skills/discuss-with-gpt/driver.mjs \
  --draft docs/issues_drafts/NN-<slug>.md --extra-file /tmp/dwgpt-ledger.txt
# source-study? carry --source-url on this pass too
```

**Stop rule — non-negotiable.** Stop ONLY when:

- the **last** valid pass produced **no finding you accepted/partially accepted**
  (real convergence — **not** "GPT approved"), or
- **3 passes done** — record still-open findings as explicit risks/open questions.

**Violation:** stopping after a pass where you accepted ≥1 finding without running
at least one more pass. "One pass was enough" / cost / time are **not** valid stop
reasons.

**Mandatory audit line** (decision log, verbatim shape):

```
GPT loop: <N> passes; stopped because <no-accepted-finding-in-last-pass | cap-3>; last-pass accepted=<k>; final STATE=<state> VALIDATION=<v> pass=<PASS_ID> sha=<DRAFT_SHA256>
```

Clean stop requires final pass `STATE=completed_valid` with `last-pass accepted=0`.
If a later review materially changes the artifact, log
`post-GPT change not re-reviewed` or re-run GPT.

### 7. Hand back

Standalone runs: the artifact continues on its normal path (architect review,
then publish when asked). Brief-only creation and competitive-stage runs stay
inside `create-issue-draft` **before acceptance** — captures land as
`pass-NN-competitive.capture.txt` in the task's review workdir, and accepted
findings are relayed to the task chat so the Issue is updated. Task-chat turns
and architectural/final review turns are normal `create-issue-draft` stages, not
the standalone adversarial loop. No GPT pass replaces the architect lens.

### 8. Publish

`publish-issue-draft` remains legacy-only for pre-existing tracked drafts. Record
GPT pass state in the owning artifact/Issue flow.

## Don't

- Auto-apply findings.
- Reimplement `create-issue-draft` one-shot turns with full page snapshots or a
  routine scratchpad rebuild; use the tracked helper.
- Run the first live `turn` for a new/uncharacterized #964 candidate before
  `npm run test:issue-964` is green, Gate-B live characterization is recorded,
  and the digest-pinned recovery root under
  `~/.local/lib/orchestrator-pack/chatgpt-browser-turn-recovery/<candidate_digest>`
  is retained.
- Treat a tracked-helper non-`ok` state, timeout, or missing stdout as fallback
  authorization or resend permission.
- Run legacy/scratchpad sends while helper-owned unresolved state blocks
  coexistence for the configured profile.
- Proceed silently on standalone `skipped` / `invalid` / `fallback_codex`.
- Let a browser review replace the architect lens or task-chat content-fix path.
- Merge task and review streams into one chat.
- Reuse any competitive, architectural, or final review chat for a later pass.
- Trust `VALIDATION≠ok` standalone replies without manual checks.
- Type credentials or attempt login.
- Report standalone liveness without polling the page.
- Open a new tab for the known persistent task-chat URL outside the tracked helper.
- Exceed three standalone/competitive passes or rerun without an accepted change.
- Stop after accepting findings without another pass.
- Skip decision logging, pass-state record, or the audit line.
- Hand-edit `.cursor/skills/` pointers; use `scripts/generate-skill-pointers.ps1`.
