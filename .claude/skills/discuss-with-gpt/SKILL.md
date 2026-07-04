---
name: discuss-with-gpt
description: Use when the user asks to author a task draft/issue AND involve GPT (the custom ChatGPT project) to challenge the approach first — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". Wraps create-issue-draft: author → GPT adversarial loop (≤3 iterations, evaluate-don't-obey) → normal architect review → sync. Browser-GPT twin of adversarial-draft-review. Skip plain "создай драфт" with no «с gpt» marker. For «с кодексом» use adversarial-draft-review, not this skill.
---

# discuss-with-gpt

Inserts a **GPT adversarial challenge loop** between draft authoring and the
normal architect review in
[`create-issue-draft`](../create-issue-draft/SKILL.md). Twin of
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md), but the
challenge runs against a **custom GPT in automation Chrome** (Playwright driver),
not the Codex CLI.

**Trust model differs from Codex.** Codex returns process-level JSON. This path
drives a mutable browser UI + ChatGPT product + custom GPT + prose output. A
weak/stale/wrong-tab pass can masquerade as "review passed." The driver hardens
with **per-pass `PASS_ID` + draft `SHA256` echo**, but treat the result as a
*validated best-effort* artifact, not a guaranteed one.

Everything else — draft structure, 5-mode framework, decision logging, normal
`codex review`, sync gate, `gh issue create` — stays owned by `create-issue-draft`.

## When to invoke

| Trigger | Skill |
|---------|-------|
| «с gpt» / «с гпт» / «обсуди с gpt» / «драфт с gpt» / "draft with gpt" | **this skill** |
| «с кодексом» / "with codex" | [`adversarial-draft-review`](../adversarial-draft-review/SKILL.md) |
| plain «создай драфт» (no marker) | `create-issue-draft` directly |
| bug/root-cause consult («почему упал…») | `investigate-root-cause` / `codex:rescue` |

Do not impose this loop by default — it spends ChatGPT quota and browser time.

## Browser preconditions — check BEFORE the first pass

The driver is **connect-only**: attaches to already-running automation Chrome
with a **logged-in** custom-GPT session. Never types credentials.

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
- `curl -s http://localhost:9222/json/version` is a fast pre-check only — the
  driver's preflight (project URL + composer present + profile match) is the real gate.

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

Missing config → `CONFIG_ERROR` / `STATE=config_missing`; no personal defaults.

## Pass states — record in decision log + final status

Every invocation resolves to exactly one state. The driver writes a record under
`~/.local/state/discuss-with-gpt/<slug>/…-<state>.md` and prints `STATE=<state>`.

| State | Meaning |
|-------|---------|
| `completed_valid` | `VALIDATION=ok`: PASS_ID+SHA echoed, packet parses. Includes clean `VERDICT=APPROVE` with no findings. **`PARSED approve_empty=true`** — confirm it was a genuine review, not lazy; downgrade to `low_quality` if it reads empty. |
| `low_quality` | Manual downgrade of `completed_valid` — findings generic/non-specific |
| `invalid` | `echo-missing` / `hash-mismatch` / `truncated` / `malformed` |
| `chrome_not_running` / `login_required` / `quota_limit` / `challenge` / `wrong_project` / `cdp_profile_mismatch` | Preflight blockers — fix and retry |
| `stream_timeout` / `no_reply` | Generation incomplete — retry once |
| `driver_error` | Unexpected Playwright/UI exception — inspect artifact, fix, retry |
| `skipped` | Browser unavailable and user absent |
| `fallback_codex` | Ran `adversarial-draft-review` instead |

**Fail loud.** If `skipped` / `invalid` / `fallback_codex`, say so plainly — do
**not** let `create-issue-draft` proceed as if GPT ran.

Exit-code hints: `chrome_not_running`(3) / `login_required`(4) /
`stream_timeout`(5) / `no_reply`(6) / `invalid`(7) / `quota_limit`(8) /
`challenge`(9).

## Flow

### 1. Author the draft

After relocation (Issue #579), the **Cursor draft-author session** owns this step
and the GPT adversarial loop below — not the architect's live session. Delegate
to an isolated draft-author session running `create-issue-draft` from the
architect's brief. Explicit wrapper invocation still floors the effective tier
at least to **T2** per #189. When relocation is inactive or the delegate returns
incomplete, fall back to architect-as-author per `create-issue-draft`.

Follow `create-issue-draft`'s structure and framework triggers →
`docs/issues_drafts/NN-<slug>.md`. **Stop before** "Codex review the draft" + sync.

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
If a later step (e.g. normal codex review) materially changes the draft, log
`post-GPT change not re-reviewed` or re-run GPT.

### 7. Hand back to `create-issue-draft`

Resume from "Codex review the draft" onward. GPT loop **never replaces** architect review.

### 8. Publish

`publish-issue-draft` (default sync-only). Record GPT pass **state** in issue/draft.

## Don't

- Auto-apply findings — step 4 is mandatory.
- Reimplement the pass with full page snapshots.
- Proceed silently on `skipped` / `invalid` / `fallback_codex`.
- Let GPT substitute for normal architect review.
- Over-specify the draft to satisfy a finding.
- Trust `VALIDATION≠ok` replies without manual checks.
- Type credentials / attempt login.
- **Exceed 3 passes**, or re-run with no accepted change.
- Stop after accepting findings without another pass.
- Skip decision logging, pass-state record, or the **audit line**.
- Hand-edit `.cursor/skills/` pointer (generated by `scripts/generate-skill-pointers.ps1`).
